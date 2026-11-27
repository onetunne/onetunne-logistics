/**
 * Аналітика складу — чисті функції (без БД і React): періоди за датами Києва, швидкість продажів, днів запасу,
 * дата вичерпання, рекомендації партій, тренд, групування продажів, посилання «Створити партію».
 *
 * Правила (docs/stage5-design.md §7):
 * - продажі — оплачені, не скасовані замовлення; кількість позиції — effectiveLineQuantity (Shopify currentQuantity:
 *   без повернених і видалених одиниць); дата продажу — orders.placed_at за Києвом;
 * - періоди — календарні дні за Києвом включно з сьогоднішнім: «7 днів» = сьогодні й 6 попередніх днів;
 *   попередній період — стільки ж днів безпосередньо перед ним (для тренду);
 * - швидкість: v30 = продано за 30 днів / 30, v90 = продано за 90 днів / 90 (вікна — до сьогодні включно);
 *   зважена v = (2·v30 + v90) / 3 — свіжі продажі важать більше, 90 днів згладжують сплески й «нуль через відсутність»;
 * - днів запасу = доступно / v30; дата вичерпання = сьогодні + ⌊днів запасу⌋ (доступно ≤ 0 → сьогодні);
 * - рекомендація: ⌈v × (термін виробництва + цільовий запас)⌉ − (доступно + у виробництві + заплановано), лише > 0,
 *   угору до кратного «округлення партії». «Заплановано» (партії ще не запущені) теж віднімається: інакше після
 *   створення партії з рекомендації та сама рекомендація з'являлася б знову.
 * Попит рахується точною цілочисельною арифметикою (без похибок float на межах округлення).
 */
import { LIMITS as PRODUCTION_LIMITS } from "~/modules/production/calc";
import { parseIsoDate } from "~/modules/warehouse/dates";

// ---------------------------------------------------------------------------
// Періоди
// ---------------------------------------------------------------------------

export const PERIOD_PRESETS = ["7", "30", "90"] as const;
export const PERIOD_KEYS = [...PERIOD_PRESETS, "custom"] as const;
export type PeriodKey = (typeof PERIOD_KEYS)[number];
export const DEFAULT_PERIOD: PeriodKey = "30";
/** Найдовший довільний період (днів). */
export const MAX_CUSTOM_PERIOD_DAYS = 366;

export function isPeriodKey(value: unknown): value is PeriodKey {
  return typeof value === "string" && (PERIOD_KEYS as readonly string[]).includes(value);
}

export interface ResolvedPeriod {
  key: PeriodKey;
  /** Перший день (YYYY-MM-DD, Київ), включно. */
  from: string;
  /** Останній день (YYYY-MM-DD, Київ), включно. */
  to: string;
  days: number;
  /** Попередній період такої самої довжини (для тренду). */
  previousFrom: string;
  previousTo: string;
  /** true — довільні дати некоректні (порядок, формат, понад MAX_CUSTOM_PERIOD_DAYS) → період за замовчуванням. */
  invalid: boolean;
}

const DAY_MS = 86_400_000;

function isoToUtcMs(iso: string): number {
  const valid = parseIsoDate(iso);
  if (!valid) throw new RangeError("invalid date");
  return Date.UTC(Number(valid.slice(0, 4)), Number(valid.slice(5, 7)) - 1, Number(valid.slice(8, 10)));
}

