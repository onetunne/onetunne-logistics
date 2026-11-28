/**
 * Етап 6, WP4: дії власника в блоці «Фінанси замовлення» (docs/stage6-design.md §18.4, §2.6, §4, §8.2) — СЕРВІСИ
 * КЕРУВАННЯ: requireFinance(ctx, "manage") (дозвіл finance.manage + роль owner) першим рядком кожної функції; працівник
 * і підроблений актор — ForbiddenError, нічого не записано.
 *
 * Кожна дія — одна транзакція: блокування операції (FIOP, якщо є operationId) → FINANCE_ORDER_LOCK замовлення (§17.8) →
 * зміна (CAS за `order_finance.version` / `order_disputes.version`, ConflictError «Дані змінив інший користувач») →
 * історія фінансових змін (finance_change_log, у тій самій транзакції; причина маскується) → syncOrderFinance (записи,
 * складники, прогнози — бажаний стан) → audit_log лише з id і кодами. Ручні записи, датовані закритим місяцем,
 * відхиляються (`finance.error.monthClosed`, §3.4).
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "~/db/client.server";
import { orderDisputes, orderFinance, orders } from "~/db/schema";
import { DISPUTE_OUTCOMES, type DisputeOutcome } from "~/domain/finance";
import { SYSTEM_ACTOR } from "~/domain/permissions";
import { ConflictError, DomainError, NotFoundError } from "~/lib/errors";
import { assertSupportedCurrency, isSupportedCurrency, parseOwnerAmount, toMinorForCurrency, UnsupportedCurrencyError } from "~/lib/decimal";
import { businessDate, monthStart, parseIsoDate } from "~/lib/periods";
import { writeAudit } from "~/modules/audit/audit.server";
import { requireFinance } from "~/modules/finance/core/access.server";
import { writeFinanceChange } from "~/modules/finance/core/change-log.server";
import { assertMonthOpen, assertMonthsOpen } from "~/modules/finance/core/closed-month.server";
import { lockFinanceOperation, lockFinanceOrder } from "~/modules/finance/core/locks.server";
import { DEFAULT_STORE_ID } from "~/modules/finance/core/store.server";
import { recordExternalWaybills } from "~/modules/finance/core/waybills.server";
import { confirmItemEntries } from "~/modules/finance/periods/periods.server";
import type { ServiceContext } from "~/server/types";
import { FLAG_OVERRIDES, isFlagOverride, OVERRIDE_COMPONENT, parseOrderOverrides, type FlagOverride, type OrderOverrides } from "./overrides";
import { syncOrderFinanceAt, syncOrderFinanceMany } from "./sync.server";

type Ctx = Pick<ServiceContext, "db" | "actor" | "mode" | "now">;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Найдовша причина (маскується ядром до 300). */
export const ORDER_FINANCE_REASON_MAX = 300;
/** Найдовший номер накладної у формі. */
export const EXTERNAL_WAYBILL_INPUT_MAX = 60;

function fail(code: string, status = 400, params?: Record<string, string | number>): never {
  throw new DomainError(`financeOrders.error.${code}`, status, params);
}

function assertOrderId(orderId: string): void {
  if (!UUID_RE.test(orderId)) throw new NotFoundError("order");
}

function reasonOf(value: string | null | undefined, required: boolean): string | null {
  const r = (value ?? "").trim().slice(0, ORDER_FINANCE_REASON_MAX);
  if (!r && required) fail("reasonRequired");
  return r || null;
}

async function loadOrderRow(tx: Tx, orderId: string) {
  const [o] = await tx.select({ id: orders.id, currency: orders.currency }).from(orders).where(eq(orders.id, orderId));
  if (!o) throw new NotFoundError("order");
  return { ...o, currency: o.currency.trim() };
}

/** Рядок order_finance під блокуванням (FOR UPDATE) + CAS версії; рядка ще немає — створюється синхронізацією. */
async function lockedFinanceRow(tx: Tx, ctx: Ctx, orderId: string, expectedVersion: number | null | undefined) {
  const [row] = await tx.select().from(orderFinance).where(eq(orderFinance.orderId, orderId)).for("update");
  if (!row) {
    await syncOrderFinanceAt(tx, ctx.actor, orderId, { now: ctx.now() });
    const [created] = await tx.select().from(orderFinance).where(eq(orderFinance.orderId, orderId)).for("update");
    if (!created) throw new NotFoundError("order");
    if (expectedVersion !== undefined && expectedVersion !== null && expectedVersion !== 0 && expectedVersion !== created.version) throw new ConflictError();
    return created;
  }
  if (expectedVersion !== undefined && expectedVersion !== null && expectedVersion !== row.version) throw new ConflictError();
  return row;
}

