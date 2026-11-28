/**
 * Етап 6, WP6: проведення ручних витрат і часток сум періоду в журнал — ВНУТРІШНІ функції (F8, §14.1): актора не
 * перевіряють, пишуть лише posted_by і НЕ повертають грошей (лише кількості). Сторінки, маршрути, команди й ШІ їх не
 * імпортують (сервіси витрат — expenses.server.ts — викликають їх у своїй транзакції; WP4 syncOrderFinance — під
 * FINANCE_ORDER_LOCK замовлення).
 *
 * Бажаний стан (desired state) записів кожної витрати (`source_type` expense | allocation, `source_id` = id витрати):
 * - анульована → жодного діючого запису (сторно F2: дата й дата курсу оригіналу);
 * - із замовленням (§3.3): визнане — R1/R3 (дата визнання; повернення й комісія chargeback — R2: max(дата, визнання));
 *   скасоване до відвантаження / не враховане — R5 (дата витрати); ще не відвантажене — запис чекає визнання (немає
 *   запису); дата курсу — дата витрати. Ключ `exp:<id>:v<версія>`;
 * - сума періоду з `covers_forecast` і частками (`finance_expense_allocations` поточної версії) → лише частки
 *   (`alloc:<id>:<orderId>:v<версія>`, дата періоду — дата визнання замовлення, дата курсу — дата документа суми (R3);
 *   частки нуль і невизнані замовлення — без запису); сама сума окремого запису НЕ має (без подвійного обліку, I16);
 * - інакше — запис періоду на дату (`exp:<id>:v<версія>`) або по дню періоду послуги (`exp:<id>:v<версія>:<день>`, §10.2).
 * Розбіжність діючих записів з бажаними → сторно зайвих + проведення відсутніх (repostEntries: факт, сторнований
 * раніше, проводиться новим поколінням ключа). Збіг — за базовим ключем, категорією, сумою, валютою, справжньою датою
 * (`original_on`; запис закритого місяця має recognized_on = дата проведення) і датою курсу.
 *
 * Блокування (F10, §17.8): викликач тримає FINANCE_OP_LOCK витрати; syncExpenseEntries бере FINANCE_ORDER_LOCK кожного
 * зачепленого замовлення (у порядку id) перед порівнянням; syncOrderExpenseEntries (для WP4) нових блокувань не бере —
 * викликач уже тримає FINANCE_ORDER_LOCK замовлення.
 */
import { and, eq, inArray, isNull, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DbOrTx, Tx } from "~/db/client.server";
import { financeEntries, financeExpenseAllocations, financeExpenses, orderFinance } from "~/db/schema";
import type { ExpenseCategory, FinanceCategory } from "~/domain/finance";
import { fromMinor, toMinor, toMinorForCurrency } from "~/lib/decimal";
import type { PostingActor } from "~/modules/finance/core/contracts";
import { repostEntries, reverseEntries, type EntryInput } from "~/modules/finance/core/entries.server";
import { financeKeys } from "~/modules/finance/core/keys";
import { lockFinanceOrders } from "~/modules/finance/core/locks.server";
import { syncOrderFinanceAt } from "~/modules/order-finance/sync.server";
import { dailyShares, entryAmountMinor, orderExpenseRecognizedOn, type OrderRecognitionState } from "./rules";

const reversals = alias(financeEntries, "fe_exp_rev");

type ExpenseRow = typeof financeExpenses.$inferSelect;
type AllocationRow = typeof financeExpenseAllocations.$inferSelect;

/**
 * Категорії-складники замовлення: перша ручна сума після визнання — «пізнє завершення» (R3). Комісія chargeback — не
 * складник (§2.6), а пізніша подія (R2, POST_RECOGNITION_EVENT_CATEGORIES): без позначки.
 */
const COMPONENT_CATEGORIES: readonly ExpenseCategory[] = ["shipping_cost", "duties_paid", "packaging", "payment_fees", "platform_fees"];

export interface OrderPostingState extends OrderRecognitionState {
  recognizedAt: Date | null;
}

/** Стан фінансів замовлень (order_finance; рядка немає — «none», факт чекає). */
export async function loadOrderPostingStates(db: DbOrTx, orderIds: readonly string[]): Promise<Map<string, OrderPostingState>> {
  const out = new Map<string, OrderPostingState>();
  const ids = [...new Set(orderIds)];
  for (const id of ids) out.set(id, { state: "none", recognizedOn: null, recognizedAt: null });
  if (ids.length === 0) return out;
  const rows = await db
    .select({ orderId: orderFinance.orderId, state: orderFinance.state, recognizedOn: orderFinance.recognizedOn, recognizedAt: orderFinance.recognizedAt })
    .from(orderFinance)
    .where(inArray(orderFinance.orderId, ids));
  for (const r of rows) out.set(r.orderId, { state: r.state, recognizedOn: r.recognizedOn, recognizedAt: r.recognizedAt });
  return out;
}

