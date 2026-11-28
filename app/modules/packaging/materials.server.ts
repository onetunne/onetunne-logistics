/**
 * Пакувальні матеріали: довідник (коробки з внутрішніми габаритами, макс. вагою й тарою; наклейки, інструкції,
 * візитки, болти, наповнювач, скотч…) і залишки через журнал руху (docs/stage5-design.md §5, §11).
 *
 * Дозволи (перевіряються тут, на сервері):
 * - перегляд — warehouse.view; собівартість (unit_cost) — лише finance.view (власник): без нього не повертається й не
 *   змінюється (поле у формі ігнорується);
 * - створення/зміна/деактивація матеріалу, поріг «мало» — warehouse.adjust (типово власник);
 * - надходження — warehouse.receive (працівник); списання, коригування, інвентаризація — warehouse.adjust.
 *
 * Залишки змінюються ЛИШЕ через applyMovements (тип receipt_manual / adjustment) з ключами manual:<операція>:<матеріал>:
 * подвійне надсилання тієї самої форми не дублює рух. Матеріал не може піти в мінус (правило журналу).
 *
 * Витрата: «Витрачено за 30 днів» — сума рухів material_consume (списання при пакуванні) за останні
 * MATERIAL_CONSUMPTION_DAYS днів за Києвом; «вистачить на» — фактичний залишок / середня витрата за день (materialDaysLeft).
 *
 * Попередження «мало / немає» матеріалів оцінює цей модуль (refreshMaterialAlerts): активні — як у ядрі, неактивні —
 * закриваються й не відкриваються (власник вивів матеріал з ужитку). Блокування: рядки матеріалів → баланси
 * (FOR UPDATE у порядку stock_item_id) → попередження — той самий порядок, що й у ledger.server.ts.
 */
