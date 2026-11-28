/**
 * Етап 6, WP6: ручні витрати й доходи — СЕРВІСИ власника (docs/stage6-design.md §10.1–§10.3, §3.4, §14). Кожен сервіс
 * перевіряє requireFinance (керування — finance.manage, читання — finance.view; обидва + роль owner).
 *
 * - Один operationId — одна операція (унікальний `finance_expenses.operation_id` + FINANCE_OP_LOCK): повтор повертає
 *   ту саму витрату.
 * - Дата або будь-який день періоду послуги в закритому місяці — відмова «Місяць закрито…» (§3.4; під спільним
 *   FINANCE_PERIOD_LOCK — закриття паралельно з витратою дає або відмову, або запис до закриття).
 * - Редагування = новий рядок (`supersedes_id`) + анулювання старого (у журналі — сторно + нові записи, F2); історія
 *   змін зберігає до → після; причина обов'язкова. Анулювання — будь-якого рядка (зокрема «Списати невикористані
 *   витрати партії» WP2), з причиною.
 * - Додатна сума комісій (зі шлюзом) / доставки (з перевізником) / упаковки без замовлення — типово «замінює прогноз»
 *   (`covers_forecast`): розподіл на замовлення виміру без фактичного складника (allocation.server.ts), частки —
 *   фактичні записи замовлень, сама сума окремого запису не має; «Окрема витрата» — лише з причиною (I16).
 *   Без виміру (рахунок Shopify за тариф і застосунки, «Доставка (інше)» без перевізника) і кредит — звичайна витрата
 *   періоду (результат `coverageNote`). «Перерахувати розподіл» — нова версія (сторно + нові частки).
 * - Витрати на повернення (`return_shipping_cost`, `return_handling`) — з обов'язковим замовленням; випадок повернення
 *   (необов'язковий) має належати тому самому замовленню.
 * Суми — десяткові рядки (BigInt, app/lib/decimal.ts); відсутнє не підміняється нулем.
 */
import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, gte, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import type { DbOrTx, Tx } from "~/db/client.server";
import {
  financeEntries,
  financeExpenseAllocations,
  financeExpenses,
  orderExternalWaybills,
  orderFinance,
  orderFinanceForecasts,
  orderReturns,
  orders,
  partners,
  shipments,
} from "~/db/schema";
import { EXPENSE_CATEGORIES, type ExpenseCategory } from "~/domain/finance";
import type { Actor } from "~/domain/permissions";
import { ConflictError, DomainError, NotFoundError } from "~/lib/errors";
import { fromMinor, isSupportedCurrency, parseOwnerAmount, toMinor, toMinorForCurrency, UnsupportedCurrencyError } from "~/lib/decimal";
import { monthEnd, monthStart, parseIsoDate } from "~/lib/periods";
import { writeAudit } from "~/modules/audit/audit.server";
import { requireFinance } from "~/modules/finance/core/access.server";
import { listFinanceChanges, writeFinanceChange, type FinanceChangeRow } from "~/modules/finance/core/change-log.server";
import { assertMonthsOpen } from "~/modules/finance/core/closed-month.server";
import { lockFinanceOperation, lockFinanceOrders } from "~/modules/finance/core/locks.server";
import { loadFinanceSettings } from "~/modules/finance/core/settings.server";
import { DEFAULT_STORE_ID } from "~/modules/finance/core/store.server";
import { confirmItemEntries, isPackagingAccountedInTotal } from "~/modules/finance/periods/periods.server";
import { maskFreeTextNote } from "~/modules/privacy/notes";
import type { AppMode, ServiceContext } from "~/server/types";
import { computeAllocation, currentAllocations, sameAllocation, type ComputedAllocation } from "./allocation.server";
import { expenseOrderIds, loadOrderPostingStates, syncExpenseEntries } from "./posting.server";
import { lockExpenseRow, reallocateExpenseInTx } from "./reallocation.server";
import {
  BATCH_ONLY_CATEGORIES,
  datesTouched,
  EXPENSE_DESCRIPTION_MAX,
  EXPENSE_DOCUMENT_MAX,
  EXPENSE_GATEWAY_MAX,
  EXPENSE_REASON_MAX,
  coverageApplies,
  coverageNotApplicableReason,
  isCoveringCategory,
  isExpenseCategory,
  shapeError,
  type ExpenseChannel,
} from "./rules";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = Pick<ServiceContext, "db" | "actor" | "mode" | "now">;
export type ExpenseRow = typeof financeExpenses.$inferSelect;

/** Поля форми витрати (рядки з форми власника). */
export interface ExpenseInput {
  operationId: string;
  category: string;
  /** «1 234,50», «-120» (кредит). */
  amount: string;
  currency: string;
  /** Одна дата або період послуги. */
  dateMode: "single" | "period";
  expenseDate?: string | null;
  periodFrom?: string | null;
  periodTo?: string | null;
  description?: string | null;
  channel?: string | null;
  gateway?: string | null;
  carrierCode?: string | null;
  partnerId?: string | null;
  /** Номер замовлення («#1001» або «1001») або id. */
  order?: string | null;
  returnId?: string | null;
  document?: string | null;
  /** Для сум періоду комісій / доставки / упаковки без замовлення: «замінює прогноз» (типово) або «окрема». */
  coverage?: "covers" | "separate" | null;
  separateReason?: string | null;
}

