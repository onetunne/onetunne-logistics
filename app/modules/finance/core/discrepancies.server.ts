/**
 * Етап 6: реєстр фінансових розбіжностей `finance_discrepancies` (docs/stage6-design.md §7.5, §14.2). Лише власник;
 * відкриті — у «Потребує уваги» фінансів, критичні — попередження чек-листа закриття місяця. НІКОЛИ не створює
 * `issues` («Проблеми» й лічильник оболонки етап 6 не змінює, I19).
 *
 * - openDiscrepancy / autoResolveDiscrepancy — внутрішні (їх викликають імпорт, синхронізація, оцінка): без перевірки
 *   актора, результат без грошей;
 * - resolveDiscrepancy / listDiscrepancies / countOpenDiscrepancies — сервіси власника (requireFinance).
 * Кожна зміна стану → finance_change_log (discrepancy). Ключ дедуплікації — стабільний (`discrepancyKey`): повторна
 * подія не створює другого рядка; розв'язану власником розбіжність повторна подія не відкриває (якщо не reopen).
 */
import { and, asc, count, desc, eq, sql, type SQL } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { financeDiscrepancies } from "~/db/schema";
import {
  DISCREPANCY_CODES,
  DISCREPANCY_DEFAULT_SEVERITY,
  DISCREPANCY_RESOLUTIONS,
  type DiscrepancyCode,
  type DiscrepancyResolution,
  type DiscrepancySeverity,
  type DiscrepancyStatus,
} from "~/domain/finance";
import type { Actor } from "~/domain/permissions";
import { ConflictError, NotFoundError } from "~/lib/errors";
import { maskFreeTextNote } from "~/modules/privacy/notes";
import type { ServiceContext } from "~/server/types";
import { requireFinance } from "./access.server";
import { writeFinanceChange } from "./change-log.server";
import { assertFinanceDetails, type FinanceDetailsInput } from "./details";
import { DEFAULT_STORE_ID } from "./store.server";

/** Стабільний ключ дедуплікації: `<тип>:<частини>` (id, нормалізовані номери, коди — без персональних даних). */
export function discrepancyKey(type: DiscrepancyCode, ...parts: Array<string | number>): string {
  const key = [type, ...parts.map(String)].join(":");
  if (key.length > 300) throw new RangeError("discrepancy key too long");
  return key;
}

export interface OpenDiscrepancyInput {
  type: DiscrepancyCode;
  dedupeKey: string;
  severity?: DiscrepancySeverity;
  orderId?: string | null;
  shipmentId?: string | null;
  invoiceLineId?: string | null;
  carrierCode?: string | null;
  details?: FinanceDetailsInput;
  /** Повторно відкрити розв'язану/проігноровану (умова повернулася й рішення власника вже не діє). Типово — ні. */
  reopen?: boolean;
  storeId?: string;
}

/** Відкриває розбіжність (ідемпотентно). Результат — без грошей. */
export async function openDiscrepancy(
  db: DbOrTx,
  actor: Pick<Actor, "id" | "role">,
  input: OpenDiscrepancyInput,
): Promise<{ id: string; created: boolean; reopened: boolean }> {
  if (!(DISCREPANCY_CODES as readonly string[]).includes(input.type)) throw new RangeError(`discrepancy type ${input.type}`);
  const storeId = input.storeId ?? DEFAULT_STORE_ID;
  const details = assertFinanceDetails(input.details ?? {});
  const [inserted] = await db
    .insert(financeDiscrepancies)
    .values({
      storeId,
      type: input.type,
      severity: input.severity ?? DISCREPANCY_DEFAULT_SEVERITY[input.type],
      orderId: input.orderId ?? null,
      shipmentId: input.shipmentId ?? null,
      invoiceLineId: input.invoiceLineId ?? null,
      carrierCode: input.carrierCode ?? null,
      details,
      dedupeKey: input.dedupeKey,
    })
    .onConflictDoNothing({ target: [financeDiscrepancies.storeId, financeDiscrepancies.dedupeKey] })
    .returning({ id: financeDiscrepancies.id });
  if (inserted) {
    await writeFinanceChange(db, actor, {
      entityType: "discrepancy",
      entityId: inserted.id,
      action: "create",
      after: { type: input.type, status: "open", severity: input.severity ?? DISCREPANCY_DEFAULT_SEVERITY[input.type], orderId: input.orderId ?? null },
      storeId,
    });
    return { id: inserted.id, created: true, reopened: false };
  }
  const [existing] = await db
    .select({ id: financeDiscrepancies.id, status: financeDiscrepancies.status })
    .from(financeDiscrepancies)
    .where(and(eq(financeDiscrepancies.storeId, storeId), eq(financeDiscrepancies.dedupeKey, input.dedupeKey)));
  if (!existing) throw new NotFoundError("discrepancy");
  if (existing.status !== "open" && input.reopen) {
    await db
      .update(financeDiscrepancies)
      .set({ status: "open", details, resolutionCode: null, resolvedAt: null, resolvedBy: null, version: sql`${financeDiscrepancies.version} + 1`, updatedAt: new Date() })
      .where(eq(financeDiscrepancies.id, existing.id));
    await writeFinanceChange(db, actor, {
      entityType: "discrepancy",
      entityId: existing.id,
      action: "reopen",
      before: { status: existing.status },
      after: { status: "open" },
      storeId,
    });
    return { id: existing.id, created: false, reopened: true };
  }
  return { id: existing.id, created: false, reopened: false };
}

