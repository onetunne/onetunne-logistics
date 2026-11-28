/**
 * Етап 6, WP2: вхідні дані рушія собівартості з БД (docs/stage6-design.md §6.3, §6.5, §6.6): вартість руху у валюті
 * оцінки (курс — лише rateFor, §5.4), ручна собівартість власника / каталожна ціна матеріалу на дату, джерела вартості
 * придатного повернення (оцінки продажу замовлення, записи stdcogs). Внутрішній модуль (без перевірки актора).
 */
import { and, asc, desc, eq, inArray, isNull, like, lte, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DbOrTx } from "~/db/client.server";
import { financeEntries, fxRates, inventoryValuations, packagingMaterials, stockItemCosts, stockItems } from "~/db/schema";
import { convertMinor, minorDigits, isSupportedCurrency } from "~/lib/decimal";
import { toMinor } from "~/lib/money";
import { loadFinanceSettings } from "~/modules/finance/core/settings.server";
import { rateFor } from "~/modules/fx/rate-for.server";
import type { AppMode } from "~/server/types";
import { currencyQuantum, mulDivQ, roundToQuantum, type MovementValueInput, type SaleSource, type StandardSource, type StandardUnit } from "./engine";
import { completionTotals, detailList, type ValuationRow } from "./store.server";

/** Налаштування й режим курсів для одного виклику рушія. */
export interface CostingContext {
  valuationCurrency: string;
  /** Джерело автоматичних курсів (rateFor): demo-база має курси source = demo, робоча — nbu. */
  rateMode: AppMode;
  includeTestOrders: boolean;
}

/**
 * Режим курсів для оцінки. Внутрішні функції проведення не отримують ServiceContext (контракт ValueInsertedMovements),
 * тож режим визначається за базою: демо-курси (source = demo) засіваються ЛИШЕ в демо-базі (WP1/WP11), у робочій базі їх
 * немає ніколи — тоді rateFor бере НБУ. Ручні курси діють в обох режимах.
 */
export async function costingRateMode(db: DbOrTx): Promise<AppMode> {
  const [row] = await db.select({ one: sql<number>`1` }).from(fxRates).where(eq(fxRates.source, "demo")).limit(1);
  return row ? "demo" : "production";
}

export async function loadCostingContext(db: DbOrTx, overrides: Partial<CostingContext> = {}): Promise<CostingContext> {
  const settings = await loadFinanceSettings(db);
  return {
    valuationCurrency: overrides.valuationCurrency ?? settings.valuationCurrency,
    rateMode: overrides.rateMode ?? (await costingRateMode(db)),
    includeTestOrders: overrides.includeTestOrders ?? settings.includeTestOrders,
  };
}

export type ConvertResult =
  | { ok: true; minor: bigint; rateDate: string | null; rateSource: string | null }
  | { ok: false; reason: "no_rate" | "unsupported_currency" };

/**
 * Сума `minor` (соті частки валюти `from`) → валюта оцінки на дату `date` (одне округлення, convertMinor). Обидва курси —
 * гривень за 1 одиницю (rateFor); немає курсу → no_rate (НІКОЛИ не 0).
 */
export async function convertToValuation(db: DbOrTx, cctx: CostingContext, minor: bigint, from: string, date: string): Promise<ConvertResult> {
  const to = cctx.valuationCurrency;
  // Та сама валюта — без курсу; сума округлюється до кванта валюти (JPY — цілі одиниці), як і після конвертації.
  if (from === to) return { ok: true, minor: roundToQuantum(minor, currencyQuantum(to)), rateDate: null, rateSource: null };
  if (!isSupportedCurrency(from) || !isSupportedCurrency(to)) return { ok: false, reason: "unsupported_currency" };
  const rx = await rateFor(db, from, date, { mode: cctx.rateMode });
  const ry = await rateFor(db, to, date, { mode: cctx.rateMode });
  if (!rx.ok || !ry.ok) return { ok: false, reason: "no_rate" };
  const out = convertMinor(minor, rx.scaled, ry.scaled, minorDigits(to));
  const source = from === "UAH" ? ry : rx;
  return { ok: true, minor: out, rateDate: source.rateDate, rateSource: source.source };
}