/** no_dimension — без шлюзу / перевізника; credit — від'ємна сума (§10.3). */
export type CoverageNote = "no_dimension" | "credit" | null;

export interface ExpenseSaveResult {
  id: string;
  duplicate: boolean;
  version: number;
  /**
   * Сума категорії комісій / доставки / упаковки без замовлення, що НЕ замінює прогнози, бо вибір не застосовний
   * (`no_dimension`, `credit`); null — інакше.
   */
  coverageNote: CoverageNote;
  /** Розподіл суми періоду: замовлень з часткою (null — не розподілялась). */
  allocatedOrders: number | null;
  weightBasis: "forecast" | "revenue" | null;
  /** Проведено записів / сторновано / чекає визнання замовлень. */
  posted: number;
  reversed: number;
  awaiting: number;
}

interface Normalized {
  category: ExpenseCategory;
  amount: string;
  currency: string;
  expenseDate: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  description: string | null;
  channel: ExpenseChannel | null;
  gateway: string | null;
  carrierCode: string | null;
  partnerId: string | null;
  orderId: string | null;
  returnId: string | null;
  document: string | null;
  coversForecast: boolean;
  separateFromForecast: boolean;
  separateReason: string | null;
  /** Чому сума комісій / доставки / упаковки без замовлення — звичайна витрата періоду (не замінює прогнози). */
  coverageNote: CoverageNote;
}

const nul = (v: string | null | undefined) => {
  const s = (v ?? "").trim();
  return s === "" ? null : s;
};

/** Замовлення за номером («#1001» / «1001») або id. */
export async function resolveOrderRef(db: DbOrTx, ref: string): Promise<{ id: string; orderNumber: string } | null> {
  const r = ref.trim();
  if (!r) return null;
  if (UUID_RE.test(r)) {
    const [row] = await db.select({ id: orders.id, orderNumber: orders.orderNumber }).from(orders).where(eq(orders.id, r));
    return row ?? null;
  }
  const candidates = r.startsWith("#") ? [r] : [r, `#${r}`];
  const rows = await db.select({ id: orders.id, orderNumber: orders.orderNumber }).from(orders).where(inArray(orders.orderNumber, candidates));
  return rows.find((x) => x.orderNumber === r) ?? rows[0] ?? null;
}

