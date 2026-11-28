/**
 * Виробничі партії (етап 5, docs/stage5-design.md §4, §11): створення, зміна, запуск, надходження (часткові),
 * закриття, скасування, собівартість. Залишки змінюються ЛИШЕ через applyMovements (ключі — inventoryKeys).
 *
 * Дозволи (перевіряються тут, на сервері):
 * - створення/зміна/запуск/закриття/скасування — production.manage;
 * - надходження — warehouse.receive (складська операція: працівник без production.manage теж може);
 * - будь-які поля собівартості (ціна одиниці, додаткові витрати, валюта) — лише finance.view (власник).
 *
 * Блокування: рядок партії FOR NO KEY UPDATE (як рядок замовлення — не конфліктує з KEY SHARE зовнішніх ключів
 * рухів/надходжень) → позиції → склад → баланси (applyMovements). Усі зміни партії й позицій — під блокуванням
 * рядка партії, тож два одночасні надходження тієї самої позиції виконуються по черзі й не перевищують залишок.
 *
 * Ідемпотентність:
 * - запуск: production_start:<line>:<version>; надходження: production_receipts.idempotency_key (uuid форми) +
 *   receipt_production:<receiptLine>; закриття/скасування: production_close:<line>.
 * - повторне надсилання тієї самої форми надходження (той самий uuid) повертає вже записане надходження
 *   (duplicate: true) без нових рухів.
 */