/** Календарна дата + n днів (YYYY-MM-DD; без часових поясів — лише календар). */
export function addDays(iso: string, n: number): string {
  if (!Number.isSafeInteger(n)) throw new RangeError("invalid day offset");
  return new Date(isoToUtcMs(iso) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Кількість днів від from до to включно (from ≤ to → ≥ 1; інакше ≤ 0). */
export function daysInclusive(from: string, to: string): number {
  return Math.round((isoToUtcMs(to) - isoToUtcMs(from)) / DAY_MS) + 1;
}

function presetPeriod(key: Exclude<PeriodKey, "custom">, today: string, invalid = false): ResolvedPeriod {
  const days = Number(key);
  const from = addDays(today, -(days - 1));
  return { key, from, to: today, days, previousFrom: addDays(from, -days), previousTo: addDays(from, -1), invalid };
}

/**
 * Період аналітики: «7/30/90» — останні N днів до сьогодні включно; «custom» — from…to (включно; майбутнє обрізається
 * сьогоднішнім днем). Некоректний довільний період → 30 днів з invalid = true.
 */
export function resolvePeriod(input: { key?: string | null; from?: string | null; to?: string | null; today: string }): ResolvedPeriod {
  const today = parseIsoDate(input.today);
  if (!today) throw new RangeError("invalid today");
  const key = isPeriodKey(input.key) ? input.key : DEFAULT_PERIOD;
  if (key !== "custom") return presetPeriod(key, today);
  const from = parseIsoDate(input.from);
  const rawTo = parseIsoDate(input.to);
  const to = rawTo && rawTo > today ? today : rawTo;
  if (!from || !to || from > to || daysInclusive(from, to) > MAX_CUSTOM_PERIOD_DAYS) {
    return presetPeriod(DEFAULT_PERIOD as Exclude<PeriodKey, "custom">, today, true);
  }
  const days = daysInclusive(from, to);
  return { key, from, to, days, previousFrom: addDays(from, -days), previousTo: addDays(from, -1), invalid: false };
}

// ---------------------------------------------------------------------------
// Швидкість продажів
// ---------------------------------------------------------------------------

export const VELOCITY_SHORT_DAYS = 30;
export const VELOCITY_LONG_DAYS = 90;
/** Ваги зваженої швидкості: (2·v30 + 1·v90) / 3. */
export const VELOCITY_WEIGHT_SHORT = 2;
export const VELOCITY_WEIGHT_LONG = 1;

/** Вікна швидкості (YYYY-MM-DD, включно): останні 30 і 90 днів до сьогодні. */
export function velocityWindows(today: string): { short: { from: string; to: string }; long: { from: string; to: string } } {
  return {
    short: { from: addDays(today, -(VELOCITY_SHORT_DAYS - 1)), to: today },
    long: { from: addDays(today, -(VELOCITY_LONG_DAYS - 1)), to: today },
  };
}

export interface VelocityUnits {
  /** Продано за останні 30 днів (шт.). */
  units30: number;
  /** Продано за останні 90 днів (шт., включно з останніми 30). */
  units90: number;
}

const units = (n: number) => (Number.isSafeInteger(n) && n > 0 ? n : 0);

/** Зважена швидкість як дріб num / den (точний попит без float). */
function weightedFraction(u: VelocityUnits): { num: number; den: number } {
  const s = VELOCITY_SHORT_DAYS;
  const l = VELOCITY_LONG_DAYS;
  const ws = VELOCITY_WEIGHT_SHORT;
  const wl = VELOCITY_WEIGHT_LONG;
  return { num: ws * units(u.units30) * l + wl * units(u.units90) * s, den: s * l * (ws + wl) };
}

export function velocity30(u: VelocityUnits): number {
  return units(u.units30) / VELOCITY_SHORT_DAYS;
}

export function velocity90(u: VelocityUnits): number {
  return units(u.units90) / VELOCITY_LONG_DAYS;
}

/** Зважена швидкість (шт./день): (2·v30 + v90) / 3. */
export function weightedVelocity(u: VelocityUnits): number {
  const { num, den } = weightedFraction(u);
  return num / den;
}

/** Попит за days днів за зваженою швидкістю, округлений угору до цілих штук. */
export function demandForDays(u: VelocityUnits, days: number): number {
  if (!Number.isSafeInteger(days) || days <= 0) return 0;
  const { num, den } = weightedFraction(u);
  return Math.floor((num * days + den - 1) / den);
}

/** Округлення вгору до кратного step (step ≥ 1). */
export function roundUpTo(value: number, step: number): number {
  const s = Number.isSafeInteger(step) && step >= 1 ? step : 1;
  if (value <= 0) return 0;
  return Math.ceil(value / s) * s;
}

// ---------------------------------------------------------------------------
// Прогноз позиції: днів запасу, дата вичерпання, ризик, рекомендація партії
// ---------------------------------------------------------------------------

export interface ForecastSettings {
  /** Термін виробництва партії, днів (warehouse.productionLeadDays). */
  productionLeadDays: number;
  /** Цільовий запас після надходження, днів продажів (warehouse.targetCoverDays). */
  targetCoverDays: number;
  /** Округлення рекомендованої кількості вгору до кратного (warehouse.batchRounding). */
  batchRounding: number;
}

export interface ForecastInput extends VelocityUnits {
  /** Доступно для продажу (on_hand − reserved; може бути < 0, якщо продано більше, ніж є). */
  available: number;
  /** Кошик «У виробництві» (запущені партії). */
  inProduction: number;
  /** Заплановано в ще не запущених партіях. */
  planned: number;
}

/** out — немає доступних, а попит є; critical — закінчиться раніше, ніж встигне нова партія; none — ні. */
export type RiskLevel = "out" | "critical" | "none";

export interface Recommendation {
  /** Горизонт планування: термін виробництва + цільовий запас (днів). */
  horizonDays: number;
  /** ⌈зважена швидкість × горизонт⌉ (шт.). */
  demand: number;
  available: number;
  inProduction: number;
  planned: number;
  /** available + inProduction + planned. */
  supply: number;
  /** demand − supply (може бути ≤ 0 — тоді партія не потрібна). */
  shortfall: number;
  /** Округлення партії (шт.). */
  rounding: number;
  /** Рекомендовано виготовити (кратне rounding; 0 — не потрібно). */
  quantity: number;
}

export interface Forecast {
  velocity30: number;
  velocity90: number;
  /** Зважена швидкість (шт./день). */
  velocity: number;
  /** Днів запасу = доступно / v30 (униз до 0,1); null — продажів за 30 днів немає, а доступні є. */
  coverDays: number | null;
  /** Прогнозована дата вичерпання (YYYY-MM-DD); null — продажів за 30 днів немає, а доступні є. */
  stockOutDate: string | null;
  risk: RiskLevel;
  recommendation: Recommendation;
}

/** Рекомендація партії (див. заголовок файлу). */
export function recommendBatch(input: ForecastInput, settings: ForecastSettings): Recommendation {
  const horizonDays = Math.max(0, Math.trunc(settings.productionLeadDays)) + Math.max(0, Math.trunc(settings.targetCoverDays));
  const demand = demandForDays(input, horizonDays);
  const inProduction = Math.max(0, Math.trunc(input.inProduction));
  const planned = Math.max(0, Math.trunc(input.planned));
  const available = Math.trunc(input.available);
  const supply = available + inProduction + planned;
  const shortfall = demand - supply;
  const rounding = Number.isSafeInteger(settings.batchRounding) && settings.batchRounding >= 1 ? settings.batchRounding : 1;
  return { horizonDays, demand, available, inProduction, planned, supply, shortfall, rounding, quantity: shortfall > 0 ? roundUpTo(shortfall, rounding) : 0 };
}

/** Повний прогноз позиції на сьогодні (today — YYYY-MM-DD за Києвом). */
export function forecastItem(input: ForecastInput, settings: ForecastSettings, today: string): Forecast {
  const u30 = units(input.units30);
  const u90 = units(input.units90);
  const available = Math.trunc(input.available);
  const velocity = weightedVelocity(input);
  let coverDays: number | null;
  let stockOutDate: string | null;
  if (available <= 0) {
    coverDays = 0;
    stockOutDate = today;
  } else if (u30 === 0) {
    coverDays = null;
    stockOutDate = null;
  } else {
    // Цілочисельно: available / (u30 / 30) = available·30 / u30.
    const whole = Math.floor((available * VELOCITY_SHORT_DAYS) / u30);
    coverDays = Math.floor((available * VELOCITY_SHORT_DAYS * 10) / u30) / 10;
    stockOutDate = addDays(today, whole);
  }
  const hasDemand = u30 > 0 || u90 > 0;
  let risk: RiskLevel = "none";
  if (available <= 0) risk = hasDemand ? "out" : "none";
  else if (coverDays !== null && Math.floor(coverDays) < settings.productionLeadDays) risk = "critical";
  return {
    velocity30: velocity30(input),
    velocity90: velocity90(input),
    velocity,
    coverDays,
    stockOutDate,
    risk,
    recommendation: recommendBatch(input, settings),
  };
}

// ---------------------------------------------------------------------------
// Тренд
// ---------------------------------------------------------------------------

/** up/down/flat — порівняно з попереднім періодом; new — раніше продажів не було; none — продажів немає взагалі. */
export type TrendDirection = "up" | "down" | "flat" | "new" | "none";

export interface Trend {
  current: number;
  previous: number;
  direction: TrendDirection;
  /** Зміна у %, ціле; null для new/none. */
  percent: number | null;
}

export function trendOf(current: number, previous: number): Trend {
  const c = units(current);
  const p = units(previous);
  if (c === 0 && p === 0) return { current: c, previous: p, direction: "none", percent: null };
  if (p === 0) return { current: c, previous: p, direction: "new", percent: null };
  const percent = Math.round(((c - p) * 100) / p);
  return { current: c, previous: p, direction: c > p ? "up" : c < p ? "down" : "flat", percent };
}

// ---------------------------------------------------------------------------
// Групування продажів (топ товарів / кольорів / моделей)
// ---------------------------------------------------------------------------

export interface SalesLine {
  variantId: string;
  productId: string;
  productTitle: string;
  model: string | null;
  color: string | null;
  imageUrl: string | null;
  /** Продано за період. */
  units: number;
  /** Продано за попередній період. */
  previousUnits: number;
}

export type SalesGroupBy = "product" | "color" | "model";

export interface SalesGroup {
  /** productId, колір або модель; "" — без кольору/моделі. */
  key: string;
  /** Назва товару / колір / модель; null — не вказано. */
  label: string | null;
  units: number;
  previousUnits: number;
  /** Частка від усіх продажів періоду, % (ціле). */
  sharePercent: number;
  /** Варіантів із продажами в групі. */
  variants: number;
  trend: Trend;
  /** Зображення товару (лише group by product). */
  imageUrl: string | null;
}

/** Групує продажі за товаром/кольором/моделлю; лише групи з продажами в періоді; за спаданням кількості. */
export function groupSales(lines: readonly SalesLine[], by: SalesGroupBy, limit?: number): SalesGroup[] {
  const total = lines.reduce((s, l) => s + units(l.units), 0);
  const groups = new Map<string, Omit<SalesGroup, "sharePercent" | "trend">>();
  for (const l of lines) {
    const rawKey = by === "product" ? l.productId : by === "color" ? (l.color ?? "").trim() : (l.model ?? "").trim();
    const label = by === "product" ? l.productTitle : rawKey || null;
    const g = groups.get(rawKey) ?? { key: rawKey, label, units: 0, previousUnits: 0, variants: 0, imageUrl: by === "product" ? l.imageUrl : null };
    g.units += units(l.units);
    g.previousUnits += units(l.previousUnits);
    if (units(l.units) > 0) g.variants += 1;
    if (by === "product" && !g.imageUrl && l.imageUrl) g.imageUrl = l.imageUrl;
    groups.set(rawKey, g);
  }
  const out = [...groups.values()]
    .filter((g) => g.units > 0)
    .map((g) => ({ ...g, sharePercent: total > 0 ? Math.round((g.units * 100) / total) : 0, trend: trendOf(g.units, g.previousUnits) }))
    .sort((a, b) => b.units - a.units || (a.label ?? "").localeCompare(b.label ?? "") || a.key.localeCompare(b.key));
  return limit !== undefined ? out.slice(0, Math.max(0, limit)) : out;
}

// ---------------------------------------------------------------------------
// «Створити партію» з рекомендацій (посилання на форму партії)
// ---------------------------------------------------------------------------

/** Форма партії приймає щонайбільше 20 вибраних товарів (production-batch.tsx, MAX_SELECTED_PRODUCTS). */
export const PREFILL_MAX_PRODUCTS = 20;

export interface PrefillItem {
  productId: string;
  variantId: string;
  quantity: number;
}

export interface ProductionPrefill {
  /** Рядок запиту для /production/new: ?product=<id>…&qty.<variantId>=<кількість>… */
  search: string;
  products: number;
  variants: number;
  units: number;
  /** true — частину товарів не включено (понад PREFILL_MAX_PRODUCTS). */
  truncated: boolean;
}

/**
 * Посилання на створення партії з рекомендованими позиціями: `product` — товари для сітки форми (форма вже вміє),
 * `qty.<variantId>` — рекомендовані кількості (ті самі імена, що й поля форми партії). Нічого не створює — людина
 * перевіряє й зберігає партію сама.
 * УВАГА: форма партії (pages/production-batch.tsx) поки НЕ заповнює кількості з `qty.*` — лише вибирає товари;
 * для заповнення її loader має викликати parseProductionPrefill (нижче). Тому підписи кнопок не обіцяють кількостей.
 */
export function productionPrefill(items: readonly PrefillItem[]): ProductionPrefill {
  const params = new URLSearchParams();
  const products: string[] = [];
  let variants = 0;
  let total = 0;
  let truncated = false;
  const seen = new Set<string>();
  for (const item of items) {
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0 || seen.has(item.variantId)) continue;
    if (!products.includes(item.productId)) {
      if (products.length >= PREFILL_MAX_PRODUCTS) {
        truncated = true;
        continue;
      }
      products.push(item.productId);
      params.append("product", item.productId);
    }
    seen.add(item.variantId);
    params.append(`qty.${item.variantId}`, String(item.quantity));
    variants += 1;
    total += item.quantity;
  }
  const s = params.toString();
  return { search: s ? `?${s}` : "", products: products.length, variants, units: total, truncated };
}

const PREFILL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Зворотне до productionPrefill — для loader форми нової партії: `qty.<variantId>=<n>` → { variantId: n }.
 * Беруться лише UUID-варіанти (з `allowedVariantIds`, якщо задано — напр. варіанти завантаженої сітки), цілі
 * 1…max (лише цифри); решта мовчки ігнорується (це підказка, а не дані: людина все одно перевіряє й зберігає форму).
 * Повтор того самого варіанта — перше значення. Не більше PRODUCTION_LIMITS.lines позицій.
 */
export function parseProductionPrefill(
  params: URLSearchParams,
  opts: { allowedVariantIds?: Iterable<string>; max?: number } = {},
): Record<string, number> {
  const allowed = opts.allowedVariantIds ? new Set([...opts.allowedVariantIds].map((id) => id.toLowerCase())) : null;
  const max = opts.max ?? PRODUCTION_LIMITS.quantity;
  const out: Record<string, number> = {};
  let count = 0;
  for (const [key, raw] of params) {
    if (count >= PRODUCTION_LIMITS.lines) break;
    if (!key.startsWith("qty.")) continue;
    const variantId = key.slice(4).toLowerCase();
    if (!PREFILL_UUID_RE.test(variantId) || (allowed && !allowed.has(variantId)) || variantId in out) continue;
    const value = raw.trim();
    if (!/^\d{1,9}$/.test(value)) continue;
    const n = Number(value);
    if (n < 1 || n > max) continue;
    out[variantId] = n;
    count += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Відображення
// ---------------------------------------------------------------------------

/** Округлення до digits знаків для показу/CSV (не для розрахунків). */
export function roundTo(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