async function saveOverrides(tx: Tx, orderId: string, next: OrderOverrides, now: Date): Promise<number> {
  const [r] = await tx
    .update(orderFinance)
    .set({ overrides: next as Record<string, unknown>, version: sql`${orderFinance.version} + 1`, updatedAt: now })
    .where(eq(orderFinance.orderId, orderId))
    .returning({ version: orderFinance.version });
  return r!.version;
}

export interface FlagOverrideInput {
  orderId: string;
  flag: FlagOverride;
  active: boolean;
  reason: string;
  expectedVersion?: number | null;
}

/**
 * Позначка власника: «Платить отримувач» / «Без витрат на доставку» (доставка not_applicable), «Шлюз без комісії» для
 * цього замовлення (комісії zero_confirmed), «Упаковку обліковано загальною сумою» (упаковка not_applicable). Причина —
 * обов'язкова (історія змін). «Платить отримувач» і «Без витрат на доставку» взаємовиключні.
 */
export async function setOrderFinanceFlag(ctx: Ctx, input: FlagOverrideInput): Promise<{ version: number; changed: boolean }> {
  requireFinance(ctx, "manage");
  assertOrderId(input.orderId);
  if (!isFlagOverride(input.flag)) fail("invalidFlag");
  const reason = reasonOf(input.reason, true);
  const now = ctx.now();
  const out = await ctx.db.transaction(async (tx) => {
    await lockFinanceOrder(tx, input.orderId);
    await loadOrderRow(tx, input.orderId);
    const row = await lockedFinanceRow(tx, ctx, input.orderId, input.expectedVersion);
    const current = parseOrderOverrides(row.overrides);
    if (Boolean(current[input.flag]) === input.active) return { version: row.version, changed: false };
    // §2.6: «обліковано загальною сумою» — лише якщо за місяць визнання є загальна сума упаковки (packaging_unlinked або
    // ручна упаковка без замовлення); інакше позначка приховала б відсутню вартість (прибуток завищено).
    if (input.flag === "packaging_accounted_in_total" && input.active) {
      if (row.state !== "recognized" || !row.recognizedOn) fail("packagingNotRecognized", 409);
      const month = monthStart(row.recognizedOn);
      if ((await confirmItemEntries(tx, month, "packaging_total_accounted")) === 0) fail("packagingTotalMissing", 409, { month });
    }
    const next: OrderOverrides = { ...current };
    if (input.active) {
      next[input.flag] = { at: now.toISOString(), by: ctx.actor.id.slice(0, 120) };
      if (input.flag === "recipient_pays") delete next.no_shipping_cost;
      if (input.flag === "no_shipping_cost") delete next.recipient_pays;
    } else delete next[input.flag];
    const version = await saveOverrides(tx, input.orderId, next, now);
    await writeFinanceChange(tx, ctx.actor, {
      entityType: "order_component_override",
      entityId: input.orderId,
      action: input.active ? "create" : "void",
      before: { orderId: input.orderId, component: OVERRIDE_COMPONENT[input.flag], override: input.flag, active: Boolean(current[input.flag]) },
      after: { orderId: input.orderId, component: OVERRIDE_COMPONENT[input.flag], override: input.flag, active: input.active },
      reason,
    });
    await syncOrderFinanceAt(tx, ctx.actor, input.orderId, { now });
    await writeAudit(tx, ctx.actor, "finance.order_override_set", { type: "order", id: input.orderId }, { override: input.flag, active: input.active });
    return { version, changed: true };
  });
  return out;
}

export interface ConfirmAmountsInput {
  orderId: string;
  /** Товари без податків (після знижок), «1 234,50». */
  products: string;
  /** Доставка без податків. */
  shipping: string;
  reason: string;
  expectedVersion?: number | null;
}

/**
 * «Підтвердити суми замовлення» (§4, для «Оцінки» — замовлення без угод Shopify): власник вводить суми товарів і
 * доставки БЕЗ податків (у валюті замовлення) і причину → факт виручки (`owner_confirmed`, записи
 * `confirm:<orderId>:v<n>:products|shipping`). Нова версія сторнує попередню (F2). Коли угоди Shopify стануть повними —
 * підтверджені записи сторнуються автоматично (факт Shopify замінює їх).
 */