async function normalize(db: DbOrTx, input: ExpenseInput, opts: { allowBatchOnly?: boolean } = {}): Promise<Normalized> {
  const category = (input.category ?? "").trim();
  if (!isExpenseCategory(category)) throw new DomainError("financeExpenses.error.categoryInvalid", 400);
  if (BATCH_ONLY_CATEGORIES.includes(category) && !opts.allowBatchOnly) throw new DomainError("financeExpenses.error.batchOnly", 400);
  const currency = (input.currency ?? "").trim().toUpperCase();
  if (!isSupportedCurrency(currency)) throw new DomainError("finance.error.unsupportedCurrency", 400, { currency: currency.slice(0, 3) });
  const parsed = parseOwnerAmount(input.amount);
  if (!parsed.ok) throw new DomainError(parsed.error, 400, { field: "amount" });
  let minor: bigint;
  try {
    minor = toMinorForCurrency(parsed.value, currency);
  } catch (e) {
    if (e instanceof UnsupportedCurrencyError) throw new DomainError("finance.error.unsupportedCurrency", 400, { currency });
    throw new DomainError("finance.error.amountWholeUnits", 400, { field: "amount" });
  }
  const single = input.dateMode !== "period";
  const expenseDate = single ? parseIsoDate(input.expenseDate) : null;
  const periodFrom = single ? null : parseIsoDate(input.periodFrom);
  const periodTo = single ? null : parseIsoDate(input.periodTo);
  if (single && !expenseDate) throw new DomainError("financeExpenses.error.dateInvalid", 400);
  if (!single && (!periodFrom || !periodTo)) throw new DomainError("financeExpenses.error.periodInvalid", 400);
  const gatewayRaw = nul(input.gateway);
  if (gatewayRaw && gatewayRaw.length > EXPENSE_GATEWAY_MAX) throw new DomainError("financeExpenses.error.gatewayInvalid", 400);
  const gateway = gatewayRaw ? gatewayRaw.replace(/[\u0000-\u001f\u007f]/g, "") : null;
  const carrierCode = nul(input.carrierCode)?.toLowerCase() ?? null;
  const channel = nul(input.channel);
  const partnerId = nul(input.partnerId);
  if (partnerId && !UUID_RE.test(partnerId)) throw new DomainError("financeExpenses.error.partnerNotFound", 404);
  // Замовлення й повернення.
  const orderRef = nul(input.order);
  const order = orderRef ? await resolveOrderRef(db, orderRef) : null;
  if (orderRef && !order) throw new DomainError("financeExpenses.error.orderNotFound", 404, { order: orderRef.slice(0, 40) });
  const returnId = nul(input.returnId);
  if (returnId) {
    if (!UUID_RE.test(returnId)) throw new DomainError("financeExpenses.error.returnNotFound", 404);
    const [ret] = await db.select({ id: orderReturns.id, orderId: orderReturns.orderId }).from(orderReturns).where(eq(orderReturns.id, returnId));
    if (!ret) throw new DomainError("financeExpenses.error.returnNotFound", 404);
    if (order && ret.orderId !== order.id) throw new DomainError("financeExpenses.error.returnOtherOrder", 400);
  }
  if (partnerId) {
    const [p] = await db.select({ id: partners.id }).from(partners).where(eq(partners.id, partnerId));
    if (!p) throw new DomainError("financeExpenses.error.partnerNotFound", 404);
  }
  // Вибір «замінює прогноз / окрема» — лише для додатної суми комісій / доставки / упаковки без замовлення з виміром
  // (шлюз / перевізник; упаковка — без виміру), §10.3. Інакше (кредит; рахунок Shopify за тариф без шлюзу; «Доставка
  // (інше)» без перевізника) — звичайна витрата періоду: вибір форми (типово «замінює») не застосовується.
  const coverageInput = { category, hasOrder: Boolean(order), amountMinor: minor, gateway, carrierCode };
  const coverage = coverageApplies(coverageInput) ? (input.coverage ?? "covers") : null;
  const coverageNote = isCoveringCategory(category) && !order ? coverageNotApplicableReason(coverageInput) : null;
  const separateReason = coverage === "separate" ? maskFreeTextNote(input.separateReason, EXPENSE_REASON_MAX) : null;
  const shape = {
    category,
    amountMinor: minor,
    currency,
    expenseDate,
    periodFrom,
    periodTo,
    channel,
    gateway,
    carrierCode,
    partnerId,
    hasOrder: Boolean(order),
    hasReturn: Boolean(returnId),
    coversForecast: coverage === "covers",
    separateFromForecast: coverage === "separate",
    separateReason,
  };
  const err = shapeError(shape);
  if (err) throw new DomainError(err, 400);
  return {
    category,
    amount: fromMinor(minor),
    currency,
    expenseDate,
    periodFrom,
    periodTo,
    description: maskFreeTextNote(input.description, EXPENSE_DESCRIPTION_MAX),
    channel: channel as ExpenseChannel | null,
    gateway,
    carrierCode,
    partnerId,
    orderId: order?.id ?? null,
    returnId,
    document: maskFreeTextNote(input.document, EXPENSE_DOCUMENT_MAX),
    coversForecast: shape.coversForecast,
    separateFromForecast: shape.separateFromForecast,
    separateReason,
    coverageNote,
  };
}

/** Поля для історії змін (без опису й документа — вільний текст не потрапляє в before/after). */
function logFields(r: Pick<ExpenseRow, "id" | "version" | "status" | "category" | "amount" | "currency" | "expenseDate" | "periodFrom" | "periodTo" | "channel" | "gateway" | "carrierCode" | "partnerId" | "orderId" | "returnId" | "productionBatchId" | "coversForecast" | "separateFromForecast" | "supersedesId">) {
  return {
    id: r.id,
    version: r.version,
    status: r.status,
    category: r.category,
    amount: r.amount,
    currency: r.currency,
    expenseDate: r.expenseDate,
    periodFrom: r.periodFrom,
    periodTo: r.periodTo,
    channel: r.channel,
    gateway: r.gateway,
    carrierCode: r.carrierCode,
    partnerId: r.partnerId,
    orderId: r.orderId,
    returnId: r.returnId,
    productionBatchId: r.productionBatchId,
    coversForecast: r.coversForecast,
    separateFromForecast: r.separateFromForecast,
    supersedesId: r.supersedesId,
  };
}

async function settingsOf(db: DbOrTx): Promise<{ includeTestOrders: boolean }> {
  const s = await loadFinanceSettings(db);
  return { includeTestOrders: s.includeTestOrders };
}

type AllocationOutcome = Pick<ExpenseSaveResult, "allocatedOrders" | "weightBasis" | "posted" | "reversed" | "awaiting">;

/**
 * Розрахунок розподілу нової версії рядка (лише читання; null — не сума, що замінює прогнози). replacedId — виправлення:
 * записи анульованої старої витрати (сторно ще попереду, після одного блокування замовлень) не роблять складник
 * фактичним.
 */
async function planAllocation(tx: Tx, row: ExpenseRow, mode: AppMode, replacedId?: string): Promise<{ computed: ComputedAllocation | null } | null> {
  if (!row.coversForecast || row.status !== "active") return null;
  return { computed: await computeAllocation(tx, row, { mode, ...(await settingsOf(tx)), ...(replacedId ? { ignoreExpenseId: replacedId } : {}) }) };
}