/** Дата, від якої рахується курс частки / витрати із замовленням (власна дата значення, R3). */
export function expenseReferenceDate(row: Pick<ExpenseRow, "expenseDate" | "periodTo">): string {
  const d = row.expenseDate ?? row.periodTo;
  if (!d) throw new RangeError("expense without a date");
  return d;
}

function baseDetails(row: ExpenseRow): Record<string, string | number | boolean | null> {
  return {
    kind: "manual",
    expenseVersion: row.version,
    ...(row.channel ? { channel: row.channel } : {}),
    ...(row.gateway ? { gateway: row.gateway } : {}),
    ...(row.returnId ? { returnId: row.returnId } : {}),
    ...(row.productionBatchId ? { productionBatchId: row.productionBatchId } : {}),
    ...(row.supersedesId ? { supersedesId: row.supersedesId } : {}),
  };
}

/**
 * Бажані записи витрати (див. вгорі файла). allocations — поточна версія; orders — стани замовлень витрати й часток.
 * Ключі — базові (без покоління).
 */
export function desiredExpenseEntries(row: ExpenseRow, allocations: readonly AllocationRow[], orders: ReadonlyMap<string, OrderPostingState>): EntryInput[] {
  if (row.status !== "active") return [];
  const category = row.category as ExpenseCategory;
  const ownerMinor = toMinorForCurrency(row.amount, row.currency);
  const common = {
    category: category as FinanceCategory,
    currency: row.currency,
    sourceId: row.id,
    storeId: row.storeId,
    carrierCode: row.carrierCode,
    partnerId: row.partnerId,
  };
  if (row.orderId) {
    const refDate = expenseReferenceDate(row);
    const order = orders.get(row.orderId) ?? { state: "none", recognizedOn: null, recognizedAt: null };
    const recognizedOn = orderExpenseRecognizedOn(category, refDate, order);
    if (!recognizedOn) return [];
    const late = order.state === "recognized" && COMPONENT_CATEGORIES.includes(category) && order.recognizedAt !== null && order.recognizedAt < row.createdAt;
    return [
      {
        ...common,
        idempotencyKey: financeKeys.expense(row.id, row.version),
        recognizedOn,
        fxOn: refDate,
        originalOn: recognizedOn,
        isLateCompletion: late,
        amount: fromMinor(entryAmountMinor(category, ownerMinor)),
        orderId: row.orderId,
        sourceType: "expense",
        details: baseDetails(row),
      },
    ];
  }
  if (row.coversForecast && allocations.length > 0) {
    // Дата курсу частки — власна дата значення (R3, §3.3): дата документа суми (кінець періоду послуги), як у записі
    // періоду й у ручної витрати замовлення; Σ часток у валюті звітності не залежить від дат відвантаження замовлень.
    const refDate = expenseReferenceDate(row);
    const out: EntryInput[] = [];
    for (const a of allocations) {
      const minor = toMinor(a.amount);
      if (minor === 0n) continue;
      const order = orders.get(a.orderId) ?? { state: "none", recognizedOn: null, recognizedAt: null };
      const recognizedOn = orderExpenseRecognizedOn(category, refDate, order);
      if (!recognizedOn) continue;
      out.push({
        ...common,
        idempotencyKey: financeKeys.allocation(row.id, a.orderId, row.version),
        recognizedOn,
        fxOn: refDate,
        originalOn: recognizedOn,
        isLateCompletion: order.state === "recognized" && order.recognizedAt !== null && order.recognizedAt < a.createdAt,
        amount: fromMinor(entryAmountMinor(category, minor)),
        currency: a.currency,
        orderId: a.orderId,
        sourceType: "allocation",
        details: { ...baseDetails(row), kind: "allocation", allocationId: a.id, weightBasis: a.weightBasis },
      });
    }
    return out;
  }
  if (row.periodFrom && row.periodTo) {
    return dailyShares(entryAmountMinor(category, ownerMinor), row.currency, row.periodFrom, row.periodTo).map((d) => ({
      ...common,
      idempotencyKey: financeKeys.expense(row.id, row.version, d.day),
      recognizedOn: d.day,
      fxOn: d.day,
      amount: fromMinor(d.minor),
      sourceType: "expense" as const,
      details: { ...baseDetails(row), periodFrom: row.periodFrom!, periodTo: row.periodTo! },
    }));
  }
  const date = expenseReferenceDate(row);
  return [
    {
      ...common,
      idempotencyKey: financeKeys.expense(row.id, row.version),
      recognizedOn: date,
      fxOn: date,
      amount: fromMinor(entryAmountMinor(category, ownerMinor)),
      sourceType: "expense",
      details: { ...baseDetails(row), ...(row.coversForecast ? { kind: "period_total" } : {}) },
    },
  ];
}

