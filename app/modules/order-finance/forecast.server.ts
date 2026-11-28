/**
 * Етап 6, WP4: ВНУТРІШНІ прогнози для syncOrderFinance (docs/stage6-design.md §4, §7.1, §7.7) — без перевірки актора, з
 * сумами (F8: сторінки не імпортують; модуль — у запиті до реєстру INTERNAL_ONLY_MODULES ядра). Прогнози НІКОЛИ не
 * пишуться в журнал (order_finance_forecasts / shipping_forecast_snapshots).
 *
 * Доставка — ланцюжок основ (§7.1): 1) `carrier_reported` — розрахунок перевізника при створенні накладної
 * (shipment_cost_estimates); 2) `country_average` — середня фактична до країни за `historyDays` (типово 90) днів
 * до дати, щонайменше `minSamples` (типово 3) накладні з фактом, у валюті звітності; 3) `owner_table` — таблиця власника
 * `finance.shippingForecast.byCountry`; інакше `none` (сума null). Під час визнання прогноз, чинний на той момент,
 * ЗАМОРОЖУЄТЬСЯ для кожної накладної замовлення (і рядком `order` для замовлення без накладної) — лише вставка; він
 * не перераховується й саме він — прогноз «≈» і «прогноз vs факт» (§7.7). Накладна, додана після визнання, отримує
 * знімок у момент додавання (`late_snapshot`).
 *
 * Собівартість і упаковка — прогноз одиниці WP2 (unitCostForecast: середня пулу → непідтверджена ручна → остання партія /
 * каталожна ціна матеріалу) × кількість; шаблон комплектації (resolveKitMaterials) × прогноз матеріалу.
 */
import { and, eq, gte, inArray, isNull, lt, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DbOrTx, Tx } from "~/db/client.server";
import { financeEntries, orderFinance, packagingMaterials, shippingForecastSnapshots, stockItems } from "~/db/schema";
import type { FinanceBasis, ShippingForecastBasis } from "~/domain/finance";
import { assertSupportedCurrency, fromMinor, isSupportedCurrency, mulDivHalfAwayFromZero, toMinorForCurrency } from "~/lib/decimal";
import { addDays } from "~/lib/periods";
import { unitCostForecast } from "~/modules/costing/forecast.server";
import { DEFAULT_STORE_ID } from "~/modules/finance/core/store.server";
import { sumConverted } from "~/modules/fx/convert";
import { createRateResolver, rateWindowOf } from "~/modules/fx/rate-for.server";
import { resolveKitMaterials } from "~/modules/packaging/kits.server";
import type { FinanceSettings } from "~/modules/settings/schema";
import type { AppMode } from "~/server/types";
import type { Money } from "./components";

export interface ShippingForecast {
  basis: ShippingForecastBasis;
  amount: string | null;
  currency: string | null;
  details: Record<string, string | number | boolean | null>;
}

const NONE: ShippingForecast = { basis: "none", amount: null, currency: null, details: {} };

/** Типи нарахувань «вартості відправлення» для середньої (§7.7): без повернень, зберігання й мита. */
export const SHIPMENT_COST_CHARGE_TYPES = ["delivery", "additional_service", "insurance", "other", "credit"] as const;

const reversals = alias(financeEntries, "of_fc_rev");

/**
 * Середня фактична вартість накладної до країни за вікно [date − historyDays, date) за датою визнання замовлення
 * (§7.7): Σ фактичних записів рахунків (типи вартості відправлення) накладної у валюті звітності (кожен запис — за
 * курсом свого fx_on) / кількість накладних; менше minSamples або без курсу для всіх — null.
 */