/** Частки (план з planAllocation) + історія розподілу + записи журналу для нової версії рядка. */
async function allocateAndPost(
  tx: Tx,
  actor: Actor,
  row: ExpenseRow,
  plan: { computed: ComputedAllocation | null } | null,
  now: Date,
): Promise<AllocationOutcome> {
  let allocatedOrders: number | null = null;
  let weightBasis: ExpenseSaveResult["weightBasis"] = null;
  if (plan) {
    const computed = plan.computed;
    if (computed) {
      await tx.insert(financeExpenseAllocations).values(
        computed.shares.map((s) => ({
          expenseId: row.id,
          expenseVersion: row.version,
          orderId: s.orderId,
          amount: fromMinor(s.minor),
          currency: row.currency,
          weightBasis: computed.weightBasis,
        })),
      );
      allocatedOrders = computed.shares.length;
      weightBasis = computed.weightBasis;
    } else allocatedOrders = 0;
    await writeFinanceChange(tx, actor, {
      entityType: "expense_allocation",
      entityId: row.id,
      action: row.version === 1 ? "create" : "update",
      after: {
        expenseId: row.id,
        expenseVersion: row.version,
        orders: allocatedOrders,
        total: row.amount,
        currency: row.currency,
        weightBasis: weightBasis ?? "none",
      },
      storeId: row.storeId,
    });
  }
  const r = await syncExpenseEntries(tx, actor, row.id, { now });
  return { allocatedOrders, weightBasis, ...r };
}

/** Замовлення нової версії рядка: замовлення витрати + частки плану (для одного впорядкованого блокування). */
function plannedOrderIds(row: ExpenseRow, plan: { computed: ComputedAllocation | null } | null): string[] {
  return [...(row.orderId ? [row.orderId] : []), ...(plan?.computed?.shares.map((s) => s.orderId) ?? [])];
}

function withoutNote(n: Normalized): Omit<Normalized, "coverageNote"> {
  const { coverageNote: _note, ...rest } = n;
  return rest;
}

/** Додає витрату або дохід (див. вгорі файла). */
export async function createExpense(ctx: Ctx, input: ExpenseInput): Promise<ExpenseSaveResult> {
  requireFinance(ctx, "manage");
  if (!UUID_RE.test(input.operationId ?? "")) throw new DomainError("financeExpenses.error.operationInvalid", 400);
  const op = input.operationId.toLowerCase();
  return ctx.db.transaction(async (tx) => {
    await lockFinanceOperation(tx, op);
    const [dup] = await tx.select().from(financeExpenses).where(eq(financeExpenses.operationId, op));
    if (dup) return { id: dup.id, duplicate: true, version: dup.version, coverageNote: null, allocatedOrders: null, weightBasis: null, posted: 0, reversed: 0, awaiting: 0 };
    const n = await normalize(tx, input);
    await assertMonthsOpen(tx, datesTouched(n));
    const id = randomUUID();
    await lockFinanceOperation(tx, `expense|${id}`);
    const [row] = await tx
      .insert(financeExpenses)
      .values({ id, ...withoutNote(n), operationId: op, createdBy: ctx.actor.id })
      .returning();
    const plan = await planAllocation(tx, row!, ctx.mode);
    const r = await allocateAndPost(tx, ctx.actor, row!, plan, ctx.now());
    await writeFinanceChange(tx, ctx.actor, {
      entityType: "expense",
      entityId: id,
      action: "create",
      after: logFields(row!),
      reason: n.separateReason,
    });
    await writeAudit(tx, ctx.actor, "finance.expense_created", { type: "finance_expense", id }, { posted: r.posted, allocatedOrders: r.allocatedOrders ?? 0 });
    return { id, duplicate: false, version: row!.version, coverageNote: n.coverageNote, ...r };
  });
}

/** Рядок витрати під блокуванням операції витрати (FOR UPDATE). */
const lockExpense = lockExpenseRow;

function checkVersion(row: ExpenseRow, expected: number | null | undefined) {
  if (expected !== undefined && expected !== null && expected !== row.version) throw new ConflictError();
}

export interface ReplaceExpenseInput extends ExpenseInput {
  expenseId: string;
  expectedVersion?: number | null;
  /** Причина виправлення (обов'язкова). */
  reason: string;
}

/**
 * Виправлення: новий рядок (supersedes_id) + анулювання старого; сторно старих записів і нові записи (F2).
 * Блокування (F10, §17.8): FINANCE_OP_LOCK обох рядків, потім FINANCE_ORDER_LOCK УСІХ зачеплених замовлень (старі записи
 * й частки + нове замовлення + частки нового розподілу) одним упорядкованим набором — до будь-якого проведення.
 */