import { and, asc, count, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";
import type { DbOrTx, Tx } from "~/db/client.server";
import {
  inventoryBalances,
  inventoryMovements,
  kitTemplateLines,
  packagingMaterials,
  stockAlerts,
  stockItemCosts,
  stockItems,
  type MaterialUnit,
  type PackagingMaterialKind,
} from "~/db/schema";
import { can, ForbiddenError, requirePermission } from "~/domain/permissions";
import { ConflictError, DomainError, NotFoundError } from "~/lib/errors";
import { writeAudit } from "~/modules/audit/audit.server";
import { writeFinanceChange } from "~/modules/finance/core/change-log.server";
import { stockLevelStatus, type StockLevelStatus } from "~/modules/inventory/alerts";
import { inventoryKeys } from "~/modules/inventory/keys";
import {
  applyMovements,
  ensureStockItemForMaterial,
  evaluateStockAlerts,
  lockBalances,
  setLowStockThreshold,
  type MovementInput,
} from "~/modules/inventory/ledger.server";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import { getSetting } from "~/modules/settings/settings.server";
import { businessDate, businessDayEnd, businessDayStart } from "~/modules/warehouse/dates";
import type { ServiceContext } from "~/server/types";
import { BOX_KINDS, boxInnerDims } from "./box-selection";
import { matchesVersion, touchedAt, versionToken } from "./version";
import {
  materialInputSchema,
  materialStockDelta,
  materialStockInputSchema,
  type MaterialInput,
  type MaterialStockInput,
  type ParsedMaterialInput,
  type MaterialStockOperation,
} from "./schemas";

export type MaterialRow = typeof packagingMaterials.$inferSelect;

/** Стан залишку матеріалу для фільтрів (резервів у матеріалів немає, тож oversold неможливий). */
export const MATERIAL_STOCK_STATUSES = ["ok", "low", "out", "negative"] as const satisfies readonly StockLevelStatus[];
export type MaterialStockStatus = (typeof MATERIAL_STOCK_STATUSES)[number];

export interface MaterialView {
  id: string;
  code: string;
  name: string;
  kind: PackagingMaterialKind;
  unit: MaterialUnit;
  active: boolean;
  innerLengthMm: number | null;
  innerWidthMm: number | null;
  innerHeightMm: number | null;
  maxWeightGrams: number | null;
  tareWeightGrams: number | null;
  /** Лише з finance.view (includeCosts), інакше null. */
  unitCost: string | null;
  costCurrency: string | null;
  /** Коробка/пакет (може бути транспортною упаковкою). */
  isBox: boolean;
  /** Бере участь в автоматичному підборі (активна коробка/пакет із габаритами). */
  selectable: boolean;
  stockItemId: string | null;
  onHand: number;
  /** Власний поріг матеріалу (null — типовий із налаштувань «Склад»). */
  lowStockThreshold: number | null;
  /** Поріг, що діє. */
  threshold: number;
  status: StockLevelStatus;
  /** Скільки рядків шаблонів комплектації посилаються на матеріал. */
  kitLines: number;
  /** Витрачено при пакуванні за останні MATERIAL_CONSUMPTION_DAYS днів (рухи material_consume). */
  consumedRecent: number;
  /** На скільки днів вистачить фактичного залишку за такої витрати; null — витрат за цей час не було. */
  daysLeft: number | null;
  /** Мітка версії для оптимістичного блокування форми (version.ts). */
  version: string;
}

/** Період «Витрачено за … днів» і прогнозу «вистачить на» (днів, до сьогодні включно, за Києвом). */
export const MATERIAL_CONSUMPTION_DAYS = 30;

/** "YYYY-MM-DD" + n днів (календарна дата, без часового поясу). */
function isoAddDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * На скільки днів вистачить залишку onHand за витрати consumed за `days` днів (униз до цілих днів).
 * Без витрат — null (прогнозу немає); немає залишку — 0.
 */
export function materialDaysLeft(onHand: number, consumed: number, days: number = MATERIAL_CONSUMPTION_DAYS): number | null {
  if (!Number.isSafeInteger(consumed) || consumed <= 0 || !Number.isSafeInteger(days) || days <= 0) return null;
  if (onHand <= 0) return 0;
  return Math.floor((onHand * days) / consumed);
}

/**
 * Витрата матеріалів (Σ −on_hand_delta рухів material_consume) за останні `days` днів до сьогодні включно (за Києвом)
 * на складі — для позицій обліку stockItemIds. Позиції без витрат у результаті відсутні.
 */
export async function loadMaterialConsumption(
  db: DbOrTx,
  stockItemIds: readonly string[],
  opts: { warehouseId: string; now?: Date; days?: number },
): Promise<Map<string, number>> {
  const ids = [...new Set(stockItemIds)];
  if (ids.length === 0) return new Map();
  const days = opts.days ?? MATERIAL_CONSUMPTION_DAYS;
  const today = businessDate(opts.now ?? new Date());
  const rows = await db
    .select({
      stockItemId: inventoryMovements.stockItemId,
      consumed: sql<number>`coalesce(sum(-${inventoryMovements.onHandDelta}), 0)`.mapWith(Number),
    })
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.warehouseId, opts.warehouseId),
        inArray(inventoryMovements.stockItemId, ids),
        eq(inventoryMovements.type, "material_consume"),
        gte(inventoryMovements.createdAt, businessDayStart(isoAddDays(today, -(days - 1)))),
        lte(inventoryMovements.createdAt, businessDayEnd(today)),
      ),
    )
    .groupBy(inventoryMovements.stockItemId);
  return new Map(rows.filter((r) => r.consumed > 0).map((r) => [r.stockItemId, r.consumed]));
}

export interface MaterialListFilters {
  kinds?: PackagingMaterialKind[];
  statuses?: MaterialStockStatus[];
  /** active (за замовчуванням) | inactive | all */
  activity?: "active" | "inactive" | "all";
  search?: string;
  ids?: string[];
}

export interface MaterialListResult {
  rows: MaterialView[];
  /** Кількість за станом залишку (з урахуванням інших фільтрів, без фільтра стану) — для вкладок/лічильників. */
  statusCounts: Record<MaterialStockStatus, number>;
  total: number;
}

export const MAX_MATERIALS_LISTED = 1000;

