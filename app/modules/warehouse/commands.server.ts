/**
 * Сервісний шар команд складу для майбутнього Telegram-бота та ШІ-асистента (docs/telegram-warehouse-readiness.md).
 *
 * РЕАЛІЗОВАНО: типізовані команди (zod-схеми), дозвіл на кожну команду, рівень ризику, ознака підтвердження,
 * виконання від імені АКТОРА (ctx.actor — працівник, якому зіставлено користувача Telegram), короткі
 * текстові результати без персональних даних. Реєстрація в інструментах асистента — modules/assistant/tools.server.ts.
 * НЕ РЕАЛІЗОВАНО: сам бот, мережеві виклики Telegram, зіставлення користувачів Telegram з працівниками, сповіщення.
 *
 * Правила:
 * - команда не має більших прав, ніж працівник: дозвіл перевіряється тут (runWarehouseCommand) і повторно в сервісах
 *   (receiveStock/markDefective — operations.server.ts);
 * - команди-зміни (write) ЗАВЖДИ потребують підтвердження людиною в цьому шарі (confirmed: true після кнопки
 *   «Підтвердити» в боті); preview показує «було → стане» і нічого не змінює;
 * - ідемпотентність: write-команда отримує operationId (uuid) ВІД ВИКЛИКАЧА — бот генерує його один раз на
 *   намір (newCommandOperationId) і повторює той самий при повторі/підтвердженні. Ключ руху — manual:<operationId>:
 *   повтор не змінює залишок удруге (result: "replay"), той самий uuid для іншої операції — помилка;
 * - результати — коди, кількості, SKU й назви товарів; жодних даних покупців, сум і собівартості (фінанси — лише
 *   на сторінках власника).
 * start_packing — «Почати пакування» замовлення через модуль пакування (modules/packing/packing.server.ts: дозвіл
 * packing.perform, CAS-перехід статусу «Накладну створено» → «Очікує комплектації», одне активне пакування).
 * receive_production — надходження з виробничої партії через receiveProduction (modules/production/batches.server.ts:
 * дозвіл warehouse.receive, блокування рядка партії, operationId = production_receipts.idempotency_key — повтор не
 * записує друге надходження). material_receive — надходження пакувальних матеріалів через applyMaterialStock
 * (modules/packaging/materials.server.ts: ключ manual:<operationId>:<materialId>; без собівартості).
 * Один operationId — одна операція: той самий uuid для іншої команди/позиції/кількостей — warehouse.error.operationReused.
 * Діє й для паралельних викликів: перевірка й запис write-команди — в одній транзакції під блокуванням за operationId
 * (withOperationLock), тож дві команди з одним uuid не можуть записати обидві операції.
 */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  inventoryBalances,
  inventoryMovements,
  orderLineItems,
  orders,
  packagingMaterials,
  productionBatchLines,
  productionBatches,
  productionReceiptLines,
  productionReceipts,
  productVariants,
  products,
  stockItems,
  type MaterialUnit,
  type ProductionBatchStatus,
  type StockAlertKind,
} from "~/db/schema";
import { can, ForbiddenError, requirePermission, type Actor, type Permission } from "~/domain/permissions";
import { hasKey, makeT, type Locale } from "~/i18n";
import { formatDecimal, formatIsoDate, formatNumber } from "~/lib/format";
import { DomainError, NotFoundError } from "~/lib/errors";
import { writeAudit } from "~/modules/audit/audit.server";
import { STOCK_LEVEL_STATUSES, type StockLevelStatus } from "~/modules/inventory/alerts";
import { inventoryKeys } from "~/modules/inventory/keys";
import { ensureStockItemForVariant, type MovementType } from "~/modules/inventory/ledger.server";
import { effectiveLineQuantitySql } from "~/modules/inventory/reservations.server";
import { STARTABLE_STATUSES } from "~/modules/packing/constants";
import { startPacking } from "~/modules/packing/packing.server";
import { applyMaterialStock, materialStockPermission } from "~/modules/packaging/materials.server";
import { receiveProduction } from "~/modules/production/batches.server";
import { LIMITS as PRODUCTION_LIMITS, RECEIVABLE_STATUSES, allocateReceipt, isStatusIn, kyivDate, lineRemaining, statusAfterReceipt } from "~/modules/production/calc";
import { getBatchDetail, openProductionByVariant } from "~/modules/production/queries.server";
import { findActiveShipment } from "~/modules/shipments/waybill.server";
import { resolvePeriod, roundTo } from "~/modules/warehouse-analytics/calc";
import { computeWarehouseAnalytics, listAllStock } from "~/modules/warehouse-analytics/queries.server";
import type { OrderStatus } from "~/domain/order-status";
import type { ServiceContext } from "~/server/types";
import {
  DEFECT_REASONS,
  MAX_NOTE_LENGTH,
  MAX_OPERATION_QUANTITY,
  OPERATION_ID_RE,
  RECEIPT_REASONS,
  displayVariantTitle,
} from "./constants";
import { markDefective, OPERATION_PERMISSIONS, RETURN_DEFECT_KEY_SUFFIX, receiveStock, recordedReceiptState, type OperationResult } from "./operations.server";
import { listStock, loadAlertSummary, type StockRow } from "./stock.server";

// ---------------------------------------------------------------------------
// Типи
// ---------------------------------------------------------------------------

export const WAREHOUSE_COMMAND_NAMES = [
  "stock_summary",
  "low_stock",
  "item_stock",
  "production_status",
  "recommendations",
  "receive_stock",
  "mark_defective",
  "start_packing",
  "receive_production",
  "material_receive",
] as const;
export type WarehouseCommandName = (typeof WAREHOUSE_COMMAND_NAMES)[number];
export type WarehouseCommandRisk = "read" | "write";

export interface WarehouseCommand<S extends z.ZodType = z.ZodType> {
  name: WarehouseCommandName;
  /** Опис англійською (стабільніше для моделей; людям — i18n warehouseCommands.name.<name>). */
  description: string;
  input: S;
  permission: Permission;
  risk: WarehouseCommandRisk;
  /** write — завжди true (перевіряється defineCommand). */
  requiresConfirmation: boolean;
  /**
   * Ризик для ШІ-асистента (modules/assistant/tools.server.ts), якщо суворіший за risk: critical — підтвердження людиною
   * в БУДЬ-ЯКОМУ режимі автоматизації (навіть auto). Для незворотних операцій (надходження з виробництва не скасовується).
   */
  assistantRisk?: "critical";
  /** Номер замовлення з параметрів (асистент перевіряє паузу автоматизації цього замовлення). */
  orderNumberOf?(input: z.output<S>): string;
  /** Попередній перегляд наслідків для підтвердження (нічого не змінює). */
  preview?(ctx: ServiceContext, input: z.output<S>): Promise<unknown>;
  run(ctx: ServiceContext, input: z.output<S>): Promise<unknown>;
}

export type AnyWarehouseCommand = WarehouseCommand<z.ZodType>;

function defineCommand<S extends z.ZodType>(c: WarehouseCommand<S>): AnyWarehouseCommand {
  if (c.risk === "write" && (!c.requiresConfirmation || !c.preview)) {
    throw new Error(`warehouse command ${c.name}: write commands must require confirmation and provide a preview`);
  }
  return c as unknown as AnyWarehouseCommand;
}

/** Рядок позиції в результатах (без персональних даних). */
export interface ItemLine {
  sku: string | null;
  title: string;
  variant: string | null;
  onHand: number;
  reserved: number;
  available: number;
  defective: number;
  inProduction: number;
  threshold: number;
  status: StockLevelStatus;
}

export interface StockSummaryResult {
  kind: "stock_summary";
  variants: number;
  /** Позицій із відкритим обліком (резерви ведуться). */
  opened: number;
  onHand: number;
  reserved: number;
  available: number;
  defective: number;
  inProduction: number;
  /** Позицій за станом (лише відкриті). */
  status: Record<StockLevelStatus, number>;
  /** Відкриті попередження товарів (stock_alerts). */
  openAlerts: Record<StockAlertKind, number>;
  /** Відкриті попередження пакувальних матеріалів. */
  materialAlerts: number;
}

export interface LowStockResult {
  kind: "low_stock";
  total: number;
  truncated: boolean;
  items: ItemLine[];
}

export interface ItemStockResult {
  kind: "item_stock";
  /** Усього варіантів із цим SKU/штрихкодом (точна кількість, навіть коли показано лише перші MAX_MATCHES). */
  total: number;
  /** true — показано не всі збіги (total > matches): боту слід попросити уточнити SKU або штрихкод. */
  truncated: boolean;
  matches: Array<
    ItemLine & {
      barcode: string | null;
      model: string | null;
      color: string | null;
      tracking: StockRow["tracking"] | null;
      /** У ще не запущених партіях. */
      planned: number;
      nextReadyDate: string | null;
    }
  >;
}