export async function replaceExpense(ctx: Ctx, input: ReplaceExpenseInput): Promise<ExpenseSaveResult & { replacedId: string }> {
  requireFinance(ctx, "manage");
  if (!UUID_RE.test(input.operationId ?? "")) throw new DomainError("financeExpenses.error.operationInvalid", 400);
  const reason = maskFreeTextNote(input.reason, EXPENSE_REASON_MAX);
  if (!reason) throw new DomainError("financeExpenses.error.reasonRequired", 400);
  const op = input.operationId.toLowerCase();
  return ctx.db.transaction(async (tx) => {
    await lockFinanceOperation(tx, op);
    const [dup] = await tx.select().from(financeExpenses).where(eq(financeExpenses.operationId, op));
    if (dup) {
      return {
        id: dup.id,
        duplicate: true,
        version: dup.version,
        replacedId: dup.supersedesId ?? input.expenseId,
        coverageNote: null,
        allocatedOrders: null,
        weightBasis: null,
        posted: 0,
        reversed: 0,
        awaiting: 0,
      };
    }
    const old = await lockExpense(tx, input.expenseId);
    if (old.status !== "active") throw new DomainError("financeExpenses.error.alreadyVoided", 409);
    checkVersion(old, input.expectedVersion);
    if (BATCH_ONLY_CATEGORIES.includes(old.category as ExpenseCategory)) throw new DomainError("financeExpenses.error.batchOnly", 400);
    const n = await normalize(tx, input);
    await assertMonthsOpen(tx, [...datesTouched(old), ...datesTouched(n)]);
    const voidedAt = ctx.now();
    const [voided] = await tx
      .update(financeExpenses)
      .set({ status: "voided", voidedAt, voidReason: reason, version: old.version + 1 })
      .where(and(eq(financeExpenses.id, old.id), eq(financeExpenses.version, old.version)))
      .returning();
    if (!voided) throw new ConflictError();
    const id = randomUUID();
    await lockFinanceOperation(tx, `expense|${id}`);
    const [row] = await tx
      .insert(financeExpenses)
      .values({ id, ...withoutNote(n), operationId: op, supersedesId: old.id, createdBy: ctx.actor.id })
      .returning();
    // Розподіл нової версії — після анулювання старої (її замовлення знову кандидати), лише читання.
    const plan = await planAllocation(tx, row!, ctx.mode, old.id);
    await lockFinanceOrders(tx, [...(await expenseOrderIds(tx, voided)), ...plannedOrderIds(row!, plan)]);
    const oldEntries = await syncExpenseEntries(tx, ctx.actor, old.id, { now: voidedAt });
    const r = await allocateAndPost(tx, ctx.actor, row!, plan, ctx.now());
    await writeFinanceChange(tx, ctx.actor, {
      entityType: "expense",
      entityId: old.id,
      action: "replace",
      before: logFields(old),
      after: logFields(voided),
      reason,
    });
    await writeFinanceChange(tx, ctx.actor, {
      entityType: "expense",
      entityId: id,
      action: "create",
      before: logFields(old),
      after: logFields(row!),
      reason,
    });
    await writeAudit(tx, ctx.actor, "finance.expense_replaced", { type: "finance_expense", id }, { replacedId: old.id, reversed: oldEntries.reversed, posted: r.posted });
    return { id, duplicate: false, version: row!.version, replacedId: old.id, coverageNote: n.coverageNote, ...r, reversed: r.reversed + oldEntries.reversed };
  });
}

export interface VoidExpenseInput {
  expenseId: string;
  reason: string;
  expectedVersion?: number | null;
}

/** Анулювання будь-якого рядка finance_expenses (з причиною): сторно всіх його записів (F2), статус voided. */
export async function voidExpense(ctx: Ctx, input: VoidExpenseInput): Promise<{ voided: boolean; reversed: number }> {
  requireFinance(ctx, "manage");
  const reason = maskFreeTextNote(input.reason, EXPENSE_REASON_MAX);
  if (!reason) throw new DomainError("financeExpenses.error.reasonRequired", 400);
  return ctx.db.transaction(async (tx) => {
    const row = await lockExpense(tx, input.expenseId);
    if (row.status === "voided") return { voided: false, reversed: 0 };
    checkVersion(row, input.expectedVersion);
    await assertMonthsOpen(tx, datesTouched(row));
    const [updated] = await tx
      .update(financeExpenses)
      .set({ status: "voided", voidedAt: ctx.now(), voidReason: reason, version: row.version + 1 })
      .where(and(eq(financeExpenses.id, row.id), eq(financeExpenses.version, row.version)))
      .returning();
    if (!updated) throw new ConflictError();
    const r = await syncExpenseEntries(tx, ctx.actor, row.id, { now: ctx.now() });
    await writeFinanceChange(tx, ctx.actor, {
      entityType: "expense",
      entityId: row.id,
      action: "void",
      before: { status: row.status, version: row.version },
      after: { status: updated.status, version: updated.version },
      reason,
      storeId: row.storeId,
    });
    await writeAudit(tx, ctx.actor, "finance.expense_voided", { type: "finance_expense", id: row.id }, { reversed: r.reversed });
    return { voided: true, reversed: r.reversed };
  });
}