interface ActiveRow {
  id: string;
  idempotencyKey: string;
  category: string;
  amount: string;
  currency: string;
  originalOn: string;
  fxOn: string;
  orderId: string | null;
}

/** Діючі записи витрати (усі або лише замовлення orderId). */
async function activeExpenseEntries(db: DbOrTx, expenseId: string, orderId?: string): Promise<ActiveRow[]> {
  const rows = await db
    .select({
      id: financeEntries.id,
      idempotencyKey: financeEntries.idempotencyKey,
      category: financeEntries.category,
      amount: financeEntries.amount,
      currency: financeEntries.currency,
      originalOn: financeEntries.originalOn,
      fxOn: financeEntries.fxOn,
      orderId: financeEntries.orderId,
    })
    .from(financeEntries)
    .where(
      and(
        eq(financeEntries.sourceId, expenseId),
        inArray(financeEntries.sourceType, ["expense", "allocation"]),
        isNull(financeEntries.reversesEntryId),
        orderId ? eq(financeEntries.orderId, orderId) : undefined,
        notExists(db.select({ one: sql`1` }).from(reversals).where(eq(reversals.reversesEntryId, financeEntries.id))),
      ),
    )
    .orderBy(financeEntries.seq);
  return rows.map((r) => ({ ...r, currency: r.currency.trim() }));
}

const GEN_RE = /:g[1-9]\d*$/;
const baseKeyOf = (key: string) => key.replace(GEN_RE, "");

const sameFact = (a: ActiveRow, d: EntryInput) =>
  baseKeyOf(a.idempotencyKey) === d.idempotencyKey &&
  a.category === d.category &&
  a.currency === d.currency &&
  toMinor(a.amount) === toMinor(d.amount) &&
  a.originalOn === (d.originalOn ?? d.recognizedOn) &&
  a.fxOn === d.fxOn &&
  (a.orderId ?? null) === (d.orderId ?? null);

export interface SyncExpenseResult {
  posted: number;
  reversed: number;
  /** Частки / витрата із замовленням, що чекають визнання замовлення (без запису). */
  awaiting: number;
}

async function applyDiff(tx: Tx, actor: PostingActor, desired: readonly EntryInput[], active: readonly ActiveRow[], now?: Date): Promise<{ posted: number; reversed: number }> {
  const keep = new Set<string>();
  const toReverse: string[] = [];
  const satisfied = new Set<number>();
  for (const a of active) {
    const i = desired.findIndex((d, idx) => !satisfied.has(idx) && sameFact(a, d));
    if (i >= 0) {
      satisfied.add(i);
      keep.add(a.id);
    } else toReverse.push(a.id);
  }
  const { reversed } = toReverse.length ? await reverseEntries(tx, actor, toReverse, { reasonCode: "expense_changed", now }) : { reversed: 0 };
  const missing = desired.filter((_d, idx) => !satisfied.has(idx));
  const r = missing.length ? await repostEntries(tx, actor, missing, { now }) : { inserted: 0 };
  return { posted: r.inserted, reversed };
}

async function loadAllocationsFor(db: DbOrTx, row: ExpenseRow): Promise<AllocationRow[]> {
  return db
    .select()
    .from(financeExpenseAllocations)
    .where(and(eq(financeExpenseAllocations.expenseId, row.id), eq(financeExpenseAllocations.expenseVersion, row.version)));
}

function countAwaiting(row: ExpenseRow, allocations: readonly AllocationRow[], orders: ReadonlyMap<string, OrderPostingState>): number {
  if (row.status !== "active") return 0;
  const waiting = (orderId: string) => {
    const s = orders.get(orderId)?.state ?? "none";
    return s === "open" || s === "none";
  };
  if (row.orderId) return waiting(row.orderId) ? 1 : 0;
  if (row.coversForecast) return allocations.filter((a) => toMinor(a.amount) !== 0n && waiting(a.orderId)).length;
  return 0;
}

/**
 * Замовлення, FINANCE_ORDER_LOCK яких бере syncExpenseEntries для рядка: замовлення витрати, частки поточної версії й
 * замовлення діючих записів. Викликач, що проводить кілька витрат в одній транзакції (виправлення: стара + нова),
 * блокує об'єднання цих наборів ОДНИМ упорядкованим викликом lockFinanceOrders до першого проведення (F10): повторне
 * блокування вже взятого замовлення миттєве, нових — поза порядком — не буде.
 */
