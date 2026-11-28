/**
 * Етап 6, WP6: правила комісій шлюзів (`finance_fee_rules`, docs/stage6-design.md §8.1) — сервіси власника
 * (requireFinance) і внутрішнє читання правил для прогнозу (WP4 syncOrderFinance → fee-rules.ts feeForecast).
 *
 * Рядки НЕЗМІННІ: нове правило для (шлюз, вид) закриває чинне (`applies_to` = день перед новим) і додається окремим
 * рядком; «Завершити правило» лише встановлює `applies_to`. Кожна зміна — finance_change_log (fee_rule). Правило, що
 * діє з дати в закритому місяці, — відмова (стани складників закритих місяців не змінюються). Після зміни — перерахунок
 * фінансів незавершених замовлень шлюзу (syncOrderFinance WP4; прогнози в журнал не пишуться).
 * Шлюз — точна назва з OrderTransaction.gateway / paymentGatewayNames (вибір із побачених або введена власником).
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, notExists, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DbOrTx, Tx } from "~/db/client.server";
import { financeEntries, financeFeeRules, orderFinance, orders, orderShopifyFinance, orderTransactions } from "~/db/schema";
import { FEE_RULE_KINDS } from "~/domain/finance";
import { ConflictError, DomainError, NotFoundError } from "~/lib/errors";
import { convertMinor, fromMinor, isSupportedCurrency, parseOwnerAmount, toMinorForCurrency, assertSupportedCurrency } from "~/lib/decimal";
import { addDays, addMonths, businessDate, monthEnd, monthStart, parseIsoDate } from "~/lib/periods";
import { writeAudit } from "~/modules/audit/audit.server";
import { requireFinance } from "~/modules/finance/core/access.server";
import { writeFinanceChange } from "~/modules/finance/core/change-log.server";
import { assertMonthOpen } from "~/modules/finance/core/closed-month.server";
import { lockFinanceOperation, lockFinanceOrders } from "~/modules/finance/core/locks.server";
import { loadFinanceSettings } from "~/modules/finance/core/settings.server";
import { DEFAULT_STORE_ID } from "~/modules/finance/core/store.server";
import { createRateResolver, rateWindowOf } from "~/modules/fx/rate-for.server";
import { syncOrderFinance } from "~/modules/order-finance/sync.server";
import { maskFreeTextNote } from "~/modules/privacy/notes";
import { businessDayEnd, businessDayStart } from "~/modules/warehouse/dates";
import type { ServiceContext } from "~/server/types";
import { bpToPercent, feeForecast, feeRuleShapeError, normalizeGateway, parsePercentToBp, type FeeRuleKind, type FeeRuleLike } from "./fee-rules";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Скільки незавершених замовлень перераховується одразу після зміни правила (решту — синхронізація замовлення). */
export const FEE_RULE_RESYNC_LIMIT = 500;

type Ctx = Pick<ServiceContext, "db" | "actor" | "mode" | "now">;
type RuleRow = typeof financeFeeRules.$inferSelect;

const toLike = (r: RuleRow): FeeRuleLike => ({
  id: r.id,
  gateway: r.gateway,
  kind: r.kind as FeeRuleKind,
  percentBp: r.percentBp,
  fixedAmount: r.fixedAmount,
  fixedCurrency: r.fixedCurrency?.trim() ?? null,
  noFees: r.noFees,
  appliesFrom: r.appliesFrom,
  appliesTo: r.appliesTo,
});

/** Внутрішнє (WP4): правила шлюзів (усі або обраних) — конфігурація прогнозу, без перевірки актора. */
export async function loadFeeRules(db: DbOrTx, filter: { gateways?: readonly string[]; storeId?: string } = {}): Promise<FeeRuleLike[]> {
  const conds: SQL[] = [eq(financeFeeRules.storeId, filter.storeId ?? DEFAULT_STORE_ID)];
  if (filter.gateways) {
    if (filter.gateways.length === 0) return [];
    conds.push(inArray(financeFeeRules.gateway, [...filter.gateways]));
  }
  const rows = await db.select().from(financeFeeRules).where(and(...conds)).orderBy(asc(financeFeeRules.gateway), asc(financeFeeRules.kind), asc(financeFeeRules.appliesFrom));
  return rows.map(toLike);
}