export interface ProductionStatusResult {
  kind: "production_status";
  number: string;
  title: string;
  status: string;
  plannedReadyDate: string | null;
  overdue: boolean;
  ordered: number;
  received: number;
  defective: number;
  remaining: number;
  inProduction: number;
  receipts: number;
  lastReceiptAt: string | null;
  linesTotal: number;
  lines: Array<{ sku: string | null; title: string; variant: string | null; ordered: number; received: number; defective: number; remaining: number }>;
}

export interface RecommendationsResult {
  kind: "recommendations";
  settings: { productionLeadDays: number; targetCoverDays: number; batchRounding: number };
  total: number;
  truncated: boolean;
  items: Array<{
    sku: string | null;
    title: string;
    variant: string | null;
    quantity: number;
    velocity30: number;
    velocity: number;
    available: number;
    inProduction: number;
    planned: number;
    coverDays: number | null;
    stockOutDate: string | null;
  }>;
}

export interface StockChangeResult {
  kind: "receive_stock" | "mark_defective";
  /** received / marked — записано; replay — ця операція (operationId) вже була виконана, залишок не змінено вдруге. */
  result: "received" | "marked" | "replay";
  operationId: string;
  sku: string | null;
  title: string;
  variant: string | null;
  quantity: number;
  defectiveQuantity: number;
  balance: { onHand: number; reserved: number; available: number; defective: number };
  shopifyPushQueued: boolean;
}

export interface StockChangePreview {
  kind: "receive_stock" | "mark_defective";
  operationId: string;
  item: { sku: string | null; title: string; variant: string | null };
  quantity: number;
  defectiveQuantity: number;
  reason: string;
  current: { onHand: number; reserved: number; available: number; defective: number };
  after: { onHand: number; reserved: number; available: number; defective: number };
  /** Операція зробила б фактичний залишок від'ємним — буде відхилена (inventory.insufficient). */
  insufficient: boolean;
  /**
   * ЦЮ САМУ операцію (той самий operationId, позиція, вид і кількості) уже записано — підтвердження нічого не змінить
   * (повтор; after = current). Той самий operationId для ІНШОЇ операції — не прапорець, а помилка
   * warehouse.error.operationReused уже на етапі перегляду (бот просить почати нову операцію).
   */
  alreadyApplied: boolean;
}

export interface StartPackingCommandResult {
  kind: "start_packing";
  /** started — пакування розпочато; already_started — уже в роботі (продовжуйте); already_packed — уже запаковано. */
  result: "started" | "already_started" | "already_packed";
  orderNumber: string;
  /** Статус замовлення після команди. */
  status: OrderStatus;
}

export interface StartPackingPreview {
  kind: "start_packing";
  orderNumber: string;
  status: OrderStatus;
  /** Одиниць товару до пакування (currentQuantity). */
  units: number;
  /** Можна почати: статус «Накладну створено»/«Очікує комплектації» і є створена накладна, ще не передана перевізнику. */
  startable: boolean;
  /** Чому не можна: status — інший статус замовлення; no_waybill — немає створеної накладної. */
  blockedReason: "status" | "no_waybill" | null;
  alreadyPacked: boolean;
}

export interface ProductionReceiptPreviewLine {
  sku: string | null;
  title: string;
  variant: string | null;
  /** Лишалося у виробництві до надходження. */
  remaining: number;
  good: number;
  defective: number;
  /** Понад залишок (лише з allowOverReceipt — одразу у «Фактично»/«Брак»). */
  over: number;
}

export interface ProductionReceiptPreview {
  kind: "receive_production";
  operationId: string;
  batchNumber: string;
  title: string;
  status: ProductionBatchStatus;
  /** Стан партії після підтвердження (null — надходження неможливе або вже записане). */
  statusAfter: ProductionBatchStatus | null;
  lines: ProductionReceiptPreviewLine[];
  good: number;
  defective: number;
  overReceived: number;
  allowOverReceipt: boolean;
  /**
   * Чому підтвердження буде відхилено: status — партія не в стані для надходження; nothing_remaining — у партії не
   * лишилося одиниць у виробництві («remaining»); over_receipt — більше, ніж лишилося, без allowOverReceipt.
   */
  blockedReason: "status" | "nothing_remaining" | "over_receipt" | null;
  /** ЦЕ САМЕ надходження (той самий operationId, партія й позиції) уже записано — підтвердження нічого не змінить. */
  alreadyApplied: boolean;
}

export interface ProductionReceiptCommandResult {
  kind: "receive_production";
  /** received — записано; replay — це надходження (operationId) уже було записане, нічого не змінено вдруге. */
  result: "received" | "replay";
  operationId: string;
  batchNumber: string;
  /** Стан партії після надходження. */
  status: ProductionBatchStatus;
  lines: number;
  good: number;
  defective: number;
  overReceived: number;
}

export interface MaterialReceivePreview {
  kind: "material_receive";
  operationId: string;
  material: { code: string; name: string; unit: MaterialUnit };
  quantity: number;
  current: { onHand: number };
  after: { onHand: number };
  /** ЦЕ САМЕ надходження (operationId, матеріал, кількість) уже записано: «стане» = «зараз». */
  alreadyApplied: boolean;
}

export interface MaterialReceiveResult {
  kind: "material_receive";
  result: "received" | "replay";
  operationId: string;
  code: string;
  name: string;
  unit: MaterialUnit;
  quantity: number;
  onHand: number;
}

// ---------------------------------------------------------------------------
// Спільні схеми й допоміжні функції
// ---------------------------------------------------------------------------

const skuSchema = z.string().trim().min(1).max(64).describe('Exact SKU, e.g. "OT-PH-BLK" (case-insensitive).');
const barcodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[0-9A-Za-z-]+$/, "invalid barcode")
  .describe("Exact barcode (EAN/UPC) as printed on the label.");

type ItemRef = { sku?: string; barcode?: string };
const exactlyOneRef = (v: ItemRef) => (v.sku ? 1 : 0) + (v.barcode ? 1 : 0) === 1;
const REF_MESSAGE = "exactly one of sku or barcode is required";

const operationIdSchema = z
  .string()
  .trim()
  .regex(OPERATION_ID_RE, "operationId must be a UUID")
  .transform((v) => v.toLowerCase())
  .describe(
    "UUID generated by the caller ONCE per intended operation and reused on retries/confirmation " +
      "(idempotency key: a repeated call with the same operationId does not change stock twice).",
  );

const noteSchema = z
  .string()
  .trim()
  .max(MAX_NOTE_LENGTH)
  .optional()
  .describe("Short note without personal data (phones/emails are masked).");

/** Новий operationId для write-команди (бот генерує один раз на намір і повторює при повторі/підтвердженні). */
export function newCommandOperationId(): string {
  return randomUUID();
}

interface VariantMatch {
  variantId: string;
  productId: string;
  title: string;
  variant: string | null;
  sku: string | null;
  barcode: string | null;
}

const MAX_MATCHES = 5;

/** Варіанти за точним SKU (без урахування регістру) або штрихкодом (до MAX_MATCHES + 1 — щоб знати про неоднозначність). */
function variantRefWhere(ref: ItemRef) {
  return ref.sku ? sql`lower(${productVariants.sku}) = lower(${ref.sku})` : eq(productVariants.barcode, ref.barcode ?? "");
}

