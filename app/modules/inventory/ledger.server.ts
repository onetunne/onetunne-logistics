/**
 * Журнал руху залишків (ledger) — єдине джерело внутрішнього складського обліку (docs/stage5-design.md §1).
 *
 * Гарантії applyMovements:
 * 1. Кожен рух має унікальний ключ ідемпотентності (inventory_movements.idempotency_key). Вставка
 *    ON CONFLICT DO NOTHING RETURNING: баланс змінюється ЛИШЕ для щойно вставлених рядків → повтор події
 *    (webhook, подвійне натискання, повтор завдання) не створює другого руху й не змінює баланс двічі.
 * 2. Баланси змінюються лише тут, разом зі вставкою руху, у транзакції викликача, з блокуванням рядків балансу
 *    FOR UPDATE у порядку (stock_item_id, warehouse_id) — без втрачених оновлень і взаємоблокувань.
 * 3. Обмеження: reserved/defective/in_production ≥ 0 завжди; on_hand < 0 — лише для фізичних подій
 *    (consume_sale; shopify_external — якщо warehouse.allowNegativeOnHand) з попередженням negative_on_hand.
 *    Порушення → DomainError("inventory.insufficient", 409) і відкат до точки збереження (savepoint):
 *    транзакція викликача лишається придатною, жодних частково записаних рухів.
 * 4. Після зміни — оцінка попереджень (stock_alerts) для змінених позицій.
 * 5. Товар, ще не «відкритий» (inventory_balances.opened_at = null, див. opening.server.ts): рухи, пов'язані з
 *    Shopify (reserve/release/consume_sale/shopify_external), заборонені — DomainError("inventory.notOpened", 409);
 *    внутрішні зміни on_hand не надсилаються в Shopify (стан "skipped"): при відкритті вони ДОДАЮТЬСЯ до знімка
 *    Shopify (і створюється розбіжність для перевірки власником).
 *
 * ВАЖЛИВО для викликачів: одна логічна операція → один виклик applyMovements з усіма рухами (порядок блокувань
 * гарантується в межах виклику). Порядок блокувань у транзакції: замовлення/партія/пакування → склад
 * (syncOrderReservations / initializeInventory) → баланси; ніколи навпаки. Рядки замовлень блокуйте
 * FOR NO KEY UPDATE (не FOR UPDATE): FOR UPDATE конфліктує з перевіркою зовнішніх ключів (KEY SHARE) під час
 * вставки рухів/резервів цього замовлення в іншій транзакції (ініціалізація складу) → взаємоблокування.
 */
