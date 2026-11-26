/**
 * Тарифи доставки в Shopify Checkout (CarrierService callback).
 *
 * Shopify надсилає POST із кошиком і адресою (документація: DeliveryCarrierService → «Example shipping rate request»);
 * ми рахуємо вагу посилки, питаємо вартість у перевізника за замовчуванням (`quoteRates`), перераховуємо у валюту
 * кошика з націнкою (pricing.ts) і повертаємо `{ rates: [...] }`.
 *
 * Семантика відповіді (документація, «Special conditions»):
 * - «не можемо обробити» → 2xx з `{ "rates": [] }` (Shopify покаже інші тарифи магазину);
 * - помилка/тайм-аут перевізника → 4xx/5xx («return any 4xx or 5xx») — Shopify використає резервні тарифи (backup rates).
 *   Повторів Shopify не робить; помилки Shopify кешує на 30 с, успіх — на 15 хв.
 *
 * Персональні дані: імена, телефони, email з запиту відкидаються вже при розборі (zod прибирає невідомі ключі);
 * адреса передається лише перевізнику для розрахунку і НІКОЛИ не потрапляє в журнал.
 */
import { createHash } from "node:crypto";
import { inArray } from "drizzle-orm";
import { z } from "zod";
import type { DbOrTx } from "~/db/client.server";
import { productVariants } from "~/db/schema";
import { requirePermission } from "~/domain/permissions";
import {
  CarrierError,
  type CarrierAdapter,
  type CarrierAddress,
  type CarrierErrorKind,
  type CarrierMode,
  type CarrierRegistry,
  type Money,
  type ParcelSpec,
  type RateItem,
  type RateQuote,
  type RateRequest,
} from "~/integrations/carriers/types";
import { logger } from "~/lib/logger.server";
import { fromMinor, toMinor } from "~/lib/money";
import type { AllSettings } from "~/modules/settings/schema";
import { getSettings } from "~/modules/settings/settings.server";
import { computeParcelWeights } from "~/modules/shipments/weight";
import type { ServiceContext } from "~/server/types";
import { priceCheckoutRate, subunitsToDecimal, type PricingFailure, type PricingResult } from "./pricing";

// ---------------------------------------------------------------------------
// Константи
// ---------------------------------------------------------------------------

/**
 * Тайм-аут виклику перевізника. Shopify чекає відповідь щонайбільше 10 с (< 1500 запитів/хв на пару магазин-застосунок),
 * 5 с (1500–3000) або 3 с (> 3000) — «upper limits», можуть змінюватися. 4,5 с вкладається в рівень 5 с із запасом
 * на нашу обробку; для одного магазину очікуваний рівень — 10 с.
 */
export const CHECKOUT_RATES_TIMEOUT_MS = 4500;

/**
 * `items[].grams` — вага ОДНІЄЇ одиниці товару (множимо на `quantity`).
 * У прикладі документації quantity = 1, тож приклад не розрізняє «за одиницю» і «за рядок»; «за одиницю» —
 * усталена конвенція CarrierService (аналогічно `price` — ціна за одиницю). Перевірити на тестовому магазині.
 */
export const SHOPIFY_ITEM_GRAMS_ARE_PER_UNIT = true;

/**
 * Крок ваги для запиту тарифу: фактична вага округлюється ВГОРУ до 100 г. Так результат кешу (ключ — ваговий крок)
 * завжди відповідає вазі, не меншій за фактичну (жодного заниження ціни).
 */
export const RATE_WEIGHT_STEP_GRAMS = 100;

export const CHECKOUT_RATES_CACHE_TTL_MS = 10 * 60_000;
export const CHECKOUT_RATES_CACHE_MAX_ENTRIES = 500;

/** Shopify: service_code «must be stable and consistent across requests» — без дат, сесій, ідентифікаторів запиту. */
const SERVICE_CODE_MAX_LENGTH = 64;