async function findVariants(ctx: ServiceContext, ref: ItemRef): Promise<VariantMatch[]> {
  const where = variantRefWhere(ref);
  const rows = await ctx.db
    .select({
      variantId: productVariants.id,
      productId: productVariants.productId,
      title: products.title,
      variantTitle: productVariants.title,
      sku: productVariants.sku,
      barcode: productVariants.barcode,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(where)
    .orderBy(products.title, productVariants.title, productVariants.id)
    .limit(MAX_MATCHES + 1);
  return rows.map((r) => ({ ...r, variant: displayVariantTitle(r.variantTitle) }));
}

/** Точна кількість варіантів за SKU/штрихкодом (коли збігів більше, ніж MAX_MATCHES). */
async function countVariants(ctx: ServiceContext, ref: ItemRef): Promise<number> {
  const [row] = await ctx.db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(productVariants)
    .where(variantRefWhere(ref));
  return Number(row?.n ?? 0);
}

/** Рівно один варіант (для змін): немає → itemNotFound; кілька → itemAmbiguous. */
async function findSingleVariant(ctx: ServiceContext, ref: ItemRef): Promise<VariantMatch> {
  const rows = await findVariants(ctx, ref);
  if (rows.length === 0) throw new DomainError("warehouseCommands.error.itemNotFound", 404);
  if (rows.length > 1) throw new DomainError("warehouseCommands.error.itemAmbiguous", 409, { count: rows.length > MAX_MATCHES ? `${MAX_MATCHES}+` : rows.length });
  return rows[0]!;
}

async function stockRowsFor(ctx: ServiceContext, variantIds: readonly string[]): Promise<Map<string, StockRow>> {
  if (variantIds.length === 0) return new Map();
  const { rows } = await listStock(ctx.db, { variantIds: [...variantIds], includeInactive: true }, { limit: Math.min(variantIds.length, 500) });
  return new Map(rows.map((r) => [r.variantId, r]));
}

function itemLine(r: StockRow): ItemLine {
  return {
    sku: r.sku,
    title: r.productTitle,
    variant: displayVariantTitle(r.variantTitle),
    onHand: r.onHand,
    reserved: r.reserved,
    available: r.available,
    defective: r.defective,
    inProduction: r.inProduction,
    threshold: r.threshold,
    status: r.status,
  };
}

const today = (ctx: ServiceContext) => kyivDate(ctx.now());

const operationReused = () => new DomainError("warehouse.error.operationReused", 409);

/**
 * Кому вже належить operationId: manual — рух manual:<id> (receive_stock / mark_defective, разом із
 * manual:<id>:return_defect); material — рух manual:<id>:<матеріал>; production — надходження з виробництва
 * (production_receipts.idempotency_key). Той самий uuid для іншого виду операції — помилка (не «повтор»).
 */
async function operationIdOwners(ctx: ServiceContext, operationId: string): Promise<Set<"manual" | "material" | "production">> {
  const manualKey = inventoryKeys.manual(operationId);
  const returnDefectKey = inventoryKeys.manual(operationId, RETURN_DEFECT_KEY_SUFFIX);
  const prefix = `${manualKey}:`;
  const [movements, receipts] = await Promise.all([
    ctx.db
      .select({ key: inventoryMovements.idempotencyKey })
      .from(inventoryMovements)
      .where(sql`(${inventoryMovements.idempotencyKey} = ${manualKey} or left(${inventoryMovements.idempotencyKey}, ${prefix.length}) = ${prefix})`)
      .limit(5),
    ctx.db.select({ id: productionReceipts.id }).from(productionReceipts).where(eq(productionReceipts.idempotencyKey, operationId)).limit(1),
  ]);
  const out = new Set<"manual" | "material" | "production">();
  for (const m of movements) out.add(m.key === manualKey || m.key === returnDefectKey ? "manual" : "material");
  if (receipts.length > 0) out.add("production");
  return out;
}

/** operationId уже використано іншим видом операції, ніж own → operationReused. */
async function assertOperationIdFor(ctx: ServiceContext, operationId: string, own: "manual" | "material" | "production"): Promise<void> {
  for (const owner of await operationIdOwners(ctx, operationId)) if (owner !== own) throw operationReused();
}

/** Клас рекомендаційного блокування operationId write-команд (pg_advisory_xact_lock(клас, hashtext(uuid))). */
const COMMAND_OPERATION_LOCK_CLASS = 0x57434f50;

/**
 * Виконання write-команди з operationId: перевірки uuid (assertOperationIdFor, recorded*State) і запис сервісу — в
 * ОДНІЙ транзакції під блокуванням за operationId. Паралельні виклики з тим самим uuid (повтор бота, дві різні команди
 * з одним uuid) виконуються по черзі, і другий бачить запис першого: «один operationId — одна операція» діє атомарно,
 * а не лише як попередня перевірка. Сервіси відкривають власну транзакцію — тут це точка збереження (savepoint) у
 * зовнішній; помилка сервісу відкочує все. Збіг hashtext різних uuid лише ставить їх у чергу (без хибних помилок).
 */
async function withOperationLock<T>(ctx: ServiceContext, operationId: string, fn: (ctx: ServiceContext) => Promise<T>): Promise<T> {
  return ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${COMMAND_OPERATION_LOCK_CLASS}::int, hashtext(${operationId}))`);
    return fn({ ...ctx, db: tx });
  });
}

// ---------------------------------------------------------------------------
// Команди читання
// ---------------------------------------------------------------------------

const stockSummary = defineCommand({
  name: "stock_summary",
  description:
    "Warehouse totals for active products: on hand, reserved, available, defective, in production, item counts by " +
    "stock level and open low-stock alerts. No customer data, no costs.",
  input: z.object({}).strict(),
  permission: "warehouse.view",
  risk: "read",
  requiresConfirmation: false,
  async run(ctx): Promise<StockSummaryResult> {
    requirePermission(ctx.actor, "warehouse.view");
    const [rows, alerts] = await Promise.all([listAllStock(ctx.db), loadAlertSummary(ctx.db, 0)]);
    const status = Object.fromEntries(STOCK_LEVEL_STATUSES.map((s) => [s, 0])) as Record<StockLevelStatus, number>;
    const out: StockSummaryResult = {
      kind: "stock_summary",
      variants: rows.length,
      opened: 0,
      onHand: 0,
      reserved: 0,
      available: 0,
      defective: 0,
      inProduction: 0,
      status,
      openAlerts: alerts.byKind,
      materialAlerts: alerts.materials,
    };
    for (const r of rows) {
      out.onHand += r.onHand;
      out.reserved += r.reserved;
      out.available += r.available;
      out.defective += r.defective;
      out.inProduction += r.inProduction;
      if (r.tracking === "opened") {
        out.opened += 1;
        status[r.status] += 1;
      }
    }
    return out;
  },
});

const lowStock = defineCommand({
  name: "low_stock",
  description:
    "Products whose available stock is at or below the low-stock threshold, out of stock, oversold or negative " +
    "(only items with opened inventory). Most critical first.",
  input: z.object({ limit: z.number().int().min(1).max(50).default(20) }).strict(),
  permission: "warehouse.view",
  risk: "read",
  requiresConfirmation: false,
  async run(ctx, input): Promise<LowStockResult> {
    requirePermission(ctx.actor, "warehouse.view");
    const { rows, total } = await listStock(
      ctx.db,
      { statuses: ["negative", "oversold", "out", "low"], tracking: ["opened"] },
      { sort: "status", limit: input.limit },
    );
    return { kind: "low_stock", total, truncated: total > rows.length, items: rows.map(itemLine) };
  },
});

const itemStock = defineCommand({
  name: "item_stock",
  description:
    "Stock of one product variant found by exact SKU or barcode: on hand, reserved, available, defective, in " +
    "production, planned in production batches and the next planned ready date. Exactly one of sku/barcode.",
  input: z
    .object({ sku: skuSchema.optional(), barcode: barcodeSchema.optional() })
    .strict()
    .refine(exactlyOneRef, { message: REF_MESSAGE, path: ["sku"] }),
  permission: "warehouse.view",
  risk: "read",
  requiresConfirmation: false,
  async run(ctx, input): Promise<ItemStockResult> {
    requirePermission(ctx.actor, "warehouse.view");
    // findVariants бере до MAX_MATCHES + 1: зайвий рядок означає «є ще» — тоді рахуємо точну кількість окремо.
    const found = await findVariants(ctx, input);
    const variants = found.slice(0, MAX_MATCHES);
    const truncated = found.length > MAX_MATCHES;
    const ids = variants.map((v) => v.variantId);
    const [stock, production, total] = await Promise.all([
      stockRowsFor(ctx, ids),
      openProductionByVariant(ctx.db, ids),
      truncated ? countVariants(ctx, input) : Promise.resolve(found.length),
    ]);
    const prod = new Map(production.map((p) => [p.variantId, p]));
    return {
      kind: "item_stock",
      total,
      truncated,
      matches: variants.flatMap((v) => {
        const r = stock.get(v.variantId);
        if (!r) return [];
        return [
          {
            ...itemLine(r),
            barcode: r.barcode,
            model: r.model,
            color: r.color,
            tracking: r.tracking,
            planned: prod.get(v.variantId)?.planned ?? 0,
            nextReadyDate: prod.get(v.variantId)?.nextReadyDate ?? null,
          },
        ];
      }),
    };
  },
});

const MAX_BATCH_LINES = 20;

const productionStatus = defineCommand({
  name: "production_status",
  description:
    'Status of one production batch by its number (e.g. "PB-2026-0001"): status, planned ready date, overdue flag, ' +
    "ordered / received / defective / remaining units and the first lines. No costs or manufacturer details.",
  input: z
    .object({
      batchNumber: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^PB-\d{4}-\d{4,9}$/, "invalid batch number")
        .describe('Production batch number, e.g. "PB-2026-0001".'),
    })
    .strict(),
  permission: "warehouse.view",
  risk: "read",
  requiresConfirmation: false,
  async run(ctx, input): Promise<ProductionStatusResult> {
    requirePermission(ctx.actor, "warehouse.view");
    const [batch] = await ctx.db
      .select({ id: productionBatches.id })
      .from(productionBatches)
      .where(eq(productionBatches.number, input.batchNumber));
    if (!batch) throw new NotFoundError("productionBatch");
    const d = await getBatchDetail(ctx.db, batch.id, { today: today(ctx), includeCosts: false });
    if (!d) throw new NotFoundError("productionBatch");
    const last = d.receipts[0];
    return {
      kind: "production_status",
      number: d.batch.number,
      title: d.batch.title,
      status: d.batch.status,
      plannedReadyDate: d.batch.plannedReadyDate,
      overdue: d.batch.overdue,
      ordered: d.totals.ordered,
      received: d.totals.received,
      defective: d.totals.defective,
      remaining: d.totals.remaining,
      inProduction: d.inProduction,
      receipts: d.receipts.length,
      lastReceiptAt: last ? last.receivedAt.toISOString() : null,
      linesTotal: d.lines.length,
      lines: d.lines.slice(0, MAX_BATCH_LINES).map((l) => ({
        sku: l.sku,
        title: l.productTitle,
        variant: l.variantTitle,
        ordered: l.ordered,
        received: l.received,
        defective: l.defective,
        remaining: l.remaining,
      })),
    };
  },
});

const recommendations = defineCommand({
  name: "recommendations",
  description:
    "Recommended production batches: units to produce per variant = weighted sales velocity × (production lead days " +
    "+ target cover days) − (available + in production + planned), rounded up to the batch rounding. Soonest " +
    "stock-out first. Optional model/color filters.",
  input: z
    .object({
      limit: z.number().int().min(1).max(50).default(10),
      model: z.string().trim().min(1).max(100).optional().describe("Exact model name filter."),
      color: z.string().trim().min(1).max(100).optional().describe("Exact color name filter."),
    })
    .strict(),
  permission: "warehouse.view",
  risk: "read",
  requiresConfirmation: false,
  async run(ctx, input): Promise<RecommendationsResult> {
    requirePermission(ctx.actor, "warehouse.view");
    const day = today(ctx);
    const data = await computeWarehouseAnalytics(ctx.db, {
      today: day,
      period: resolvePeriod({ today: day }),
      filters: { ...(input.model ? { models: [input.model] } : {}), ...(input.color ? { colors: [input.color] } : {}) },
      includeCosts: false,
    });
    const rows = data.recommendations.slice(0, input.limit);
    return {
      kind: "recommendations",
      settings: {
        productionLeadDays: data.settings.productionLeadDays,
        targetCoverDays: data.settings.targetCoverDays,
        batchRounding: data.settings.batchRounding,
      },
      total: data.recommendations.length,
      truncated: data.recommendations.length > rows.length,
      items: rows.map((v) => ({
        sku: v.sku,
        title: v.productTitle,
        variant: v.variantTitle,
        quantity: v.recommendation?.quantity ?? 0,
        velocity30: roundTo(v.velocity30, 2),
        velocity: roundTo(v.velocity, 2),
        available: v.available,
        inProduction: v.inProduction,
        planned: v.planned,
        coverDays: v.coverDays,
        stockOutDate: v.stockOutDate,
      })),
    };
  },
});

// ---------------------------------------------------------------------------
// Команди змін (завжди з підтвердженням)
// ---------------------------------------------------------------------------

/** Вид руху, який записує команда (як у operations.server.ts: receiveStock → receipt_manual, markDefective → defect_mark). */
const CHANGE_MOVEMENT_TYPE: Record<StockChangePreview["kind"], MovementType> = {
  receive_stock: "receipt_manual",
  mark_defective: "defect_mark",
};

async function previewChange(
  ctx: ServiceContext,
  kind: StockChangePreview["kind"],
  input: ItemRef & { operationId: string; quantity: number; defectiveQuantity?: number; reason: string },
  delta: { onHand: number; defective: number },
): Promise<StockChangePreview> {
  // uuid уже належить надходженню з виробництва чи матеріалів — підтвердження однаково відхилено б.
  await assertOperationIdFor(ctx, input.operationId, "manual");
  const v = await findSingleVariant(ctx, input);
  const row = (await stockRowsFor(ctx, [v.variantId])).get(v.variantId);
  const current = {
    onHand: row?.onHand ?? 0,
    reserved: row?.reserved ?? 0,
    available: row?.available ?? 0,
    defective: row?.defective ?? 0,
  };
  let alreadyApplied: boolean;
  if (kind === "receive_stock") {
    // Надходження повернення може бути записане двома рухами (надходження + рух браку пошкоджених, ключ
    // manual:<uuid>:return_defect) — те саме порівняння, що й у receiveStock (operations.server.ts recordedReceiptState).
    const state = row?.stockItemId
      ? await recordedReceiptState(ctx.db, {
          operationId: input.operationId,
          stockItemId: row.stockItemId,
          quantity: input.quantity,
          defectiveQuantity: input.defectiveQuantity ?? 0,
        })
      : (await ctx.db.select({ id: inventoryMovements.id }).from(inventoryMovements).where(eq(inventoryMovements.idempotencyKey, inventoryKeys.manual(input.operationId)))).length > 0
        ? "other"
        : "none";
    alreadyApplied = state === "same";
    if (state === "other") throw new DomainError("warehouse.error.operationReused", 409);
  } else {
    const key = inventoryKeys.manual(input.operationId);
    const [existing] = await ctx.db
      .select({
        stockItemId: inventoryMovements.stockItemId,
        type: inventoryMovements.type,
        onHandDelta: inventoryMovements.onHandDelta,
        defectiveDelta: inventoryMovements.defectiveDelta,
      })
      .from(inventoryMovements)
      .where(eq(inventoryMovements.idempotencyKey, key));
    // Те саме порівняння, що й у applyDeltaOperation (operations.server.ts): повтор — лише та сама позиція, вид і дельти.
    alreadyApplied = Boolean(
      existing &&
        row?.stockItemId &&
        existing.stockItemId === row.stockItemId &&
        existing.type === CHANGE_MOVEMENT_TYPE[kind] &&
        existing.onHandDelta === delta.onHand &&
        existing.defectiveDelta === delta.defective,
    );
    // Ідентифікатор уже використано для іншої дії: підтвердження однаково буде відхилено — кажемо це одразу, без «повтору».
    if (existing && !alreadyApplied) throw new DomainError("warehouse.error.operationReused", 409);
  }
  // Повтор нічого не змінить: «стане» = «зараз».
  const after = alreadyApplied
    ? { ...current }
    : {
        onHand: current.onHand + delta.onHand,
        reserved: current.reserved,
        available: current.available + delta.onHand,
        defective: current.defective + delta.defective,
      };
  return {
    kind,
    operationId: input.operationId,
    item: { sku: v.sku, title: v.title, variant: v.variant },
    quantity: input.quantity,
    defectiveQuantity: input.defectiveQuantity ?? 0,
    reason: input.reason,
    current,
    after,
    insufficient: after.onHand < 0,
    alreadyApplied,
  };
}

function changeResult(
  kind: StockChangeResult["kind"],
  v: VariantMatch,
  operationId: string,
  quantity: number,
  defectiveQuantity: number,
  r: OperationResult,
): StockChangeResult {
  return {
    kind,
    result: r.replay ? "replay" : kind === "receive_stock" ? "received" : "marked",
    operationId,
    sku: v.sku,
    title: v.title,
    variant: v.variant,
    quantity,
    defectiveQuantity,
    balance: { onHand: r.balance.onHand, reserved: r.balance.reserved, available: r.balance.available, defective: r.balance.defective },
    shopifyPushQueued: r.shopifyPushQueued,
  };
}

const receiveStockCommand = defineCommand({
  name: "receive_stock",
  description:
    "Receive stock without a production batch (purchase, customer return, found units): adds good units to on hand " +
    "and damaged units to defective. Customer returns are not pushed to Shopify (Shopify restocks them itself); " +
    "damaged units of such a return are then taken out of Shopify's available by a defect movement. " +
    "Exactly one of sku/barcode. Requires human confirmation; pass the same operationId on retries.",
  input: z
    .object({
      sku: skuSchema.optional(),
      barcode: barcodeSchema.optional(),
      quantity: z.number().int().min(0).max(MAX_OPERATION_QUANTITY).describe("Good units received (on hand +)."),
      defectiveQuantity: z.number().int().min(0).max(MAX_OPERATION_QUANTITY).default(0).describe("Damaged units received (defective +)."),
      reason: z.enum(RECEIPT_REASONS).describe("customer_return | purchase | found | other."),
      operationId: operationIdSchema,
      note: noteSchema,
    })
    .strict()
    .refine(exactlyOneRef, { message: REF_MESSAGE, path: ["sku"] })
    .refine((v) => v.quantity + v.defectiveQuantity >= 1 && v.quantity + v.defectiveQuantity <= MAX_OPERATION_QUANTITY, {
      message: `quantity + defectiveQuantity must be between 1 and ${MAX_OPERATION_QUANTITY}`,
      path: ["quantity"],
    }),
  permission: OPERATION_PERMISSIONS.receiveStock,
  risk: "write",
  requiresConfirmation: true,
  async preview(ctx, input) {
    requirePermission(ctx.actor, OPERATION_PERMISSIONS.receiveStock);
    return previewChange(ctx, "receive_stock", input, { onHand: input.quantity, defective: input.defectiveQuantity });
  },
  async run(ctx, input): Promise<StockChangeResult> {
    requirePermission(ctx.actor, OPERATION_PERMISSIONS.receiveStock);
    return withOperationLock(ctx, input.operationId, async (ctx) => {
      await assertOperationIdFor(ctx, input.operationId, "manual");
      const v = await findSingleVariant(ctx, input);
      const stockItemId = await ensureStockItemForVariant(ctx.db, v.variantId);
      const r = await receiveStock(ctx, {
        operationId: input.operationId,
        stockItemId,
        quantity: input.quantity,
        defectiveQuantity: input.defectiveQuantity,
        reason: input.reason,
        note: input.note ?? null,
      });
      return changeResult("receive_stock", v, input.operationId, input.quantity, input.defectiveQuantity, r);
    });
  },
});

const markDefectiveCommand = defineCommand({
  name: "mark_defective",
  description:
    "Mark units as defective/damaged: moves them from on hand to defective (not for sale). Exactly one of sku/barcode. " +
    "Requires human confirmation; pass the same operationId on retries.",
  input: z
    .object({
      sku: skuSchema.optional(),
      barcode: barcodeSchema.optional(),
      quantity: z.number().int().min(1).max(MAX_OPERATION_QUANTITY).describe("Units to mark as defective."),
      reason: z.enum(DEFECT_REASONS).describe("damaged_in_warehouse | customer_return | production | other."),
      operationId: operationIdSchema,
      note: noteSchema,
    })
    .strict()
    .refine(exactlyOneRef, { message: REF_MESSAGE, path: ["sku"] }),
  permission: OPERATION_PERMISSIONS.markDefective,
  risk: "write",
  requiresConfirmation: true,
  async preview(ctx, input) {
    requirePermission(ctx.actor, OPERATION_PERMISSIONS.markDefective);
    return previewChange(ctx, "mark_defective", input, { onHand: -input.quantity, defective: input.quantity });
  },
  async run(ctx, input): Promise<StockChangeResult> {
    requirePermission(ctx.actor, OPERATION_PERMISSIONS.markDefective);
    return withOperationLock(ctx, input.operationId, async (ctx) => {
      await assertOperationIdFor(ctx, input.operationId, "manual");
      const v = await findSingleVariant(ctx, input);
      const stockItemId = await ensureStockItemForVariant(ctx.db, v.variantId);
      const r = await markDefective(ctx, {
        operationId: input.operationId,
        stockItemId,
        quantity: input.quantity,
        reason: input.reason,
        note: input.note ?? null,
      });
      return changeResult("mark_defective", v, input.operationId, input.quantity, 0, r);
    });
  },
});

/** "1850", "#1850" → "#1850" (як в інструментах асистента). */
const orderNumberSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^#?[A-Za-z0-9-]+$/, "invalid order number")
  .transform((v) => (/^\d+$/.test(v) ? `#${v}` : v))
  .describe('Order number as the shop shows it, e.g. "#1850" (a bare "1850" is accepted).');

async function findOrderForPacking(ctx: ServiceContext, orderNumber: string) {
  const [row] = await ctx.db
    .select({ id: orders.id, orderNumber: orders.orderNumber, status: orders.status })
    .from(orders)
    .where(eq(orders.orderNumber, orderNumber))
    .limit(1);
  if (!row) throw new NotFoundError("order");
  return row;
}

const startPackingCommand = defineCommand({
  name: "start_packing",
  description:
    "Start packing an order that has a created waybill (status waybill_created or awaiting_picking): creates the " +
    "packing checklist and moves the order to awaiting_picking. Repeating it continues the same packing. Requires " +
    "human confirmation. Packing does not mean handed to the carrier.",
  input: z.object({ orderNumber: orderNumberSchema }).strict(),
  permission: "packing.perform",
  risk: "write",
  requiresConfirmation: true,
  orderNumberOf: (i) => i.orderNumber,
  async preview(ctx, input): Promise<StartPackingPreview> {
    requirePermission(ctx.actor, "packing.perform");
    const order = await findOrderForPacking(ctx, input.orderNumber);
    const [units] = await ctx.db
      .select({ n: sql<number>`coalesce(sum(${effectiveLineQuantitySql}), 0)`.mapWith(Number) })
      .from(orderLineItems)
      .where(eq(orderLineItems.orderId, order.id));
    const shipment = await findActiveShipment(ctx.db, order.id);
    const packable = Boolean(shipment && shipment.status === "created" && shipment.waybillNumber && !shipment.handedOverAt);
    const statusOk = (STARTABLE_STATUSES as readonly OrderStatus[]).includes(order.status);
    return {
      kind: "start_packing",
      orderNumber: order.orderNumber,
      status: order.status,
      units: Number(units?.n ?? 0),
      startable: statusOk && packable,
      blockedReason: order.status === "packed" ? null : !statusOk ? "status" : !packable ? "no_waybill" : null,
      alreadyPacked: order.status === "packed",
    };
  },
  async run(ctx, input): Promise<StartPackingCommandResult> {
    requirePermission(ctx.actor, "packing.perform");
    const order = await findOrderForPacking(ctx, input.orderNumber);
    const r = await startPacking(ctx, order.id);
    const [after] = await ctx.db.select({ status: orders.status }).from(orders).where(eq(orders.id, order.id));
    // Ім'я працівника, який уже пакує (startedByName), у результат не передаємо — лише факт.
    return { kind: "start_packing", result: r.kind, orderNumber: order.orderNumber, status: after?.status ?? order.status };
  },
});


// ---------------------------------------------------------------------------
// Надходження з виробництва й матеріалів
// ---------------------------------------------------------------------------

const batchNumberSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^PB-\d{4}-\d{4,9}$/, "invalid batch number")
  .describe('Production batch number, e.g. "PB-2026-0001".');

/** Позицій в одному надходженні через команду (бот/асистент; більше — сторінкою партії). */
const MAX_RECEIPT_LINES = 50;

const receiptLineSchema = z
  .object({
    sku: skuSchema.optional(),
    barcode: barcodeSchema.optional(),
    good: z.number().int().min(0).max(PRODUCTION_LIMITS.quantity).default(0).describe("Good units received from production."),
    defective: z.number().int().min(0).max(PRODUCTION_LIMITS.quantity).default(0).describe("Defective units received from production."),
    defectReason: z.string().trim().min(1).max(PRODUCTION_LIMITS.defectReason).optional().describe("Short defect reason without personal data."),
  })
  .strict()
  .refine(exactlyOneRef, { message: REF_MESSAGE, path: ["sku"] })
  .refine((l) => l.good + l.defective >= 1, { message: "good + defective must be at least 1", path: ["good"] });

type ReceiptLineRequest = z.output<typeof receiptLineSchema>;

interface BatchForReceipt {
  id: string;
  number: string;
  title: string;
  status: ProductionBatchStatus;
}

interface BatchLineForReceipt {
  id: string;
  sku: string | null;
  barcode: string | null;
  title: string;
  variant: string | null;
  ordered: number;
  received: number;
  defective: number;
}

async function findBatchForReceipt(ctx: ServiceContext, batchNumber: string): Promise<BatchForReceipt> {
  const [batch] = await ctx.db
    .select({ id: productionBatches.id, number: productionBatches.number, title: productionBatches.title, status: productionBatches.status })
    .from(productionBatches)
    .where(eq(productionBatches.number, batchNumber));
  if (!batch) throw new NotFoundError("productionBatch");
  return batch;
}

async function batchLinesForReceipt(ctx: ServiceContext, batchId: string): Promise<BatchLineForReceipt[]> {
  const rows = await ctx.db
    .select({
      id: productionBatchLines.id,
      sku: productVariants.sku,
      barcode: productVariants.barcode,
      title: products.title,
      variantTitle: productVariants.title,
      ordered: productionBatchLines.quantityOrdered,
      received: productionBatchLines.quantityReceived,
      defective: productionBatchLines.quantityDefective,
    })
    .from(productionBatchLines)
    .innerJoin(productVariants, eq(productVariants.id, productionBatchLines.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(eq(productionBatchLines.batchId, batchId))
    .orderBy(products.title, productVariants.title, productionBatchLines.id);
  return rows.map((r) => ({ ...r, variant: displayVariantTitle(r.variantTitle) }));
}

const refLabel = (ref: ItemRef) => ref.sku ?? ref.barcode ?? "—";

/** Позиції запиту → позиції партії за точним SKU (без урахування регістру) або штрихкодом; кожна — щонайбільше раз. */
function matchReceiptLines(
  lines: readonly BatchLineForReceipt[],
  requested: readonly ReceiptLineRequest[],
): Array<{ line: BatchLineForReceipt; good: number; defective: number; defectReason: string | null }> {
  const used = new Set<string>();
  return requested.map((r) => {
    const found = lines.filter((l) => (r.sku ? (l.sku ?? "").toLowerCase() === r.sku.toLowerCase() : l.barcode === r.barcode));
    if (found.length === 0) throw new DomainError("warehouseCommands.error.batchLineNotFound", 404, { item: refLabel(r) });
    if (found.length > 1) throw new DomainError("warehouseCommands.error.batchLineAmbiguous", 409, { item: refLabel(r) });
    const line = found[0]!;
    if (used.has(line.id)) throw new DomainError("warehouseCommands.error.batchLineDuplicate", 400, { item: refLabel(r) });
    used.add(line.id);
    return { line, good: r.good, defective: r.defective, defectReason: r.defectReason ?? null };
  });
}

const lineQty = (l: BatchLineForReceipt) => ({ ordered: l.ordered, received: l.received, defective: l.defective });

/**
 * Записане надходження з цим operationId: none — немає; same — для ЦІЄЇ партії й (для явних позицій) з тими самими
 * позиціями й кількостями; other — інша партія або інші позиції/кількості (→ operationReused).
 * «remaining» — намір «решта партії»: будь-яке записане надходження цієї партії з цим uuid — те саме.
 */
async function recordedProductionReceipt(
  ctx: ServiceContext,
  operationId: string,
  batchId: string,
  planned: Array<{ line: { id: string }; good: number; defective: number }> | "remaining",
): Promise<"none" | "same" | "other"> {
  const [receipt] = await ctx.db
    .select({ id: productionReceipts.id, batchId: productionReceipts.batchId })
    .from(productionReceipts)
    .where(eq(productionReceipts.idempotencyKey, operationId));
  if (!receipt) return "none";
  if (receipt.batchId !== batchId) return "other";
  if (planned === "remaining") return "same";
  const recorded = await ctx.db
    .select({ batchLineId: productionReceiptLines.batchLineId, good: productionReceiptLines.goodQty, defective: productionReceiptLines.defectiveQty })
    .from(productionReceiptLines)
    .where(eq(productionReceiptLines.receiptId, receipt.id));
  const norm = (rows: Array<{ id: string; good: number; defective: number }>) =>
    rows
      .map((r) => `${r.id}:${r.good}:${r.defective}`)
      .sort()
      .join("|");
  const same =
    norm(recorded.map((r) => ({ id: r.batchLineId, good: r.good, defective: r.defective }))) ===
    norm(planned.map((p) => ({ id: p.line.id, good: p.good, defective: p.defective })));
  return same ? "same" : "other";
}

const receiveProductionCommand = defineCommand({
  name: "receive_production",
  description:
    'Receive units from a production batch by its number (e.g. "PB-2026-0001"): good units go to on hand, defective ' +
    'units to defective, both leave "in production". lines: "remaining" (the whole unfinished remainder as good units) ' +
    "or explicit lines by exact SKU or barcode of the batch items with good/defective quantities. More than the " +
    "remainder only with allowOverReceipt. The batch becomes partially received or received. A receipt cannot be " +
    "undone. Requires human confirmation; pass the same operationId on retries (it is the receipt's idempotency key). " +
    "No costs in the result.",
  input: z
    .object({
      batchNumber: batchNumberSchema,
      lines: z
        .union([z.literal("remaining"), z.array(receiptLineSchema).min(1).max(MAX_RECEIPT_LINES)])
        .describe('"remaining" or a list of batch items with good/defective quantities.'),
      allowOverReceipt: z.boolean().default(false).describe("Allow receiving more than the unfinished remainder (explicit owner decision)."),
      operationId: operationIdSchema,
      note: noteSchema,
    })
    .strict(),
  permission: "warehouse.receive",
  risk: "write",
  // Надходження не скасовується (партію з надходженнями лише закривають) — асистент завжди питає людину.
  assistantRisk: "critical",
  requiresConfirmation: true,
  async preview(ctx, input): Promise<ProductionReceiptPreview> {
    requirePermission(ctx.actor, "warehouse.receive");
    await assertOperationIdFor(ctx, input.operationId, "production");
    const batch = await findBatchForReceipt(ctx, input.batchNumber);
    const lines = await batchLinesForReceipt(ctx, batch.id);
    const planned =
      input.lines === "remaining"
        ? lines.filter((l) => lineRemaining(lineQty(l)) > 0).map((l) => ({ line: l, good: lineRemaining(lineQty(l)), defective: 0, defectReason: null }))
        : matchReceiptLines(lines, input.lines);
    const recorded = await recordedProductionReceipt(ctx, input.operationId, batch.id, input.lines === "remaining" ? "remaining" : planned);
    if (recorded === "other") throw operationReused();
    const alreadyApplied = recorded === "same";
    const previewLines: ProductionReceiptPreviewLine[] = planned.map((p) => {
      const remaining = lineRemaining(lineQty(p.line));
      return {
        sku: p.line.sku,
        title: p.line.title,
        variant: p.line.variant,
        remaining,
        good: p.good,
        defective: p.defective,
        over: allocateReceipt(remaining, p.good, p.defective).over,
      };
    });
    const overReceived = previewLines.reduce((s, l) => s + l.over, 0);
    const receivable = isStatusIn(batch.status, RECEIVABLE_STATUSES);
    const blockedReason: ProductionReceiptPreview["blockedReason"] = alreadyApplied
      ? null
      : !receivable
        ? "status"
        : planned.length === 0
          ? "nothing_remaining"
          : overReceived > 0 && !input.allowOverReceipt
            ? "over_receipt"
            : null;
    const after = new Map(lines.map((l) => [l.id, lineQty(l)]));
    for (const p of planned) {
      const a = after.get(p.line.id)!;
      after.set(p.line.id, { ...a, received: a.received + p.good, defective: a.defective + p.defective });
    }
    return {
      kind: "receive_production",
      operationId: input.operationId,
      batchNumber: batch.number,
      title: batch.title,
      status: batch.status,
      statusAfter: alreadyApplied || blockedReason ? null : statusAfterReceipt([...after.values()]),
      lines: previewLines,
      good: planned.reduce((s, p) => s + p.good, 0),
      defective: planned.reduce((s, p) => s + p.defective, 0),
      overReceived,
      allowOverReceipt: input.allowOverReceipt,
      blockedReason,
      alreadyApplied,
    };
  },
  async run(ctx, input): Promise<ProductionReceiptCommandResult> {
    requirePermission(ctx.actor, "warehouse.receive");
    return withOperationLock(ctx, input.operationId, async (ctx) => {
      await assertOperationIdFor(ctx, input.operationId, "production");
      const batch = await findBatchForReceipt(ctx, input.batchNumber);
      const planned = input.lines === "remaining" ? ("remaining" as const) : matchReceiptLines(await batchLinesForReceipt(ctx, batch.id), input.lines);
      // Той самий uuid для іншої партії або інших позицій — не повтор (receiveProduction повернув би чуже надходження).
      if ((await recordedProductionReceipt(ctx, input.operationId, batch.id, planned)) === "other") throw operationReused();
      const r = await receiveProduction(ctx, batch.id, {
        idempotencyKey: input.operationId,
        lines:
          planned === "remaining"
            ? "remaining"
            : planned.map((p) => ({ batchLineId: p.line.id, good: p.good, defective: p.defective, defectReason: p.defectReason })),
        note: input.note ?? null,
        allowOverReceipt: input.allowOverReceipt,
      });
      // Надходження з цим ключем записав інший викликач між перевіркою й сервісом (не команда — без блокування за
      // operationId): «повтор» лише якщо це ті самі позиції й кількості, інакше — чужий намір, а не наш результат.
      if (r.duplicate && (await recordedProductionReceipt(ctx, input.operationId, batch.id, planned)) === "other") throw operationReused();
      return {
        kind: "receive_production",
        result: r.duplicate ? "replay" : "received",
        operationId: input.operationId,
        batchNumber: batch.number,
        status: r.status,
        lines: r.lines,
        good: r.good,
        defective: r.defective,
        overReceived: r.overReceived,
      };
    });
  },
});

const materialCodeSchema = z.string().trim().min(1).max(64).describe('Exact packaging material code, e.g. "box_s" (case-insensitive).');

async function findMaterial(ctx: ServiceContext, code: string): Promise<{ id: string; code: string; name: string; unit: MaterialUnit }> {
  const rows = await ctx.db
    .select({ id: packagingMaterials.id, code: packagingMaterials.code, name: packagingMaterials.name, unit: packagingMaterials.unit })
    .from(packagingMaterials)
    .where(sql`lower(${packagingMaterials.code}) = lower(${code})`)
    .orderBy(packagingMaterials.code)
    .limit(MAX_MATCHES + 1);
  if (rows.length === 0) throw new DomainError("warehouseCommands.error.materialNotFound", 404);
  if (rows.length > 1) throw new DomainError("warehouseCommands.error.materialAmbiguous", 409, { count: rows.length > MAX_MATCHES ? `${MAX_MATCHES}+` : rows.length });
  return rows[0]!;
}

async function materialOnHand(ctx: ServiceContext, materialId: string): Promise<number> {
  const [row] = await ctx.db
    .select({ onHand: inventoryBalances.onHand })
    .from(stockItems)
    .innerJoin(inventoryBalances, eq(inventoryBalances.stockItemId, stockItems.id))
    .where(eq(stockItems.materialId, materialId));
  return row?.onHand ?? 0;
}

const materialReceiveCommand = defineCommand({
  name: "material_receive",
  description:
    "Receive packaging materials (boxes, stickers, instructions, cards, bolts…) by exact material code: adds the " +
    "quantity to the material's stock. No unit costs through commands (the owner records costs on the materials page). " +
    "Requires human confirmation; pass the same operationId on retries.",
  input: z
    .object({
      code: materialCodeSchema,
      quantity: z.number().int().min(1).max(MAX_OPERATION_QUANTITY).describe("Units received (in the material's unit)."),
      operationId: operationIdSchema,
      note: noteSchema,
    })
    .strict(),
  permission: materialStockPermission("receive"),
  risk: "write",
  requiresConfirmation: true,
  async preview(ctx, input): Promise<MaterialReceivePreview> {
    requirePermission(ctx.actor, materialStockPermission("receive"));
    await assertOperationIdFor(ctx, input.operationId, "material");
    const m = await findMaterial(ctx, input.code);
    const alreadyApplied = await materialReceiptState(ctx, input.operationId, m.id, input.quantity);
    const onHand = await materialOnHand(ctx, m.id);
    return {
      kind: "material_receive",
      operationId: input.operationId,
      material: { code: m.code, name: m.name, unit: m.unit },
      quantity: input.quantity,
      current: { onHand },
      after: { onHand: alreadyApplied ? onHand : onHand + input.quantity },
      alreadyApplied,
    };
  },
  async run(ctx, input): Promise<MaterialReceiveResult> {
    requirePermission(ctx.actor, materialStockPermission("receive"));
    return withOperationLock(ctx, input.operationId, async (ctx) => {
      await assertOperationIdFor(ctx, input.operationId, "material");
      const m = await findMaterial(ctx, input.code);
      await materialReceiptState(ctx, input.operationId, m.id, input.quantity);
      const r = await applyMaterialStock(ctx, {
        operationId: input.operationId,
        operation: "receive",
        lines: [{ materialId: m.id, quantity: input.quantity }],
        note: input.note ?? null,
      });
      const line = r.lines[0]!;
      // Рух із цим ключем записав інший викликач після перевірки: «повтор» лише для тієї самої кількості (інакше throw).
      if (line.status !== "applied") await materialReceiptState(ctx, input.operationId, m.id, input.quantity);
      return {
        kind: "material_receive",
        result: line.status === "applied" ? "received" : "replay",
        operationId: input.operationId,
        code: m.code,
        name: m.name,
        unit: m.unit,
        quantity: input.quantity,
        onHand: line.after,
      };
    });
  },
});

/**
 * Чи записано ЦЕ САМЕ надходження матеріалу (manual:<uuid>:<матеріал>, receipt_manual, +quantity). Інший матеріал або
 * кількість з тим самим uuid — operationReused (applyMaterialStock інакше записав би рух для другого матеріалу).
 */
async function materialReceiptState(ctx: ServiceContext, operationId: string, materialId: string, quantity: number): Promise<boolean> {
  const prefix = `${inventoryKeys.manual(operationId)}:`;
  const rows = await ctx.db
    .select({ key: inventoryMovements.idempotencyKey, type: inventoryMovements.type, onHandDelta: inventoryMovements.onHandDelta })
    .from(inventoryMovements)
    .where(sql`left(${inventoryMovements.idempotencyKey}, ${prefix.length}) = ${prefix}`)
    .limit(5);
  if (rows.length === 0) return false;
  const own = inventoryKeys.manual(operationId, materialId);
  if (rows.length === 1 && rows[0]!.key === own && rows[0]!.type === "receipt_manual" && rows[0]!.onHandDelta === quantity) return true;
  throw operationReused();
}

// ---------------------------------------------------------------------------
// Реєстр і виконавець
// ---------------------------------------------------------------------------

export const WAREHOUSE_COMMANDS: ReadonlyMap<WarehouseCommandName, AnyWarehouseCommand> = new Map(
  [
    stockSummary,
    lowStock,
    itemStock,
    productionStatus,
    recommendations,
    receiveStockCommand,
    markDefectiveCommand,
    startPackingCommand,
    receiveProductionCommand,
    materialReceiveCommand,
  ].map((c) => [c.name, c]),
);

export function isWarehouseCommandName(value: unknown): value is WarehouseCommandName {
  return typeof value === "string" && (WAREHOUSE_COMMAND_NAMES as readonly string[]).includes(value);
}

/** Команди, доступні актору (для меню бота / довідки). */
/**
 * Команди, доступні актору. `label` — локалізована назва для меню бота (warehouseCommands.name.<команда>, uk/en);
 * `description` — англійський опис для моделі/розробника (не для людей).
 */
export function warehouseCommandsFor(
  actor: Actor,
  locale: Locale = "uk",
): Array<{
  name: WarehouseCommandName;
  label: string;
  description: string;
  permission: Permission;
  risk: WarehouseCommandRisk;
  requiresConfirmation: boolean;
}> {
  const t = makeT(locale);
  return [...WAREHOUSE_COMMANDS.values()]
    .filter((c) => can(actor, c.permission))
    .map((c) => ({
      name: c.name,
      label: t(`warehouseCommands.name.${c.name}`),
      description: c.description,
      permission: c.permission,
      risk: c.risk,
      requiresConfirmation: c.requiresConfirmation,
    }));
}

export type WarehouseCommandRefusal = "unknown_command" | "forbidden" | "invalid_input";

export type WarehouseCommandOutcome =
  | { status: "ok"; command: WarehouseCommandName; risk: WarehouseCommandRisk; data: unknown }
  | { status: "confirmation_required"; command: WarehouseCommandName; risk: WarehouseCommandRisk; input: unknown; preview: unknown }
  | {
      status: "refused";
      command: string;
      reason: WarehouseCommandRefusal;
      permission?: Permission;
      issues?: Array<{ path: string; message: string }>;
    }
  | { status: "error"; command: WarehouseCommandName; risk: WarehouseCommandRisk; code: string; params: Record<string, string | number> };

export interface RunWarehouseCommandOptions {
  /** true — людина натиснула «Підтвердити» САМЕ для цієї команди з цими параметрами (обов'язково для write). */
  confirmed?: boolean;
  /** Канал для журналу (без персональних даних). */
  via?: "telegram" | "command";
}

const zodIssues = (e: z.ZodError) =>
  e.issues.slice(0, 20).map((i) => ({ path: i.path.join(".") || "_", message: i.message.slice(0, 200) }));

/**
 * Виконує команду від імені ctx.actor (працівник, якому зіставлено користувача бота). Порядок: команда існує →
 * дозвіл → схема → для write: без confirmed — попередній перегляд (нічого не змінено) → виконання.
 * Зміни журналюються (warehouse.command_executed/refused; без персональних даних). Помилки предметної області —
 * status "error" з кодом i18n; непередбачені — прокидаються.
 */
export async function runWarehouseCommand(
  ctx: ServiceContext,
  name: string,
  rawInput: unknown,
  opts: RunWarehouseCommandOptions = {},
): Promise<WarehouseCommandOutcome> {
  const command = isWarehouseCommandName(name) ? WAREHOUSE_COMMANDS.get(name) : undefined;
  if (!command) return { status: "refused", command: String(name).slice(0, 64), reason: "unknown_command" };
  const isWrite = command.risk === "write";
  const audit = async (action: string, details: Record<string, unknown>) => {
    if (!isWrite) return;
    await writeAudit(ctx.db, ctx.actor, action, { type: "warehouse" }, { via: opts.via ?? "command", command: command.name, ...details });
  };
  if (!can(ctx.actor, command.permission)) {
    await audit("warehouse.command_refused", { reason: "forbidden", permission: command.permission });
    return { status: "refused", command: command.name, reason: "forbidden", permission: command.permission };
  }
  const parsed = command.input.safeParse(rawInput);
  if (!parsed.success) return { status: "refused", command: command.name, reason: "invalid_input", issues: zodIssues(parsed.error) };
  const input = parsed.data;
  try {
    if (isWrite && opts.confirmed !== true) {
      const preview = await command.preview!(ctx, input);
      return { status: "confirmation_required", command: command.name, risk: command.risk, input, preview };
    }
    const data = await command.run(ctx, input);
    const outcome = data && typeof data === "object" && "result" in data ? String((data as { result: unknown }).result) : "ok";
    await audit("warehouse.command_executed", { outcome });
    return { status: "ok", command: command.name, risk: command.risk, data };
  } catch (e) {
    if (e instanceof ForbiddenError) {
      await audit("warehouse.command_refused", { reason: "forbidden", permission: e.permission });
      return { status: "refused", command: command.name, reason: "forbidden", permission: e.permission };
    }
    if (e instanceof DomainError) {
      await audit("warehouse.command_failed", { code: e.code });
      return { status: "error", command: command.name, risk: command.risk, code: e.code, params: e.params };
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Текст для бота
// ---------------------------------------------------------------------------

function itemLabel(i: { title: string; variant: string | null; sku: string | null }): string {
  return [i.title, i.variant, i.sku ? `(${i.sku})` : null].filter(Boolean).join(" ");
}

const ERROR_ALIASES: Record<string, string> = {
  "warehouse.error.operationReused": "warehouseCommands.error.operationReused",
};

/**
 * error.notFound (NotFoundError) за сутністю → текст для бота: користувач бачить, що невірний номер партії чи замовлення,
 * а не «Сторінку не знайдено» (текст сторінок). Код результату лишається error.notFound з params.entity.
 */
const NOT_FOUND_TEXTS: ReadonlyMap<string, string> = new Map([
  ["productionBatch", "warehouseCommands.error.batchNotFound"],
  ["order", "warehouseCommands.error.orderNotFound"],
]);

function errorTextKey(code: string, params: Record<string, string | number>): string {
  if (code === "error.notFound") {
    const specific = NOT_FOUND_TEXTS.get(String(params.entity ?? ""));
    if (specific) return specific;
  }
  return ERROR_ALIASES[code] ?? code;
}

/**
 * Короткий текст результату для бота (uk/en). Лише кількості, SKU, назви товарів і номери партій.
 * Майбутній бот надсилає його як є (або будує власне форматування з data).
 */
export function formatWarehouseCommandOutcome(outcome: WarehouseCommandOutcome, locale: Locale = "uk"): string {
  const t = makeT(locale);
  // Числа й дати — тим самим форматером, що й сторінки (uk «1 234», «0,78», «11.12.2026»; en «1,234», «0.78», «11/12/2026»).
  const n = (v: number) => formatNumber(v, locale);
  const dec = (v: number) => formatDecimal(v, locale, { maximumFractionDigits: 2 });
  const date = (iso: string | null | undefined) => (iso ? formatIsoDate(iso, locale) : "—");
  if (outcome.status === "refused") {
    if (outcome.reason === "forbidden") return t("warehouseCommands.refused.forbidden");
    if (outcome.reason === "invalid_input") return t("warehouseCommands.refused.invalidInput");
    return t("warehouseCommands.refused.unknownCommand");
  }
  if (outcome.status === "error") {
    const code = errorTextKey(outcome.code, outcome.params);
    return t("warehouseCommands.error", { message: hasKey(code) ? t(code, outcome.params) : t("error.generic") });
  }
  if (outcome.status === "confirmation_required") {
    const previewKind = (outcome.preview as { kind?: string } | null)?.kind;
    if (previewKind === "receive_production") {
      const p = outcome.preview as ProductionReceiptPreview;
      const lines = [
        t("warehouseCommands.confirm.receiveProduction", { number: p.batchNumber, good: n(p.good), defective: n(p.defective) }),
        ...p.lines.map((l) =>
          t("warehouseCommands.confirm.receiveProduction.line", {
            item: itemLabel(l),
            good: n(l.good),
            defective: n(l.defective),
            remaining: n(l.remaining),
          }),
        ),
      ];
      if (p.statusAfter) {
        lines.push(t("warehouseCommands.confirm.batchStatus", { before: t(`productionStatus.${p.status}`), after: t(`productionStatus.${p.statusAfter}`) }));
      }
      if (p.overReceived > 0 && p.allowOverReceipt) lines.push(t("warehouseCommands.confirm.overReceived", { count: p.overReceived }));
      if (p.blockedReason) {
        lines.push(t(`warehouseCommands.production.blocked.${p.blockedReason}`, { status: t(`productionStatus.${p.status}`) }));
      }
      if (p.alreadyApplied) lines.push(t("warehouseCommands.replay"));
      return lines.join("\n");
    }
    if (previewKind === "material_receive") {
      const p = outcome.preview as MaterialReceivePreview;
      const lines = [
        t("warehouseCommands.confirm.materialReceive", {
          item: `${p.material.name} (${p.material.code})`,
          quantity: n(p.quantity),
          unit: t(`materialUnit.${p.material.unit}`),
        }),
        t("warehouseCommands.confirm.materialChange", { before: n(p.current.onHand), after: n(p.after.onHand) }),
      ];
      if (p.alreadyApplied) lines.push(t("warehouseCommands.replay"));
      return lines.join("\n");
    }
    if (previewKind === "start_packing") {
      const p = outcome.preview as StartPackingPreview;
      const lines = [t("warehouseCommands.confirm.startPacking", { order: p.orderNumber, units: n(p.units), status: t(`status.${p.status}`) })];
      if (p.alreadyPacked) lines.push(t("warehouseCommands.packing.already_packed", { order: p.orderNumber }));
      else if (p.blockedReason) lines.push(t(`warehouseCommands.packing.blocked.${p.blockedReason}`));
      return lines.join("\n");
    }
    const p = outcome.preview as StockChangePreview;
    const lines = [
      t(p.kind === "receive_stock" ? "warehouseCommands.confirm.receive" : "warehouseCommands.confirm.defect", {
        item: itemLabel({ ...p.item }),
        quantity: n(p.quantity),
        defective: n(p.defectiveQuantity),
      }),
      t("warehouseCommands.confirm.change", { before: n(p.current.available), after: n(p.after.available) }),
    ];
    if (p.insufficient) lines.push(t("warehouseCommands.confirm.insufficient", { onHand: n(p.current.onHand) }));
    if (p.alreadyApplied) lines.push(t("warehouseCommands.replay"));
    return lines.join("\n");
  }
  const d = outcome.data as
    | StockSummaryResult
    | LowStockResult
    | ItemStockResult
    | ProductionStatusResult
    | RecommendationsResult
    | StockChangeResult
    | StartPackingCommandResult
    | ProductionReceiptCommandResult
    | MaterialReceiveResult;
  switch (d.kind) {
    case "stock_summary":
      return [
        t("warehouseCommands.summary", {
          variants: n(d.variants),
          available: n(d.available),
          onHand: n(d.onHand),
          reserved: n(d.reserved),
          defective: n(d.defective),
          inProduction: n(d.inProduction),
        }),
        t("warehouseCommands.summary.alerts", {
          low: n(d.openAlerts.low_stock),
          out: n(d.openAlerts.out_of_stock),
          oversold: n(d.openAlerts.oversold),
          negative: n(d.openAlerts.negative_on_hand),
        }),
      ].join("\n");
    case "low_stock":
      if (d.items.length === 0) return t("warehouseCommands.lowStock.empty");
      return [
        t("warehouseCommands.lowStock.title", { total: n(d.total) }),
        ...d.items.map((i) => t("warehouseCommands.lowStock.line", { item: itemLabel(i), available: n(i.available), status: t(`stockLevel.${i.status}`) })),
      ].join("\n");
    case "item_stock":
      if (d.matches.length === 0) return t("warehouseCommands.item.none");
      return [
        ...d.matches.map((i) =>
          t("warehouseCommands.item.line", {
            item: itemLabel(i),
            available: n(i.available),
            onHand: n(i.onHand),
            reserved: n(i.reserved),
            defective: n(i.defective),
            inProduction: n(i.inProduction),
          }),
        ),
        ...(d.truncated || d.total > d.matches.length ? [t("warehouseCommands.item.more", { total: n(d.total), shown: n(d.matches.length) })] : []),
      ].join("\n");
    case "production_status":
      return [
        t("warehouseCommands.production.title", { number: d.number, status: t(`productionStatus.${d.status}`) }),
        t("warehouseCommands.production.totals", { ordered: n(d.ordered), received: n(d.received), defective: n(d.defective), remaining: n(d.remaining) }),
        ...(d.plannedReadyDate
          ? [t(d.overdue ? "warehouseCommands.production.overdue" : "warehouseCommands.production.planned", { date: date(d.plannedReadyDate) })]
          : []),
      ].join("\n");
    case "recommendations":
      if (d.items.length === 0) return t("warehouseCommands.recommendations.empty");
      return [
        t("warehouseCommands.recommendations.title", { total: n(d.total) }),
        ...d.items.map((i) =>
          t("warehouseCommands.recommendations.line", {
            item: itemLabel(i),
            quantity: n(i.quantity),
            velocity: dec(i.velocity),
            available: n(i.available),
            date: date(i.stockOutDate),
          }),
        ),
      ].join("\n");
    case "start_packing":
      return t(`warehouseCommands.packing.${d.result}`, { order: d.orderNumber });
    case "receive_production":
      if (d.result === "replay") return t("warehouseCommands.replay");
      return t("warehouseCommands.receivedProduction", {
        number: d.batchNumber,
        good: n(d.good),
        defective: n(d.defective),
        status: t(`productionStatus.${d.status}`),
      });
    case "material_receive":
      if (d.result === "replay") return t("warehouseCommands.replay");
      return t("warehouseCommands.materialReceived", {
        item: `${d.name} (${d.code})`,
        quantity: n(d.quantity),
        unit: t(`materialUnit.${d.unit}`),
        onHand: n(d.onHand),
      });
    case "receive_stock":
    case "mark_defective":
      if (d.result === "replay") return t("warehouseCommands.replay");
      return t(d.kind === "receive_stock" ? "warehouseCommands.received" : "warehouseCommands.marked", {
        item: itemLabel(d),
        quantity: n(d.quantity),
        defective: n(d.defectiveQuantity),
        available: n(d.balance.available),
      });
  }
}