import { and, asc, count, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import type { DbOrTx, Tx } from "~/db/client.server";
import {
  inventoryBalances,
  inventoryMovements,
  orders,
  packagingMaterials,
  productionBatches,
  productVariants,
  products,
  stockAlerts,
  stockItems,
  type MaterialUnit,
  type PackagingMaterialKind,
  type ShopifySyncState,
  type StockAlertKind,
  type StockItemKind,
} from "~/db/schema";
import type { Actor } from "~/domain/permissions";
import { DomainError, NotFoundError } from "~/lib/errors";
import { toMinor } from "~/lib/money";
import { maskFreeTextNote } from "~/modules/privacy/notes";
import { getSetting } from "~/modules/settings/settings.server";
import { alertKindsFor, availableOf, stockLevelStatus, type StockLevelStatus } from "./alerts";
import {
  BUCKETS,
  MOVEMENT_RULES,
  assertMovementShape,
  defaultShopifySyncState,
  type Bucket,
  type MovementDeltas,
  type MovementType,
} from "./movement-types";
import { getDefaultWarehouse } from "./warehouse.server";

export { MOVEMENT_TYPES, isMovementType, type MovementType } from "./movement-types";

/** Хто виконав рух (знімок імені зберігається в рядку руху). */
export type MovementActor = Pick<Actor, "id" | "displayName">;

export interface MovementInput {
  warehouseId: string;
  stockItemId: string;
  type: MovementType;
  /** Унікальний ключ бізнес-події (див. keys.ts). */
  idempotencyKey: string;
  onHandDelta?: number;
  reservedDelta?: number;
  defectiveDelta?: number;
  inProductionDelta?: number;
  orderId?: string | null;
  orderLineItemId?: string | null;
  productionBatchId?: string | null;
  packingId?: string | null;
  /** Собівартість одиниці (десятковий рядок "12.50") — лише власник бачить; потребує costCurrency. */
  unitCost?: string | null;
  costCurrency?: string | null;
  /** Короткий код причини: [a-z0-9_.-], до 64 символів. */
  reason?: string | null;
  /** Примітка без персональних даних (до 500 символів). */
  note?: string | null;
  /** Перевизначає стан передачі в Shopify (за замовчуванням — defaultShopifySyncState). */
  shopifySyncState?: ShopifySyncState;
}

export interface BalanceState {
  warehouseId: string;
  stockItemId: string;
  kind: StockItemKind;
  onHand: number;
  reserved: number;
  defective: number;
  inProduction: number;
  /** on_hand − reserved */
  available: number;
  version: number;
  /** Товар відкрито (облік пов'язано зі знімком Shopify); null — не відкрито / матеріал. */
  openedAt: Date | null;
}

export interface AppliedMovement {
  id: string;
  idempotencyKey: string;
  warehouseId: string;
  stockItemId: string;
  type: MovementType;
  shopifySyncState: ShopifySyncState;
  createdAt: Date;
}

export interface ApplyMovementsResult {
  /** Щойно записані рухи (баланс змінено). */
  applied: AppliedMovement[];
  /** Повтори: рух із таким ключем уже існує — баланс НЕ змінювався. */
  skipped: Array<{ idempotencyKey: string; stockItemId: string; warehouseId: string }>;
  /** Підсумкові баланси всіх позицій виклику (після змін). */
  balances: BalanceState[];
  /** Попередження, відкриті цим викликом (для сповіщень). */
  openedAlerts: OpenedAlert[];
}

export interface ApplyMovementsOptions {
  /** false — не оцінювати попередження (викличте evaluateStockAlerts самі). За замовчуванням true. */
  evaluateAlerts?: boolean;
  /**
   * Режим передачі в Shopify для стану нових рухів (defaultShopifySyncState); за замовчуванням — налаштування
   * warehouse.shopifyPush. Демо передає "off" (movementOptionsFor): магазину немає, тож внутрішня зміна позначається
   * «Не надсилалося», а не «Очікує надсилання», і завдання передачі не ставиться.
   */
  shopifyPush?: "off" | "deltas";
}

/**
 * Опції applyMovements для контексту запиту: у демо Shopify не підключено й нічого не надсилається → передача
 * вимкнена незалежно від налаштування (інтерфейс не обіцяє «буде надіслано в Shopify»).
 */
export function movementOptionsFor(ctx: { mode: "demo" | "production" }, opts: ApplyMovementsOptions = {}): ApplyMovementsOptions {
  return ctx.mode === "production" ? opts : { ...opts, shopifyPush: "off" };
}

export const MAX_MOVEMENTS_PER_CALL = 2000;

/** Типи руху, пов'язані з Shopify: лише для ВІДКРИТИХ товарів (див. п. 5 вгорі файлу). */
export const OPENED_ONLY_MOVEMENT_TYPES: ReadonlySet<MovementType> = new Set<MovementType>([
  "reserve",
  "release",
  "consume_sale",
  "shopify_external",
]);
const REASON_RE = /^[a-z0-9_.-]{1,64}$/;
/** Найдовша примітка руху (після маскування). */
const MOVEMENT_NOTE_MAX_LENGTH = 500;
const CURRENCY_RE = /^[A-Z]{3}$/;

const pairKey = (warehouseId: string, stockItemId: string) => `${warehouseId}|${stockItemId}`;

interface NormalizedInput extends MovementInput {
  deltas: MovementDeltas;
}

function normalize(input: MovementInput): NormalizedInput {
  const deltas: MovementDeltas = {
    onHand: input.onHandDelta ?? 0,
    reserved: input.reservedDelta ?? 0,
    defective: input.defectiveDelta ?? 0,
    inProduction: input.inProductionDelta ?? 0,
  };
  if (!MOVEMENT_RULES[input.type]) throw new DomainError("inventory.invalidMovement", 400, { type: String(input.type), bucket: "type" });
  const key = input.idempotencyKey;
  if (typeof key !== "string" || key.length === 0 || key.length > 200) {
    throw new DomainError("inventory.invalidMovement", 400, { type: input.type, bucket: "idempotencyKey" });
  }
  if (input.reason != null && !REASON_RE.test(input.reason)) {
    throw new DomainError("inventory.invalidMovement", 400, { type: input.type, bucket: "reason" });
  }
  if (input.unitCost != null) {
    try {
      if (toMinor(input.unitCost) < 0n) throw new Error("negative");
    } catch {
      throw new DomainError("inventory.invalidMovement", 400, { type: input.type, bucket: "unitCost" });
    }
    if (!input.costCurrency || !CURRENCY_RE.test(input.costCurrency)) {
      throw new DomainError("inventory.invalidMovement", 400, { type: input.type, bucket: "costCurrency" });
    }
  }
  // Примітка — вільний текст працівника, видимий усім з warehouse.view: маскування PII тут, щоб жоден викликач
  // (склад, матеріали, виробництво, синхронізація) не міг записати телефон/email без маскування.
  return { ...input, deltas, note: maskFreeTextNote(input.note, MOVEMENT_NOTE_MAX_LENGTH) };
}

function sortByLockOrder<T extends { stockItemId: string; warehouseId: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) =>
    a.stockItemId === b.stockItemId ? a.warehouseId.localeCompare(b.warehouseId) : a.stockItemId.localeCompare(b.stockItemId),
  );
}

type LockedBalance = BalanceState;

/**
 * Створює (за потреби) і блокує рядки балансів FOR UPDATE у порядку (stock_item_id, warehouse_id).
 * Для операцій «встановити значення» (інвентаризація, початковий залишок): заблокуйте, обчисліть дельту від
 * поточного on_hand і передайте її в applyMovements у тій самій транзакції.
 */
export async function lockBalances(
  tx: Tx,
  pairs: ReadonlyArray<{ warehouseId: string; stockItemId: string }>,
): Promise<Map<string, LockedBalance>> {
  const unique = new Map<string, { warehouseId: string; stockItemId: string }>();
  for (const p of pairs) unique.set(pairKey(p.warehouseId, p.stockItemId), { warehouseId: p.warehouseId, stockItemId: p.stockItemId });
  const sorted = sortByLockOrder([...unique.values()]);
  const out = new Map<string, LockedBalance>();
  if (sorted.length === 0) return out;
  await tx.insert(inventoryBalances).values(sorted).onConflictDoNothing();
  const byWarehouse = new Map<string, string[]>();
  for (const p of sorted) byWarehouse.set(p.warehouseId, [...(byWarehouse.get(p.warehouseId) ?? []), p.stockItemId]);
  const rows = await tx
    .select({ b: inventoryBalances, kind: stockItems.kind })
    .from(inventoryBalances)
    .innerJoin(stockItems, eq(stockItems.id, inventoryBalances.stockItemId))
    .where(
      or(
        ...[...byWarehouse].map(([warehouseId, ids]) =>
          and(eq(inventoryBalances.warehouseId, warehouseId), inArray(inventoryBalances.stockItemId, ids)),
        ),
      ),
    )
    .orderBy(asc(inventoryBalances.stockItemId), asc(inventoryBalances.warehouseId))
    .for("update", { of: inventoryBalances });
  for (const { b, kind } of rows) {
    out.set(pairKey(b.warehouseId, b.stockItemId), toBalanceState(b, kind));
  }
  for (const p of sorted) if (!out.has(pairKey(p.warehouseId, p.stockItemId))) throw new NotFoundError("stockItem");
  return out;
}