// ---------------------------------------------------------------------------
// Розбір запиту Shopify
// ---------------------------------------------------------------------------

const optStr = z.string().max(500).nullish();

/** Ціле ≥ 0: число або рядок із цифр (м'яка сумісність). */
const intLike = (max: number) =>
  z
    .union([z.number(), z.string().trim().regex(/^\d{1,16}$/)])
    .transform((v) => Number(v))
    .pipe(z.number().int().min(0).max(max));

/** Числовий legacy ID (приклад: 258644705304) або GID → рядок; інше → null. */
const idLike = z
  .union([z.number().int().nonnegative(), z.string().trim().max(100)])
  .nullish()
  .transform((v) => (v === null || v === undefined || v === "" ? null : String(v)));

const addressSchema = z.object({
  country: optStr,
  /** У прикладі JSON — `postal_code`; у тексті документації — `zip`. Приймаємо обидва. */
  postal_code: optStr,
  zip: optStr,
  province: optStr,
  city: optStr,
  address1: optStr,
  address2: optStr,
});

const itemSchema = z.object({
  name: optStr,
  sku: optStr,
  quantity: intLike(100_000),
  grams: intLike(100_000_000).nullish(),
  /** Ціна за одиницю в найменших одиницях валюти (приклад: 1999 = 19.99). */
  price: intLike(1e13).nullish(),
  requires_shipping: z.boolean().nullish(),
  product_id: idLike,
  variant_id: idLike,
});

const orderTotalsSchema = z.object({
  subtotal_price: intLike(1e15).nullish(),
  total_price: intLike(1e15).nullish(),
  discount_amount: intLike(1e15).nullish(),
});

export const rateRequestSchema = z.object({
  rate: z.object({
    origin: addressSchema.nullish(),
    destination: addressSchema,
    items: z.array(itemSchema).max(1000),
    currency: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3}$/)
      .transform((s) => s.toUpperCase()),
    locale: optStr,
    order_totals: orderTotalsSchema.nullish(),
  }),
});

export type ShopifyRateRequest = z.infer<typeof rateRequestSchema>;
type ShopifyRateItem = ShopifyRateRequest["rate"]["items"][number];

export type ParseRateRequestResult = { ok: true; request: ShopifyRateRequest } | { ok: false; issues: string[] };