import { and, count, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "~/db/client.server";
import {
  productionBatchLines,
  productionBatches,
  productionReceiptLines,
  productionReceipts,
  productVariants,
  products,
  type ProductionBatchStatus,
} from "~/db/schema";
import { can, ForbiddenError, requirePermission, type Actor } from "~/domain/permissions";
import { ConflictError, DomainError, NotFoundError } from "~/lib/errors";
import { writeAudit } from "~/modules/audit/audit.server";
import { revalueBatchLines, revalueBatchLinesInternal } from "~/modules/costing/revalue.server";
import { writeFinanceChange } from "~/modules/finance/core/change-log.server";
import { inventoryKeys } from "~/modules/inventory/keys";
import { applyMovements, ensureStockItemsForVariants, movementOptionsFor, type MovementInput } from "~/modules/inventory/ledger.server";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import { enqueueInventoryPushIfPending } from "~/modules/inventory-sync/schedule.server";
import type { ServiceContext } from "~/server/types";
import {
  CLOSABLE_STATUSES,
  LIMITS,
  RECEIVABLE_STATUSES,
  allocateReceipt,
  billedQuantity,
  formatBatchNumber,
  isStatusIn,
  isValidDateString,
  kyivYear,
  landedUnitCost,
  lineRemaining,
  parseMoneyInput,
  statusAfterReceipt,
  type LineQuantities,
} from "./calc";
import { FIELD_ERRORS, PRODUCTION_ERRORS, ProductionValidationError } from "./errors";
import { maskFreeTextNote } from "~/modules/privacy/notes";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY_RE = /^[A-Z]{3}$/;

type BatchRow = typeof productionBatches.$inferSelect;
type LineRow = typeof productionBatchLines.$inferSelect;

// ---------------------------------------------------------------------------
// Вхідні дані
// ---------------------------------------------------------------------------

export interface BatchLineInput {
  variantId: string;
  /** Замовлено, 1…100 000. */
  quantity: number;
  /**
   * Ціна одиниці ("12.50"), null — без ціни. undefined — не змінювати (оновлення) / без ціни (створення).
   * Будь-яке значення, крім undefined, — лише finance.view.
   */
  unitCost?: string | null;
}

export interface BatchInput {
  title: string;
  /** YYYY-MM-DD або null. */
  plannedReadyDate?: string | null;
  manufacturer?: string | null;
  notes?: string | null;
  /** Додаткові витрати партії (доставка, пакування…), лише finance.view; undefined — не змінювати. */
  extraCost?: string | null;
  /** Валюта собівартості партії (ISO 4217), лише finance.view; undefined — не змінювати. */
  costCurrency?: string | null;
  lines: BatchLineInput[];
}

export interface BatchCostsInput {
  extraCost: string | null;
  costCurrency: string | null;
  /** Позиції, ціну яких змінено (інші — без змін). */
  lines: Array<{ batchLineId: string; unitCost: string | null }>;
}

export interface ReceiptLineInput {
  batchLineId: string;
  /** Якісні одиниці. */
  good: number;
  /** Браковані одиниці. */
  defective: number;
  /** Причина браку (без персональних даних), до 200 символів — зберігається в примітці руху складу. */
  defectReason?: string | null;
}

export interface ReceiptInput {
  /** uuid форми (генерується при відкритті форми): подвійне надсилання не дублює надходження. */
  idempotencyKey: string;
  /** Позиції надходження або "remaining" — увесь незавершений залишок як якісні (без браку). */
  lines: ReceiptLineInput[] | "remaining";
  note?: string | null;
  /** Дозволити отримати більше, ніж залишилось у виробництві (надлишок — одразу у «Фактично»/«Брак»). */
  allowOverReceipt?: boolean;
}

export interface ReceiptResult {
  receiptId: string;
  /** true — це повтор уже записаного надходження (той самий ключ форми): нічого не змінено. */
  duplicate: boolean;
  status: ProductionBatchStatus;
  lines: number;
  good: number;
  defective: number;
  overReceived: number;
}

// ---------------------------------------------------------------------------
// Перевірка даних
// ---------------------------------------------------------------------------

interface NormalizedLine {
  variantId: string;
  quantity: number;
  unitCost: string | null | undefined;
}

interface NormalizedBatchInput {
  title: string;
  plannedReadyDate: string | null;
  manufacturer: string | null;
  notes: string | null;
  extraCost: string | null | undefined;
  costCurrency: string | null | undefined;
  lines: NormalizedLine[];
}

const trimOrNull = (v: string | null | undefined) => {
  const s = (v ?? "").trim();
  return s === "" ? null : s;
};

function normalizeMoney(value: string | null | undefined, field: string, errors: Record<string, string>): string | null | undefined {
  if (value === undefined) return undefined;
  const parsed = parseMoneyInput(value);
  if (parsed === "invalid") {
    errors[field] = FIELD_ERRORS.invalidMoney;
    return null;
  }
  return parsed;
}

function normalizeCurrency(value: string | null | undefined, errors: Record<string, string>): string | null | undefined {
  if (value === undefined) return undefined;
  const c = (value ?? "").trim().toUpperCase();
  if (c === "") return null;
  if (!CURRENCY_RE.test(c)) {
    errors.costCurrency = FIELD_ERRORS.invalidCurrency;
    return null;
  }
  return c;
}

function normalizeBatchInput(input: BatchInput): NormalizedBatchInput {
  const errors: Record<string, string> = {};
  const title = (input.title ?? "").trim();
  if (!title) errors.title = FIELD_ERRORS.required;
  else if (title.length > LIMITS.title) errors.title = FIELD_ERRORS.tooLong;
  const plannedReadyDate = trimOrNull(input.plannedReadyDate);
  if (plannedReadyDate && !isValidDateString(plannedReadyDate)) errors.plannedReadyDate = FIELD_ERRORS.invalidDate;
  const manufacturer = trimOrNull(input.manufacturer);
  if (manufacturer && manufacturer.length > LIMITS.manufacturer) errors.manufacturer = FIELD_ERRORS.tooLong;
  const notes = trimOrNull(input.notes);
  if (notes && notes.length > LIMITS.notes) errors.notes = FIELD_ERRORS.tooLong;
  const extraCost = normalizeMoney(input.extraCost, "extraCost", errors);
  const costCurrency = normalizeCurrency(input.costCurrency, errors);

  const lines: NormalizedLine[] = [];
  const seen = new Set<string>();
  if (input.lines.length === 0) errors.lines = FIELD_ERRORS.noLines;
  if (input.lines.length > LIMITS.lines) errors.lines = FIELD_ERRORS.tooManyLines;
  for (const l of input.lines.slice(0, LIMITS.lines)) {
    if (!UUID_RE.test(l.variantId)) throw new NotFoundError("variant");
    const variantId = l.variantId.toLowerCase();
    if (seen.has(variantId)) {
      errors[`qty.${variantId}`] = FIELD_ERRORS.duplicate;
      continue;
    }
    seen.add(variantId);
    if (!Number.isSafeInteger(l.quantity) || l.quantity < 1 || l.quantity > LIMITS.quantity) {
      errors[`qty.${variantId}`] = FIELD_ERRORS.invalidQuantity;
    }
    lines.push({ variantId, quantity: l.quantity, unitCost: normalizeMoney(l.unitCost, `cost.${variantId}`, errors) });
  }
  if (Object.keys(errors).length > 0) throw new ProductionValidationError(errors);
  return { title, plannedReadyDate, manufacturer, notes, extraCost, costCurrency, lines };
}

/** Поля собівартості — лише finance.view (навіть якщо значення порожнє: очищення — теж зміна). */
function assertCostPermission(actor: Actor, input: Pick<BatchInput, "extraCost" | "costCurrency" | "lines">): void {
  const touches = input.extraCost !== undefined || input.costCurrency !== undefined || input.lines.some((l) => l.unitCost !== undefined);
  if (touches && !can(actor, "finance.view")) throw new ForbiddenError("finance.view");
}

// ---------------------------------------------------------------------------
// Допоміжне
// ---------------------------------------------------------------------------

function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return err?.code === "23505" || err?.cause?.code === "23505";
}

async function lockBatch(tx: Tx, batchId: string): Promise<BatchRow> {
  if (!UUID_RE.test(batchId)) throw new NotFoundError("productionBatch");
  const [row] = await tx.select().from(productionBatches).where(eq(productionBatches.id, batchId)).for("no key update");
  if (!row) throw new NotFoundError("productionBatch");
  return row;
}