export async function confirmOrderAmounts(ctx: Ctx, input: ConfirmAmountsInput): Promise<{ version: number }> {
  requireFinance(ctx, "manage");
  assertOrderId(input.orderId);
  const reason = reasonOf(input.reason, true);
  const products = parseOwnerAmount(input.products);
  if (!products.ok) throw new DomainError(products.error, 400, { field: "products" });
  const shipping = parseOwnerAmount(input.shipping);
  if (!shipping.ok) throw new DomainError(shipping.error, 400, { field: "shipping" });
  const now = ctx.now();
  return ctx.db.transaction(async (tx) => {
    await lockFinanceOrder(tx, input.orderId);
    const order = await loadOrderRow(tx, input.orderId);
    let digits: 0 | 2;
    try {
      digits = assertSupportedCurrency(order.currency);
    } catch (e) {
      if (e instanceof UnsupportedCurrencyError) throw new DomainError("finance.error.unsupportedCurrency", 400, { currency: order.currency });
      throw e;
    }
    for (const [field, v] of [["products", products.value], ["shipping", shipping.value]] as const) {
      const minor = toMinorForCurrency(v, order.currency);
      if (minor < 0n) fail("amountNegative", 400, { field });
      if (digits === 0 && minor % 100n !== 0n) throw new DomainError("finance.error.amountWholeUnits", 400, { field });
    }
    const row = await lockedFinanceRow(tx, ctx, input.orderId, input.expectedVersion);
    if (row.recognizedOn) await assertMonthOpen(tx, row.recognizedOn);
    const current = parseOrderOverrides(row.overrides);
    const nextVersion = (current.confirmed_amounts?.version ?? 0) + 1;
    const next: OrderOverrides = {
      ...current,
      confirmed_amounts: { version: nextVersion, products: products.value, shipping: shipping.value, currency: order.currency, at: now.toISOString(), by: ctx.actor.id.slice(0, 120) },
    };
    const version = await saveOverrides(tx, input.orderId, next, now);
    await writeFinanceChange(tx, ctx.actor, {
      entityType: "order_component_override",
      entityId: input.orderId,
      action: current.confirmed_amounts ? "update" : "create",
      before: current.confirmed_amounts
        ? { orderId: input.orderId, component: "revenue", override: "confirmed_amounts", productsAmount: current.confirmed_amounts.products, shippingAmount: current.confirmed_amounts.shipping, currency: current.confirmed_amounts.currency, active: true }
        : null,
      after: { orderId: input.orderId, component: "revenue", override: "confirmed_amounts", productsAmount: products.value, shippingAmount: shipping.value, currency: order.currency, active: true },
      reason,
    });
    await syncOrderFinanceAt(tx, ctx.actor, input.orderId, { now });
    await writeAudit(tx, ctx.actor, "finance.order_amounts_confirmed", { type: "order", id: input.orderId }, { version: nextVersion });
    return { version };
  });
}

/** Скасувати підтвердження сум (виручка знову «Оцінка» / угоди Shopify); записи сторнуються (F2). */
export async function clearConfirmedAmounts(ctx: Ctx, input: { orderId: string; reason: string; expectedVersion?: number | null }): Promise<{ version: number; changed: boolean }> {
  requireFinance(ctx, "manage");
  assertOrderId(input.orderId);
  const reason = reasonOf(input.reason, true);
  const now = ctx.now();
  return ctx.db.transaction(async (tx) => {
    await lockFinanceOrder(tx, input.orderId);
    await loadOrderRow(tx, input.orderId);
    const row = await lockedFinanceRow(tx, ctx, input.orderId, input.expectedVersion);
    const current = parseOrderOverrides(row.overrides);
    if (!current.confirmed_amounts) return { version: row.version, changed: false };
    if (row.recognizedOn) await assertMonthOpen(tx, row.recognizedOn);
    const next: OrderOverrides = { ...current };
    delete next.confirmed_amounts;
    const version = await saveOverrides(tx, input.orderId, next, now);
    await writeFinanceChange(tx, ctx.actor, {
      entityType: "order_component_override",
      entityId: input.orderId,
      action: "void",
      before: { orderId: input.orderId, component: "revenue", override: "confirmed_amounts", productsAmount: current.confirmed_amounts.products, shippingAmount: current.confirmed_amounts.shipping, currency: current.confirmed_amounts.currency, active: true },
      after: { orderId: input.orderId, component: "revenue", override: "confirmed_amounts", active: false },
      reason,
    });
    await syncOrderFinanceAt(tx, ctx.actor, input.orderId, { now });
    await writeAudit(tx, ctx.actor, "finance.order_amounts_cleared", { type: "order", id: input.orderId });
    return { version, changed: true };
  });
}

