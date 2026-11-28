/**
 * Етап 6, WP6 (інтеграційний раунд ядра): перерахунок розподілу суми періоду, що замінює прогнози (§10.3, I16) —
 * ВНУТРІШНІ функції (без перевірки актора; повертають лише кількості й коди, ніколи не гроші; сторінки, маршрути,
 * команди й інструменти ШІ їх не імпортують — INTERNAL_POSTING_FUNCTIONS / INTERNAL_ONLY_MODULES).
 *
 * - reallocateExpenseInTx — ТОЙ САМИЙ перерахунок, що й кнопка власника «Перерахувати розподіл»
 *   (expenses.server.ts recalculateAllocation = requireFinance("manage") + ця функція у своїй транзакції): FIOP
 *   `expense|<id>` + рядок витрати FOR UPDATE → перевірки (діюча, «замінює прогноз», версія) → місяці витрати відкриті
 *   (assertMonthsOpen під спільним FIPE — закритий місяць НЕ переписується мовчки: відмова finance.error.monthClosed) →
 *   новий розподіл → нова версія + частки → syncExpenseEntries (FINO усіх замовлень витрати ОДНИМ упорядкованим
 *   набором; частки замовлень, визнаних у закритому місяці, — пізні записи is_late, як у postEntries) → історія змін і
 *   журнал дій (лише id і кількість).
 * - runExpenseReallocation — обробник завдання finance.expense_reallocate: SYSTEM_ACTOR, ВЛАСНА транзакція (жодного
 *   FINO викликача не утримується — §17.8/F10: «ніколи не брати FINO іншого замовлення, тримаючи FINO(X)»).
 *   Анульована / не «замінює прогноз» / не знайдена / закритий місяць — завдання завершується без змін (код у
 *   результаті й журналі; кнопка власника лишається). Немає курсу для ваг різних валют (finance.error.noRate) — теж
 *   без змін і БЕЗ «мертвого» завдання: код no_rate, обробник ставить повтор через
 *   FINANCE_JOB_TIMING.expenseReallocateNoRateRetryMs (не більше expenseReallocateNoRateMaxRetries поспіль; наступна
 *   синхронізація WP4 замовлення, що чекає, починає ланцюжок заново).
 * - enqueueExpenseReallocation(tx, orderId) — для WP4 (syncOrderFinance під FINO(X)), коли coveringStatusForOrder дає
 *   awaiting_reallocation: ЛИШЕ ставить завдання (без блокувань фінансів і проведень), одне на суму в черзі (dedupe
 *   `finance-expense-reallocate:<expenseId>`); у транзакції викликача — відкат синхронізації скасовує й завдання.
 *   Наявне завдання в черзі УТРИМУЄТЬСЯ (рядок jobs FOR UPDATE) до фіксації викликача — обробник не виконає його без
 *   фактів цієї синхронізації (enqueueOrHoldReallocation). Тому WP4 викликає її ОСТАННІМ записом транзакції.
 *   У демо обробника завдань немає (усе — дією): не ставить нічого, лишається кнопка (режим — явний `mode` або ядра
 *   resolveRateMode: демо-база з демо-курсами → demo).
 */
import { and, eq, sql } from "drizzle-orm";
import type { Db, DbOrTx, Tx } from "~/db/client.server";
import { financeExpenseAllocations, financeExpenses, jobs } from "~/db/schema";
import type { Actor } from "~/domain/permissions";
import { ConflictError, DomainError, NotFoundError } from "~/lib/errors";
import { fromMinor } from "~/lib/decimal";
import { writeAudit } from "~/modules/audit/audit.server";
import { writeFinanceChange } from "~/modules/finance/core/change-log.server";
import { assertMonthsOpen } from "~/modules/finance/core/closed-month.server";
import { lockFinanceOperation } from "~/modules/finance/core/locks.server";
import { resolveRateMode } from "~/modules/finance/core/rate-mode.server";
import { loadFinanceSettings } from "~/modules/finance/core/settings.server";
import { FINANCE_JOB, FINANCE_JOB_TIMING, financeJobDedupe } from "~/modules/finance/jobs";
import { enqueueJob } from "~/modules/jobs/queue.server";
import type { AppMode } from "~/server/types";
import { computeAllocation, coveringStatusForOrder, currentAllocations, sameAllocation, type OrderCoveringStatus } from "./allocation.server";
import { syncExpenseEntries } from "./posting.server";
import { datesTouched } from "./rules";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ExpenseRow = typeof financeExpenses.$inferSelect;

/** Результат перерахунку (кількості й версія — без сум). */
export interface ReallocationResult {
  changed: boolean;
  version: number;
  allocatedOrders: number;
  posted: number;
  reversed: number;
  awaiting: number;
}

/** FIOP `expense|<id>` і рядок витрати FOR UPDATE (порядок §17.8: операція → … → фінанси замовлення → записи). */
export async function lockExpenseRow(tx: Tx, id: string): Promise<ExpenseRow> {
  if (!UUID_RE.test(id ?? "")) throw new NotFoundError("finance_expense");
  await lockFinanceOperation(tx, `expense|${id.toLowerCase()}`);
  const [row] = await tx.select().from(financeExpenses).where(eq(financeExpenses.id, id)).for("update");
  if (!row) throw new NotFoundError("finance_expense");
  return row;
}