/**
 * Блокує НАЯВНІ баланси позицій (на всіх складах; нових рядків не створює) у порядку блокувань ledger — перед оцінкою
 * попереджень поза applyMovements (зміна порогу тощо), щоб не оцінювати стан, який паралельно змінює рух.
 */
export async function lockExistingBalances(tx: Tx, stockItemIds: readonly string[]): Promise<void> {
  const ids = [...new Set(stockItemIds)];
  if (ids.length === 0) return;
  const pairs = await tx
    .select({ warehouseId: inventoryBalances.warehouseId, stockItemId: inventoryBalances.stockItemId })
    .from(inventoryBalances)
    .where(inArray(inventoryBalances.stockItemId, ids));
  if (pairs.length > 0) await lockBalances(tx, pairs);
}

function toBalanceState(b: typeof inventoryBalances.$inferSelect, kind: StockItemKind): BalanceState {
  return {
    warehouseId: b.warehouseId,
    stockItemId: b.stockItemId,
    kind,
    onHand: b.onHand,
    reserved: b.reserved,
    defective: b.defective,
    inProduction: b.inProduction,
    available: availableOf(b),
    version: b.version,
    openedAt: b.openedAt,
  };
}

const BUCKET_LABEL: Record<Bucket, string> = {
  onHand: "on_hand",
  reserved: "reserved",
  defective: "defective",
  inProduction: "in_production",
};

/**
 * Записує рухи й змінює баланси (див. гарантії вгорі файлу). Викликати ЛИШЕ в транзакції викликача.
 */