export interface FeeRuleInput {
  gateway: string;
  kind: string;
  /** Відсоток з форми («3,49»). */
  percent: string;
  fixedAmount?: string | null;
  fixedCurrency?: string | null;
  noFees: boolean;
  appliesFrom: string;
  reason?: string | null;
}

export interface FeeRuleView extends FeeRuleLike {
  percent: string;
  createdAt: string;
  createdBy: string;
  /** Чинне на сьогодні. */
  current: boolean;
}

function logOf(r: Pick<RuleRow, "gateway" | "kind" | "percentBp" | "fixedAmount" | "fixedCurrency" | "noFees" | "appliesFrom" | "appliesTo">) {
  return {
    gateway: r.gateway,
    kind: r.kind,
    percentBp: r.percentBp,
    fixedAmount: r.fixedAmount,
    fixedCurrency: r.fixedCurrency?.trim() ?? null,
    noFees: r.noFees,
    appliesFrom: r.appliesFrom,
    appliesTo: r.appliesTo,
  };
}

/** Незавершені замовлення шлюзу, оформлені від дати, — перерахунок фінансів (WP4). Повертає кількість. */
async function resyncGatewayOrders(tx: Tx, actor: Ctx["actor"], gateway: string, from: string): Promise<number> {
  const rows = await tx
    .select({ id: orders.id })
    .from(orders)
    .leftJoin(orderFinance, eq(orderFinance.orderId, orders.id))
    .where(
      and(
        gte(orders.placedAt, businessDayStart(from)),
        sql`coalesce(${orderFinance.profitState}, 'n/a') <> 'final'`,
        or(
          sql`exists (select 1 from ${orderShopifyFinance} where ${orderShopifyFinance.orderId} = ${orders.id} and ${gateway} = any(${orderShopifyFinance.paymentGatewayNames}))`,
          sql`exists (select 1 from ${orderTransactions} where ${orderTransactions.orderId} = ${orders.id} and ${orderTransactions.gateway} = ${gateway})`,
        ),
      ),
    )
    .orderBy(asc(orders.id))
    .limit(FEE_RULE_RESYNC_LIMIT);
  // FINO усіх замовлень одним упорядкованим набором до першої синхронізації (як WP4 syncOrderFinanceMany, §17.8).
  await lockFinanceOrders(tx, rows.map((r) => r.id));
  for (const r of rows) await syncOrderFinance(tx, actor, r.id);
  return rows.length;
}

/**
 * Нове правило шлюзу (вид payment | platform) з дати. Чинне правило того самого (шлюз, вид) закривається днем раніше.
 * Дата має бути пізніша за початок останнього правила; та сама дата й ті самі значення — повтор без змін.
 */