export interface ChargebackInput {
  orderId: string;
  /** Наявний спір (з Shopify або ручний); null — новий ручний (інші шлюзи). */
  disputeId?: string | null;
  /** uuid форми (новий ручний спір: dispute_gid `manual:<operationId>`). */
  operationId: string;
  /** Сума спору брутто (як списав банк); порожньо — суми ще немає. */
  amount: string | null;
  /** Повернено (часткова / повна перемога). */
  recovered: string | null;
  currency: string;
  fee: string | null;
  feeCurrency: string | null;
  outcome: string | null;
  decidedOn: string | null;
  /** «ПДВ у втраченій сумі зменшує податкове зобов'язання» (D-26, типово ні). */
  vatReducible: boolean;
  /** «Скасувати винагороду повністю». */
  fullPartnerCancellation: boolean;
  expectedVersion?: number | null;
  reason?: string | null;
}

function optionalAmount(value: string | null | undefined, field: string, currency: string): string | null {
  if (value === null || value === undefined || value.trim() === "") return null;
  const p = parseOwnerAmount(value);
  if (!p.ok) throw new DomainError(p.error, 400, { field });
  const minor = toMinorForCurrency(p.value, currency);
  if (minor < 0n) fail("amountNegative", 400, { field });
  if (assertSupportedCurrency(currency) === 0 && minor % 100n !== 0n) throw new DomainError("finance.error.amountWholeUnits", 400, { field });
  return p.value;
}

function currencyOf(value: string | null | undefined, field: string): string {
  const c = (value ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) fail("currencyInvalid", 400, { field });
  if (!isSupportedCurrency(c)) throw new DomainError("finance.error.unsupportedCurrency", 400, { currency: c });
  return c;
}

/**
 * Chargeback (§8.2): сума спору брутто, повернено, комісія, результат (lost / accepted / won / prevented), дата
 * рішення, «ПДВ зменшується», «Скасувати винагороду повністю». Записи (chargeback_loss нетто / податкова частина,
 * chargeback_fees) проводить syncOrderFinance датою рішення (R2); винагорода партнера — WP7.
 */