/**
 * «Перерахувати розподіл» суми періоду: якщо кандидати чи прогнози змінилися — нова версія (сторно старих часток /
 * запису періоду + нові); інакше без змін.
 */
export async function recalculateAllocation(
  ctx: Ctx,
  input: { expenseId: string; expectedVersion?: number | null },
): Promise<{ changed: boolean; version: number; allocatedOrders: number; posted: number; reversed: number; awaiting: number }> {
  requireFinance(ctx, "manage");
  // Той самий перерахунок виконує завдання finance.expense_reallocate (reallocation.server.ts) — від SYSTEM_ACTOR.
  return ctx.db.transaction((tx) => reallocateExpenseInTx(tx, ctx.actor, input.expenseId, { mode: ctx.mode, now: ctx.now(), expectedVersion: input.expectedVersion }));
}

// ---------------------------------------------------------------------------
// Читання (finance.view)
// ---------------------------------------------------------------------------

export interface ExpenseListFilter {
  /** YYYY-MM-01: витрати, дата або період яких перетинає місяць. */
  month?: string | null;
  category?: string | null;
  status?: "active" | "voided" | "all";
  /** Лише доходи / лише витрати. */
  limit?: number;
  offset?: number;
}

export interface ExpenseListItem {
  id: string;
  version: number;
  status: "active" | "voided";
  category: ExpenseCategory;
  amount: string;
  currency: string;
  expenseDate: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  description: string | null;
  channel: string | null;
  gateway: string | null;
  carrierCode: string | null;
  partner: { id: string; name: string } | null;
  order: { id: string; number: string } | null;
  returnId: string | null;
  productionBatchId: string | null;
  document: string | null;
  coversForecast: boolean;
  separateFromForecast: boolean;
  separateReason: string | null;
  supersedesId: string | null;
  supersededById: string | null;
  voidReason: string | null;
  voidedAt: string | null;
  createdAt: string;
  allocation: { orders: number; withShare: number; awaiting: number; weightBasis: string | null } | null;
  /** Чекає визнання замовлення (витрата із замовленням без запису). */
  awaitingOrder: boolean;
}

function monthOverlap(month: string): SQL {
  const from = monthStart(month);
  const to = monthEnd(month);
  return or(
    and(gte(financeExpenses.expenseDate, from), lte(financeExpenses.expenseDate, to)),
    and(lte(financeExpenses.periodFrom, to), gte(financeExpenses.periodTo, from)),
  )!;
}

/** Список витрат (finance.view), новіші першими. */
export async function listExpenses(ctx: Pick<ServiceContext, "db" | "actor">, filter: ExpenseListFilter = {}): Promise<{ items: ExpenseListItem[]; total: number }> {
  requireFinance(ctx, "view");
  const conds: SQL[] = [eq(financeExpenses.storeId, DEFAULT_STORE_ID)];
  const month = filter.month ? parseIsoDate(filter.month) : null;
  if (month) conds.push(monthOverlap(month));
  if (filter.category && (EXPENSE_CATEGORIES as readonly string[]).includes(filter.category)) conds.push(eq(financeExpenses.category, filter.category));
  const status = filter.status ?? "active";
  if (status !== "all") conds.push(eq(financeExpenses.status, status));
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const offset = Math.max(filter.offset ?? 0, 0);
  const [totalRow] = await ctx.db.select({ c: count() }).from(financeExpenses).where(and(...conds));
  const rows = await ctx.db
    .select()
    .from(financeExpenses)
    .where(and(...conds))
    .orderBy(desc(sql`coalesce(${financeExpenses.expenseDate}, ${financeExpenses.periodFrom})`), desc(financeExpenses.createdAt), asc(financeExpenses.id))
    .limit(limit)
    .offset(offset);
  return { items: await describeRows(ctx.db, rows), total: Number(totalRow?.c ?? 0) };
}