export async function saveFeeRule(ctx: Ctx, input: FeeRuleInput): Promise<{ id: string; duplicate: boolean; closedRuleId: string | null; resynced: number }> {
  requireFinance(ctx, "manage");
  const gateway = normalizeGateway(input.gateway);
  const kind = (input.kind ?? "").trim();
  const percentBp = parsePercentToBp(input.percent);
  const fixedRaw = (input.fixedAmount ?? "").trim();
  const fixedCurrency = fixedRaw ? (input.fixedCurrency ?? "").trim().toUpperCase() : null;
  let fixedMinor: bigint | null = null;
  if (fixedRaw) {
    if (!fixedCurrency || !isSupportedCurrency(fixedCurrency)) throw new DomainError("finance.error.unsupportedCurrency", 400, { currency: (fixedCurrency ?? "").slice(0, 3) });
    const p = parseOwnerAmount(fixedRaw);
    if (!p.ok) throw new DomainError(p.error, 400, { field: "fixedAmount" });
    try {
      fixedMinor = toMinorForCurrency(p.value, fixedCurrency);
    } catch {
      throw new DomainError("finance.error.amountWholeUnits", 400, { field: "fixedAmount" });
    }
  }
  const err = feeRuleShapeError({ gateway, kind, percentBp, fixedMinor, fixedCurrency, noFees: input.noFees });
  if (err) throw new DomainError(err, 400);
  const appliesFrom = parseIsoDate(input.appliesFrom);
  if (!appliesFrom) throw new DomainError("financeExpenses.error.dateInvalid", 400);
  const reason = maskFreeTextNote(input.reason, 300);
  const values = {
    gateway: gateway!,
    kind: kind as FeeRuleKind,
    percentBp: percentBp!,
    fixedAmount: fixedMinor === null ? null : fromMinor(fixedMinor),
    fixedCurrency: fixedMinor === null ? null : fixedCurrency,
    noFees: input.noFees,
  };
  return ctx.db.transaction(async (tx) => {
    await lockFinanceOperation(tx, `feerule|${DEFAULT_STORE_ID}|${values.gateway}|${values.kind}`);
    const [latest] = await tx
      .select()
      .from(financeFeeRules)
      .where(and(eq(financeFeeRules.storeId, DEFAULT_STORE_ID), eq(financeFeeRules.gateway, values.gateway), eq(financeFeeRules.kind, values.kind)))
      .orderBy(desc(financeFeeRules.appliesFrom))
      .limit(1);
    if (latest && latest.appliesFrom >= appliesFrom) {
      const same =
        latest.appliesFrom === appliesFrom &&
        latest.percentBp === values.percentBp &&
        latest.noFees === values.noFees &&
        (latest.fixedAmount ?? null) === values.fixedAmount &&
        (latest.fixedCurrency?.trim() ?? null) === values.fixedCurrency;
      if (same) return { id: latest.id, duplicate: true, closedRuleId: null, resynced: 0 };
      throw new DomainError("financeExpenses.error.feeRuleNotAfterLatest", 409, { date: latest.appliesFrom });
    }
    await assertMonthOpen(tx, appliesFrom);
    let closedRuleId: string | null = null;
    if (latest && (latest.appliesTo === null || latest.appliesTo >= appliesFrom)) {
      const appliesTo = addDays(appliesFrom, -1);
      const [closed] = await tx
        .update(financeFeeRules)
        .set({ appliesTo })
        .where(and(eq(financeFeeRules.id, latest.id), latest.appliesTo === null ? sql`${financeFeeRules.appliesTo} is null` : eq(financeFeeRules.appliesTo, latest.appliesTo)))
        .returning();
      if (!closed) throw new ConflictError();
      closedRuleId = closed.id;
      await writeFinanceChange(tx, ctx.actor, { entityType: "fee_rule", entityId: closed.id, action: "update", before: logOf(latest), after: logOf(closed), reason });
    }
    const [row] = await tx
      .insert(financeFeeRules)
      .values({ ...values, appliesFrom, createdBy: ctx.actor.id })
      .returning();
    await writeFinanceChange(tx, ctx.actor, { entityType: "fee_rule", entityId: row!.id, action: "create", after: logOf(row!), reason });
    // Дата правила — дата оплати; замовлення, оформлені трохи раніше, могли бути оплачені вже за новим правилом.
    const resynced = await resyncGatewayOrders(tx, ctx.actor, values.gateway, addDays(appliesFrom, -31));
    await writeAudit(tx, ctx.actor, "finance.fee_rule_created", { type: "finance_fee_rule", id: row!.id }, { closed: closedRuleId ? 1 : 0, resynced });
    return { id: row!.id, duplicate: false, closedRuleId, resynced };
  });
}