/**
 * «Перерахувати розподіл» (кнопка власника й завдання — одна функція). Викликач відповідає за доступ (кнопка —
 * requireFinance("manage")) і транзакцію; функція бере блокування сама.
 */
export async function reallocateExpenseInTx(
  tx: Tx,
  actor: Actor,
  expenseId: string,
  opts: { mode: AppMode; now: Date; expectedVersion?: number | null },
): Promise<ReallocationResult> {
  const row = await lockExpenseRow(tx, expenseId);
  if (row.status !== "active") throw new DomainError("financeExpenses.error.alreadyVoided", 409);
  if (!row.coversForecast) throw new DomainError("financeExpenses.error.notCovering", 400);
  if (opts.expectedVersion !== undefined && opts.expectedVersion !== null && opts.expectedVersion !== row.version) throw new ConflictError();
  await assertMonthsOpen(tx, datesTouched(row));
  const { includeTestOrders } = await loadFinanceSettings(tx);
  const current = await currentAllocations(tx, row);
  const computed = await computeAllocation(tx, row, { mode: opts.mode, includeTestOrders });
  if (sameAllocation(current, computed)) {
    const r = await syncExpenseEntries(tx, actor, row.id, { now: opts.now });
    return { changed: false, version: row.version, allocatedOrders: current.length, ...r };
  }
  const [next] = await tx
    .update(financeExpenses)
    .set({ version: row.version + 1 })
    .where(and(eq(financeExpenses.id, row.id), eq(financeExpenses.version, row.version)))
    .returning();
  if (!next) throw new ConflictError();
  if (computed) {
    await tx.insert(financeExpenseAllocations).values(
      computed.shares.map((s) => ({
        expenseId: row.id,
        expenseVersion: next.version,
        orderId: s.orderId,
        amount: fromMinor(s.minor),
        currency: row.currency,
        weightBasis: computed.weightBasis,
      })),
    );
  }
  const r = await syncExpenseEntries(tx, actor, row.id, { now: opts.now });
  await writeFinanceChange(tx, actor, {
    entityType: "expense_allocation",
    entityId: row.id,
    action: "update",
    before: { expenseId: row.id, expenseVersion: row.version, orders: current.length, total: row.amount, currency: row.currency },
    after: {
      expenseId: row.id,
      expenseVersion: next.version,
      orders: computed?.shares.length ?? 0,
      total: row.amount,
      currency: row.currency,
      weightBasis: computed?.weightBasis ?? "none",
    },
    storeId: row.storeId,
  });
  await writeAudit(tx, actor, "finance.expense_reallocated", { type: "finance_expense", id: row.id }, { orders: computed?.shares.length ?? 0 });
  return { changed: true, version: next.version, allocatedOrders: computed?.shares.length ?? 0, ...r };
}

/** Коди результату завдання (без сум). */
export type ReallocationJobStatus = "reallocated" | "unchanged" | "voided" | "not_covering" | "not_found" | "month_closed" | "no_rate";

export interface ReallocationJobOutcome {
  status: ReallocationJobStatus;
  allocatedOrders: number;
  posted: number;
  reversed: number;
  awaiting: number;
  /** no_rate: якого курсу бракує (валюта, дата — без сум). */
  missingRate?: { currency: string; date: string };
}

const SKIPPED: Record<string, ReallocationJobStatus> = {
  "financeExpenses.error.alreadyVoided": "voided",
  "financeExpenses.error.notCovering": "not_covering",
  "finance.error.monthClosed": "month_closed",
  "finance.error.noRate": "no_rate",
};

/**
 * Обробник завдання finance.expense_reallocate: той самий перерахунок у ВЛАСНІЙ транзакції. Стани, у яких кнопка
 * відмовила б (анульована, не «замінює прогноз», закритий місяць, немає витрати), — завершення без змін і без повтору;
 * немає курсу (finance.error.noRate) — no_rate з валютою й датою (повтор ставить обробник — scheduleNoRateRetry).
 */
export async function runExpenseReallocation(db: Db, actor: Actor, expenseId: string, opts: { mode: AppMode; now: Date }): Promise<ReallocationJobOutcome> {
  const none = { allocatedOrders: 0, posted: 0, reversed: 0, awaiting: 0 };
  try {
    const r = await db.transaction((tx) => reallocateExpenseInTx(tx, actor, expenseId, opts));
    return { status: r.changed ? "reallocated" : "unchanged", allocatedOrders: r.allocatedOrders, posted: r.posted, reversed: r.reversed, awaiting: r.awaiting };
  } catch (e) {
    if (e instanceof NotFoundError) return { status: "not_found", ...none };
    if (e instanceof DomainError && SKIPPED[e.code]) {
      const status = SKIPPED[e.code]!;
      if (status !== "no_rate") return { status, ...none };
      return { status, ...none, missingRate: { currency: String(e.params.currency ?? ""), date: String(e.params.date ?? "") } };
    }
    throw e;
  }
}