export async function expenseOrderIds(db: DbOrTx, row: ExpenseRow, allocations?: readonly AllocationRow[]): Promise<string[]> {
  const shares = allocations ?? (await loadAllocationsFor(db, row));
  const active = await activeExpenseEntries(db, row.id);
  return [
    ...new Set([
      ...(row.orderId ? [row.orderId] : []),
      ...shares.map((a) => a.orderId),
      ...active.map((a) => a.orderId).filter((v): v is string => v !== null),
    ]),
  ];
}

/**
 * Приводить записи витрати до бажаного стану (усі замовлення витрати; FINANCE_ORDER_LOCK кожного — у порядку id).
 * Викликач тримає FINANCE_OP_LOCK витрати й рядок витрати (FOR UPDATE).
 */
export async function syncExpenseEntries(tx: Tx, actor: PostingActor, expenseId: string, opts: { now?: Date } = {}): Promise<SyncExpenseResult> {
  const [row] = await tx.select().from(financeExpenses).where(eq(financeExpenses.id, expenseId));
  if (!row) return { posted: 0, reversed: 0, awaiting: 0 };
  const allocations = await loadAllocationsFor(tx, row);
  const orderIds = await expenseOrderIds(tx, row, allocations);
  await lockFinanceOrders(tx, orderIds);
  // Після блокувань — свіжі стани й діючі записи (паралельний syncOrderExpenseEntries міг щойно провести частку).
  const orders = await loadOrderPostingStates(tx, orderIds);
  const desired = desiredExpenseEntries(row, allocations, orders);
  const active = await activeExpenseEntries(tx, row.id);
  const r = await applyDiff(tx, actor, desired, active, opts.now);
  const awaiting = countAwaiting(row, allocations, orders);
  // Фінанси КОЖНОГО замовлення витрати (витрата замовлення, частки суми періоду поточної версії, замовлення діючих і
  // щойно сторнованих записів) — у тій самій транзакції, у порядку id, під уже взятими FINO (нових блокувань немає,
  // §17.8): факт витрати / частка замінює прогноз складника (basis allocated, I16), анулювання чи переподіл повертає
  // прогноз / «немає даних». Без цього order_finance лишався б «≈ Прогноз» поруч із фактом (подвійний облік) або
  // «очікує перерахунку» після перерахунку — до наступної синхронізації замовлення (WP4).
  for (const id of [...orderIds].sort()) await syncOrderFinanceAt(tx, actor, id, { now: opts.now });
  return { ...r, awaiting };
}

/**
 * Для WP4 (syncOrderFinance, під FINANCE_ORDER_LOCK замовлення): записи всіх ручних витрат і часток сум періоду цього
 * замовлення — до бажаного стану за поточним станом фінансів замовлення (визнання → проведення R1/R2; скасоване до
 * відвантаження → R5; анульовані/переподілені → сторно). Нових блокувань не бере. Повертає лише кількості.
 * WP4 НЕ сторнує записи source_type expense / allocation сам — лише через цю функцію.
 */
export async function syncOrderExpenseEntries(tx: Tx, actor: PostingActor, orderId: string, opts: { now?: Date } = {}): Promise<SyncExpenseResult> {
  const linked = await tx
    .selectDistinct({ id: financeExpenses.id })
    .from(financeExpenses)
    .where(
      or(
        eq(financeExpenses.orderId, orderId),
        sql`exists (select 1 from ${financeExpenseAllocations} fa where fa.expense_id = ${financeExpenses.id} and fa.order_id = ${orderId})`,
        sql`exists (select 1 from ${financeEntries} fe where fe.source_id = ${financeExpenses.id}::text and fe.order_id = ${orderId}
          and fe.source_type in ('expense', 'allocation'))`,
      ),
    );
  const orders = await loadOrderPostingStates(tx, [orderId]);
  let posted = 0;
  let reversed = 0;
  let awaiting = 0;
  for (const { id } of [...linked].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const [row] = await tx.select().from(financeExpenses).where(eq(financeExpenses.id, id));
    if (!row) continue;
    const allocations = (await loadAllocationsFor(tx, row)).filter((a) => a.orderId === orderId);
    const desired = desiredExpenseEntries(row, allocations, orders).filter((d) => d.orderId === orderId);
    const active = await activeExpenseEntries(tx, row.id, orderId);
    const r = await applyDiff(tx, actor, desired, active, opts.now);
    posted += r.posted;
    reversed += r.reversed;
    awaiting += countAwaiting(row.orderId === orderId ? row : { ...row, orderId: null }, allocations, orders);
  }
  return { posted, reversed, awaiting };
}