async function describeRows(db: DbOrTx, rows: readonly ExpenseRow[]): Promise<ExpenseListItem[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const orderIds = [...new Set(rows.map((r) => r.orderId).filter((v): v is string => v !== null))];
  const partnerIds = [...new Set(rows.map((r) => r.partnerId).filter((v): v is string => v !== null))];
  const [orderRows, partnerRows, successors, allocs] = await Promise.all([
    orderIds.length ? db.select({ id: orders.id, number: orders.orderNumber }).from(orders).where(inArray(orders.id, orderIds)) : [],
    partnerIds.length ? db.select({ id: partners.id, name: partners.displayName }).from(partners).where(inArray(partners.id, partnerIds)) : [],
    db.select({ id: financeExpenses.id, supersedesId: financeExpenses.supersedesId }).from(financeExpenses).where(inArray(financeExpenses.supersedesId, ids)),
    db
      .select({ expenseId: financeExpenseAllocations.expenseId, version: financeExpenseAllocations.expenseVersion, orderId: financeExpenseAllocations.orderId, amount: financeExpenseAllocations.amount, basis: financeExpenseAllocations.weightBasis })
      .from(financeExpenseAllocations)
      .where(inArray(financeExpenseAllocations.expenseId, ids)),
  ]);
  const allocOrderIds = [...new Set(allocs.map((a) => a.orderId))];
  const states = await loadOrderPostingStates(db, [...orderIds, ...allocOrderIds]);
  const orderById = new Map(orderRows.map((o) => [o.id, o.number]));
  const partnerById = new Map(partnerRows.map((p) => [p.id, p.name]));
  const successorOf = new Map(successors.map((s) => [s.supersedesId!, s.id]));
  const waiting = (orderId: string) => {
    const s = states.get(orderId)?.state ?? "none";
    return s === "open" || s === "none";
  };
  return rows.map((r) => {
    const current = allocs.filter((a) => a.expenseId === r.id && a.version === r.version);
    return {
      id: r.id,
      version: r.version,
      status: r.status === "voided" ? "voided" : "active",
      category: r.category as ExpenseCategory,
      amount: r.amount,
      currency: r.currency.trim(),
      expenseDate: r.expenseDate,
      periodFrom: r.periodFrom,
      periodTo: r.periodTo,
      description: r.description,
      channel: r.channel,
      gateway: r.gateway,
      carrierCode: r.carrierCode,
      partner: r.partnerId ? { id: r.partnerId, name: partnerById.get(r.partnerId) ?? "—" } : null,
      order: r.orderId ? { id: r.orderId, number: orderById.get(r.orderId) ?? "—" } : null,
      returnId: r.returnId,
      productionBatchId: r.productionBatchId,
      document: r.document,
      coversForecast: r.coversForecast,
      separateFromForecast: r.separateFromForecast,
      separateReason: r.separateReason,
      supersedesId: r.supersedesId,
      supersededById: successorOf.get(r.id) ?? null,
      voidReason: r.voidReason,
      voidedAt: r.voidedAt ? r.voidedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
      allocation: r.coversForecast
        ? {
            orders: current.length,
            withShare: current.filter((a) => toMinor(a.amount) !== 0n).length,
            awaiting: current.filter((a) => toMinor(a.amount) !== 0n && waiting(a.orderId)).length,
            weightBasis: current[0]?.basis ?? null,
          }
        : null,
      awaitingOrder: r.status === "active" && r.orderId !== null && waiting(r.orderId),
    };
  });
}

export interface ExpenseDetail extends ExpenseListItem {
  shares: Array<{ orderId: string; orderNumber: string; amount: string; currency: string; weightBasis: string; posted: boolean; orderState: string }>;
  history: FinanceChangeRow[];
}

/** Витрата з частками розподілу й історією змін (finance.view). */
export async function getExpense(ctx: Pick<ServiceContext, "db" | "actor">, id: string): Promise<ExpenseDetail> {
  requireFinance(ctx, "view");
  if (!UUID_RE.test(id ?? "")) throw new NotFoundError("finance_expense");
  const [row] = await ctx.db.select().from(financeExpenses).where(eq(financeExpenses.id, id));
  if (!row) throw new NotFoundError("finance_expense");
  const [item] = await describeRows(ctx.db, [row]);
  const allocs = await currentAllocations(ctx.db, row);
  const numbers = allocs.length
    ? await ctx.db.select({ id: orders.id, number: orders.orderNumber }).from(orders).where(inArray(orders.id, allocs.map((a) => a.orderId)))
    : [];
  const numberOf = new Map(numbers.map((n) => [n.id, n.number]));
  const states = await loadOrderPostingStates(ctx.db, allocs.map((a) => a.orderId));
  const history = await listFinanceChanges(ctx, { entityId: row.id, limit: 50 });
  return {
    ...item!,
    shares: allocs.map((a) => {
      const s = states.get(a.orderId)?.state ?? "none";
      return {
        orderId: a.orderId,
        orderNumber: numberOf.get(a.orderId) ?? "—",
        amount: a.amount,
        currency: a.currency.trim(),
        weightBasis: a.weightBasis,
        posted: row.status === "active" && toMinor(a.amount) !== 0n && s !== "open" && s !== "none",
        orderState: s,
      };
    }),
    history,
  };
}

/** Повернення замовлення для форми витрати на повернення (finance.view): лише id, вид, стан — без сум. */
export async function orderForExpenseForm(
  ctx: Pick<ServiceContext, "db" | "actor">,
  ref: string,
): Promise<{ id: string; orderNumber: string; returns: Array<{ id: string; kind: string; status: string }> } | null> {
  requireFinance(ctx, "view");
  const order = await resolveOrderRef(ctx.db, ref);
  if (!order) return null;
  const returns = await ctx.db
    .select({ id: orderReturns.id, kind: orderReturns.kind, status: orderReturns.status })
    .from(orderReturns)
    .where(eq(orderReturns.orderId, order.id))
    .orderBy(desc(orderReturns.createdAt));
  return { ...order, returns };
}