export async function countryAverageForecast(
  db: DbOrTx,
  input: { country: string; date: string; settings: FinanceSettings; mode: AppMode },
): Promise<ShippingForecast | null> {
  const { historyDays, minSamples } = input.settings.shippingForecast;
  const from = addDays(input.date, -historyDays);
  const reporting = input.settings.reportingCurrency;
  const rows = await db
    .select({
      orderId: financeEntries.orderId,
      amount: financeEntries.amount,
      currency: financeEntries.currency,
      fxOn: financeEntries.fxOn,
      waybillKey: sql<string | null>`${financeEntries.details} ->> 'waybillKey'`,
    })
    .from(financeEntries)
    .innerJoin(orderFinance, eq(orderFinance.orderId, financeEntries.orderId))
    .where(
      and(
        eq(financeEntries.storeId, DEFAULT_STORE_ID),
        eq(financeEntries.category, "shipping_cost"),
        eq(financeEntries.sourceType, "invoice_line"),
        eq(financeEntries.countryCode, input.country),
        isNull(financeEntries.reversesEntryId),
        notExists(db.select({ one: sql`1` }).from(reversals).where(eq(reversals.reversesEntryId, financeEntries.id))),
        sql`${financeEntries.details} ->> 'chargeType' in (${sql.join(SHIPMENT_COST_CHARGE_TYPES.map((t) => sql`${t}`), sql`, `)})`,
        eq(orderFinance.state, "recognized"),
        gte(orderFinance.recognizedOn, from),
        lt(orderFinance.recognizedOn, input.date),
      ),
    );
  const byWaybill = new Map<string, Array<{ amount: string; currency: string; fxOn: string }>>();
  for (const r of rows) {
    if (!r.waybillKey || !r.orderId) continue;
    const k = `${r.orderId}|${r.waybillKey}`;
    byWaybill.set(k, [...(byWaybill.get(k) ?? []), { amount: r.amount, currency: r.currency.trim(), fxOn: r.fxOn }]);
  }
  if (byWaybill.size < minSamples) return null;
  const all = [...byWaybill.values()].flat();
  const window = rateWindowOf(all, [reporting]);
  if (!window) return null;
  const resolver = await createRateResolver(db, window, { mode: input.mode });
  let total = 0n;
  let samples = 0;
  for (const list of byWaybill.values()) {
    const s = sumConverted(list, reporting, (c, d) => resolver.scaled(c, d));
    if (s.total === null || s.unconverted.length > 0) continue;
    // Записи витрат журналу — від'ємні (вплив на прибуток); прогноз знімка — ДОДАТНА вартість, як carrier_reported і
    // owner_table (знак «−» дає components.ts rowsOf(…, −1)). Кредит накладної (додатний запис) зменшує вартість.
    total -= toMinorForCurrency(s.total, reporting);
    samples++;
  }
  if (samples < minSamples) return null;
  // Середня — у сотих; для валют з 0 знаками — цілі одиниці (одне округлення, половина від нуля).
  const quantum = assertSupportedCurrency(reporting) === 0 ? 100n : 1n;
  const rounded = mulDivHalfAwayFromZero(total, 1n, BigInt(samples) * quantum) * quantum;
  // Середня без додатної вартості (лише кредити) — не прогноз вартості доставки.
  if (rounded <= 0n) return null;
  return {
    basis: "country_average",
    amount: fromMinor(rounded),
    currency: reporting,
    details: { country: input.country, windowFrom: from, windowTo: addDays(input.date, -1), samples, historyDays, minSamples },
  };
}

/** Таблиця власника за країнами (прогноз №3). */
export function ownerTableForecast(settings: FinanceSettings, country: string | null): ShippingForecast | null {
  if (!country) return null;
  const row = settings.shippingForecast.byCountry.find((r) => r.country === country);
  return row ? { basis: "owner_table", amount: row.amount, currency: row.currency, details: { country } } : null;
}

/** Ланцюжок прогнозу доставки однієї накладної (або замовлення без накладної — без carrier_reported). */
export async function shippingForecastChain(
  db: DbOrTx,
  input: {
    country: string | null;
    date: string;
    estimate: { amount: string; currency: string; source: string; currencyAssumed: boolean } | null;
    settings: FinanceSettings;
    mode: AppMode;
    /** Кеш середньої за викликом syncOrderFinance (country|date → значення). */
    cache: Map<string, ShippingForecast | null>;
  },
): Promise<ShippingForecast> {
  if (input.estimate && isSupportedCurrency(input.estimate.currency)) {
    return {
      basis: "carrier_reported",
      amount: input.estimate.amount,
      currency: input.estimate.currency,
      details: { source: input.estimate.source, currencyAssumed: input.estimate.currencyAssumed },
    };
  }
  if (input.country) {
    const key = `${input.country}|${input.date}`;
    if (!input.cache.has(key)) input.cache.set(key, await countryAverageForecast(db, { country: input.country, date: input.date, settings: input.settings, mode: input.mode }));
    const avg = input.cache.get(key);
    if (avg) return avg;
  }
  return ownerTableForecast(input.settings, input.country) ?? NONE;
}

export interface WaybillRef {
  /** shipment:<id> | external:<id> | order. */
  waybillKey: string;
  shipmentId: string | null;
  externalWaybillId: string | null;
  carrierCode: string | null;
  country: string | null;
  estimate: { amount: string; currency: string; source: string; currencyAssumed: boolean } | null;
}

/**
 * Заморожує прогноз для накладних без знімка (лише вставка; повтор — нічого). `late` — знімок після визнання
 * (зовнішній номер, доданий пізніше). Повертає кількість нових знімків.
 */