export async function saveOrderChargeback(ctx: Ctx, input: ChargebackInput): Promise<{ disputeId: string; version: number; created: boolean }> {
  requireFinance(ctx, "manage");
  assertOrderId(input.orderId);
  if (!UUID_RE.test(input.operationId ?? "")) fail("operationInvalid");
  if (input.disputeId && !UUID_RE.test(input.disputeId)) throw new NotFoundError("dispute");
  const currency = currencyOf(input.currency, "currency");
  const amount = optionalAmount(input.amount, "amount", currency);
  const recovered = optionalAmount(input.recovered, "recovered", currency);
  const feeCurrency = input.fee && input.fee.trim() !== "" ? currencyOf(input.feeCurrency || currency, "feeCurrency") : null;
  const fee = feeCurrency ? optionalAmount(input.fee, "fee", feeCurrency) : null;
  if (amount !== null && recovered !== null && toMinorForCurrency(recovered, currency) > toMinorForCurrency(amount, currency)) fail("recoveredTooLarge", 400, { field: "recovered" });
  let outcome: DisputeOutcome | null = null;
  if (input.outcome && input.outcome !== "") {
    if (!(DISPUTE_OUTCOMES as readonly string[]).includes(input.outcome)) fail("outcomeInvalid", 400, { field: "outcome" });
    outcome = input.outcome as DisputeOutcome;
  }
  const today = businessDate(ctx.now());
  const decidedOn = input.decidedOn && input.decidedOn.trim() !== "" ? parseIsoDate(input.decidedOn.trim()) : null;
  if (input.decidedOn && input.decidedOn.trim() !== "" && !decidedOn) fail("dateInvalid", 400, { field: "decidedOn" });
  if (decidedOn && decidedOn > today) fail("dateInFuture", 400, { field: "decidedOn" });
  if (outcome && !decidedOn) fail("decidedOnRequired", 400, { field: "decidedOn" });
  if (fee && !decidedOn) fail("decidedOnRequired", 400, { field: "decidedOn" });
  const reason = reasonOf(input.reason, false);
  const op = input.operationId.toLowerCase();
  const now = ctx.now();
  return ctx.db.transaction(async (tx) => {
    await lockFinanceOperation(tx, op);
    await lockFinanceOrder(tx, input.orderId);
    await loadOrderRow(tx, input.orderId);
    // §3.4: ручний запис закритого місяця не створюється, не змінюється й не анулюється. Записи спору датовані
    // max(дата рішення, дата визнання) (R2) — перевіряються і НОВА дата, і дата ЗБЕРЕЖЕНОГО спору (зміна / очищення /
    // перенесення спору закритого місяця відхиляється, а не сторнується «пізнім записом»).
    const [fin] = await tx.select({ state: orderFinance.state, recognizedOn: orderFinance.recognizedOn }).from(orderFinance).where(eq(orderFinance.orderId, input.orderId));
    const entryDateOf = (d: string | null) => (d === null ? null : fin?.state === "recognized" && fin.recognizedOn && fin.recognizedOn > d ? fin.recognizedOn : d);
    const guarded = new Set<string>();
    const guard = (d: string | null) => {
      const e = entryDateOf(d);
      if (e) guarded.add(e);
    };
    guard(decidedOn);
    const values = {
      amount,
      recoveredAmount: recovered,
      currency,
      fee,
      feeCurrency,
      outcome,
      decidedOn,
      vatReducible: input.vatReducible,
      fullPartnerCancellation: input.fullPartnerCancellation,
      updatedBy: ctx.actor.id.slice(0, 120),
    };
    let disputeId: string;
    let created = false;
    let before: Record<string, unknown> | null = null;
    let version: number;
    if (input.disputeId) {
      const [d] = await tx
        .select()
        .from(orderDisputes)
        .where(and(eq(orderDisputes.id, input.disputeId), eq(orderDisputes.orderId, input.orderId)))
        .for("update");
      if (!d) throw new NotFoundError("dispute");
      if (input.expectedVersion !== undefined && input.expectedVersion !== null && input.expectedVersion !== d.version) throw new ConflictError();
      guard(d.decidedOn);
      await assertMonthsOpen(tx, [...guarded].sort());
      before = {
        disputeId: d.id,
        orderId: d.orderId,
        amount: d.amount,
        recoveredAmount: d.recoveredAmount,
        currency: d.currency?.trim() ?? null,
        fee: d.fee,
        feeCurrency: d.feeCurrency?.trim() ?? null,
        outcome: d.outcome,
        decidedOn: d.decidedOn,
        vatReducible: d.vatReducible,
        fullPartnerCancellation: d.fullPartnerCancellation,
        version: d.version,
      };
      const [u] = await tx
        .update(orderDisputes)
        .set({ ...values, version: sql`${orderDisputes.version} + 1`, statusChangedAt: d.outcome !== outcome ? now : d.statusChangedAt })
        .where(eq(orderDisputes.id, d.id))
        .returning({ version: orderDisputes.version });
      disputeId = d.id;
      version = u!.version;
    } else {
      const gid = `manual:${op}`;
      const inserted = await tx
        .insert(orderDisputes)
        .values({ storeId: DEFAULT_STORE_ID, orderId: input.orderId, disputeGid: gid, source: "manual", ...values, firstSeenAt: now, statusChangedAt: outcome ? now : null })
        .onConflictDoNothing({ target: [orderDisputes.storeId, orderDisputes.disputeGid] })
        .returning({ id: orderDisputes.id, version: orderDisputes.version });
      if (inserted.length === 0) {
        // Повтор тієї самої форми (той самий operationId) — нічого нового.
        const [d] = await tx.select({ id: orderDisputes.id, version: orderDisputes.version, orderId: orderDisputes.orderId }).from(orderDisputes).where(eq(orderDisputes.disputeGid, gid));
        if (!d || d.orderId !== input.orderId) throw new NotFoundError("dispute");
        return { disputeId: d.id, version: d.version, created: false };
      }
      // Новий спір у закритому місяці — відмова (вставку буде скасовано разом із транзакцією).
      await assertMonthsOpen(tx, [...guarded].sort());
      disputeId = inserted[0]!.id;
      version = inserted[0]!.version;
      created = true;
    }
    await writeFinanceChange(tx, ctx.actor, {
      entityType: "chargeback",
      entityId: disputeId,
      action: created ? "create" : "update",
      before,
      after: {
        disputeId,
        orderId: input.orderId,
        amount,
        recoveredAmount: recovered,
        currency,
        fee,
        feeCurrency,
        outcome,
        decidedOn,
        vatReducible: input.vatReducible,
        fullPartnerCancellation: input.fullPartnerCancellation,
        version,
      },
      reason,
    });
    await syncOrderFinanceAt(tx, ctx.actor, input.orderId, { now });
    await writeAudit(tx, ctx.actor, "finance.chargeback_saved", { type: "order", id: input.orderId }, { created, outcome: outcome ?? "open" });
    return { disputeId, version, created };
  });
}