export async function applyMovements(
  tx: Tx,
  actor: MovementActor,
  inputs: readonly MovementInput[],
  opts: ApplyMovementsOptions = {},
): Promise<ApplyMovementsResult> {
  if (inputs.length === 0) return { applied: [], skipped: [], balances: [], openedAlerts: [] };
  if (inputs.length > MAX_MOVEMENTS_PER_CALL) throw new RangeError(`applyMovements: more than ${MAX_MOVEMENTS_PER_CALL} movements`);
  const normalized = sortByLockOrder(inputs.map(normalize));

  // Точка збереження: помилка обмеження не лишає частково записаних рухів, навіть якщо викликач її перехопить.
  return tx.transaction(async (sp) => {
    const locked = await lockBalances(sp, normalized);
    const settings = await getSetting(sp, "warehouse");
    for (const m of normalized) {
      const b = locked.get(pairKey(m.warehouseId, m.stockItemId))!;
      assertMovementShape(m.type, b.kind, m.deltas);
      if (b.kind === "product" && b.openedAt === null && OPENED_ONLY_MOVEMENT_TYPES.has(m.type)) {
        throw new DomainError("inventory.notOpened", 409, { type: m.type, stockItemId: m.stockItemId });
      }
    }

    const applied: AppliedMovement[] = [];
    const skipped: ApplyMovementsResult["skipped"] = [];
    const sums = new Map<string, MovementDeltas>();
    const decreasingTypes = new Map<string, Set<MovementType>>();
    for (const m of normalized) {
      const pk = pairKey(m.warehouseId, m.stockItemId);
      const { kind, openedAt } = locked.get(pk)!;
      let syncState = m.shopifySyncState ?? defaultShopifySyncState(m.type, kind, m.deltas.onHand, opts.shopifyPush ?? settings.shopifyPush);
      // Невідкритий товар не синхронізується з Shopify: його внутрішні рухи додаються до знімка при відкритті.
      if (kind === "product" && openedAt === null && syncState === "pending") syncState = "skipped";
      const [row] = await sp
        .insert(inventoryMovements)
        .values({
          warehouseId: m.warehouseId,
          stockItemId: m.stockItemId,
          type: m.type,
          onHandDelta: m.deltas.onHand,
          reservedDelta: m.deltas.reserved,
          defectiveDelta: m.deltas.defective,
          inProductionDelta: m.deltas.inProduction,
          idempotencyKey: m.idempotencyKey,
          orderId: m.orderId ?? null,
          orderLineItemId: m.orderLineItemId ?? null,
          productionBatchId: m.productionBatchId ?? null,
          packingId: m.packingId ?? null,
          unitCost: m.unitCost ?? null,
          costCurrency: m.unitCost != null ? (m.costCurrency ?? null) : null,
          reason: m.reason ?? null,
          note: m.note ?? null,
          actorId: actor.id,
          actorName: actor.displayName.slice(0, 120),
          shopifySyncState: syncState,
        })
        .onConflictDoNothing({ target: inventoryMovements.idempotencyKey })
        .returning({ id: inventoryMovements.id, createdAt: inventoryMovements.createdAt });
      if (!row) {
        skipped.push({ idempotencyKey: m.idempotencyKey, stockItemId: m.stockItemId, warehouseId: m.warehouseId });
        continue;
      }
      applied.push({
        id: row.id,
        idempotencyKey: m.idempotencyKey,
        warehouseId: m.warehouseId,
        stockItemId: m.stockItemId,
        type: m.type,
        shopifySyncState: syncState,
        createdAt: row.createdAt,
      });
      const sum = sums.get(pk) ?? { onHand: 0, reserved: 0, defective: 0, inProduction: 0 };
      for (const bucket of BUCKETS) sum[bucket] += m.deltas[bucket];
      sums.set(pk, sum);
      if (m.deltas.onHand < 0) decreasingTypes.set(pk, (decreasingTypes.get(pk) ?? new Set()).add(m.type));
    }

    // Перевірка підсумкового стану до запису балансів (у межах точки збереження).
    for (const [pk, d] of sums) {
      const b = locked.get(pk)!;
      for (const bucket of ["reserved", "defective", "inProduction"] as const) {
        const next = b[bucket] + d[bucket];
        if (next < 0) {
          throw new DomainError("inventory.insufficient", 409, {
            bucket: BUCKET_LABEL[bucket],
            stockItemId: b.stockItemId,
            current: b[bucket],
            change: d[bucket],
          });
        }
      }
      const nextOnHand = b.onHand + d.onHand;
      if (nextOnHand < 0 && d.onHand < 0) {
        const types = [...(decreasingTypes.get(pk) ?? [])];
        const allowed = types.every(
          (t) => MOVEMENT_RULES[t].negativeOnHand && (t !== "shopify_external" || settings.allowNegativeOnHand),
        );
        if (!allowed) {
          throw new DomainError("inventory.insufficient", 409, {
            bucket: BUCKET_LABEL.onHand,
            stockItemId: b.stockItemId,
            current: b.onHand,
            change: d.onHand,
            available: b.available,
          });
        }
      }
    }

    const balances = new Map(locked);
    for (const [pk, d] of sums) {
      const b = locked.get(pk)!;
      const [row] = await sp
        .update(inventoryBalances)
        .set({
          onHand: sql`${inventoryBalances.onHand} + ${d.onHand}`,
          reserved: sql`${inventoryBalances.reserved} + ${d.reserved}`,
          defective: sql`${inventoryBalances.defective} + ${d.defective}`,
          inProduction: sql`${inventoryBalances.inProduction} + ${d.inProduction}`,
          version: sql`${inventoryBalances.version} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(inventoryBalances.warehouseId, b.warehouseId), eq(inventoryBalances.stockItemId, b.stockItemId)))
        .returning();
      balances.set(pk, toBalanceState(row!, b.kind));
    }

    let openedAlerts: OpenedAlert[] = [];
    if (opts.evaluateAlerts !== false && sums.size > 0) {
      const evaluated = await evaluateStockAlerts(sp, [...new Set([...sums.keys()].map((pk) => locked.get(pk)!.stockItemId))], {
        defaultThreshold: settings.lowStockThreshold,
      });
      openedAlerts = evaluated.opened;
    }
    return { applied, skipped, balances: [...balances.values()], openedAlerts };
  });
}

// ---------------------------------------------------------------------------
// Позиції обліку
// ---------------------------------------------------------------------------

/** Позиція обліку для варіанта товару (створюється за потреби; ідемпотентно). */
export async function ensureStockItemForVariant(tx: DbOrTx, variantId: string): Promise<string> {
  const map = await ensureStockItemsForVariants(tx, [variantId]);
  const id = map.get(variantId);
  if (!id) throw new NotFoundError("variant");
  return id;
}

/** Пакетна версія: variantId → stockItemId. Вставка в стабільному порядку (без взаємоблокувань). */
export async function ensureStockItemsForVariants(tx: DbOrTx, variantIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(variantIds)].sort();
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const existing = await tx.select({ id: stockItems.id, variantId: stockItems.variantId }).from(stockItems).where(inArray(stockItems.variantId, ids));
  for (const r of existing) out.set(r.variantId!, r.id);
  const missing = ids.filter((id) => !out.has(id));
  if (missing.length > 0) {
    await tx
      .insert(stockItems)
      .values(missing.map((variantId) => ({ kind: "product" as const, variantId })))
      .onConflictDoNothing({ target: stockItems.variantId });
    const rows = await tx.select({ id: stockItems.id, variantId: stockItems.variantId }).from(stockItems).where(inArray(stockItems.variantId, missing));
    for (const r of rows) out.set(r.variantId!, r.id);
  }
  return out;
}

/** Позиція обліку для пакувального матеріалу (створюється за потреби; ідемпотентно). */
export async function ensureStockItemForMaterial(tx: DbOrTx, materialId: string): Promise<string> {
  const [existing] = await tx.select({ id: stockItems.id }).from(stockItems).where(eq(stockItems.materialId, materialId));
  if (existing) return existing.id;
  await tx.insert(stockItems).values({ kind: "material", materialId }).onConflictDoNothing({ target: stockItems.materialId });
  const [row] = await tx.select({ id: stockItems.id }).from(stockItems).where(eq(stockItems.materialId, materialId));
  if (!row) throw new NotFoundError("material");
  return row.id;
}

/** Власний поріг «мало на складі» позиції (null — типовий з налаштувань). Переоцінює попередження. */
export async function setLowStockThreshold(tx: Tx, stockItemId: string, threshold: number | null): Promise<void> {
  if (threshold !== null && (!Number.isSafeInteger(threshold) || threshold < 0 || threshold > 100000)) {
    throw new DomainError("error.validation", 400, { field: "lowStockThreshold" });
  }
  // Спершу баланси (той самий порядок блокувань, що й applyMovements): оцінка бачить зафіксований стан і чужі
  // попередження, а не стару версію поруч із паралельним рухом (інакше — суперечливі «мало» + «немає»).
  await lockExistingBalances(tx, [stockItemId]);
  const updated = await tx.update(stockItems).set({ lowStockThreshold: threshold }).where(eq(stockItems.id, stockItemId)).returning({ id: stockItems.id });
  if (updated.length === 0) throw new NotFoundError("stockItem");
  await evaluateStockAlerts(tx, [stockItemId]);
}

// ---------------------------------------------------------------------------
// Попередження
// ---------------------------------------------------------------------------

export interface OpenedAlert {
  id: string;
  stockItemId: string;
  warehouseId: string;
  kind: StockAlertKind;
  details: Record<string, number | string | null>;
}

export interface EvaluateAlertsResult {
  opened: OpenedAlert[];
  resolved: Array<{ id: string; stockItemId: string; warehouseId: string; kind: StockAlertKind }>;
}

/**
 * Відкриває/оновлює/закриває попередження для позицій (усі склади) ідемпотентно: одне відкрите попередження
 * виду на (позиція, склад) — частковий унікальний індекс. Поріг: stock_items.low_stock_threshold ?? налаштування.
 */
export async function evaluateStockAlerts(
  tx: DbOrTx,
  stockItemIds: readonly string[],
  opts: { defaultThreshold?: number } = {},
): Promise<EvaluateAlertsResult> {
  const ids = [...new Set(stockItemIds)];
  const result: EvaluateAlertsResult = { opened: [], resolved: [] };
  if (ids.length === 0) return result;
  const defaultThreshold = opts.defaultThreshold ?? (await getSetting(tx, "warehouse")).lowStockThreshold;
  const rows = await tx
    .select({ b: inventoryBalances, threshold: stockItems.lowStockThreshold, materialActive: packagingMaterials.active })
    .from(inventoryBalances)
    .innerJoin(stockItems, eq(stockItems.id, inventoryBalances.stockItemId))
    .leftJoin(packagingMaterials, eq(packagingMaterials.id, stockItems.materialId))
    .where(inArray(inventoryBalances.stockItemId, ids))
    // Детермінований порядок записів попереджень (як порядок блокувань) — менше шансів на взаємне блокування.
    .orderBy(asc(inventoryBalances.stockItemId), asc(inventoryBalances.warehouseId));
  const open = await tx
    .select()
    .from(stockAlerts)
    .where(and(inArray(stockAlerts.stockItemId, ids), eq(stockAlerts.status, "open")))
    .orderBy(asc(stockAlerts.stockItemId), asc(stockAlerts.warehouseId), asc(stockAlerts.kind));
  const openByKey = new Map(open.map((a) => [`${a.warehouseId}|${a.stockItemId}|${a.kind}`, a]));
  const now = new Date();
  const seen = new Set<string>();
  for (const { b, threshold, materialActive } of rows) {
    // Неактивний пакувальний матеріал не попереджає: відкриті попередження нижче закриваються (не в `seen`).
    if (materialActive === false) continue;
    const effective = threshold ?? defaultThreshold;
    const details = { onHand: b.onHand, reserved: b.reserved, available: availableOf(b), threshold: effective };
    for (const kind of alertKindsFor({ onHand: b.onHand, reserved: b.reserved, threshold: effective })) {
      const k = `${b.warehouseId}|${b.stockItemId}|${kind}`;
      seen.add(k);
      const existing = openByKey.get(k);
      if (existing) {
        if (JSON.stringify(existing.details) !== JSON.stringify(details)) {
          await tx.update(stockAlerts).set({ details }).where(eq(stockAlerts.id, existing.id));
        }
        continue;
      }
      const [inserted] = await tx
        .insert(stockAlerts)
        .values({ stockItemId: b.stockItemId, warehouseId: b.warehouseId, kind, details })
        .onConflictDoNothing({
          target: [stockAlerts.stockItemId, stockAlerts.warehouseId, stockAlerts.kind],
          where: sql`${stockAlerts.status} = 'open'`,
        })
        .returning({ id: stockAlerts.id });
      if (inserted) result.opened.push({ id: inserted.id, stockItemId: b.stockItemId, warehouseId: b.warehouseId, kind, details });
    }
  }
  for (const a of open) {
    if (seen.has(`${a.warehouseId}|${a.stockItemId}|${a.kind}`)) continue;
    await tx.update(stockAlerts).set({ status: "resolved", resolvedAt: now }).where(and(eq(stockAlerts.id, a.id), eq(stockAlerts.status, "open")));
    result.resolved.push({ id: a.id, stockItemId: a.stockItemId, warehouseId: a.warehouseId, kind: a.kind });
  }
  return result;
}

export interface AlertView {
  id: string;
  kind: StockAlertKind;
  stockItemId: string;
  warehouseId: string;
  itemKind: StockItemKind;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  details: Record<string, number | string | null>;
  createdAt: Date;
}

/** Відкриті попередження (новіші спершу) — для розділу «Склад», панелі й майбутніх сповіщень Telegram. */
export async function listOpenAlerts(db: DbOrTx, opts: { limit?: number; kinds?: StockAlertKind[] } = {}): Promise<AlertView[]> {
  const rows = await db
    .select({
      alert: stockAlerts,
      itemKind: stockItems.kind,
      productTitle: products.title,
      variantTitle: productVariants.title,
      sku: productVariants.sku,
      materialName: packagingMaterials.name,
      materialCode: packagingMaterials.code,
    })
    .from(stockAlerts)
    .innerJoin(stockItems, eq(stockItems.id, stockAlerts.stockItemId))
    .leftJoin(productVariants, eq(productVariants.id, stockItems.variantId))
    .leftJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(packagingMaterials, eq(packagingMaterials.id, stockItems.materialId))
    .where(and(eq(stockAlerts.status, "open"), opts.kinds?.length ? inArray(stockAlerts.kind, opts.kinds) : undefined))
    .orderBy(desc(stockAlerts.createdAt), desc(stockAlerts.id))
    .limit(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  return rows.map((r) => ({
    id: r.alert.id,
    kind: r.alert.kind,
    stockItemId: r.alert.stockItemId,
    warehouseId: r.alert.warehouseId,
    itemKind: r.itemKind,
    title: r.productTitle ?? r.materialName ?? "—",
    variantTitle: r.itemKind === "product" ? r.variantTitle : null,
    sku: r.itemKind === "product" ? r.sku : r.materialCode,
    details: r.alert.details,
    createdAt: r.alert.createdAt,
  }));
}

// ---------------------------------------------------------------------------
// Читання: баланси та історія руху
// ---------------------------------------------------------------------------

export interface BalanceFilters {
  /** За замовчуванням — склад за замовчуванням. */
  warehouseId?: string;
  /** product (за замовчуванням) — варіанти товарів; material — пакувальні матеріали. */
  kind?: StockItemKind;
  /** Пошук за назвою, варіантом, SKU, штрихкодом (товари) або назвою/кодом (матеріали). */
  search?: string;
  models?: string[];
  colors?: string[];
  productIds?: string[];
  variantIds?: string[];
  stockItemIds?: string[];
  materialIds?: string[];
  materialKinds?: PackagingMaterialKind[];
  statuses?: StockLevelStatus[];
  /** Товари: включати архівні/видалені в Shopify (за замовчуванням ні). Матеріали: неактивні. */
  includeInactive?: boolean;
}

export interface PageRequest {
  /** 1–500, за замовчуванням 50. */
  limit?: number;
  offset?: number;
}

export interface BalanceView {
  /** null — позиція ще не мала жодного руху (нулі). */
  stockItemId: string | null;
  kind: StockItemKind;
  warehouseId: string;
  variantId: string | null;
  productId: string | null;
  materialId: string | null;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  barcode: string | null;
  color: string | null;
  model: string | null;
  imageUrl: string | null;
  materialKind: PackagingMaterialKind | null;
  unit: MaterialUnit;
  onHand: number;
  reserved: number;
  available: number;
  defective: number;
  inProduction: number;
  /** Власний поріг позиції (null — типовий). */
  lowStockThreshold: number | null;
  /** Поріг, що діє. */
  threshold: number;
  status: StockLevelStatus;
  /** Shopify «доступно» з останньої синхронізації товару (лише для порівняння; не джерело обліку). */
  shopifyAvailable: number | null;
  /** Товар відкрито (облік пов'язано зі знімком Shopify; резерви ведуться). null — не відкрито / матеріал. */
  openedAt: Date | null;
  version: number;
  updatedAt: Date | null;
}

function pageOf(page: PageRequest): { limit: number; offset: number } {
  const limit = Math.min(Math.max(Math.trunc(page.limit ?? 50), 1), 500);
  const offset = Math.max(Math.trunc(page.offset ?? 0), 0);
  return { limit, offset };
}

const likePattern = (search: string) => `%${search.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function levelStatusSql(onHand: SQL, reserved: SQL, threshold: SQL): SQL<StockLevelStatus> {
  return sql<StockLevelStatus>`case
    when ${onHand} < 0 then 'negative'
    when ${reserved} > 0 and ${reserved} > ${onHand} then 'oversold'
    when ${onHand} - ${reserved} <= 0 then 'out'
    when ${onHand} - ${reserved} <= ${threshold} then 'low'
    else 'ok' end`;
}

/**
 * Залишки: кожен варіант товару (або матеріал) з балансом на складі; позиції без руху — нулі.
 * Фільтри за моделлю, кольором, станом (low/out/…), пошук; сторінки limit/offset.
 */
export async function getBalances(
  db: DbOrTx,
  filters: BalanceFilters = {},
  page: PageRequest = {},
): Promise<{ rows: BalanceView[]; total: number }> {
  const warehouseId = filters.warehouseId ?? (await getDefaultWarehouse(db)).id;
  const defaultThreshold = (await getSetting(db, "warehouse")).lowStockThreshold;
  const { limit, offset } = pageOf(page);
  const onHand = sql`coalesce(${inventoryBalances.onHand}, 0)`;
  const reserved = sql`coalesce(${inventoryBalances.reserved}, 0)`;
  const threshold = sql`coalesce(${stockItems.lowStockThreshold}, ${defaultThreshold})`;
  const status = levelStatusSql(onHand, reserved, threshold);
  const balanceJoin = and(eq(inventoryBalances.stockItemId, stockItems.id), eq(inventoryBalances.warehouseId, warehouseId));
  const common = {
    stockItemId: stockItems.id,
    lowStockThreshold: stockItems.lowStockThreshold,
    onHand: sql<number>`${onHand}`.mapWith(Number),
    reserved: sql<number>`${reserved}`.mapWith(Number),
    defective: sql<number>`coalesce(${inventoryBalances.defective}, 0)`.mapWith(Number),
    inProduction: sql<number>`coalesce(${inventoryBalances.inProduction}, 0)`.mapWith(Number),
    threshold: sql<number>`${threshold}`.mapWith(Number),
    status,
    version: sql<number>`coalesce(${inventoryBalances.version}, 0)`.mapWith(Number),
    openedAt: inventoryBalances.openedAt,
    updatedAt: inventoryBalances.updatedAt,
  };
  const statusFilter = filters.statuses?.length ? sql`(${status}) in ${filters.statuses}` : undefined;

  if ((filters.kind ?? "product") === "material") {
    const where = and(
      filters.includeInactive ? undefined : eq(packagingMaterials.active, true),
      filters.materialIds?.length ? inArray(packagingMaterials.id, filters.materialIds) : undefined,
      filters.stockItemIds?.length ? inArray(stockItems.id, filters.stockItemIds) : undefined,
      filters.materialKinds?.length ? inArray(packagingMaterials.kind, filters.materialKinds) : undefined,
      filters.search?.trim()
        ? or(ilike(packagingMaterials.name, likePattern(filters.search)), ilike(packagingMaterials.code, likePattern(filters.search)))
        : undefined,
      statusFilter,
    );
    const base = () =>
      db
        .select({ ...common, material: packagingMaterials })
        .from(packagingMaterials)
        .leftJoin(stockItems, eq(stockItems.materialId, packagingMaterials.id))
        .leftJoin(inventoryBalances, balanceJoin);
    const [rows, [totalRow]] = await Promise.all([
      base().where(where).orderBy(asc(packagingMaterials.kind), asc(packagingMaterials.name)).limit(limit).offset(offset),
      db
        .select({ c: count() })
        .from(packagingMaterials)
        .leftJoin(stockItems, eq(stockItems.materialId, packagingMaterials.id))
        .leftJoin(inventoryBalances, balanceJoin)
        .where(where),
    ]);
    return {
      total: Number(totalRow?.c ?? 0),
      rows: rows.map((r) => ({
        stockItemId: r.stockItemId,
        kind: "material",
        warehouseId,
        variantId: null,
        productId: null,
        materialId: r.material.id,
        title: r.material.name,
        variantTitle: null,
        sku: r.material.code,
        barcode: null,
        color: null,
        model: null,
        imageUrl: null,
        materialKind: r.material.kind,
        unit: r.material.unit,
        onHand: r.onHand,
        reserved: r.reserved,
        available: r.onHand - r.reserved,
        defective: r.defective,
        inProduction: r.inProduction,
        lowStockThreshold: r.lowStockThreshold,
        threshold: r.threshold,
        status: r.status,
        shopifyAvailable: null,
        openedAt: null,
        version: r.version,
        updatedAt: r.updatedAt,
      })),
    };
  }

  const search = filters.search?.trim() ? likePattern(filters.search) : null;
  const where = and(
    filters.includeInactive ? undefined : or(sql`${products.status} is null`, inArray(products.status, ["ACTIVE", "active", "DRAFT", "draft"])),
    filters.productIds?.length ? inArray(products.id, filters.productIds) : undefined,
    filters.variantIds?.length ? inArray(productVariants.id, filters.variantIds) : undefined,
    filters.stockItemIds?.length ? inArray(stockItems.id, filters.stockItemIds) : undefined,
    filters.models?.length ? inArray(productVariants.model, filters.models) : undefined,
    filters.colors?.length ? inArray(productVariants.color, filters.colors) : undefined,
    search
      ? or(
          ilike(products.title, search),
          ilike(productVariants.title, search),
          ilike(productVariants.sku, search),
          ilike(productVariants.barcode, search),
        )
      : undefined,
    statusFilter,
  );
  const from = () =>
    db
      .select({ ...common, variant: productVariants, productTitle: products.title, productImage: products.imageUrl })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .leftJoin(stockItems, eq(stockItems.variantId, productVariants.id))
      .leftJoin(inventoryBalances, balanceJoin);
  const [rows, [totalRow]] = await Promise.all([
    from().where(where).orderBy(asc(products.title), asc(productVariants.title), asc(productVariants.id)).limit(limit).offset(offset),
    db
      .select({ c: count() })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .leftJoin(stockItems, eq(stockItems.variantId, productVariants.id))
      .leftJoin(inventoryBalances, balanceJoin)
      .where(where),
  ]);
  return {
    total: Number(totalRow?.c ?? 0),
    rows: rows.map((r) => ({
      stockItemId: r.stockItemId,
      kind: "product",
      warehouseId,
      variantId: r.variant.id,
      productId: r.variant.productId,
      materialId: null,
      title: r.productTitle,
      variantTitle: r.variant.title,
      sku: r.variant.sku,
      barcode: r.variant.barcode,
      color: r.variant.color,
      model: r.variant.model,
      imageUrl: r.variant.imageUrl ?? r.productImage,
      materialKind: null,
      unit: "pcs",
      onHand: r.onHand,
      reserved: r.reserved,
      available: r.onHand - r.reserved,
      defective: r.defective,
      inProduction: r.inProduction,
      lowStockThreshold: r.lowStockThreshold,
      threshold: r.threshold,
      status: r.status,
      shopifyAvailable: r.variant.inventoryAvailable,
      openedAt: r.openedAt,
      version: r.version,
      updatedAt: r.updatedAt,
    })),
  };
}

/** Баланс однієї позиції (нулі, якщо руху ще не було). Без блокування — для показу. */
export async function getBalance(db: DbOrTx, stockItemId: string, warehouseId?: string): Promise<BalanceState> {
  const wid = warehouseId ?? (await getDefaultWarehouse(db)).id;
  const [item] = await db.select({ kind: stockItems.kind }).from(stockItems).where(eq(stockItems.id, stockItemId));
  if (!item) throw new NotFoundError("stockItem");
  const [b] = await db
    .select()
    .from(inventoryBalances)
    .where(and(eq(inventoryBalances.warehouseId, wid), eq(inventoryBalances.stockItemId, stockItemId)));
  return b
    ? toBalanceState(b, item.kind)
    : { warehouseId: wid, stockItemId, kind: item.kind, onHand: 0, reserved: 0, defective: 0, inProduction: 0, available: 0, version: 0, openedAt: null };
}

export interface MovementFilters {
  warehouseId?: string;
  /** Конкретні рухи (посилання на документ, напр. referenceDocumentUri у Shopify: ?movement=<id>). */
  movementIds?: string[];
  stockItemIds?: string[];
  variantIds?: string[];
  materialIds?: string[];
  /**
   * Модель / колір варіанта (product_variants.model / color) — точний збіг, ті самі значення, що у фільтрах переліку
   * залишків (warehouse/stock.server.ts stockFilterOptions). Рухи матеріалів під такий фільтр не підпадають.
   */
  models?: string[];
  colors?: string[];
  kind?: StockItemKind;
  types?: MovementType[];
  orderId?: string;
  productionBatchId?: string;
  packingId?: string;
  actorId?: string;
  from?: Date;
  to?: Date;
}

export interface MovementView {
  id: string;
  createdAt: Date;
  type: MovementType;
  warehouseId: string;
  stockItemId: string;
  itemKind: StockItemKind;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  onHandDelta: number;
  reservedDelta: number;
  defectiveDelta: number;
  inProductionDelta: number;
  orderId: string | null;
  orderNumber: string | null;
  orderLineItemId: string | null;
  productionBatchId: string | null;
  batchNumber: string | null;
  packingId: string | null;
  reason: string | null;
  note: string | null;
  actorId: string;
  actorName: string;
  shopifySyncState: ShopifySyncState;
  /** Лише з includeCosts (finance.view); інакше null. */
  unitCost: string | null;
  costCurrency: string | null;
}

/**
 * Історія руху (новіші спершу). Собівартість повертається ЛИШЕ з includeCosts: true — викликач передає
 * can(actor, "finance.view").
 */
export async function movementHistory(
  db: DbOrTx,
  filters: MovementFilters = {},
  page: PageRequest = {},
  opts: { includeCosts?: boolean } = {},
): Promise<{ rows: MovementView[]; total: number }> {
  const { limit, offset } = pageOf(page);
  const where = and(
    filters.warehouseId ? eq(inventoryMovements.warehouseId, filters.warehouseId) : undefined,
    filters.movementIds?.length ? inArray(inventoryMovements.id, filters.movementIds) : undefined,
    filters.stockItemIds?.length ? inArray(inventoryMovements.stockItemId, filters.stockItemIds) : undefined,
    filters.variantIds?.length ? inArray(stockItems.variantId, filters.variantIds) : undefined,
    filters.materialIds?.length ? inArray(stockItems.materialId, filters.materialIds) : undefined,
    filters.models?.length ? inArray(productVariants.model, filters.models) : undefined,
    filters.colors?.length ? inArray(productVariants.color, filters.colors) : undefined,
    filters.kind ? eq(stockItems.kind, filters.kind) : undefined,
    filters.types?.length ? inArray(inventoryMovements.type, filters.types) : undefined,
    filters.orderId ? eq(inventoryMovements.orderId, filters.orderId) : undefined,
    filters.productionBatchId ? eq(inventoryMovements.productionBatchId, filters.productionBatchId) : undefined,
    filters.packingId ? eq(inventoryMovements.packingId, filters.packingId) : undefined,
    filters.actorId ? eq(inventoryMovements.actorId, filters.actorId) : undefined,
    filters.from ? gte(inventoryMovements.createdAt, filters.from) : undefined,
    filters.to ? lte(inventoryMovements.createdAt, filters.to) : undefined,
  );
  const [rows, [totalRow]] = await Promise.all([
    db
      .select({
        m: inventoryMovements,
        itemKind: stockItems.kind,
        productTitle: products.title,
        variantTitle: productVariants.title,
        sku: productVariants.sku,
        materialName: packagingMaterials.name,
        materialCode: packagingMaterials.code,
        orderNumber: orders.orderNumber,
        batchNumber: productionBatches.number,
      })
      .from(inventoryMovements)
      .innerJoin(stockItems, eq(stockItems.id, inventoryMovements.stockItemId))
      .leftJoin(productVariants, eq(productVariants.id, stockItems.variantId))
      .leftJoin(products, eq(products.id, productVariants.productId))
      .leftJoin(packagingMaterials, eq(packagingMaterials.id, stockItems.materialId))
      .leftJoin(orders, eq(orders.id, inventoryMovements.orderId))
      .leftJoin(productionBatches, eq(productionBatches.id, inventoryMovements.productionBatchId))
      .where(where)
      .orderBy(desc(inventoryMovements.createdAt), desc(inventoryMovements.id))
      .limit(limit)
      .offset(offset),
    db
      .select({ c: count() })
      .from(inventoryMovements)
      .innerJoin(stockItems, eq(stockItems.id, inventoryMovements.stockItemId))
      // Той самий join, що й у переліку: фільтри моделі/кольору стосуються варіанта.
      .leftJoin(productVariants, eq(productVariants.id, stockItems.variantId))
      .where(where),
  ]);
  return {
    total: Number(totalRow?.c ?? 0),
    rows: rows.map((r) => ({
      id: r.m.id,
      createdAt: r.m.createdAt,
      type: r.m.type as MovementType,
      warehouseId: r.m.warehouseId,
      stockItemId: r.m.stockItemId,
      itemKind: r.itemKind,
      title: r.productTitle ?? r.materialName ?? "—",
      variantTitle: r.itemKind === "product" ? r.variantTitle : null,
      sku: r.itemKind === "product" ? r.sku : r.materialCode,
      onHandDelta: r.m.onHandDelta,
      reservedDelta: r.m.reservedDelta,
      defectiveDelta: r.m.defectiveDelta,
      inProductionDelta: r.m.inProductionDelta,
      orderId: r.m.orderId,
      orderNumber: r.orderNumber,
      orderLineItemId: r.m.orderLineItemId,
      productionBatchId: r.m.productionBatchId,
      batchNumber: r.batchNumber,
      packingId: r.m.packingId,
      reason: r.m.reason,
      note: r.m.note,
      actorId: r.m.actorId,
      actorName: r.m.actorName,
      shopifySyncState: r.m.shopifySyncState,
      unitCost: opts.includeCosts ? r.m.unitCost : null,
      costCurrency: opts.includeCosts ? r.m.costCurrency : null,
    })),
  };
}