async function lockLines(tx: Tx, batchId: string): Promise<LineRow[]> {
  return tx
    .select()
    .from(productionBatchLines)
    .where(eq(productionBatchLines.batchId, batchId))
    .orderBy(productionBatchLines.id)
    .for("no key update");
}

async function assertVariantsExist(tx: Tx, variantIds: readonly string[]): Promise<void> {
  if (variantIds.length === 0) return;
  const rows = await tx.select({ id: productVariants.id }).from(productVariants).where(inArray(productVariants.id, [...variantIds]));
  if (rows.length !== new Set(variantIds).size) throw new NotFoundError("variant");
}

const q = (l: LineRow): LineQuantities => ({ ordered: l.quantityOrdered, received: l.quantityReceived, defective: l.quantityDefective });

/** Наступний вільний номер року (максимальний наявний + 1). Викликати лише під lockBatchNumbers. */
async function nextBatchSeq(tx: Tx, year: number): Promise<number> {
  const pattern = `^PB-${year}-([0-9]+)$`;
  const [row] = await tx
    .select({ max: sql<number | null>`max((substring(${productionBatches.number} from ${pattern}))::int)` })
    .from(productionBatches)
    .where(sql`${productionBatches.number} like ${`PB-${year}-%`}`);
  return Number(row?.max ?? 0) + 1;
}

/** Клас рекомендаційного блокування номерів партій («PBNO»); другий ключ — рік. */
const BATCH_NUMBER_LOCK_CLASS = 0x50424e4f;

/**
 * Номери партій року видаються по черзі: блокування транзакції (знімається при commit/rollback) до читання max.
 * READ COMMITTED: наступний запит після отримання блокування бачить номер, щойно записаний попередньою транзакцією,
 * тож одночасні створення не конфліктують (без блокування ~10 паралельних створень вичерпували повтори).
 */