/**
 * «Номер накладної перевізника» (зовнішній, §7.4): відправлено поза застосунком — номер для зіставлення з рахунком
 * перевізника. Нормалізація й класи номерів — ядро (recordExternalWaybills); після запису — синхронізація замовлення
 * (знімок прогнозу доставки, доданий після визнання, — late_snapshot).
 */
export async function addOrderExternalWaybill(
  ctx: Ctx,
  input: { orderId: string; number: string; carrierCode?: string | null },
): Promise<{ inserted: number; skipped: number; invalid: number; ownShipment: number }> {
  requireFinance(ctx, "manage");
  assertOrderId(input.orderId);
  const number = (input.number ?? "").trim().slice(0, EXTERNAL_WAYBILL_INPUT_MAX);
  if (!number) fail("waybillRequired", 400, { field: "number" });
  const carrierCode = input.carrierCode && /^[a-z0-9_-]{1,40}$/.test(input.carrierCode) ? input.carrierCode : null;
  const now = ctx.now();
  return ctx.db.transaction(async (tx) => {
    await lockFinanceOrder(tx, input.orderId);
    await loadOrderRow(tx, input.orderId);
    const r = await recordExternalWaybills(tx, ctx.actor, { orderId: input.orderId, source: "manual", numbers: [{ number, carrierCode }] });
    if (r.invalid > 0) fail("waybillInvalid", 400, { field: "number" });
    if (r.inserted > 0) await syncOrderFinanceAt(tx, ctx.actor, input.orderId, { now });
    await writeAudit(tx, ctx.actor, "finance.external_waybill_added", { type: "order", id: input.orderId }, { inserted: r.inserted, skipped: r.skipped, ownShipment: r.ownShipment });
    return r;
  });
}

/** «Перерахувати фінанси замовлення» (власник): бажаний стан наново (без мережевих запитів). */
export async function recalculateOrderFinance(ctx: Ctx, orderId: string): Promise<{ ok: true }> {
  requireFinance(ctx, "manage");
  assertOrderId(orderId);
  await ctx.db.transaction(async (tx) => {
    await loadOrderRow(tx, orderId);
    await syncOrderFinanceAt(tx, ctx.actor, orderId, { now: ctx.now() });
  });
  return { ok: true };
}

/** Скільки тестових замовлень перерахувати за одну транзакцію (resyncTestOrders). */
export const TEST_ORDERS_BATCH = 50;

/**
 * Перерахунок тестових замовлень після перемикання `finance.includeTestOrders` (§2.5): виключені → сторно записів (F2),
 * знову враховані → повторне проведення новим поколінням ключа (repostEntries). Для сторінки налаштувань фінансів
 * (WP10) — одразу після saveFinanceSettings; пакетами по TEST_ORDERS_BATCH замовлень, кожен пакет — окрема транзакція.
 */
export async function resyncTestOrders(ctx: Ctx): Promise<{ orders: number }> {
  requireFinance(ctx, "manage");
  const ids = await ctx.db.select({ id: orders.id }).from(orders).where(eq(orders.shopifyTest, true)).orderBy(orders.id);
  for (let i = 0; i < ids.length; i += TEST_ORDERS_BATCH) {
    const batch = ids.slice(i, i + TEST_ORDERS_BATCH);
    // FINO усіх замовлень пакета — одним упорядкованим набором ДО першої синхронізації (syncOrderFinanceMany): інакше
    // утримання завдання перерахунку розподілу попереднім замовленням + очікування FINO наступного = взаємоблокування з
    // паралельною синхронізацією того замовлення.
    await ctx.db.transaction((tx) => syncOrderFinanceMany(tx, SYSTEM_ACTOR, batch.map((b) => b.id), { now: ctx.now() }));
  }
  await writeAudit(ctx.db, ctx.actor, "finance.test_orders_resynced", { type: "system" }, { orders: ids.length });
  return { orders: ids.length };
}

/** Новий operationId для форм картки (uuid; новий після кожної успішної дії). */
export function newOperationId(): string {
  return randomUUID();
}

export { FLAG_OVERRIDES };