/** Партнери для форми (власник бачить імена своїх контрагентів, §9.1). */
export async function partnerOptions(ctx: Pick<ServiceContext, "db" | "actor">): Promise<Array<{ id: string; name: string }>> {
  requireFinance(ctx, "view");
  const rows = await ctx.db
    .select({ id: partners.id, name: partners.displayName })
    .from(partners)
    .where(and(eq(partners.storeId, DEFAULT_STORE_ID), inArray(partners.status, ["active", "paused"])))
    .orderBy(asc(partners.displayName));
  return rows;
}

export interface CoverageWarnings {
  stale: Array<{ expenseId: string; category: string; current: number; next: number }>;
  periodTotals: Array<{ expenseId: string; category: string }>;
  /** Загальна сума упаковки поряд із прогнозами упаковки замовлень місяця (дія — підтвердження на «Місяцях»). */
  packaging: { month: string; totals: number; ordersWithForecast: number } | null;
}

/**
 * Попередження про подвійний облік за місяць (finance.view, §10.3): суми періоду, розподіл яких застарів (є нові
 * кандидати або змінилися прогнози — «Перерахувати розподіл»), і суми, проведені одним записом періоду без
 * відповідних замовлень. Лише id і кількості.
 */
export async function coverageWarnings(
  ctx: Pick<ServiceContext, "db" | "actor" | "mode">,
  month: string,
): Promise<CoverageWarnings> {
  requireFinance(ctx, "view");
  const m = parseIsoDate(month);
  if (!m) return { stale: [], periodTotals: [], packaging: null };
  const rows = await ctx.db
    .select()
    .from(financeExpenses)
    .where(and(eq(financeExpenses.storeId, DEFAULT_STORE_ID), eq(financeExpenses.status, "active"), eq(financeExpenses.coversForecast, true), isNull(financeExpenses.orderId), monthOverlap(m)))
    .orderBy(asc(financeExpenses.createdAt))
    .limit(50);
  const settings = await settingsOf(ctx.db);
  const stale: Array<{ expenseId: string; category: string; current: number; next: number }> = [];
  const periodTotals: Array<{ expenseId: string; category: string }> = [];
  for (const r of rows) {
    const current = await currentAllocations(ctx.db, r);
    let computed;
    try {
      computed = await computeAllocation(ctx.db, r, { mode: ctx.mode, ...settings });
    } catch {
      computed = undefined;
    }
    if (computed !== undefined && !sameAllocation(current, computed)) {
      stale.push({ expenseId: r.id, category: r.category, current: current.length, next: computed?.shares.length ?? 0 });
    } else if (current.length === 0) periodTotals.push({ expenseId: r.id, category: r.category });
  }
  return { stale, periodTotals, packaging: await packagingTotalWarning(ctx.db, monthStart(m)) };
}

/**
 * Загальна сума упаковки за місяць (packaging_unlinked або упаковка без замовлення) поряд із прогнозами упаковки
 * замовлень, визнаних у місяці, поки власник не підтвердив «Упаковку … обліковано загальною сумою» (§10.3, §2.6).
 */
async function packagingTotalWarning(db: DbOrTx, month: string): Promise<CoverageWarnings["packaging"]> {
  const to = monthEnd(month);
  // Той самий предикат, що й пункт чек-листа: лише діючі записи (без сторно й сторнованих оригіналів).
  const totals = await confirmItemEntries(db, month, "packaging_total_accounted");
  if (totals === 0) return null;
  const [withForecast] = await db
    .select({ c: count() })
    .from(orderFinanceForecasts)
    .innerJoin(orderFinance, eq(orderFinance.orderId, orderFinanceForecasts.orderId))
    .where(
      and(
        eq(orderFinanceForecasts.component, "packaging"),
        eq(orderFinance.state, "recognized"),
        gte(orderFinance.recognizedOn, month),
        lte(orderFinance.recognizedOn, to),
      ),
    );
  const orders = Number(withForecast?.c ?? 0);
  if (orders === 0 || (await isPackagingAccountedInTotal(db, month))) return null;
  return { month, totals, ordersWithForecast: orders };
}

/** Коди перевізників, побачені у відправленнях і зовнішніх номерах (finance.view) — підказки форми. */
export async function carrierCodeOptions(ctx: Pick<ServiceContext, "db" | "actor">): Promise<string[]> {
  requireFinance(ctx, "view");
  const [a, b] = await Promise.all([
    ctx.db.selectDistinct({ c: shipments.carrierCode }).from(shipments).limit(50),
    ctx.db.selectDistinct({ c: orderExternalWaybills.carrierCode }).from(orderExternalWaybills).limit(50),
  ]);
  return [...new Set([...a, ...b].map((r) => r.c).filter((c): c is string => typeof c === "string" && c.length > 0))].sort();
}
