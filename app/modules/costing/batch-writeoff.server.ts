/**
 * Етап 6, WP2: «Списати невикористані витрати партії» (docs/stage6-design.md §6.7, §10.1) — СЕРВІС КЕРУВАННЯ
 * (finance.manage + роль owner). Для скасованої партії або закритої з недопоставкою (замовлено > виготовлено): скільки
 * сплачено виробнику за невироблене, застосунку невідомо, тож суму вносить власник → рядок finance_expenses (категорія
 * inventory_loss, production_batch_id — іншим шляхом ця категорія недоступна) → запис inventory_loss
 * (details.kind = production_cancelled, номер партії, R6 — дата власника) + історія змін + журнал дій (без сум).
 * Один operationId — одна операція (унікальний operation_id + FIOP). Дата в закритому місяці — відмова (§3.4).
 * Анулювання рядка — загальна дія витрат (WP6).
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { financeExpenses, productionBatchLines, productionBatches } from "~/db/schema";
import { DomainError, NotFoundError } from "~/lib/errors";
import { isSupportedCurrency, toMinorForCurrency } from "~/lib/decimal";
import { businessDate, parseIsoDate } from "~/lib/periods";
import { writeAudit } from "~/modules/audit/audit.server";
import { requireFinance } from "~/modules/finance/core/access.server";
import { writeFinanceChange } from "~/modules/finance/core/change-log.server";
import { assertMonthOpen } from "~/modules/finance/core/closed-month.server";
import { postEntries } from "~/modules/finance/core/entries.server";
import { financeKeys } from "~/modules/finance/core/keys";
import { lockFinanceOperation } from "~/modules/finance/core/locks.server";
import { lineProduced } from "~/modules/production/calc";
import { maskFreeTextNote } from "~/modules/privacy/notes";
import type { ServiceContext } from "~/server/types";
import { minorToDecimal } from "./engine";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const WRITE_OFF_REASON_MAX = 200;

export interface BatchWriteOffInput {
  operationId: string;
  batchId: string;
  /** Десятковий рядок > 0 (parseOwnerAmount). */
  amount: string;
  currency: string;
  date: string;
  reason: string;
}

/** Чи можна списати невикористані витрати партії: скасована або закрита з недопоставкою. */
export function batchWriteOffEligible(status: string, lines: ReadonlyArray<{ ordered: number; received: number; defective: number }>): boolean {
  if (status === "cancelled") return true;
  if (status !== "closed") return false;
  return lines.some((l) => l.ordered > lineProduced(l));
}

/** Партії, для яких дія доступна (id), — для сторінки. */
export async function writeOffEligibleBatchIds(db: DbOrTx, batchIds: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (batchIds.length === 0) return out;
  const batches = await db.select({ id: productionBatches.id, status: productionBatches.status }).from(productionBatches).where(inArray(productionBatches.id, [...batchIds]));
  const lines = await db
    .select({ batchId: productionBatchLines.batchId, ordered: productionBatchLines.quantityOrdered, received: productionBatchLines.quantityReceived, defective: productionBatchLines.quantityDefective })
    .from(productionBatchLines)
    .where(inArray(productionBatchLines.batchId, [...batchIds]));
  for (const b of batches) if (batchWriteOffEligible(b.status, lines.filter((l) => l.batchId === b.id))) out.add(b.id);
  return out;
}