/**
 * Після no_rate: повтор того самого перерахунку через FINANCE_JOB_TIMING.expenseReallocateNoRateRetryMs (курс міг
 * з'явитися — завантаження НБУ, ручний курс). `retry` — номер повтору поспіль (1…expenseReallocateNoRateMaxRetries);
 * понад межу — нічого (лишаються кнопка власника й наступна синхронізація WP4). Повертає, чи поставлено/утримано повтор.
 */
export async function scheduleNoRateRetry(db: DbOrTx, expenseId: string, opts: { retry: number; now: Date }): Promise<boolean> {
  if (opts.retry > FINANCE_JOB_TIMING.expenseReallocateNoRateMaxRetries) return false;
  await enqueueOrHoldReallocation(db, expenseId, { runAt: new Date(opts.now.getTime() + FINANCE_JOB_TIMING.expenseReallocateNoRateRetryMs), noRateRetry: opts.retry });
  return true;
}

/**
 * Для WP4 (syncOrderFinance, у транзакції викликача під FINO(X)): поставити перерахунок кожної суми, що чекає
 * перерозподілу для цього замовлення (awaiting_reallocation). Лише черга (ідемпотентно: dedupe серед завдань у черзі;
 * наявне завдання утримується до фіксації — enqueueOrHoldReallocation); без блокувань фінансів і без проведень. `statuses` — уже обчислений coveringStatusForOrder (щоб не
 * рахувати двічі). У демо — нічого (обробника немає).
 */
export async function enqueueExpenseReallocation(
  db: DbOrTx,
  orderId: string,
  opts: { mode?: AppMode; statuses?: readonly OrderCoveringStatus[]; now?: Date } = {},
): Promise<{ queued: number; expenseIds: string[] }> {
  // Режим: явний або ядра (resolveRateMode: робочий сервер — production; демо-база з демо-курсами — demo).
  const mode = opts.mode ?? (await resolveRateMode(db));
  if (mode === "demo") return { queued: 0, expenseIds: [] };
  const statuses = opts.statuses ?? (await coveringStatusForOrder(db, orderId, { mode }));
  const expenseIds = [...new Set(statuses.filter((s) => s.state === "awaiting_reallocation").map((s) => s.expenseId))].sort();
  const runAt = new Date((opts.now ?? new Date()).getTime() + FINANCE_JOB_TIMING.expenseReallocateDelayMs);
  let queued = 0;
  for (const expenseId of expenseIds) if (await enqueueOrHoldReallocation(db, expenseId, { runAt })) queued++;
  return { queued, expenseIds };
}

/** Скільки разів повторити пару «вставка → утримання» (рядок у черзі могли захопити між ними). */
const HOLD_ATTEMPTS = 5;

/**
 * Поставити завдання перерахунку суми або, якщо таке вже чекає в черзі, УТРИМАТИ його рядок (UPDATE — блокування рядка)
 * до кінця транзакції викликача. Інакше втрачався б перерахунок: синхронізація Y (під FINO(Y), факти Y ще не зафіксовано)
 * дедуплікується з завданням J у черзі, обробник захоплює й виконує J ДО фіксації Y — розподіл без Y, а нового завдання
 * вже немає. Утриманий рядок обробник не захопить (claimJob — FOR UPDATE SKIP LOCKED), доки викликач не зафіксує
 * транзакцію, тож J завжди бачить факти Y. Якщо J уже виконується (не в черзі) — вставляється нове завдання, яке
 * виконається після J. Повертає true, якщо вставлено нове завдання (false — утримано наявне).
 * Викликач (WP4) ставить завдання ОСТАННІМ записом своєї транзакції: утримання — до фіксації.
 */
export async function enqueueOrHoldReallocation(db: DbOrTx, expenseId: string, opts: { runAt: Date; noRateRetry?: number }): Promise<boolean> {
  const dedupeKey = financeJobDedupe.expenseReallocate(expenseId);
  const payload: Record<string, unknown> = opts.noRateRetry ? { expenseId, noRateRetry: opts.noRateRetry } : { expenseId };
  for (let attempt = 0; attempt < HOLD_ATTEMPTS; attempt++) {
    if (await enqueueJob(db, FINANCE_JOB.expenseReallocate, payload, { dedupeKey, runAt: opts.runAt })) return true;
    // Утримання: UPDATE бере блокування рядка до кінця транзакції й не відкладає завдання (раніший із двох run_at —
    // напр. повтор no_rate через годину стає «через 30 с» після нової синхронізації). READ COMMITTED: рядок, який тим
    // часом захопив обробник (status = running), повторна перевірка умови відкидає → повтор вставки.
    const held = await db
      .update(jobs)
      .set({ runAt: sql`least(${jobs.runAt}, ${opts.runAt.toISOString()}::timestamptz)` })
      .where(and(eq(jobs.dedupeKey, dedupeKey), eq(jobs.status, "queued")))
      .returning({ id: jobs.id });
    if (held.length > 0) return false;
  }
  throw new Error("expense reallocation: the queued job could neither be inserted nor held");
}