const likePattern = (search: string) => `%${search.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * Перелік матеріалів із залишком на складі за замовчуванням. Фільтри: вид, стан залишку (ok/low/out/negative),
 * активність, пошук за назвою/кодом. Матеріалів небагато (десятки), тож стан рахується в коді (alerts.ts — ті самі
 * правила, що й попередження) і перелік не ділиться на сторінки (до MAX_MATERIALS_LISTED).
 */
export async function listMaterials(
  db: DbOrTx,
  filters: MaterialListFilters = {},
  opts: { includeCosts?: boolean; /** «Сьогодні» для витрат за 30 днів (ctx.now()). */ now?: Date } = {},
): Promise<MaterialListResult> {
  const warehouse = await getDefaultWarehouse(db);
  const defaultThreshold = (await getSetting(db, "warehouse")).lowStockThreshold;
  const activity = filters.activity ?? "active";
  if (filters.ids && filters.ids.length === 0) return { rows: [], statusCounts: emptyCounts(), total: 0 };
  const search = filters.search?.trim();
  const rows = await db
    .select({
      material: packagingMaterials,
      stockItemId: stockItems.id,
      lowStockThreshold: stockItems.lowStockThreshold,
      onHand: inventoryBalances.onHand,
      reserved: inventoryBalances.reserved,
      version: versionToken(packagingMaterials.updatedAt),
    })
    .from(packagingMaterials)
    .leftJoin(stockItems, eq(stockItems.materialId, packagingMaterials.id))
    .leftJoin(
      inventoryBalances,
      and(eq(inventoryBalances.stockItemId, stockItems.id), eq(inventoryBalances.warehouseId, warehouse.id)),
    )
    .where(
      and(
        activity === "all" ? undefined : eq(packagingMaterials.active, activity === "active"),
        filters.kinds?.length ? inArray(packagingMaterials.kind, filters.kinds) : undefined,
        filters.ids?.length ? inArray(packagingMaterials.id, filters.ids) : undefined,
        search ? or(ilike(packagingMaterials.name, likePattern(search)), ilike(packagingMaterials.code, likePattern(search))) : undefined,
      ),
    )
    .orderBy(asc(packagingMaterials.kind), asc(packagingMaterials.name), asc(packagingMaterials.code))
    .limit(MAX_MATERIALS_LISTED);
  const ids = rows.map((r) => r.material.id);
  const usage = ids.length
    ? await db
        .select({ materialId: kitTemplateLines.materialId, c: count() })
        .from(kitTemplateLines)
        .where(inArray(kitTemplateLines.materialId, ids))
        .groupBy(kitTemplateLines.materialId)
    : [];
  const usageBy = new Map(usage.map((u) => [u.materialId, Number(u.c)]));
  const consumption = await loadMaterialConsumption(
    db,
    rows.flatMap((r) => (r.stockItemId ? [r.stockItemId] : [])),
    { warehouseId: warehouse.id, now: opts.now },
  );
  const views = rows.map((r) =>
    toView(r.material, {
      stockItemId: r.stockItemId,
      lowStockThreshold: r.lowStockThreshold,
      onHand: r.onHand ?? 0,
      reserved: r.reserved ?? 0,
      defaultThreshold,
      kitLines: usageBy.get(r.material.id) ?? 0,
      consumedRecent: r.stockItemId ? (consumption.get(r.stockItemId) ?? 0) : 0,
      includeCosts: opts.includeCosts === true,
      version: r.version,
    }),
  );
  const statusCounts = emptyCounts();
  for (const v of views) if (isMaterialStatus(v.status)) statusCounts[v.status] += 1;
  const filtered = filters.statuses?.length ? views.filter((v) => (filters.statuses as string[]).includes(v.status)) : views;
  return { rows: filtered, statusCounts, total: filtered.length };
}

function emptyCounts(): Record<MaterialStockStatus, number> {
  return { ok: 0, low: 0, out: 0, negative: 0 };
}

export function isMaterialStatus(v: unknown): v is MaterialStockStatus {
  return typeof v === "string" && (MATERIAL_STOCK_STATUSES as readonly string[]).includes(v);
}

function toView(
  m: MaterialRow,
  s: {
    stockItemId: string | null;
    lowStockThreshold: number | null;
    onHand: number;
    reserved: number;
    defaultThreshold: number;
    kitLines: number;
    consumedRecent: number;
    includeCosts: boolean;
    version: string;
  },
): MaterialView {
  const threshold = s.lowStockThreshold ?? s.defaultThreshold;
  const isBox = BOX_KINDS.includes(m.kind);
  return {
    id: m.id,
    code: m.code,
    name: m.name,
    kind: m.kind,
    unit: m.unit,
    active: m.active,
    innerLengthMm: m.innerLengthMm,
    innerWidthMm: m.innerWidthMm,
    innerHeightMm: m.innerHeightMm,
    maxWeightGrams: m.maxWeightGrams,
    tareWeightGrams: m.tareWeightGrams,
    unitCost: s.includeCosts ? m.unitCost : null,
    costCurrency: s.includeCosts ? m.costCurrency : null,
    isBox,
    selectable: isBox && m.active && boxInnerDims(m) !== null,
    stockItemId: s.stockItemId,
    onHand: s.onHand,
    lowStockThreshold: s.lowStockThreshold,
    threshold,
    status: stockLevelStatus({ onHand: s.onHand, reserved: s.reserved, threshold }),
    kitLines: s.kitLines,
    consumedRecent: s.consumedRecent,
    daysLeft: materialDaysLeft(s.onHand, s.consumedRecent),
    version: s.version,
  };
}

/** Один матеріал (у т.ч. неактивний). */
export async function getMaterial(db: DbOrTx, id: string, opts: { includeCosts?: boolean; now?: Date } = {}): Promise<MaterialView> {
  const { rows } = await listMaterials(db, { ids: [id], activity: "all" }, opts);
  const row = rows[0];
  if (!row) throw new NotFoundError("material");
  return row;
}

// ---------------------------------------------------------------------------
// Попередження матеріалів
// ---------------------------------------------------------------------------

/**
 * Блокує НАЯВНІ рядки балансів матеріалів (усі склади) FOR UPDATE у порядку (stock_item_id, warehouse_id) — як
 * lockBalances, але без створення нових рядків (новий матеріал без руху не має балансу й попереджень). Перед зміною
 * попереджень поза applyMovements (поріг, активність): зміни попереджень позиції не перетинаються з рухами.
 */
async function lockMaterialBalances(tx: Tx, materialIds: readonly string[]): Promise<void> {
  const ids = [...new Set(materialIds)];
  if (ids.length === 0) return;
  const items = await tx.select({ id: stockItems.id }).from(stockItems).where(inArray(stockItems.materialId, ids));
  if (items.length === 0) return;
  await tx
    .select({ stockItemId: inventoryBalances.stockItemId })
    .from(inventoryBalances)
    .where(inArray(inventoryBalances.stockItemId, items.map((i) => i.id)))
    .orderBy(asc(inventoryBalances.stockItemId), asc(inventoryBalances.warehouseId))
    .for("update");
}

/**
 * Попередження «мало / немає» матеріалів: АКТИВНІ — переоцінюються (evaluateStockAlerts), НЕАКТИВНІ — закриваються
 * й не відкриваються (власник вивів матеріал з ужитку; «Склад» рахує відкриті попередження матеріалів, а «Матеріали»
 * типово показує лише активні). Ядро активність не враховує, тому модуль викликає це після кожної зміни залишку
 * (applyMovements з evaluateAlerts: false), порогу чи активності матеріалів — під блокуванням їхніх балансів.
 * Для consumption.server.ts (списання при пакуванні) — так само.
 */
export async function refreshMaterialAlerts(tx: DbOrTx, materialIds: readonly string[]): Promise<{ resolvedInactive: number }> {
  const ids = [...new Set(materialIds)];
  if (ids.length === 0) return { resolvedInactive: 0 };
  const items = await tx
    .select({ stockItemId: stockItems.id, active: packagingMaterials.active })
    .from(stockItems)
    .innerJoin(packagingMaterials, eq(packagingMaterials.id, stockItems.materialId))
    .where(inArray(stockItems.materialId, ids));
  const active = items.filter((i) => i.active).map((i) => i.stockItemId);
  const inactive = items.filter((i) => !i.active).map((i) => i.stockItemId);
  if (active.length > 0) await evaluateStockAlerts(tx, active);
  if (inactive.length === 0) return { resolvedInactive: 0 };
  const resolved = await tx
    .update(stockAlerts)
    .set({ status: "resolved", resolvedAt: new Date() })
    .where(and(inArray(stockAlerts.stockItemId, inactive), eq(stockAlerts.status, "open")))
    .returning({ id: stockAlerts.id });
  return { resolvedInactive: resolved.length };
}

// ---------------------------------------------------------------------------
// Довідник: створення / зміна / активність
// ---------------------------------------------------------------------------

function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return (err?.code ?? err?.cause?.code) === "23505";
}

function materialValues(parsed: ParsedMaterialInput, withCosts: boolean) {
  const isBox = BOX_KINDS.includes(parsed.kind);
  return {
    code: parsed.code,
    name: parsed.name,
    kind: parsed.kind,
    unit: parsed.unit,
    // Габарити, вага й тара мають сенс лише для коробок/пакетів — для інших видів не зберігаються.
    innerLengthMm: isBox ? parsed.innerLengthMm : null,
    innerWidthMm: isBox ? parsed.innerWidthMm : null,
    innerHeightMm: isBox ? parsed.innerHeightMm : null,
    maxWeightGrams: isBox ? parsed.maxWeightGrams : null,
    tareWeightGrams: isBox ? parsed.tareWeightGrams : null,
    active: parsed.active,
    // Собівартість — лише з finance.view і лише якщо поле передано (форма працівника його не має).
    ...(withCosts && parsed.unitCost !== undefined
      ? { unitCost: parsed.unitCost, costCurrency: parsed.unitCost !== null ? (parsed.costCurrency ?? null) : null }
      : {}),
  };
}

/** Новий матеріал (warehouse.adjust). Собівартість — лише з finance.view. Створює позицію обліку з нульовим залишком. */
export async function createMaterial(ctx: ServiceContext, input: MaterialInput): Promise<{ id: string }> {
  requirePermission(ctx.actor, "warehouse.adjust");
  const parsed = materialInputSchema.parse(input);
  const withCosts = can(ctx.actor, "finance.view");
  try {
    return await ctx.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(packagingMaterials)
        .values(materialValues(parsed, withCosts))
        .returning({ id: packagingMaterials.id });
      const stockItemId = await ensureStockItemForMaterial(tx, row!.id);
      if (parsed.lowStockThreshold !== null) await setLowStockThreshold(tx, stockItemId, parsed.lowStockThreshold);
      if (withCosts && parsed.unitCost != null) {
        await recordCatalogueCost(ctx, tx, row!.id, stockItemId, { unitCost: null, currency: null }, { unitCost: parsed.unitCost, currency: parsed.costCurrency ?? null });
      }
      await writeAudit(tx, ctx.actor, "packaging.material.created", { type: "packaging_material", id: row!.id }, {
        code: parsed.code,
        kind: parsed.kind,
      });
      return { id: row!.id };
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new DomainError("packaging.error.codeTaken", 409, { code: parsed.code });
    throw e;
  }
}

/**
 * Зміна матеріалу (warehouse.adjust). expectedVersion — мітка версії з форми (MaterialView.version): дані,
 * змінені іншим користувачем після відкриття форми, не перезаписуються (ConflictError).
 */
export async function updateMaterial(
  ctx: ServiceContext,
  id: string,
  input: MaterialInput,
  opts: { expectedVersion?: string | null } = {},
): Promise<void> {
  requirePermission(ctx.actor, "warehouse.adjust");
  const parsed = materialInputSchema.parse(input);
  const withCosts = can(ctx.actor, "finance.view");
  try {
    await ctx.db.transaction(async (tx) => {
      const [previous] = await tx
        .select({ unitCost: packagingMaterials.unitCost, currency: packagingMaterials.costCurrency })
        .from(packagingMaterials)
        .where(eq(packagingMaterials.id, id))
        .for("no key update");
      const updated = await tx
        .update(packagingMaterials)
        .set({ ...materialValues(parsed, withCosts), updatedAt: touchedAt() })
        .where(and(eq(packagingMaterials.id, id), opts.expectedVersion ? matchesVersion(packagingMaterials.updatedAt, opts.expectedVersion) : undefined))
        .returning({ id: packagingMaterials.id });
      if (updated.length === 0) {
        const [exists] = await tx.select({ id: packagingMaterials.id }).from(packagingMaterials).where(eq(packagingMaterials.id, id));
        if (!exists) throw new NotFoundError("material");
        throw new ConflictError();
      }
      const stockItemId = await ensureStockItemForMaterial(tx, id);
      if (withCosts && parsed.unitCost !== undefined && previous) {
        const next = { unitCost: parsed.unitCost, currency: parsed.unitCost !== null ? (parsed.costCurrency ?? null) : null };
        if (next.unitCost !== previous.unitCost || next.currency !== previous.currency) {
          await recordCatalogueCost(ctx, tx, id, stockItemId, { unitCost: previous.unitCost, currency: previous.currency }, next);
        }
      }
      await lockMaterialBalances(tx, [id]);
      const [item] = await tx.select({ t: stockItems.lowStockThreshold }).from(stockItems).where(eq(stockItems.id, stockItemId));
      if ((item?.t ?? null) !== parsed.lowStockThreshold) await setLowStockThreshold(tx, stockItemId, parsed.lowStockThreshold);
      // Активність могла змінитися у формі: неактивний — попередження закриваються, активний — переоцінюються.
      await refreshMaterialAlerts(tx, [id]);
      await writeAudit(tx, ctx.actor, "packaging.material.updated", { type: "packaging_material", id }, {
        code: parsed.code,
        kind: parsed.kind,
        active: parsed.active,
        costChanged: withCosts && parsed.unitCost !== undefined,
      });
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new DomainError("packaging.error.codeTaken", 409, { code: parsed.code });
    throw e;
  }
}

/**
 * Етап 6 (§6.6, §6.7): зміна каталожної ціни матеріалу — рядок stock_item_costs (material_catalogue, діє з сьогодні за
 * Києвом; лише вставка — оцінки минулих рухів не змінюються) + історія змін (до → після). Порожня ціна — лише запис
 * історії (рядка без ціни немає: «немає даних», не 0). Викликається лише з finance.view (поле ціни власника).
 */
async function recordCatalogueCost(
  ctx: ServiceContext,
  tx: Tx,
  materialId: string,
  stockItemId: string,
  before: { unitCost: string | null; currency: string | null },
  after: { unitCost: string | null; currency: string | null },
): Promise<void> {
  if (after.unitCost !== null && after.currency) {
    await tx.insert(stockItemCosts).values({
      stockItemId,
      unitCost: after.unitCost,
      currency: after.currency,
      effectiveFrom: businessDate(ctx.now()),
      source: "material_catalogue",
      confirmed: true,
      createdBy: ctx.actor.id,
    });
  }
  await writeFinanceChange(tx, ctx.actor, {
    entityType: "material_cost",
    entityId: materialId,
    action: before.unitCost === null ? "create" : "update",
    before: before.unitCost === null ? null : { materialId, unitCost: before.unitCost, currency: before.currency },
    after: { materialId, unitCost: after.unitCost, currency: after.currency },
  });
}

/** Масово активувати/деактивувати (warehouse.adjust). Неактивний матеріал не підбирається й не входить у комплекти. */
export async function setMaterialsActive(ctx: ServiceContext, ids: readonly string[], active: boolean): Promise<{ updated: number }> {
  requirePermission(ctx.actor, "warehouse.adjust");
  const unique = [...new Set(ids)];
  if (unique.length === 0) return { updated: 0 };
  return ctx.db.transaction(async (tx) => {
    // Блокування рядків у стабільному порядку (без взаємоблокувань паралельних масових дій), потім зміна.
    await tx.select({ id: packagingMaterials.id }).from(packagingMaterials).where(inArray(packagingMaterials.id, unique)).orderBy(asc(packagingMaterials.id)).for("no key update");
    const rows = await tx
      .update(packagingMaterials)
      .set({ active, updatedAt: touchedAt() })
      .where(and(inArray(packagingMaterials.id, unique), eq(packagingMaterials.active, !active)))
      .returning({ id: packagingMaterials.id });
    if (rows.length > 0) {
      // Деактивація закриває попередження матеріалу, активація — переоцінює їх.
      const changed = rows.map((r) => r.id);
      await lockMaterialBalances(tx, changed);
      await refreshMaterialAlerts(tx, changed);
      await writeAudit(tx, ctx.actor, active ? "packaging.material.activated" : "packaging.material.deactivated", { type: "packaging_material" }, {
        ids: rows.map((r) => r.id),
      });
    }
    return { updated: rows.length };
  });
}

/** Власний поріг «мало» матеріалу (null — типовий). warehouse.adjust. */
export async function setMaterialThreshold(ctx: ServiceContext, materialId: string, threshold: number | null): Promise<void> {
  requirePermission(ctx.actor, "warehouse.adjust");
  await ctx.db.transaction(async (tx) => {
    const [m] = await tx.select({ id: packagingMaterials.id }).from(packagingMaterials).where(eq(packagingMaterials.id, materialId));
    if (!m) throw new NotFoundError("material");
    const stockItemId = await ensureStockItemForMaterial(tx, materialId);
    await lockMaterialBalances(tx, [materialId]);
    await setLowStockThreshold(tx, stockItemId, threshold);
    await refreshMaterialAlerts(tx, [materialId]);
    await writeAudit(tx, ctx.actor, "packaging.material.threshold", { type: "packaging_material", id: materialId }, { threshold });
  });
}

// ---------------------------------------------------------------------------
// Залишки: надходження / списання / коригування / інвентаризація
// ---------------------------------------------------------------------------

export interface MaterialStockLineResult {
  materialId: string;
  code: string;
  name: string;
  unit: MaterialUnit;
  before: number;
  delta: number;
  after: number;
  /** applied — записано; duplicate — ця форма вже була застосована (повтор, рух не створено); unchanged — різниці немає. */
  status: "applied" | "duplicate" | "unchanged";
}

export interface MaterialStockResult {
  operation: MaterialStockOperation;
  lines: MaterialStockLineResult[];
  applied: number;
  duplicates: number;
  unchanged: number;
  /** Сума застосованих змін (одиниці матеріалу). */
  totalDelta: number;
}

/** Потрібний дозвіл для операції із залишком матеріалу. */
export function materialStockPermission(operation: MaterialStockOperation): "warehouse.receive" | "warehouse.adjust" {
  return operation === "receive" ? "warehouse.receive" : "warehouse.adjust";
}

const OPERATION_REASON: Record<MaterialStockOperation, string> = {
  receive: "material_receipt",
  writeoff: "write_off",
  adjust: "correction",
  count: "stock_count",
};

/**
 * Операція із залишком кількох матеріалів — ОДНА транзакція й один виклик applyMovements (усе або нічого).
 * - receive: +кількість (receipt_manual; кількість > 0; собівартість — лише з finance.view);
 * - writeoff: −кількість (adjustment, причина write_off; кількість > 0);
 * - adjust: ±кількість (adjustment, причина correction; ≠ 0);
 * - count: інвентаризація — фактична кількість ≥ 0 (adjustment на різницю від поточного; без різниці — без руху).
 * Ключі ідемпотентності — manual:<operationId>:<materialId>: повтор тієї самої форми → «duplicate», залишок не
 * змінюється вдруге. Якщо результат зробив би залишок від'ємним — packaging.error.insufficient (нічого не записано).
 */
export async function applyMaterialStock(ctx: ServiceContext, input: MaterialStockInput): Promise<MaterialStockResult> {
  const parsed = materialStockInputSchema.parse(input);
  requirePermission(ctx.actor, materialStockPermission(parsed.operation));
  const hasCost = parsed.unitCost != null;
  if (hasCost && !can(ctx.actor, "finance.view")) throw new ForbiddenError("finance.view");
  if (hasCost && parsed.operation !== "receive") throw new DomainError("packaging.error.costOnlyReceive", 400);
  if (hasCost && !parsed.costCurrency) throw new DomainError("packaging.error.currencyRequired", 400);

  const seen = new Set<string>();
  for (const line of parsed.lines) {
    const id = line.materialId.toLowerCase();
    if (seen.has(id)) throw new DomainError("packaging.error.stockDuplicate", 400);
    seen.add(id);
    if (materialStockDelta(parsed.operation, line.quantity, 0) === null) {
      throw new DomainError("packaging.error.stockQuantity", 400, { operation: parsed.operation });
    }
  }

  return ctx.db.transaction(async (tx) => {
    const warehouse = await getDefaultWarehouse(tx);
    const ids = parsed.lines.map((l) => l.materialId);
    const materials = await tx.select().from(packagingMaterials).where(inArray(packagingMaterials.id, ids));
    const byId = new Map(materials.map((m) => [m.id, m]));
    for (const id of ids) if (!byId.has(id)) throw new NotFoundError("material");

    // Позиції обліку в стабільному порядку, потім блокування балансів — дельти рахуються від заблокованих значень.
    const stockIds = new Map<string, string>();
    for (const id of [...ids].sort()) stockIds.set(id, await ensureStockItemForMaterial(tx, id));
    const locked = await lockBalances(
      tx,
      ids.map((id) => ({ warehouseId: warehouse.id, stockItemId: stockIds.get(id)! })),
    );

    // Повтор тієї самої форми: рух із ключем уже є → «duplicate» (без перевірки залишку й без нового руху).
    const keyOf = (materialId: string) => inventoryKeys.manual(parsed.operationId.toLowerCase(), materialId);
    const existing = await tx
      .select({ key: inventoryMovements.idempotencyKey })
      .from(inventoryMovements)
      .where(inArray(inventoryMovements.idempotencyKey, ids.map(keyOf)));
    const existingKeys = new Set(existing.map((r) => r.key));

    const results: MaterialStockLineResult[] = [];
    const movements: MovementInput[] = [];
    const reason = OPERATION_REASON[parsed.operation];
    for (const line of parsed.lines) {
      const m = byId.get(line.materialId)!;
      const stockItemId = stockIds.get(line.materialId)!;
      const before = locked.get(`${warehouse.id}|${stockItemId}`)?.onHand ?? 0;
      const base = { materialId: m.id, code: m.code, name: m.name, unit: m.unit, before };
      if (existingKeys.has(keyOf(m.id))) {
        results.push({ ...base, delta: 0, after: before, status: "duplicate" });
        continue;
      }
      const delta = materialStockDelta(parsed.operation, line.quantity, before)!;
      if (before + delta < 0) {
        throw new DomainError("packaging.error.insufficient", 409, { code: m.code, current: before, change: delta });
      }
      results.push({ ...base, delta, after: before + delta, status: delta === 0 ? "unchanged" : "applied" });
      if (delta === 0) continue;
      movements.push({
        warehouseId: warehouse.id,
        stockItemId,
        type: parsed.operation === "receive" ? "receipt_manual" : "adjustment",
        idempotencyKey: keyOf(m.id),
        onHandDelta: delta,
        reason,
        note: parsed.note ?? null,
        unitCost: hasCost ? parsed.unitCost : null,
        costCurrency: hasCost ? parsed.costCurrency : null,
      });
    }
    // Попередження оцінює refreshMaterialAlerts (неактивні матеріали — без попереджень); баланси вже заблоковані.
    const applied = await applyMovements(tx, ctx.actor, movements, { evaluateAlerts: false });
    // Паралельне надсилання тієї самої форми: інша транзакція встигла записати рух — теж «duplicate».
    const raced = new Set(applied.skipped.map((s) => s.stockItemId));
    for (const r of results) {
      if (r.status === "applied" && raced.has(stockIds.get(r.materialId)!)) {
        r.status = "duplicate";
        r.delta = 0;
        r.after = r.before;
      }
    }
    // Також без руху (інвентаризація без різниці, повтор): поріг міг змінитися.
    await refreshMaterialAlerts(tx, ids);
    const summary: MaterialStockResult = {
      operation: parsed.operation,
      lines: results,
      applied: results.filter((r) => r.status === "applied").length,
      duplicates: results.filter((r) => r.status === "duplicate").length,
      unchanged: results.filter((r) => r.status === "unchanged").length,
      totalDelta: results.reduce((s, r) => s + r.delta, 0),
    };
    if (summary.applied > 0) {
      await writeAudit(tx, ctx.actor, `packaging.stock.${parsed.operation}`, { type: "packaging_material" }, {
        operationId: parsed.operationId,
        materials: results.filter((r) => r.status === "applied").map((r) => ({ code: r.code, delta: r.delta })),
      });
    }
    return summary;
  });
}