/** Невідомі ключі ігноруються, null дозволено; структурно некоректний запит → ok: false (лише шляхи полів, без значень). */
export function parseRateRequest(json: unknown): ParseRateRequestResult {
  const parsed = rateRequestSchema.safeParse(json);
  if (parsed.success) return { ok: true, request: parsed.data };
  return { ok: false, issues: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".") || "_"}: ${i.code}`) };
}

// ---------------------------------------------------------------------------
// Відповідь Shopify
// ---------------------------------------------------------------------------

/**
 * Об'єкт тарифу у відповіді. `min_delivery_date` / `max_delivery_date` НЕ надсилаємо: формат дати показано лише
 * прикладом ("2013-04-12 14:48:45 -0400"), формальної специфікації немає (НЕ ЗАДОКУМЕНТОВАНО).
 */
export interface ShopifyRate {
  service_name: string;
  description: string;
  service_code: string;
  currency: string;
  total_price: string;
}

export interface CheckoutRatesResponse {
  status: 200 | 503;
  body: { rates: ShopifyRate[] };
}

/**
 * `total_price` — ціле в subunits (для валют без дробових одиниць — × 100). Тип у документації неоднозначний:
 * приклад відповіді — рядок ("1295"), таблиця полів — число (500). Обрано РЯДОК, як у прикладі відповіді.
 * Єдине місце, де визначається формат.
 */
export function shopifyTotalPrice(cents: bigint): string {
  if (cents < 0n) throw new RangeError("total_price must be non-negative");
  return cents.toString();
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

/** Стабільний service_code: "<перевізник>_<код послуги>", ≤ 64 символів (довший — скорочується з детермінованим хешем). */
export function shopifyServiceCode(carrierCode: string, serviceCode: string): string {
  const code = `${slug(carrierCode) || "carrier"}_${slug(serviceCode) || "default"}`;
  if (code.length <= SERVICE_CODE_MAX_LENGTH) return code;
  const hash = createHash("sha256").update(code).digest("hex").slice(0, 8);
  return `${code.slice(0, SERVICE_CODE_MAX_LENGTH - 9)}_${hash}`;
}

// ---------------------------------------------------------------------------
// Кеш (у пам'яті процесу)
// ---------------------------------------------------------------------------

interface CacheEntry {
  expiresAt: number;
  quotes: RateQuote[];
}

const cache = new Map<string, CacheEntry>();

/** Очищення кешу тарифів (тести; зміна налаштувань перевізника). */
export function clearCheckoutRatesCache(): void {
  cache.clear();
}

export function checkoutRatesCacheSize(): number {
  return cache.size;
}

function cacheGet(key: string, nowMs: number): RateQuote[] | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= nowMs) {
    cache.delete(key);
    return null;
  }
  return structuredClone(entry.quotes);
}

function cacheSet(key: string, quotes: RateQuote[], nowMs: number): void {
  cache.delete(key);
  while (cache.size >= CHECKOUT_RATES_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
  cache.set(key, { expiresAt: nowMs + CHECKOUT_RATES_CACHE_TTL_MS, quotes: structuredClone(quotes) });
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toUpperCase().replace(/\s+/g, " ");

/** Ключ — SHA-256 (у пам'яті не зберігаються адреси у відкритому вигляді). */
function cacheKey(carrier: CarrierAdapter, req: RateRequest): string {
  const parcel = req.parcels[0];
  const bucket = parcel ? Math.ceil(parcel.chargeableWeightGrams / RATE_WEIGHT_STEP_GRAMS) * RATE_WEIGHT_STEP_GRAMS : 0;
  const parts = [
    "v1",
    carrier.code,
    carrier.mode,
    norm(req.origin.countryCode),
    norm(req.origin.city),
    norm(req.origin.postalCode),
    norm(req.destination.countryCode),
    norm(req.destination.postalCode),
    norm(req.destination.city),
    norm(req.destination.province),
    parcel ? `${parcel.packageCode}:${parcel.lengthCm}x${parcel.widthCm}x${parcel.heightCm}:${parcel.actualWeightGrams}` : "",
    bucket,
    req.declaredValue.amount,
    req.declaredValue.currency,
    req.incoterm ?? "",
  ];
  return createHash("sha256").update(JSON.stringify(parts)).digest("base64url");
}

// ---------------------------------------------------------------------------
// Спільний конвеєр (Checkout і тестовий розрахунок власника)
// ---------------------------------------------------------------------------

export interface CheckoutRatesDeps {
  db: DbOrTx;
  carriers: CarrierRegistry;
  now: () => Date;
  timeoutMs?: number;
}

interface PipelineItem {
  weightGrams: number;
  quantity: number;
  unitValue: Money;
  hsCode: string | null;
}

interface PipelineInput {
  destination: CarrierAddress;
  items: PipelineItem[];
  declaredValue: Money;
}

type QuoteOutcome =
  | { kind: "no_rates_carrier" }
  | { kind: "origin_not_configured"; carrier: CarrierAdapter }
  | { kind: "invalid_weight"; carrier: CarrierAdapter }
  | { kind: "carrier_error"; carrier: CarrierAdapter; parcel: ParcelSpec; timedOut: boolean; errorKind: CarrierErrorKind | "timeout" | "unexpected" }
  | { kind: "quoted"; carrier: CarrierAdapter; parcel: ParcelSpec; quotes: RateQuote[]; cached: boolean };

/** Перевізник за замовчуванням, якщо він уміє рахувати тарифи. */
export function ratesCarrier(registry: CarrierRegistry): CarrierAdapter | null {
  const carrier = registry.getDefault();
  if (!carrier || !carrier.capabilities.rates || typeof carrier.quoteRates !== "function") return null;
  return carrier;
}

function buildParcel(settings: AllSettings, items: PipelineItem[]): ParcelSpec {
  const { packaging } = settings;
  const pkg = packaging.packages.find((p) => p.code === packaging.defaultPackageCode) ?? packaging.packages[0];
  if (!pkg) throw new RangeError("no packages configured");
  // RangeError — від'ємна/нецілочисельна/надто велика вага.
  const w = computeParcelWeights({
    items: items.map((i) => ({ weightGrams: i.weightGrams, quantity: i.quantity })),
    pkg,
    volumetricDivisor: packaging.volumetricDivisor,
  });
  const actual = Math.ceil(w.actualWeightGrams / RATE_WEIGHT_STEP_GRAMS) * RATE_WEIGHT_STEP_GRAMS;
  return {
    packageCode: pkg.code,
    lengthCm: pkg.lengthCm,
    widthCm: pkg.widthCm,
    heightCm: pkg.heightCm,
    actualWeightGrams: actual,
    volumetricWeightGrams: w.volumetricWeightGrams,
    chargeableWeightGrams: Math.max(actual, w.volumetricWeightGrams),
  };
}

function originFromSettings(settings: AllSettings): CarrierAddress | null {
  const s = settings.shipper;
  if (!/^[A-Z]{2}$/.test(s.countryCode)) return null;
  return {
    countryCode: s.countryCode,
    city: s.city,
    postalCode: s.postalCode || null,
    province: null,
    address1: s.address1,
    address2: s.address2 || null,
  };
}

class CarrierTimeoutError extends Error {
  constructor() {
    super("carrier rate request timed out");
    this.name = "CarrierTimeoutError";
  }
}

/**
 * Виклик із AbortSignal.timeout. Навіть якщо адаптер ігнорує сигнал, відповідь не чекає довше за тайм-аут.
 */
async function callWithTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<{ value: T } | { error: unknown; timedOut: boolean }> {
  const signal = AbortSignal.timeout(ms);
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new CarrierTimeoutError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return { value: await Promise.race([fn(signal), aborted]) };
  } catch (error) {
    return { error, timedOut: signal.aborted };
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function runQuote(
  deps: CheckoutRatesDeps,
  settings: AllSettings,
  input: PipelineInput,
  opts: { useCache: boolean },
): Promise<QuoteOutcome> {
  const carrier = ratesCarrier(deps.carriers);
  if (!carrier) return { kind: "no_rates_carrier" };
  const origin = originFromSettings(settings);
  if (!origin) return { kind: "origin_not_configured", carrier };

  let parcel: ParcelSpec;
  try {
    parcel = buildParcel(settings, input.items);
  } catch (e) {
    if (e instanceof RangeError) return { kind: "invalid_weight", carrier };
    throw e;
  }

  const items: RateItem[] = input.items.map((i) => ({
    hsCode: i.hsCode,
    quantity: i.quantity,
    unitValue: i.unitValue,
    weightGrams: i.weightGrams,
  }));
  const request: RateRequest = {
    origin,
    destination: input.destination,
    parcels: [parcel],
    declaredValue: input.declaredValue,
    items,
    incoterm: settings.customs.incoterm,
  };

  const key = cacheKey(carrier, request);
  if (opts.useCache) {
    const hit = cacheGet(key, deps.now().getTime());
    if (hit) return { kind: "quoted", carrier, parcel, quotes: hit, cached: true };
  }

  const quoteRates = carrier.quoteRates!.bind(carrier);
  const result = await callWithTimeout((signal) => quoteRates(request, { signal }), deps.timeoutMs ?? CHECKOUT_RATES_TIMEOUT_MS);
  if ("error" in result) {
    const errorKind = result.timedOut ? "timeout" : result.error instanceof CarrierError ? result.error.kind : "unexpected";
    if (errorKind === "unexpected") logger.warn("checkout_rates.carrier_unexpected_error", { carrier: carrier.code, error: result.error });
    return { kind: "carrier_error", carrier, parcel, timedOut: result.timedOut, errorKind };
  }
  const quotes = Array.isArray(result.value) ? result.value : [];
  // Помилки не кешуються; успішна відповідь (зокрема порожня) — так.
  if (opts.useCache) cacheSet(key, quotes, deps.now().getTime());
  return { kind: "quoted", carrier, parcel, quotes, cached: false };
}

interface PricedQuote {
  quote: RateQuote;
  pricing: PricingResult;
  serviceCode: string;
}

function priceQuotes(carrier: CarrierAdapter, quotes: RateQuote[], currency: string, settings: AllSettings): PricedQuote[] {
  return quotes.map((quote) => ({
    quote,
    serviceCode: shopifyServiceCode(carrier.code, quote.serviceCode),
    pricing: priceCheckoutRate(quote.price, currency, settings.checkoutRates, {
      // Таблиця курсів задана у валюті тарифів перевізника (опис налаштування: «скільки одиниць валюти перевізника (UAH)»).
      // Поки єдиний перевізник із тарифами — Nova Post, тож база = novaPost.tariffCurrency.
      fxBaseCurrency: settings.novaPost.tariffCurrency,
    }),
  }));
}

/** Тарифи для Shopify: лише розраховані; однаковий service_code → найдешевший; сортування за ціною. */
function toShopifyRates(carrier: CarrierAdapter, priced: PricedQuote[], settings: AllSettings): ShopifyRate[] {
  const byCode = new Map<string, { quote: RateQuote; cents: bigint; currency: string }>();
  for (const p of priced) {
    if (!p.pricing.ok) continue;
    const existing = byCode.get(p.serviceCode);
    if (!existing || p.pricing.price.cents < existing.cents) {
      byCode.set(p.serviceCode, { quote: p.quote, cents: p.pricing.price.cents, currency: p.pricing.price.currency });
    }
  }
  const entries = [...byCode.entries()].sort((a, b) => (a[1].cents < b[1].cents ? -1 : a[1].cents > b[1].cents ? 1 : 0));
  const customName = settings.checkoutRates.serviceName.trim();
  return entries.map(([serviceCode, { quote, cents, currency }]) => {
    const quoteName = quote.serviceName.trim();
    // Власна назва з налаштувань; якщо тарифів кілька — додаємо назву послуги, щоб клієнт бачив різницю.
    const serviceName = customName
      ? entries.length > 1 && quoteName
        ? `${customName} — ${quoteName}`
        : customName
      : quoteName || carrier.displayName;
    const description = quoteName ? `${carrier.displayName} · ${quoteName}` : carrier.displayName;
    return {
      service_name: serviceName.slice(0, 120),
      description: description.slice(0, 200),
      service_code: serviceCode,
      currency,
      total_price: shopifyTotalPrice(cents),
    };
  });
}

// ---------------------------------------------------------------------------
// Checkout (callback Shopify)
// ---------------------------------------------------------------------------

export type CheckoutRatesOutcome =
  | "ok"
  | "disabled"
  | "no_destination"
  | "no_shippable_items"
  | "missing_weight"
  | "invalid_weight"
  | "origin_not_configured"
  | "no_rates_carrier"
  | "carrier_error"
  | "carrier_timeout"
  | "no_quotes"
  | "no_priced_quotes"
  | "internal_error";

const variantGid = (id: string | null): string | null => {
  if (!id) return null;
  if (/^\d{1,20}$/.test(id)) return `gid://shopify/ProductVariant/${id}`;
  if (/^gid:\/\/shopify\/ProductVariant\/\d{1,20}$/.test(id)) return id;
  return null;
};