export async function freezeShippingSnapshots(
  tx: Tx,
  input: {
    orderId: string;
    date: string;
    waybills: readonly WaybillRef[];
    existing: ReadonlySet<string>;
    late: boolean;
    settings: FinanceSettings;
    mode: AppMode;
    now: Date;
    cache: Map<string, ShippingForecast | null>;
  },
): Promise<number> {
  let n = 0;
  for (const w of input.waybills) {
    if (input.existing.has(w.waybillKey)) continue;
    const f = await shippingForecastChain(tx, { country: w.country, date: input.date, estimate: w.estimate, settings: input.settings, mode: input.mode, cache: input.cache });
    const out = await tx
      .insert(shippingForecastSnapshots)
      .values({
        storeId: DEFAULT_STORE_ID,
        orderId: input.orderId,
        waybillKey: w.waybillKey,
        shipmentId: w.shipmentId,
        externalWaybillId: w.externalWaybillId,
        carrierCode: w.carrierCode,
        countryCode: w.country,
        basis: f.basis,
        amount: f.amount,
        currency: f.currency,
        basisDetails: f.details,
        lateSnapshot: input.late,
        frozenAt: input.now,
      })
      .onConflictDoNothing({ target: [shippingForecastSnapshots.orderId, shippingForecastSnapshots.waybillKey] })
      .returning({ id: shippingForecastSnapshots.id });
    n += out.length;
  }
  return n;
}

// ---------------------------------------------------------------------------------------------------------------
// Собівартість і упаковка
// ---------------------------------------------------------------------------------------------------------------

const UNIT_BASIS: Record<string, FinanceBasis> = {
  pool_average: "pool_average",
  owner_standard: "unconfirmed_standard",
  batch: "last_batch",
  catalogue: "catalogue",
};

/** Прогноз одиниці позиції обліку (WP2) з основою з переліку FINANCE_BASES; null — «Немає даних». */
export async function unitForecastOf(db: DbOrTx, stockItemId: string | null, date: string): Promise<{ unitCost: string; currency: string; basis: FinanceBasis } | null> {
  if (!stockItemId) return null;
  const f = await unitCostForecast(db, stockItemId, date);
  if (!f || !isSupportedCurrency(f.currency)) return null;
  return { unitCost: f.unitCost, currency: f.currency, basis: UNIT_BASIS[f.basis] ?? "pool_average" };
}

/** Прогноз упаковки за шаблонами комплектації (+ коробка пакування); null — немає плану або ціни матеріалу. */
export async function kitPackagingForecast(db: DbOrTx, orderId: string, boxMaterialId: string | null, date: string): Promise<Money[] | null> {
  const needs = new Map<string, number>();
  for (const k of await resolveKitMaterials(db, orderId)) needs.set(k.materialId, (needs.get(k.materialId) ?? 0) + k.quantity);
  if (boxMaterialId) needs.set(boxMaterialId, (needs.get(boxMaterialId) ?? 0) + 1);
  if (needs.size === 0) return null;
  const ids = [...needs.keys()].sort();
  const items = await db.select({ id: stockItems.id, materialId: stockItems.materialId }).from(stockItems).where(inArray(stockItems.materialId, ids));
  const itemOf = new Map(items.map((i) => [i.materialId, i.id]));
  const catalogue = await db
    .select({ id: packagingMaterials.id, unitCost: packagingMaterials.unitCost, currency: packagingMaterials.costCurrency })
    .from(packagingMaterials)
    .where(inArray(packagingMaterials.id, ids));
  const catOf = new Map(catalogue.map((c) => [c.id, c]));
  const out: Money[] = [];
  for (const materialId of ids) {
    const qty = needs.get(materialId)!;
    if (qty <= 0) continue;
    const stockItemId = itemOf.get(materialId) ?? null;
    const unit = stockItemId ? await unitForecastOf(db, stockItemId, date) : null;
    const cat = catOf.get(materialId);
    const u = unit ?? (cat?.unitCost && cat.currency && isSupportedCurrency(cat.currency.trim()) ? { unitCost: cat.unitCost, currency: cat.currency.trim() } : null);
    if (!u) return null;
    out.push({ amount: fromMinor(toMinorForCurrency(u.unitCost, u.currency) * BigInt(qty)), currency: u.currency });
  }
  return out;
}

/** Заморожені знімки прогнозу замовлення за ключем накладної. */
export async function loadSnapshotKeys(db: DbOrTx, orderId: string): Promise<Set<string>> {
  const rows = await db.select({ key: shippingForecastSnapshots.waybillKey }).from(shippingForecastSnapshots).where(eq(shippingForecastSnapshots.orderId, orderId));
  return new Set(rows.map((r) => r.key));
}