/** Завершити правило з дати (включно — останній день дії). */
export async function endFeeRule(ctx: Ctx, input: { ruleId: string; appliesTo: string; reason?: string | null }): Promise<{ ended: boolean; resynced: number }> {
  requireFinance(ctx, "manage");
  if (!UUID_RE.test(input.ruleId ?? "")) throw new NotFoundError("finance_fee_rule");
  const appliesTo = parseIsoDate(input.appliesTo);
  if (!appliesTo) throw new DomainError("financeExpenses.error.dateInvalid", 400);
  const reason = maskFreeTextNote(input.reason, 300);
  return ctx.db.transaction(async (tx) => {
    const [peek] = await tx.select().from(financeFeeRules).where(eq(financeFeeRules.id, input.ruleId));
    if (!peek) throw new NotFoundError("finance_fee_rule");
    await lockFinanceOperation(tx, `feerule|${peek.storeId}|${peek.gateway}|${peek.kind}`);
    const [rule] = await tx.select().from(financeFeeRules).where(eq(financeFeeRules.id, input.ruleId)).for("update");
    if (!rule) throw new NotFoundError("finance_fee_rule");
    if (appliesTo < rule.appliesFrom) throw new DomainError("financeExpenses.error.feeRuleEndBeforeStart", 400);
    if (rule.appliesTo !== null && rule.appliesTo <= appliesTo) return { ended: false, resynced: 0 };
    await assertMonthOpen(tx, addDays(appliesTo, 1));
    const [updated] = await tx.update(financeFeeRules).set({ appliesTo }).where(eq(financeFeeRules.id, rule.id)).returning();
    await writeFinanceChange(tx, ctx.actor, { entityType: "fee_rule", entityId: rule.id, action: "update", before: logOf(rule), after: logOf(updated!), reason });
    const resynced = await resyncGatewayOrders(tx, ctx.actor, rule.gateway, addDays(appliesTo, 1));
    await writeAudit(tx, ctx.actor, "finance.fee_rule_ended", { type: "finance_fee_rule", id: rule.id }, { resynced });
    return { ended: true, resynced };
  });
}

/** Правила (finance.view): за шлюзом і видом, новіші першими; позначка «чинне сьогодні». */
export async function listFeeRules(ctx: Pick<ServiceContext, "db" | "actor" | "now">): Promise<FeeRuleView[]> {
  requireFinance(ctx, "view");
  const today = businessDate(ctx.now());
  const rows = await ctx.db
    .select()
    .from(financeFeeRules)
    .where(eq(financeFeeRules.storeId, DEFAULT_STORE_ID))
    .orderBy(asc(financeFeeRules.gateway), asc(financeFeeRules.kind), desc(financeFeeRules.appliesFrom));
  return rows.map((r) => ({
    ...toLike(r),
    percent: bpToPercent(r.percentBp),
    createdAt: r.createdAt.toISOString(),
    createdBy: r.createdBy,
    current: r.appliesFrom <= today && (r.appliesTo === null || today <= r.appliesTo),
  }));
}

/** Назви шлюзів, побачені в транзакціях і замовленнях Shopify, і з правил (finance.view). */
export async function listSeenGateways(ctx: Pick<ServiceContext, "db" | "actor">): Promise<string[]> {
  requireFinance(ctx, "view");
  const [tx, osf, rules] = await Promise.all([
    ctx.db.selectDistinct({ g: orderTransactions.gateway }).from(orderTransactions).where(isNotNull(orderTransactions.gateway)).limit(200),
    ctx.db.selectDistinct({ g: sql<string>`unnest(${orderShopifyFinance.paymentGatewayNames})` }).from(orderShopifyFinance).limit(200),
    ctx.db.selectDistinct({ g: financeFeeRules.gateway }).from(financeFeeRules).limit(200),
  ]);
  const all = new Set<string>();
  for (const r of [...tx, ...osf, ...rules]) if (r.g && normalizeGateway(r.g)) all.add(r.g);
  return [...all].sort((a, b) => a.localeCompare(b));
}

export interface UnconvertedValue {
  /** Прогноз правила чи факт комісії. */
  kind: "forecast" | "actual";
  currency: string;
  /** Σ значень без курсу (додатна витрата), десятковий рядок. */
  amount: string;
  /** Кількість значень (записів / рядків прогнозу). */
  entries: number;
}