const isShippable = (item: ShopifyRateItem) => item.requires_shipping !== false;

/**
 * Розрахунок тарифів для callback Shopify. Ніколи не кидає: внутрішня помилка → 503 (резервні тарифи Shopify).
 */
export async function computeCheckoutRates(deps: CheckoutRatesDeps, request: ShopifyRateRequest): Promise<CheckoutRatesResponse> {
  const started = deps.now().getTime();
  const rate = request.rate;
  const shippable = rate.items.filter(isShippable);
  const log: Record<string, unknown> = {
    destinationCountry: norm(rate.destination.country).slice(0, 2) || null,
    currency: rate.currency,
    itemCount: rate.items.length,
    shippableCount: shippable.length,
  };
  const finish = (outcome: CheckoutRatesOutcome, status: 200 | 503, rates: ShopifyRate[] = []): CheckoutRatesResponse => {
    logger.info("checkout_rates.request", {
      ...log,
      outcome,
      status,
      rateCount: rates.length,
      latencyMs: Math.max(0, deps.now().getTime() - started),
    });
    return { status, body: { rates } };
  };

  try {
    const settings = await getSettings(deps.db);
    if (!settings.checkoutRates.enabled) return finish("disabled", 200);

    const country = norm(rate.destination.country);
    if (!/^[A-Z]{2}$/.test(country)) return finish("no_destination", 200);
    if (shippable.length === 0) return finish("no_shippable_items", 200);

    // Вага: grams за одиницю (SHOPIFY_ITEM_GRAMS_ARE_PER_UNIT); 0/відсутня → вага варіанта з нашої бази.
    const gids = [...new Set(shippable.map((i) => variantGid(i.variant_id)).filter((g): g is string => g !== null))];
    const dbVariants = gids.length
      ? await deps.db
          .select({ gid: productVariants.shopifyVariantId, weightGrams: productVariants.weightGrams, hsCode: productVariants.hsCode })
          .from(productVariants)
          .where(inArray(productVariants.shopifyVariantId, gids))
      : [];
    const byGid = new Map(dbVariants.map((v) => [v.gid!, v]));

    let missingWeight = 0;
    let fromDb = 0;
    const items: PipelineItem[] = [];
    for (const item of shippable) {
      const gid = variantGid(item.variant_id);
      const stored = gid ? byGid.get(gid) : undefined;
      const grams = item.grams ?? 0;
      let unitGrams = 0;
      if (grams > 0) {
        unitGrams = SHOPIFY_ITEM_GRAMS_ARE_PER_UNIT ? grams : Math.ceil(grams / Math.max(1, item.quantity));
      } else if (stored?.weightGrams && stored.weightGrams > 0) {
        // Вага варіанта в нашій базі — завжди за одиницю.
        unitGrams = stored.weightGrams;
        fromDb += 1;
      }
      if (unitGrams <= 0) {
        missingWeight += 1;
        continue;
      }
      items.push({
        weightGrams: unitGrams,
        quantity: item.quantity,
        unitValue: { amount: subunitsToDecimal(BigInt(item.price ?? 0), rate.currency), currency: rate.currency },
        hsCode: stored?.hsCode ?? null,
      });
    }
    log.weightFromDb = fromDb;
    if (missingWeight > 0) {
      log.missingWeightItems = missingWeight;
      return finish("missing_weight", 200);
    }

    // Оголошена вартість: order_totals.total_price (лише коли Shopify має підсумки кошика) або Σ ціна × кількість.
    const totalSubunits =
      rate.order_totals?.total_price !== null && rate.order_totals?.total_price !== undefined
        ? BigInt(rate.order_totals.total_price)
        : shippable.reduce((acc, i) => acc + BigInt(i.price ?? 0) * BigInt(i.quantity), 0n);
    const declaredValue: Money = { amount: subunitsToDecimal(totalSubunits, rate.currency), currency: rate.currency };

    const destination: CarrierAddress = {
      countryCode: country,
      city: (rate.destination.city ?? "").trim(),
      postalCode: (rate.destination.postal_code ?? rate.destination.zip ?? "").trim() || null,
      province: (rate.destination.province ?? "").trim() || null,
      address1: (rate.destination.address1 ?? "").trim(),
      address2: (rate.destination.address2 ?? "").trim() || null,
    };

    const outcome = await runQuote(deps, settings, { destination, items, declaredValue }, { useCache: true });
    if (outcome.kind !== "no_rates_carrier") log.carrier = outcome.carrier.code;
    switch (outcome.kind) {
      case "no_rates_carrier":
        return finish("no_rates_carrier", 200);
      case "origin_not_configured":
        return finish("origin_not_configured", 200);
      case "invalid_weight":
        return finish("invalid_weight", 200);
      case "carrier_error":
        log.weightGrams = outcome.parcel.chargeableWeightGrams;
        log.errorKind = outcome.errorKind;
        return finish(outcome.timedOut ? "carrier_timeout" : "carrier_error", 503);
      case "quoted": {
        log.weightGrams = outcome.parcel.chargeableWeightGrams;
        log.cached = outcome.cached;
        log.quoteCount = outcome.quotes.length;
        if (outcome.quotes.length === 0) return finish("no_quotes", 200);
        const priced = priceQuotes(outcome.carrier, outcome.quotes, rate.currency, settings);
        const failures = priced.filter((p) => !p.pricing.ok).map((p) => (p.pricing.ok ? null : p.pricing.reason));
        if (failures.length) log.unpricedReasons = [...new Set(failures)];
        const rates = toShopifyRates(outcome.carrier, priced, settings);
        return rates.length ? finish("ok", 200, rates) : finish("no_priced_quotes", 200);
      }
    }
  } catch (error) {
    logger.error("checkout_rates.failed", { error });
    return finish("internal_error", 503);
  }
}