/** Система закриває відкриту розбіжність, умова якої зникла (resolution auto_resolved). Повертає кількість. */
export async function autoResolveDiscrepancy(
  db: DbOrTx,
  actor: Pick<Actor, "id" | "role">,
  dedupeKey: string,
  storeId: string = DEFAULT_STORE_ID,
): Promise<{ resolved: number }> {
  const rows = await db
    .update(financeDiscrepancies)
    .set({
      status: "resolved",
      resolutionCode: "auto_resolved",
      resolvedBy: actor.id,
      resolvedAt: new Date(),
      version: sql`${financeDiscrepancies.version} + 1`,
      updatedAt: new Date(),
    })
    .where(and(eq(financeDiscrepancies.storeId, storeId), eq(financeDiscrepancies.dedupeKey, dedupeKey), eq(financeDiscrepancies.status, "open")))
    .returning({ id: financeDiscrepancies.id, type: financeDiscrepancies.type });
  for (const r of rows) {
    await writeFinanceChange(db, actor, {
      entityType: "discrepancy",
      entityId: r.id,
      action: "resolve",
      before: { status: "open" },
      after: { status: "resolved", resolutionCode: "auto_resolved" },
      storeId,
    });
  }
  return { resolved: rows.length };
}

export interface ResolveDiscrepancyInput {
  id: string;
  status: Exclude<DiscrepancyStatus, "open"> | "open";
  resolutionCode: DiscrepancyResolution | null;
  /** Примітка власника (маскується, ≤ 300). */
  note?: string | null;
  expectedVersion?: number;
}

/** Рішення власника (finance.manage): розв'язати / ігнорувати / повторно відкрити, з історією змін. */
export async function resolveDiscrepancy(ctx: Pick<ServiceContext, "db" | "actor">, input: ResolveDiscrepancyInput): Promise<{ version: number }> {
  requireFinance(ctx, "manage");
  if (input.status !== "open" && (!input.resolutionCode || !(DISCREPANCY_RESOLUTIONS as readonly string[]).includes(input.resolutionCode))) {
    throw new RangeError("resolutionCode");
  }
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx.select().from(financeDiscrepancies).where(eq(financeDiscrepancies.id, input.id)).for("update");
    if (!row) throw new NotFoundError("discrepancy");
    if (input.expectedVersion !== undefined && input.expectedVersion !== row.version) throw new ConflictError();
    const open = input.status === "open";
    const [updated] = await tx
      .update(financeDiscrepancies)
      .set({
        status: input.status,
        resolutionCode: open ? null : input.resolutionCode,
        resolutionNote: open ? null : maskFreeTextNote(input.note, 300),
        resolvedBy: open ? null : ctx.actor.id,
        resolvedAt: open ? null : new Date(),
        version: row.version + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(financeDiscrepancies.id, row.id), eq(financeDiscrepancies.version, row.version)))
      .returning({ version: financeDiscrepancies.version });
    if (!updated) throw new ConflictError();
    await writeFinanceChange(tx, ctx.actor, {
      entityType: "discrepancy",
      entityId: row.id,
      action: open ? "reopen" : "resolve",
      before: { status: row.status, resolutionCode: row.resolutionCode as DiscrepancyResolution | null },
      after: { status: input.status, resolutionCode: open ? null : input.resolutionCode },
      reason: input.note ?? null,
      storeId: row.storeId,
    });
    return { version: updated.version };
  });
}

export type DiscrepancyRow = typeof financeDiscrepancies.$inferSelect;

export interface DiscrepancyFilter {
  status?: DiscrepancyStatus;
  type?: DiscrepancyCode;
  orderId?: string;
  severity?: DiscrepancySeverity;
  limit?: number;
  storeId?: string;
}

/** Перелік розбіжностей (finance.view). */
export async function listDiscrepancies(ctx: Pick<ServiceContext, "db" | "actor">, filter: DiscrepancyFilter = {}): Promise<DiscrepancyRow[]> {
  requireFinance(ctx, "view");
  const conds: SQL[] = [eq(financeDiscrepancies.storeId, filter.storeId ?? DEFAULT_STORE_ID)];
  if (filter.status) conds.push(eq(financeDiscrepancies.status, filter.status));
  if (filter.type) conds.push(eq(financeDiscrepancies.type, filter.type));
  if (filter.orderId) conds.push(eq(financeDiscrepancies.orderId, filter.orderId));
  if (filter.severity) conds.push(eq(financeDiscrepancies.severity, filter.severity));
  return ctx.db
    .select()
    .from(financeDiscrepancies)
    .where(and(...conds))
    // Критичні перші — явним порядком (текстове desc поставило б 'warning' перед 'critical').
    .orderBy(
      sql`case ${financeDiscrepancies.severity} when 'critical' then 0 else 1 end`,
      desc(financeDiscrepancies.createdAt),
      asc(financeDiscrepancies.id),
    )
    .limit(Math.min(Math.max(filter.limit ?? 200, 1), 2000));
}

/** Кількість відкритих (усього й критичних) — finance.view. */
export async function countOpenDiscrepancies(
  ctx: Pick<ServiceContext, "db" | "actor">,
  storeId: string = DEFAULT_STORE_ID,
): Promise<{ total: number; critical: number }> {
  requireFinance(ctx, "view");
  const rows = await ctx.db
    .select({ severity: financeDiscrepancies.severity, c: count() })
    .from(financeDiscrepancies)
    .where(and(eq(financeDiscrepancies.storeId, storeId), eq(financeDiscrepancies.status, "open")))
    .groupBy(financeDiscrepancies.severity);
  const total = rows.reduce((a, r) => a + Number(r.c), 0);
  const critical = Number(rows.find((r) => r.severity === "critical")?.c ?? 0);
  return { total, critical };
}