/** Вартість руху з unit_cost: unit_cost × (якісні + брак), у валюті оцінки на дату руху. */
export async function movementValueInput(
  db: DbOrTx,
  cctx: CostingContext,
  m: { unitCost: string | null; costCurrency: string | null; onHandDelta: number; defectiveDelta: number; occurredOn: string },
): Promise<MovementValueInput> {
  if (m.unitCost === null || m.costCurrency === null) return { status: "none" };
  const qty = Math.max(0, m.onHandDelta) + Math.max(0, m.defectiveDelta);
  const original = toMinor(m.unitCost) * BigInt(qty);
  const originalAmount = scaled2(original);
  const converted = await convertToValuation(db, cctx, original, m.costCurrency, m.occurredOn);
  if (converted.ok) {
    return { status: "valued", minor: converted.minor, originalAmount, originalCurrency: m.costCurrency, rateDate: converted.rateDate, rateSource: converted.rateSource };
  }
  if (converted.reason === "unsupported_currency") return { status: "none" };
  return { status: "no_rate", originalAmount, originalCurrency: m.costCurrency, unitCost: m.unitCost };
}

const scaled2 = (minor: bigint): string => {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  return `${neg ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
};

export interface StockItemInfo {
  id: string;
  kind: "product" | "material";
  variantId: string | null;
  materialId: string | null;
}

export async function loadStockItemInfo(db: DbOrTx, stockItemId: string): Promise<StockItemInfo> {
  const [row] = await db
    .select({ id: stockItems.id, kind: stockItems.kind, variantId: stockItems.variantId, materialId: stockItems.materialId })
    .from(stockItems)
    .where(eq(stockItems.id, stockItemId));
  if (!row) throw new Error("stock item not found");
  return row;
}

export interface ManualCostRow {
  id: string;
  unitCost: string;
  currency: string;
  effectiveFrom: string;
  source: string;
  confirmed: boolean;
}

/**
 * Ручна собівартість на дату (§6.6): останній effective_from ≤ дата, потім останній created_at. confirmedOnly — лише
 * підтверджені (факт); непідтверджені — лише прогноз.
 */
export async function manualCostAt(db: DbOrTx, stockItemId: string, date: string, opts: { confirmedOnly: boolean }): Promise<ManualCostRow | null> {
  const [row] = await db
    .select({
      id: stockItemCosts.id,
      unitCost: stockItemCosts.unitCost,
      currency: stockItemCosts.currency,
      effectiveFrom: stockItemCosts.effectiveFrom,
      source: stockItemCosts.source,
      confirmed: stockItemCosts.confirmed,
    })
    .from(stockItemCosts)
    .where(
      and(
        eq(stockItemCosts.stockItemId, stockItemId),
        lte(stockItemCosts.effectiveFrom, date),
        opts.confirmedOnly ? eq(stockItemCosts.confirmed, true) : undefined,
      ),
    )
    .orderBy(desc(stockItemCosts.effectiveFrom), desc(stockItemCosts.createdAt), desc(stockItemCosts.id))
    .limit(1);
  return row ?? null;
}

/**
 * Ручна собівартість власника (товар) або каталожна ціна (матеріал: рядки material_catalogue, інакше поточна
 * packaging_materials.unit_cost) на дату руху, у валюті оцінки. Немає / немає курсу → null.
 */
export async function standardUnitFor(db: DbOrTx, cctx: CostingContext, item: StockItemInfo, date: string): Promise<StandardUnit | null> {
  const row = await manualCostAt(db, item.id, date, { confirmedOnly: true });
  let unit: { amount: string; currency: string; id: string | null } | null = row ? { amount: row.unitCost, currency: row.currency, id: row.id } : null;
  if (!unit && item.kind === "material" && item.materialId) {
    const [m] = await db
      .select({ unitCost: packagingMaterials.unitCost, currency: packagingMaterials.costCurrency })
      .from(packagingMaterials)
      .where(eq(packagingMaterials.id, item.materialId));
    if (m?.unitCost && m.currency) unit = { amount: m.unitCost, currency: m.currency, id: null };
  }
  if (!unit) return null;
  const converted = await convertToValuation(db, cctx, toMinor(unit.amount), unit.currency, date);
  if (!converted.ok) return null;
  return { minor: converted.minor, source: item.kind === "material" ? "catalogue" : "owner_standard", costId: unit.id };
}

// ---------------------------------------------------------------------------
// Повернення покупця (§6.3): джерела вартості
// ---------------------------------------------------------------------------

/** Рядок «повернено з продажу» в деталях оцінки повернення: `<saleValuationId>:<known>:<knownValue>:<unvalued>`. */
export function parseFromSale(s: string): { saleValuationId: string; knownQty: number; knownValue: bigint; unvaluedQty: number } | null {
  const parts = s.split(":");
  if (parts.length !== 4) return null;
  const [id, k, v, u] = parts as [string, string, string, string];
  const knownQty = Number(k);
  const unvaluedQty = Number(u);
  if (!Number.isSafeInteger(knownQty) || !Number.isSafeInteger(unvaluedQty)) return null;
  try {
    return { saleValuationId: id, knownQty, knownValue: toMinor(v), unvaluedQty };
  } catch {
    return null;
  }
}

/** Рядок «повернено зі stdcogs»: `<entryId>:<qty>`. */
export function parseFromStd(s: string): { entryId: string; qty: number } | null {
  const i = s.lastIndexOf(":");
  if (i <= 0) return null;
  const qty = Number(s.slice(i + 1));
  return Number.isSafeInteger(qty) ? { entryId: s.slice(0, i), qty } : null;
}

/** Оцінки повернень покупця (вхід, details.kind = customer_return) замовлення й позиції. */
export async function returnValuationsOf(db: DbOrTx, orderId: string, stockItemId: string): Promise<ValuationRow[]> {
  return db
    .select()
    .from(inventoryValuations)
    .where(
      and(
        eq(inventoryValuations.orderId, orderId),
        eq(inventoryValuations.stockItemId, stockItemId),
        eq(inventoryValuations.kind, "inflow"),
        sql`${inventoryValuations.details}->>'kind' = 'customer_return'`,
      ),
    )
    .orderBy(asc(inventoryValuations.seq));
}

/** Оцінки продажу (consume_sale) товару в замовленні. */
export async function saleValuationsOf(db: DbOrTx, orderId: string, stockItemId: string): Promise<ValuationRow[]> {
  return db
    .select()
    .from(inventoryValuations)
    .where(
      and(
        eq(inventoryValuations.orderId, orderId),
        eq(inventoryValuations.stockItemId, stockItemId),
        eq(inventoryValuations.kind, "outflow"),
        sql`${inventoryValuations.details}->>'movementType' = 'consume_sale'`,
      ),
    )
    .orderBy(asc(inventoryValuations.seq));
}

/** Скільки одиниць кожного продажу вже повернуто (відомих / без вартості) — з деталей оцінок повернень. */
export function returnedFromSales(returns: readonly ValuationRow[]): Map<string, { knownQty: number; knownValue: bigint; unvaluedQty: number }> {
  const out = new Map<string, { knownQty: number; knownValue: bigint; unvaluedQty: number }>();
  for (const r of returns) {
    for (const s of detailList(r, "fromSales")) {
      const p = parseFromSale(s);
      if (!p) continue;
      const t = out.get(p.saleValuationId) ?? { knownQty: 0, knownValue: 0n, unvaluedQty: 0 };
      t.knownQty += p.knownQty;
      t.knownValue += p.knownValue;
      t.unvaluedQty += p.unvaluedQty;
      out.set(p.saleValuationId, t);
    }
  }
  return out;
}

/** Залишок продажів замовлення для повернення: відомі одиниці (з завершеннями) і ще без вартості. */
export async function saleSourcesFor(db: DbOrTx, orderId: string, stockItemId: string): Promise<SaleSource[]> {
  const sales = await saleValuationsOf(db, orderId, stockItemId);
  if (sales.length === 0) return [];
  const [completions, returns] = await Promise.all([completionTotals(db, sales.map((s) => s.id)), returnValuationsOf(db, orderId, stockItemId)]);
  const returned = returnedFromSales(returns);
  return sales.map((s) => {
    const c = completions.get(s.id) ?? { qty: 0, value: 0n };
    const r = returned.get(s.id) ?? { knownQty: 0, knownValue: 0n, unvaluedQty: 0 };
    const knownUnits = s.knownQty + c.qty - r.knownQty;
    const knownValue = (s.value === null ? 0n : toMinor(s.value)) + c.value - r.knownValue;
    const unvaluedUnits = s.unknownQty + s.deficitQty - c.qty - r.unvaluedQty;
    return {
      valuationId: s.id,
      knownUnits: Math.max(0, knownUnits),
      knownValue: knownUnits > 0 ? (knownValue > 0n ? knownValue : 0n) : 0n,
      unvaluedUnits: Math.max(0, unvaluedUnits),
    };
  });
}

const reversalsOf = alias(financeEntries, "costing_std_rev");

/**
 * Записи stdcogs (ручна собівартість позиції без списання, проводить syncOrderFinance — WP4) товару в замовленні,
 * за вирахуванням уже повернених одиниць. Одиниця = |amount| / quantity (у валюті оцінки за курсом fx_on запису).
 */
export async function standardSourcesFor(db: DbOrTx, cctx: CostingContext, orderId: string, item: StockItemInfo): Promise<StandardSource[]> {
  const itemCond = item.variantId
    ? or(eq(financeEntries.stockItemId, item.id), eq(financeEntries.variantId, item.variantId))
    : eq(financeEntries.stockItemId, item.id);
  const rows = await db
    .select({
      id: financeEntries.id,
      amount: financeEntries.amount,
      currency: financeEntries.currency,
      quantity: financeEntries.quantity,
      fxOn: financeEntries.fxOn,
    })
    .from(financeEntries)
    .where(
      and(
        eq(financeEntries.orderId, orderId),
        like(financeEntries.idempotencyKey, "stdcogs:%"),
        eq(financeEntries.category, "cogs"),
        isNull(financeEntries.reversesEntryId),
        notExists(db.select({ one: sql`1` }).from(reversalsOf).where(eq(reversalsOf.reversesEntryId, financeEntries.id))),
        itemCond,
      ),
    )
    .orderBy(asc(financeEntries.seq));
  if (rows.length === 0) return [];
  const returns = await returnValuationsOf(db, orderId, item.id);
  const used = new Map<string, number>();
  for (const r of returns) {
    for (const s of detailList(r, "fromStd")) {
      const p = parseFromStd(s);
      if (p) used.set(p.entryId, (used.get(p.entryId) ?? 0) + p.qty);
    }
  }
  const out: StandardSource[] = [];
  for (const r of rows) {
    const qty = (r.quantity ?? 0) - (used.get(r.id) ?? 0);
    if (!r.quantity || r.quantity <= 0 || qty <= 0) continue;
    const abs = toMinor(r.amount) < 0n ? -toMinor(r.amount) : toMinor(r.amount);
    const unitOriginal = isSupportedCurrency(r.currency) ? mulDivQ(abs, 1n, BigInt(r.quantity), currencyQuantum(r.currency)) : abs / BigInt(r.quantity);
    const converted = await convertToValuation(db, cctx, unitOriginal, r.currency, r.fxOn);
    if (!converted.ok) continue;
    out.push({ entryId: r.id, unitMinor: converted.minor, qty });
  }
  return out;
}

/** Оцінки за id руху (для пошуку пари повернення). */
export async function valuationIdsByMovement(db: DbOrTx, movementIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (movementIds.length === 0) return out;
  const rows = await db
    .select({ id: inventoryValuations.id, movementId: inventoryValuations.movementId })
    .from(inventoryValuations)
    .where(inArray(inventoryValuations.movementId, [...movementIds]));
  for (const r of rows) if (r.movementId) out.set(r.movementId, r.id);
  return out;
}