// ---------------------------------------------------------------------------
// Тестовий розрахунок власника (налаштування)
// ---------------------------------------------------------------------------

export const previewInputSchema = z.object({
  countryCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/),
  postalCode: z.string().trim().max(20).default(""),
  city: z.string().trim().max(120).default(""),
  province: z.string().trim().max(120).default(""),
  /** Вага товарів (без тари) — тара й об'ємна вага додаються з налаштувань пакування, як у Checkout. */
  weightGrams: z.number().int().min(1).max(1_000_000),
  /** Вартість товарів (оголошена вартість) у валюті `currency`. */
  value: z
    .string()
    .trim()
    .regex(/^\d{1,9}(\.\d{1,2})?$/),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/),
});

export type CheckoutRatesPreviewInput = z.input<typeof previewInputSchema>;

export type PreviewReason =
  | "no_rates_carrier"
  | "origin_not_configured"
  | "invalid_weight"
  | "carrier_error"
  | "carrier_timeout"
  | "no_quotes"
  | "no_priced_quotes";

export interface PreviewQuote {
  serviceCode: string;
  serviceName: string;
  /** service_code, який отримає Shopify. */
  shopifyServiceCode: string;
  carrierPrice: Money;
  /** Ціна перевізника у валюті кошика до націнки й округлення. */
  convertedPrice: Money | null;
  /** Ціна в Checkout (з націнкою й округленням). */
  checkoutPrice: Money | null;
  failure: PricingFailure | null;
  minDeliveryDays: number | null;
  maxDeliveryDays: number | null;
  estimatedDeliveryDate: string | null;
}