export interface GatewayMonthComparison {
  gateway: string;
  /** YYYY-MM-01 (місяць оформлення замовлень). */
  month: string;
  /** Не скасовані замовлення місяця з цим шлюзом (замовлення з кількома шлюзами — у кожному, але не в порівнянні). */
  orders: number;
  /** Замовлення лише з цим шлюзом, що мають діючий факт комісії (payment_fees / platform_fees). */
  ordersWithActual: number;
  /** З них — у сумах: є прогноз чинного правила (або «Без комісії» — відомий 0) і курси всіх значень. */
  compared: number;
  /** З фактом, але без чинного правила на дату оплати (або без бази для відсотка) — поза порівнянням. */
  noRule: number;
  /** З фактом і правилом, але без курсу хоч одного значення для валюти звітності — поза сумами (див. unconverted). */
  ordersUnconverted: number;
  /**
   * Σ прогнозу правила / Σ факту ОДНИХ І ТИХ САМИХ замовлень (compared) у валюті звітності; null — порівнювати нічого
   * (НЕ 0). Прогноз — «Прогноз, а не факт».
   */
  forecast: string | null;
  actual: string | null;
  /** Значення без курсу (поза сумами, §2.6 «Без курсу: 120,00 PLN (2 записи)»). */
  unconverted: UnconvertedValue[];
}

const reversalsCmp = alias(financeEntries, "fe_fee_cmp_rev");

/** Дата оплати й база відсотка замовлень (§4 «Комісії», D-25): перша SUCCESS SALE/CAPTURE; у демо без угод — сума замовлення. */
async function paymentBases(
  db: DbOrTx,
  orderRows: ReadonlyArray<{ id: string; placedAt: Date; total: string; currency: string }>,
  mode: ServiceContext["mode"],
): Promise<Map<string, { date: string; base: { amount: string; currency: string } | null }>> {
  const ids = orderRows.map((o) => o.id);
  const txs = ids.length
    ? await db
        .select({ orderId: orderTransactions.orderId, amount: orderTransactions.amount, currency: orderTransactions.currency, processedAt: orderTransactions.processedAt })
        .from(orderTransactions)
        .where(and(inArray(orderTransactions.orderId, ids), eq(orderTransactions.status, "SUCCESS"), inArray(orderTransactions.kind, ["SALE", "CAPTURE"])))
    : [];
  const byOrder = new Map<string, typeof txs>();
  for (const t of txs) byOrder.set(t.orderId, [...(byOrder.get(t.orderId) ?? []), t]);
  const out = new Map<string, { date: string; base: { amount: string; currency: string } | null }>();
  for (const o of orderRows) {
    const own = byOrder.get(o.id) ?? [];
    const times = own.map((t) => t.processedAt).filter((d): d is Date => d !== null).sort((a, b) => a.getTime() - b.getTime());
    const date = businessDate(times[0] ?? o.placedAt);
    const currencies = new Set(own.map((t) => t.currency.trim()));
    let base: { amount: string; currency: string } | null = null;
    if (own.length > 0 && currencies.size === 1) {
      const currency = [...currencies][0]!;
      base = { amount: fromMinor(own.reduce((sum, t) => sum + toMinorForCurrency(t.amount, currency), 0n)), currency };
    } else if (own.length === 0 && mode === "demo") {
      base = { amount: o.total, currency: o.currency.trim() };
    }
    out.set(o.id, { date, base });
  }
  return out;
}

/**
 * Прогноз vs факт комісій за шлюзом за останні `months` місяців (finance.view, §8.1 — точність правил): для кожного
 * замовлення ЛИШЕ з цим шлюзом, що має діючий факт комісії (записи payment_fees / platform_fees, не сторно й не
 * сторновані: Shopify, частка суми періоду, ручна), прогноз рахується чинним правилом шлюзу на дату оплати
 * (feeForecast: відсоток від бази SUCCESS SALE/CAPTURE, у демо — від суми замовлення, + фіксована частина). Обидва
 * стовпці — ОДНІ Й ТІ САМІ замовлення (compared). Конвертація — rateFor (резолвер вікна): прогноз — за датою оплати,
 * факт — за fx_on запису; одне округлення на значення, потім сума. Значення без курсу — поза сумами (unconverted), а
 * замовлення — поза compared.
 */