export async function writeOffBatchCosts(ctx: ServiceContext, input: BatchWriteOffInput): Promise<{ expenseId: string; duplicate: boolean }> {
  requireFinance(ctx, "manage");
  if (!UUID_RE.test(input.operationId)) throw new DomainError("financeCosts.error.invalid", 400, { field: "operationId" });
  if (!UUID_RE.test(input.batchId)) throw new NotFoundError("productionBatch");
  if (!isSupportedCurrency(input.currency)) throw new DomainError("finance.error.unsupportedCurrency", 400, { currency: input.currency });
  let minor: bigint;
  try {
    minor = toMinorForCurrency(input.amount, input.currency);
  } catch {
    throw new DomainError("finance.error.amountWholeUnits", 400);
  }
  if (minor <= 0n) throw new DomainError("finance.error.amountInvalid", 400);
  const date = parseIsoDate(input.date);
  if (!date || date > businessDate(ctx.now())) throw new DomainError("financeCosts.error.invalid", 400, { field: "date" });
  const reason = maskFreeTextNote(input.reason, WRITE_OFF_REASON_MAX);
  if (!reason) throw new DomainError("financeCosts.error.reasonRequired", 400);
  const op = input.operationId.toLowerCase();
  return ctx.db.transaction(async (tx) => {
    await lockFinanceOperation(tx, op);
    const [existing] = await tx.select({ id: financeExpenses.id }).from(financeExpenses).where(eq(financeExpenses.operationId, op));
    if (existing) return { expenseId: existing.id, duplicate: true };
    await assertMonthOpen(tx, date);
    const [batch] = await tx.select().from(productionBatches).where(eq(productionBatches.id, input.batchId)).for("share");
    if (!batch) throw new NotFoundError("productionBatch");
    const lines = await tx
      .select({ ordered: productionBatchLines.quantityOrdered, received: productionBatchLines.quantityReceived, defective: productionBatchLines.quantityDefective })
      .from(productionBatchLines)
      .where(eq(productionBatchLines.batchId, batch.id));
    if (!batchWriteOffEligible(batch.status, lines)) throw new DomainError("financeCosts.error.writeOffNotAllowed", 409);
    const expenseId = randomUUID();
    const amount = minorToDecimal(minor);
    await tx.insert(financeExpenses).values({
      id: expenseId,
      category: "inventory_loss",
      amount,
      currency: input.currency,
      expenseDate: date,
      description: reason,
      productionBatchId: batch.id,
      operationId: op,
      createdBy: ctx.actor.id,
    });
    await postEntries(tx, ctx.actor, [
      {
        idempotencyKey: financeKeys.expense(expenseId, 1),
        category: "inventory_loss",
        recognizedOn: date,
        fxOn: date,
        amount: minorToDecimal(-minor),
        currency: input.currency,
        sourceType: "expense",
        sourceId: expenseId,
        details: { kind: "production_cancelled", productionBatchId: batch.id, batchNumber: batch.number },
      },
    ]);
    await writeFinanceChange(tx, ctx.actor, {
      entityType: "expense",
      entityId: expenseId,
      action: "create",
      after: { id: expenseId, version: 1, status: "active", category: "inventory_loss", amount, currency: input.currency, expenseDate: date, productionBatchId: batch.id },
      reason,
    });
    await writeAudit(tx, ctx.actor, "finance.batch_cost_written_off", { type: "production_batch", id: batch.id }, { expenseId });
    return { expenseId, duplicate: false };
  });
}

/** Уже списані витрати партій (активні рядки) — суми для сторінки «Партії» (finance.view). */
export async function batchWriteOffs(ctx: Pick<ServiceContext, "db" | "actor">, batchIds: readonly string[]): Promise<Map<string, Array<{ amount: string; currency: string; date: string | null }>>> {
  requireFinance(ctx, "view");
  const out = new Map<string, Array<{ amount: string; currency: string; date: string | null }>>();
  if (batchIds.length === 0) return out;
  const rows = await ctx.db
    .select({ batchId: financeExpenses.productionBatchId, amount: financeExpenses.amount, currency: financeExpenses.currency, date: financeExpenses.expenseDate })
    .from(financeExpenses)
    .where(and(inArray(financeExpenses.productionBatchId, [...batchIds]), eq(financeExpenses.status, "active"), eq(financeExpenses.category, "inventory_loss")));
  for (const r of rows) out.set(r.batchId!, [...(out.get(r.batchId!) ?? []), { amount: r.amount, currency: r.currency, date: r.date }]);
  return out;
}