export interface CheckoutRatesPreview {
  /** Поточний стан перемикача (тестовий розрахунок працює і коли вимкнено). */
  enabled: boolean;
  carrier: { code: string; displayName: string; mode: CarrierMode } | null;
  parcel: ParcelSpec | null;
  reason: PreviewReason | null;
  errorKind: CarrierErrorKind | "timeout" | "unexpected" | null;
  quotes: PreviewQuote[];
  /** Саме те, що отримав би Shopify. */
  rates: ShopifyRate[];
}

/**
 * Тестовий розрахунок (лише власник). Той самий конвеєр, що й у Checkout, але без кешу
 * і без перевірки `checkoutRates.enabled` (власник перевіряє до увімкнення). Некоректні дані → ZodError.
 */
export async function previewCheckoutRates(
  ctx: ServiceContext,
  input: CheckoutRatesPreviewInput,
  opts: { timeoutMs?: number } = {},
): Promise<CheckoutRatesPreview> {
  requirePermission(ctx.actor, "settings.manage");
  const data = previewInputSchema.parse(input);
  const settings = await getSettings(ctx.db);
  const deps: CheckoutRatesDeps = { db: ctx.db, carriers: ctx.carriers, now: ctx.now, timeoutMs: opts.timeoutMs };
  const value = fromMinor(toMinor(data.value));
  const outcome = await runQuote(
    deps,
    settings,
    {
      destination: {
        countryCode: data.countryCode,
        city: data.city,
        postalCode: data.postalCode || null,
        province: data.province || null,
        address1: "",
        address2: null,
      },
      items: [{ weightGrams: data.weightGrams, quantity: 1, unitValue: { amount: value, currency: data.currency }, hsCode: null }],
      declaredValue: { amount: value, currency: data.currency },
    },
    { useCache: false },
  );

  const base: CheckoutRatesPreview = {
    enabled: settings.checkoutRates.enabled,
    carrier: null,
    parcel: null,
    reason: null,
    errorKind: null,
    quotes: [],
    rates: [],
  };
  if (outcome.kind === "no_rates_carrier") return { ...base, reason: "no_rates_carrier" };
  const carrier = { code: outcome.carrier.code, displayName: outcome.carrier.displayName, mode: outcome.carrier.mode };
  let result: CheckoutRatesPreview;
  switch (outcome.kind) {
    case "origin_not_configured":
    case "invalid_weight":
      result = { ...base, carrier, reason: outcome.kind };
      break;
    case "carrier_error":
      result = {
        ...base,
        carrier,
        parcel: outcome.parcel,
        reason: outcome.timedOut ? "carrier_timeout" : "carrier_error",
        errorKind: outcome.errorKind,
      };
      break;
    case "quoted": {
      const priced = priceQuotes(outcome.carrier, outcome.quotes, data.currency, settings);
      const quotes: PreviewQuote[] = priced.map((p) => ({
        serviceCode: p.quote.serviceCode,
        serviceName: p.quote.serviceName,
        shopifyServiceCode: p.serviceCode,
        carrierPrice: p.quote.price,
        convertedPrice: p.pricing.ok ? { amount: p.pricing.price.convertedAmount, currency: p.pricing.price.currency } : null,
        checkoutPrice: p.pricing.ok ? { amount: p.pricing.price.amount, currency: p.pricing.price.currency } : null,
        failure: p.pricing.ok ? null : p.pricing.reason,
        minDeliveryDays: p.quote.minDeliveryDays,
        maxDeliveryDays: p.quote.maxDeliveryDays,
        estimatedDeliveryDate: p.quote.estimatedDeliveryDate ?? null,
      }));
      const rates = toShopifyRates(outcome.carrier, priced, settings);
      result = {
        ...base,
        carrier,
        parcel: outcome.parcel,
        quotes,
        rates,
        reason: outcome.quotes.length === 0 ? "no_quotes" : rates.length === 0 ? "no_priced_quotes" : null,
      };
      break;
    }
  }
  logger.info("checkout_rates.preview", {
    destinationCountry: data.countryCode,
    carrier: carrier.code,
    reason: result.reason,
    errorKind: result.errorKind,
    quoteCount: result.quotes.length,
    rateCount: result.rates.length,
  });
  return result;
}