export async function feeForecastVsActual(
  ctx: Pick<ServiceContext, "db" | "actor" | "mode" | "now">,
  input: { months?: number; reportingCurrency?: string } = {},
): Promise<{ reportingCurrency: string; months: string[]; rows: GatewayMonthComparison[] }> {
  requireFinance(ctx, "view");
  const settings = await loadFinanceSettings(ctx.db);
  const reporting = input.reportingCurrency && isSupportedCurrency(input.reportingCurrency) ? input.reportingCurrency : settings.reportingCurrency;
  const n = Math.min(Math.max(input.months ?? 3, 1), 12);
  const thisMonth = monthStart(businessDate(ctx.now()));
  const months = Array.from({ length: n }, (_v, i) => addMonths(thisMonth, i - (n - 1)));
  const from = months[0]!;
  const to = monthEnd(thisMonth);
  const orderRows = await ctx.db
    .select({
      id: orders.id,
      placedAt: orders.placedAt,
      total: orders.total,
      currency: orders.currency,
      names: sql<string[]>`coalesce(${orderShopifyFinance.paymentGatewayNames}, '{}'::text[])`,
      txGateways: sql<string[]>`coalesce(array(select distinct ${orderTransactions.gateway} from ${orderTransactions} where ${orderTransactions.orderId} = ${orders.id} and ${orderTransactions.gateway} is not null), '{}'::text[])`,
    })
    .from(orders)
    .leftJoin(orderShopifyFinance, eq(orderShopifyFinance.orderId, orders.id))
    .where(and(gte(orders.placedAt, businessDayStart(from)), lte(orders.placedAt, businessDayEnd(to)), ne(orders.status, "cancelled")));
  const gatewaysOf = new Map<string, string[]>();
  const monthOf = new Map<string, string>();
  const withGateway: typeof orderRows = [];
  for (const o of orderRows) {
    const gs = [...new Set([...(o.names ?? []), ...(o.txGateways ?? [])])].filter((g) => normalizeGateway(g));
    if (gs.length === 0) continue;
    gatewaysOf.set(o.id, gs);
    monthOf.set(o.id, monthStart(businessDate(o.placedAt)));
    withGateway.push(o);
  }
  if (withGateway.length === 0) return { reportingCurrency: reporting, months, rows: [] };
  type Acc = { orders: Set<string>; withA: number; compared: number; noRule: number; unconvertedOrders: number; f: bigint; a: bigint; unconverted: Map<string, { kind: UnconvertedValue["kind"]; currency: string; minor: bigint; entries: number }> };
  const acc = new Map<string, Acc>();
  const get = (g: string, m: string) => {
    const k = `${g}|${m}`;
    let v = acc.get(k);
    if (!v) acc.set(k, (v = { orders: new Set(), withA: 0, compared: 0, noRule: 0, unconvertedOrders: 0, f: 0n, a: 0n, unconverted: new Map() }));
    return v;
  };
  for (const [id, gs] of gatewaysOf) for (const g of gs) get(g, monthOf.get(id)!).orders.add(id);
  // Порівнюються лише замовлення з одним шлюзом (комісію замовлення з кількома шлюзами не розділити між ними).
  const single = withGateway.filter((o) => gatewaysOf.get(o.id)!.length === 1);
  const singleIds = single.map((o) => o.id);
  const actualRows = singleIds.length
    ? await ctx.db
        .select({ orderId: financeEntries.orderId, amount: financeEntries.amount, currency: financeEntries.currency, fxOn: financeEntries.fxOn })
        .from(financeEntries)
        .where(
          and(
            inArray(financeEntries.orderId, singleIds),
            inArray(financeEntries.category, ["payment_fees", "platform_fees"]),
            isNull(financeEntries.reversesEntryId),
            notExists(ctx.db.select({ one: sql`1` }).from(reversalsCmp).where(eq(reversalsCmp.reversesEntryId, financeEntries.id))),
          ),
        )
    : [];
  const actualOf = new Map<string, Array<{ amount: string; currency: string; fxOn: string }>>();
  for (const r of actualRows) actualOf.set(r.orderId!, [...(actualOf.get(r.orderId!) ?? []), { amount: r.amount, currency: r.currency.trim(), fxOn: r.fxOn }]);
  const withActual = single.filter((o) => actualOf.has(o.id));
  const bases = await paymentBases(ctx.db, withActual, ctx.mode);
  const rules = await loadFeeRules(ctx.db, { gateways: [...new Set(withActual.map((o) => gatewaysOf.get(o.id)![0]!))] });
  type Point = { kind: UnconvertedValue["kind"]; currency: string; fxOn: string; minor: bigint };
  const plans: Array<{ orderId: string; gateway: string; points: Point[] }> = [];
  for (const o of withActual) {
    const gateway = gatewaysOf.get(o.id)![0]!;
    const v = get(gateway, monthOf.get(o.id)!);
    v.withA++;
    const pay = bases.get(o.id)!;
    const forecast = feeForecast(rules, { gateway, date: pay.date, base: pay.base });
    if (forecast.state === "none") {
      v.noRule++;
      continue;
    }
    const points: Point[] = [
      // Факт — запис зі знаком «−» (витрата): показуємо як додатну суму витрати.
      ...actualOf.get(o.id)!.map((a) => ({ kind: "actual" as const, currency: a.currency, fxOn: a.fxOn, minor: -toMinorForCurrency(a.amount, a.currency) })),
      ...(forecast.state === "forecast" ? forecast.lines.map((l) => ({ kind: "forecast" as const, currency: l.currency, fxOn: pay.date, minor: toMinorForCurrency(l.amount, l.currency) })) : []),
    ];
    plans.push({ orderId: o.id, gateway, points });
  }
  const window = rateWindowOf(plans.flatMap((p) => p.points), [reporting]);
  const resolver = window ? await createRateResolver(ctx.db, window, { mode: ctx.mode }) : null;
  const dY = assertSupportedCurrency(reporting);
  for (const p of plans) {
    const v = get(p.gateway, monthOf.get(p.orderId)!);
    let f = 0n;
    let a = 0n;
    const missing: Point[] = [];
    for (const pt of p.points) {
      const pX = resolver?.scaled(pt.currency, pt.fxOn) ?? null;
      const pY = resolver?.scaled(reporting, pt.fxOn) ?? null;
      if (pX === null || pY === null) {
        missing.push(pt);
        continue;
      }
      const minor = convertMinor(pt.minor, pX, pY, dY);
      if (pt.kind === "forecast") f += minor;
      else a += minor;
    }
    if (missing.length > 0) {
      v.unconvertedOrders++;
      for (const m of missing) {
        const key = `${m.kind}|${m.currency}`;
        const cur = v.unconverted.get(key) ?? { kind: m.kind, currency: m.currency, minor: 0n, entries: 0 };
        cur.minor += m.minor;
        cur.entries++;
        v.unconverted.set(key, cur);
      }
      continue;
    }
    v.compared++;
    v.f += f;
    v.a += a;
  }
  const rows: GatewayMonthComparison[] = [...acc.entries()]
    .map(([k, v]) => {
      const [gateway, month] = k.split("|") as [string, string];
      return {
        gateway,
        month,
        orders: v.orders.size,
        ordersWithActual: v.withA,
        compared: v.compared,
        noRule: v.noRule,
        ordersUnconverted: v.unconvertedOrders,
        forecast: v.compared > 0 ? fromMinor(v.f) : null,
        actual: v.compared > 0 ? fromMinor(v.a) : null,
        unconverted: [...v.unconverted.values()]
          .sort((x, y) => (x.kind === y.kind ? x.currency.localeCompare(y.currency) : x.kind === "forecast" ? -1 : 1))
          .map((u) => ({ kind: u.kind, currency: u.currency, amount: fromMinor(u.minor), entries: u.entries })),
      };
    })
    .sort((a, b) => a.gateway.localeCompare(b.gateway) || a.month.localeCompare(b.month));
  return { reportingCurrency: reporting, months, rows };
}

export const FEE_RULE_KIND_OPTIONS: readonly FeeRuleKind[] = FEE_RULE_KINDS;