async function lockBatchNumbers(tx: Tx, year: number): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${BATCH_NUMBER_LOCK_CLASS}::int, ${year}::int)`);
}

async function insertBatchWithNumber(tx: Tx, year: number, values: Omit<typeof productionBatches.$inferInsert, "number">): Promise<BatchRow> {
  await lockBatchNumbers(tx, year);
  // Повтор — лише запобіжник для номерів, записаних поза цією функцією (напр. демо-дані).
  for (let attempt = 0; attempt < 3; attempt++) {
    const number = formatBatchNumber(year, await nextBatchSeq(tx, year));
    try {
      // Точка збереження: конфлікт унікальності номера не псує транзакцію.
      const [row] = await tx.transaction((sp) => sp.insert(productionBatches).values({ ...values, number }).returning());
      if (row) return row;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
  }
  throw new DomainError(PRODUCTION_ERRORS.numberConflict, 409);
}

/**
 * Собівартість для руху (запуск/надходження): планова собівартість ОДИНИЦІ ВИГОТОВЛЕНОГО у валюті партії (ціна +
 * додаткові витрати / Σ billed на момент руху) — одна для якісних і браку руху, без розподілу браку на якісні.
 * Собівартість якісної одиниці (з урахуванням браку) — batchCostSummary().costPerGoodUnit (див. calc.ts).
 */
function movementCost(line: LineRow, batch: BatchRow, totalBilled: number): Pick<MovementInput, "unitCost" | "costCurrency"> {
  const currency = line.costCurrency ?? batch.costCurrency;
  const unit = landedUnitCost(line.unitCost, batch.costCurrency === currency ? batch.extraCost : null, totalBilled);
  return unit !== null && currency ? { unitCost: unit, costCurrency: currency } : { unitCost: null, costCurrency: null };
}

async function bumpBatch(tx: Tx, batch: BatchRow, set: Partial<typeof productionBatches.$inferInsert>, now: Date): Promise<BatchRow> {
  const [row] = await tx
    .update(productionBatches)
    .set({ ...set, version: sql`${productionBatches.version} + 1`, updatedAt: now })
    .where(and(eq(productionBatches.id, batch.id), eq(productionBatches.status, batch.status), eq(productionBatches.version, batch.version)))
    .returning();
  if (!row) throw new ConflictError();
  return row;
}

function invalidStatus(): DomainError {
  return new DomainError(PRODUCTION_ERRORS.invalidStatus, 409);
}

// ---------------------------------------------------------------------------
// Створення та зміна (лише «Заплановано»)
// ---------------------------------------------------------------------------

/** Нова партія «Заплановано» з номером PB-<рік за Києвом>-NNNN. */
export async function createBatch(ctx: ServiceContext, input: BatchInput): Promise<{ batchId: string; number: string }> {
  requirePermission(ctx.actor, "production.manage");
  assertCostPermission(ctx.actor, input);
  const n = normalizeBatchInput(input);
  const currency = n.costCurrency ?? null;
  const hasCosts = (n.extraCost ?? null) !== null || n.lines.some((l) => (l.unitCost ?? null) !== null);
  if (hasCosts && !currency) throw new ProductionValidationError({ costCurrency: FIELD_ERRORS.required });

  return ctx.db.transaction(async (tx) => {
    await assertVariantsExist(tx, n.lines.map((l) => l.variantId));
    const now = ctx.now();
    const batch = await insertBatchWithNumber(tx, kyivYear(now), {
      title: n.title,
      status: "planned",
      plannedReadyDate: n.plannedReadyDate,
      manufacturer: n.manufacturer,
      notes: n.notes,
      extraCost: n.extraCost ?? null,
      costCurrency: currency,
      createdBy: ctx.actor.id,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(productionBatchLines).values(
      n.lines.map((l) => ({
        batchId: batch.id,
        variantId: l.variantId,
        quantityOrdered: l.quantity,
        unitCost: l.unitCost ?? null,
        costCurrency: (l.unitCost ?? null) !== null ? currency : null,
      })),
    );
    await writeAudit(tx, ctx.actor, "production.batch_created", { type: "production_batch", id: batch.id }, {
      number: batch.number,
      lines: n.lines.length,
      units: n.lines.reduce((s, l) => s + l.quantity, 0),
    });
    return { batchId: batch.id, number: batch.number };
  });
}

/**
 * Зміна запланованої партії (заголовок і позиції: нові додаються, відсутні у вхідних даних — видаляються).
 * Оптимістичне блокування: expectedVersion — production_batches.version з форми.
 * Без finance.view ціни наявних позицій і додаткові витрати зберігаються без змін.
 */
export async function updateBatch(ctx: ServiceContext, batchId: string, expectedVersion: number, input: BatchInput): Promise<{ version: number }> {
  requirePermission(ctx.actor, "production.manage");
  assertCostPermission(ctx.actor, input);
  const n = normalizeBatchInput(input);
  const touchesCosts = can(ctx.actor, "finance.view") && (n.extraCost !== undefined || n.costCurrency !== undefined || n.lines.some((l) => l.unitCost !== undefined));

  return ctx.db.transaction(async (tx) => {
    const batch = await lockBatch(tx, batchId);
    if (batch.version !== expectedVersion) throw new ConflictError();
    if (batch.status !== "planned") throw invalidStatus();
    await assertVariantsExist(tx, n.lines.map((l) => l.variantId));
    const existing = await lockLines(tx, batch.id);
    const byVariant = new Map(existing.map((l) => [l.variantId, l]));
    const currency = n.costCurrency !== undefined ? n.costCurrency : batch.costCurrency;
    const extraCost = n.extraCost !== undefined ? n.extraCost : batch.extraCost;
    const finalCost = (l: NormalizedLine) => (l.unitCost !== undefined ? l.unitCost : (byVariant.get(l.variantId)?.unitCost ?? null));
    if ((extraCost !== null || n.lines.some((l) => finalCost(l) !== null)) && !currency) {
      throw new ProductionValidationError({ costCurrency: FIELD_ERRORS.required });
    }

    const keep = new Set(n.lines.map((l) => l.variantId));
    const removed = existing.filter((l) => !keep.has(l.variantId));
    if (removed.length > 0) {
      await tx.delete(productionBatchLines).where(inArray(productionBatchLines.id, removed.map((l) => l.id)));
    }
    const added: NormalizedLine[] = [];
    for (const l of n.lines) {
      const old = byVariant.get(l.variantId);
      const unitCost = finalCost(l);
      if (!old) {
        added.push(l);
        continue;
      }
      const costCurrency = unitCost === null ? null : touchesCosts ? currency : (old.costCurrency ?? currency);
      if (old.quantityOrdered === l.quantity && old.unitCost === unitCost && old.costCurrency === costCurrency) continue;
      await tx
        .update(productionBatchLines)
        .set({
          quantityOrdered: l.quantity,
          unitCost,
          costCurrency,
          version: old.quantityOrdered === l.quantity ? old.version : old.version + 1,
        })
        .where(eq(productionBatchLines.id, old.id));
    }
    if (added.length > 0) {
      await tx.insert(productionBatchLines).values(
        added.map((l) => ({
          batchId: batch.id,
          variantId: l.variantId,
          quantityOrdered: l.quantity,
          unitCost: l.unitCost ?? null,
          costCurrency: (l.unitCost ?? null) !== null ? currency : null,
        })),
      );
    }
    const updated = await bumpBatch(
      tx,
      batch,
      {
        title: n.title,
        plannedReadyDate: n.plannedReadyDate,
        manufacturer: n.manufacturer,
        notes: n.notes,
        extraCost,
        costCurrency: currency,
      },
      ctx.now(),
    );
    await writeAudit(tx, ctx.actor, "production.batch_updated", { type: "production_batch", id: batch.id }, {
      lines: n.lines.length,
      added: added.length,
      removed: removed.length,
      costs: touchesCosts,
    });
    return { version: updated.version };
  });
}

/** Собівартість партії (будь-який стан, крім «Скасовано»): лише власник (production.manage + finance.view). */
export async function updateBatchCosts(ctx: ServiceContext, batchId: string, expectedVersion: number, input: BatchCostsInput): Promise<{ version: number }> {
  requirePermission(ctx.actor, "production.manage");
  requirePermission(ctx.actor, "finance.view");
  const errors: Record<string, string> = {};
  const extraCost = normalizeMoney(input.extraCost, "extraCost", errors) ?? null;
  const currency = normalizeCurrency(input.costCurrency, errors) ?? null;
  const lineCosts = new Map<string, string | null>();
  for (const l of input.lines) {
    if (!UUID_RE.test(l.batchLineId)) throw new NotFoundError("productionBatchLine");
    lineCosts.set(l.batchLineId.toLowerCase(), normalizeMoney(l.unitCost, `lineCost.${l.batchLineId.toLowerCase()}`, errors) ?? null);
  }
  if (Object.keys(errors).length > 0) throw new ProductionValidationError(errors);

  return ctx.db.transaction(async (tx) => {
    const batch = await lockBatch(tx, batchId);
    if (batch.version !== expectedVersion) throw new ConflictError();
    if (batch.status === "cancelled") throw invalidStatus();
    const lines = await lockLines(tx, batch.id);
    const ids = new Set(lines.map((l) => l.id));
    for (const id of lineCosts.keys()) if (!ids.has(id)) throw new NotFoundError("productionBatchLine");
    const finalCost = (l: LineRow) => (lineCosts.has(l.id) ? lineCosts.get(l.id)! : l.unitCost);
    if ((extraCost !== null || lines.some((l) => finalCost(l) !== null)) && !currency) {
      throw new ProductionValidationError({ costCurrency: FIELD_ERRORS.required });
    }
    for (const l of lines) {
      const unitCost = finalCost(l);
      const costCurrency = unitCost === null ? null : currency;
      if (unitCost === l.unitCost && costCurrency === l.costCurrency) continue;
      await tx.update(productionBatchLines).set({ unitCost, costCurrency }).where(eq(productionBatchLines.id, l.id));
      // Етап 6 (§6.7, §14.4): історія змін собівартості — значення до → після (не лише кількість).
      await writeFinanceChange(tx, ctx.actor, {
        entityType: "batch_cost",
        entityId: batch.id,
        action: "update",
        before: { batchId: batch.id, batchLineId: l.id, unitCost: l.unitCost, currency: l.costCurrency, version: batch.version },
        after: { batchId: batch.id, batchLineId: l.id, unitCost, currency: costCurrency, version: batch.version + 1 },
      });
    }
    if (extraCost !== batch.extraCost || currency !== batch.costCurrency) {
      await writeFinanceChange(tx, ctx.actor, {
        entityType: "batch_cost",
        entityId: batch.id,
        action: "update",
        before: { batchId: batch.id, batchLineId: null, extraCost: batch.extraCost, currency: batch.costCurrency, version: batch.version },
        after: { batchId: batch.id, batchLineId: null, extraCost, currency, version: batch.version + 1 },
      });
    }
    const updated = await bumpBatch(tx, batch, { extraCost, costCurrency: currency }, ctx.now());
    // Етап 6 (§6.7): переоцінка вже отриманих одиниць (до залишку / до продажів / до втрат), датою зміни.
    await revalueBatchLinesInternal(tx, ctx.actor, batch.id, { changeActor: ctx.actor, now: ctx.now() });
    await writeAudit(tx, ctx.actor, "production.costs_updated", { type: "production_batch", id: batch.id }, { lines: lineCosts.size });
    return { version: updated.version };
  });
}

// ---------------------------------------------------------------------------
// Запуск, закриття, скасування
// ---------------------------------------------------------------------------

/** «Заплановано» → «У виробництві»: рух production_start (in_production +замовлено) для кожної позиції. */
export async function startProduction(ctx: ServiceContext, batchId: string, expectedVersion: number): Promise<{ lines: number; units: number }> {
  requirePermission(ctx.actor, "production.manage");
  return ctx.db.transaction(async (tx) => {
    const batch = await lockBatch(tx, batchId);
    if (batch.version !== expectedVersion) throw new ConflictError();
    if (batch.status !== "planned") throw invalidStatus();
    const lines = await lockLines(tx, batch.id);
    if (lines.length === 0) throw new DomainError(PRODUCTION_ERRORS.noLines, 409);
    const warehouse = await getDefaultWarehouse(tx);
    const stock = await ensureStockItemsForVariants(tx, lines.map((l) => l.variantId));
    const totalBilled = lines.reduce((s, l) => s + billedQuantity(q(l), batch.status), 0);
    await applyMovements(
      tx,
      ctx.actor,
      lines.map((l) => ({
        warehouseId: warehouse.id,
        stockItemId: stock.get(l.variantId)!,
        type: "production_start" as const,
        idempotencyKey: inventoryKeys.productionStart(l.id, l.version),
        inProductionDelta: l.quantityOrdered,
        productionBatchId: batch.id,
        ...movementCost(l, batch, totalBilled),
        reason: "batch_started",
      })),
    );
    await bumpBatch(tx, batch, { status: "in_production" }, ctx.now());
    const units = lines.reduce((s, l) => s + l.quantityOrdered, 0);
    await writeAudit(tx, ctx.actor, "production.batch_started", { type: "production_batch", id: batch.id }, { lines: lines.length, units });
    return { lines: lines.length, units };
  });
}

/**
 * Закриття партії: незавершений залишок кожної позиції знімається з «У виробництві» (production_close) — його
 * не буде виготовлено. Отримані одиниці лишаються на складі. Стан → «Закрито».
 */
export async function closeBatch(ctx: ServiceContext, batchId: string, expectedVersion: number): Promise<{ lines: number; closedUnits: number }> {
  requirePermission(ctx.actor, "production.manage");
  return ctx.db.transaction(async (tx) => {
    const batch = await lockBatch(tx, batchId);
    if (batch.version !== expectedVersion) throw new ConflictError();
    if (!isStatusIn(batch.status, CLOSABLE_STATUSES)) throw invalidStatus();
    const lines = await lockLines(tx, batch.id);
    const open = lines.filter((l) => lineRemaining(q(l)) > 0);
    if (open.length > 0) {
      const warehouse = await getDefaultWarehouse(tx);
      const stock = await ensureStockItemsForVariants(tx, open.map((l) => l.variantId));
      await applyMovements(
        tx,
        ctx.actor,
        open.map((l) => ({
          warehouseId: warehouse.id,
          stockItemId: stock.get(l.variantId)!,
          type: "production_close" as const,
          idempotencyKey: inventoryKeys.productionClose(l.id),
          inProductionDelta: -lineRemaining(q(l)),
          productionBatchId: batch.id,
          reason: "batch_closed",
        })),
      );
    }
    await bumpBatch(tx, batch, { status: "closed" }, ctx.now());
    // Етап 6 (§6.7): після закриття оплачується лише виготовлене — ціль рядків змінюється (внутрішня функція, без
    // перевірки фінансового доступу: закриття — делегований production.manage).
    await revalueBatchLines(tx, ctx.actor, batch.id);
    const closedUnits = open.reduce((s, l) => s + lineRemaining(q(l)), 0);
    await writeAudit(tx, ctx.actor, "production.batch_closed", { type: "production_batch", id: batch.id }, { lines: open.length, closedUnits });
    return { lines: open.length, closedUnits };
  });
}

/**
 * Скасування: «Заплановано» — без руху складу; «У виробництві» без жодного надходження — запущене знімається з
 * «У виробництві» (production_close). Після надходжень скасувати не можна — лише закрити.
 */
export async function cancelBatch(ctx: ServiceContext, batchId: string, expectedVersion: number): Promise<{ releasedUnits: number }> {
  requirePermission(ctx.actor, "production.manage");
  return ctx.db.transaction(async (tx) => {
    const batch = await lockBatch(tx, batchId);
    if (batch.version !== expectedVersion) throw new ConflictError();
    if (batch.status !== "planned" && batch.status !== "in_production") throw new DomainError(PRODUCTION_ERRORS.cannotCancel, 409);
    const lines = await lockLines(tx, batch.id);
    let releasedUnits = 0;
    if (batch.status === "in_production") {
      const [receipts] = await tx.select({ c: count() }).from(productionReceipts).where(eq(productionReceipts.batchId, batch.id));
      if (Number(receipts?.c ?? 0) > 0 || lines.some((l) => l.quantityReceived + l.quantityDefective > 0)) {
        throw new DomainError(PRODUCTION_ERRORS.cannotCancel, 409);
      }
      const open = lines.filter((l) => lineRemaining(q(l)) > 0);
      if (open.length > 0) {
        const warehouse = await getDefaultWarehouse(tx);
        const stock = await ensureStockItemsForVariants(tx, open.map((l) => l.variantId));
        await applyMovements(
          tx,
          ctx.actor,
          open.map((l) => ({
            warehouseId: warehouse.id,
            stockItemId: stock.get(l.variantId)!,
            type: "production_close" as const,
            idempotencyKey: inventoryKeys.productionClose(l.id),
            inProductionDelta: -lineRemaining(q(l)),
            productionBatchId: batch.id,
            reason: "batch_cancelled",
          })),
        );
      }
      releasedUnits = open.reduce((s, l) => s + lineRemaining(q(l)), 0);
    }
    await bumpBatch(tx, batch, { status: "cancelled" }, ctx.now());
    await revalueBatchLines(tx, ctx.actor, batch.id);
    await writeAudit(tx, ctx.actor, "production.batch_cancelled", { type: "production_batch", id: batch.id }, {
      from: batch.status,
      releasedUnits,
    });
    return { releasedUnits };
  });
}

// ---------------------------------------------------------------------------
// Надходження
// ---------------------------------------------------------------------------

interface PlannedReceiptLine {
  line: LineRow;
  good: number;
  defective: number;
  reason: string | null;
}

function normalizeReceiptLines(lines: ReceiptLineInput[]): ReceiptLineInput[] {
  const errors: Record<string, string> = {};
  const seen = new Set<string>();
  const out: ReceiptLineInput[] = [];
  if (lines.length > LIMITS.lines) throw new ProductionValidationError({ lines: FIELD_ERRORS.tooManyLines });
  for (const l of lines) {
    if (!UUID_RE.test(l.batchLineId)) throw new NotFoundError("productionBatchLine");
    const id = l.batchLineId.toLowerCase();
    if (seen.has(id)) {
      errors[`good.${id}`] = FIELD_ERRORS.duplicate;
      continue;
    }
    seen.add(id);
    const okQty = (n: number) => Number.isSafeInteger(n) && n >= 0 && n <= LIMITS.quantity;
    if (!okQty(l.good)) errors[`good.${id}`] = FIELD_ERRORS.invalidQuantity;
    if (!okQty(l.defective)) errors[`defective.${id}`] = FIELD_ERRORS.invalidQuantity;
    const rawReason = trimOrNull(l.defectReason);
    if (rawReason && rawReason.length > LIMITS.defectReason) errors[`reason.${id}`] = FIELD_ERRORS.tooLong;
    // Причина браку — вільний текст, видимий усім з warehouse.view (примітка руху): без телефонів/email.
    const reason = maskFreeTextNote(rawReason, LIMITS.defectReason);
    out.push({ batchLineId: id, good: l.good, defective: l.defective, defectReason: reason });
  }
  if (Object.keys(errors).length > 0) throw new ProductionValidationError(errors);
  return out.filter((l) => l.good + l.defective > 0);
}

async function existingReceiptResult(tx: Tx, receipt: typeof productionReceipts.$inferSelect, status: ProductionBatchStatus): Promise<ReceiptResult> {
  const rows = await tx.select().from(productionReceiptLines).where(eq(productionReceiptLines.receiptId, receipt.id));
  return {
    receiptId: receipt.id,
    duplicate: true,
    status,
    lines: rows.length,
    good: rows.reduce((s, r) => s + r.goodQty, 0),
    defective: rows.reduce((s, r) => s + r.defectiveQty, 0),
    overReceived: 0,
  };
}

async function lineLabel(tx: Tx, variantId: string): Promise<string> {
  const [v] = await tx
    .select({ title: products.title, variantTitle: productVariants.title, sku: productVariants.sku })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(eq(productVariants.id, variantId));
  if (!v) return "—";
  const variant = v.variantTitle && v.variantTitle !== "Default Title" ? ` · ${v.variantTitle}` : "";
  return `${v.title}${variant}${v.sku ? ` (${v.sku})` : ""}`;
}

/**
 * Надходження з виробництва (часткове): для кожної позиції — якісні й браковані одиниці.
 * Рух receipt_production: in_production −(якісні + брак) у межах залишку позиції, on_hand +якісні, defective +брак.
 * Більше, ніж залишилось, — лише з allowOverReceipt (надлишок одразу у «Фактично»/«Брак»).
 * Стан → «Частково отримано» або «Отримано» (усі позиції виготовлено повністю).
 */
export async function receiveProduction(ctx: ServiceContext, batchId: string, input: ReceiptInput): Promise<ReceiptResult> {
  requirePermission(ctx.actor, "warehouse.receive");
  const key = (input.idempotencyKey ?? "").trim().toLowerCase();
  if (!UUID_RE.test(key)) throw new DomainError(PRODUCTION_ERRORS.receiptKey, 400);
  const rawNote = trimOrNull(input.note);
  if (rawNote && rawNote.length > LIMITS.receiptNote) throw new ProductionValidationError({ note: FIELD_ERRORS.tooLong });
  // Примітка надходження показується на сторінці партії всім з warehouse.view — без телефонів/email/карток/IBAN.
  const note = maskFreeTextNote(rawNote, LIMITS.receiptNote);
  const explicit = input.lines === "remaining" ? null : normalizeReceiptLines(input.lines);

  return ctx.db.transaction(async (tx) => {
    const batch = await lockBatch(tx, batchId);
    // Повтор тієї самої форми (подвійне натискання, повторне надсилання) — вже записане надходження.
    const [existing] = await tx.select().from(productionReceipts).where(eq(productionReceipts.idempotencyKey, key));
    if (existing) {
      if (existing.batchId !== batch.id) throw new DomainError(PRODUCTION_ERRORS.receiptKey, 409);
      return existingReceiptResult(tx, existing, batch.status);
    }
    if (!isStatusIn(batch.status, RECEIVABLE_STATUSES)) throw invalidStatus();
    const lines = await lockLines(tx, batch.id);
    const byId = new Map(lines.map((l) => [l.id, l]));

    let planned: PlannedReceiptLine[];
    if (explicit === null) {
      planned = lines.filter((l) => lineRemaining(q(l)) > 0).map((l) => ({ line: l, good: lineRemaining(q(l)), defective: 0, reason: null }));
    } else {
      planned = explicit.map((i) => {
        const line = byId.get(i.batchLineId);
        if (!line) throw new NotFoundError("productionBatchLine");
        return { line, good: i.good, defective: i.defective, reason: i.defectReason ?? null };
      });
    }
    if (planned.length === 0) throw new DomainError(PRODUCTION_ERRORS.emptyReceipt, 400);
    for (const p of planned) {
      const remaining = lineRemaining(q(p.line));
      const requested = p.good + p.defective;
      if (requested > remaining && !input.allowOverReceipt) {
        throw new DomainError(PRODUCTION_ERRORS.overReceipt, 409, { item: await lineLabel(tx, p.line.variantId), remaining, requested });
      }
    }

    const now = ctx.now();
    const [receipt] = await tx
      .insert(productionReceipts)
      .values({
        batchId: batch.id,
        idempotencyKey: key,
        receivedAt: now,
        receivedBy: ctx.actor.id,
        receivedByName: ctx.actor.displayName.slice(0, 120),
        note,
      })
      .onConflictDoNothing({ target: productionReceipts.idempotencyKey })
      .returning();
    if (!receipt) {
      // Той самий ключ щойно записала інша транзакція (для іншої партії — помилка, для цієї — повтор).
      const [other] = await tx.select().from(productionReceipts).where(eq(productionReceipts.idempotencyKey, key));
      if (!other || other.batchId !== batch.id) throw new DomainError(PRODUCTION_ERRORS.receiptKey, 409);
      return existingReceiptResult(tx, other, batch.status);
    }
    const receiptLines = await tx
      .insert(productionReceiptLines)
      .values(planned.map((p) => ({ receiptId: receipt.id, batchLineId: p.line.id, goodQty: p.good, defectiveQty: p.defective })))
      .returning();
    const receiptLineByBatchLine = new Map(receiptLines.map((r) => [r.batchLineId, r.id]));

    // Нові кількості позицій (для розподілу собівартості й стану партії).
    const after = new Map(lines.map((l) => [l.id, { ...l }]));
    for (const p of planned) {
      const a = after.get(p.line.id)!;
      a.quantityReceived += p.good;
      a.quantityDefective += p.defective;
      a.version += 1;
      await tx
        .update(productionBatchLines)
        .set({
          quantityReceived: sql`${productionBatchLines.quantityReceived} + ${p.good}`,
          quantityDefective: sql`${productionBatchLines.quantityDefective} + ${p.defective}`,
          version: sql`${productionBatchLines.version} + 1`,
        })
        .where(eq(productionBatchLines.id, p.line.id));
    }
    const afterLines = [...after.values()];
    // Стан до/після надходження — відкритий (оплачується max(замовлено, виготовлено)).
    const totalBilled = afterLines.reduce((s, l) => s + billedQuantity(q(l), batch.status), 0);

    const warehouse = await getDefaultWarehouse(tx);
    const stock = await ensureStockItemsForVariants(tx, planned.map((p) => p.line.variantId));
    let overReceived = 0;
    const movements: MovementInput[] = planned.map((p) => {
      const { fromInProduction, over } = allocateReceipt(lineRemaining(q(p.line)), p.good, p.defective);
      overReceived += over;
      return {
        warehouseId: warehouse.id,
        stockItemId: stock.get(p.line.variantId)!,
        type: "receipt_production",
        idempotencyKey: inventoryKeys.productionReceipt(receiptLineByBatchLine.get(p.line.id)!),
        onHandDelta: p.good,
        defectiveDelta: p.defective,
        inProductionDelta: fromInProduction === 0 ? 0 : -fromInProduction,
        productionBatchId: batch.id,
        ...movementCost(after.get(p.line.id)!, batch, totalBilled),
        reason: over > 0 ? "production_over_receipt" : "production_receipt",
        note: p.defective > 0 ? p.reason : null,
      };
    });
    const res = await applyMovements(tx, ctx.actor, movements, movementOptionsFor(ctx));
    // Надходження змінює on_hand → передача в Shopify (у тій самій транзакції; без дублів — dedupe-ключ черги).
    await enqueueInventoryPushIfPending(tx, res.applied);

    const status = statusAfterReceipt(afterLines.map(q));
    await bumpBatch(tx, batch, { status }, now);
    const good = planned.reduce((s, p) => s + p.good, 0);
    const defective = planned.reduce((s, p) => s + p.defective, 0);
    await writeAudit(tx, ctx.actor, "production.received", { type: "production_batch", id: batch.id }, {
      receiptId: receipt.id,
      lines: planned.length,
      good,
      defective,
      overReceived,
      status,
    });
    return { receiptId: receipt.id, duplicate: false, status, lines: planned.length, good, defective, overReceived };
  });
}
