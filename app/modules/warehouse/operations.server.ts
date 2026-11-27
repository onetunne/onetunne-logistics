/**
 * Складські операції людей (сторінки «Склад», у майбутньому — команди Telegram і асистент): надходження,
 * інвентаризація, брак (позначення / ремонт / списання), пороги «мало», масові дії.
 *
 * Правила (docs/stage5-design.md §1, §11):
 * - одна логічна операція = ОДИН виклик applyMovements в ОДНІЙ транзакції (масова інвентаризація — теж один виклик);
 * - ключ ідемпотентності — `manual:<uuid форми>` (inventoryKeys.manual): uuid генерується під час відкриття форми
 *   (newOperationId у loader), тож подвійне надсилання тієї самої форми не створює другого руху (повтор → replay);
 *   той самий uuid для ІНШОЇ операції (інша позиція/тип/кількість) → warehouse.error.operationReused;
 * - «встановити значення» (інвентаризація): lockBalances → дельта від поточного on_hand → applyMovements у тій самій
 *   транзакції. Необов'язковий expectedOnHand (значення, яке бачив працівник) — порівняння зі станом під блокуванням:
 *   якщо залишок змінився (напр. передано посилку) і підрахунок не збігається з поточним — warehouse.error.stocktakeChanged
 *   (нічого не записано; працівник перевіряє підрахунок і надсилає ще раз). Підрахунок без змін теж записується
 *   (рух із нульовою дельтою, причина stocktake) — видно, коли позицію рахували;
 * - повтор інвентаризації (той самий uuid форми) — це повтор, лише якщо пораховане збігається з поточним on_hand під
 *   блокуванням (саме його й встановив перший запис, якщо після нього нічого не змінилося). Інше значення (виправлений
 *   підрахунок у вже збереженій формі, або залишок змінився після збереження) → StocktakeAlreadySavedError, нічого не
 *   записано: виправлення мовчки не відкидається, а працівник отримує нову форму (новий uuid). Окремо пораховане значення
 *   в рухові не зберігається (схема: лише дельти), тому порівнюємо з поточним станом — це суворіше, але безпечно;
 * - рухи зі станом shopify_sync_state = pending (внутрішні зміни on_hand відкритого товару, warehouse.shopifyPush =
 *   'deltas') → останнім кроком ТІЄЇ САМОЇ транзакції ставиться завдання inventory.push (enqueueInventoryPushIfPending:
 *   одне очікуване завдання на всіх; наявне блокується до фіксації, тож обробник не візьме його, не бачачи нових рухів);
 * - повернення покупця (customer_return): Shopify сам поповнює «доступно», коли повернення/відшкодування оформлено з
 *   поверненням на склад (restock). Тому таке надходження за замовчуванням НЕ надсилається (skipped) — інакше в Shopify
 *   +2q. Надіслати можна явним вибором (restockedInShopify: false — повернення оформлено в Shopify без поповнення).
 *   Якщо помилитися з вибором, звірка покаже розбіжність (docs/stage5-design.md §10).
 *   Пошкоджені одиниці такого повернення Shopify теж поповнив як доступні, тож для товару вони записуються як
 *   «повернено й поповнено Shopify, потім позначено браком»: надходження on_hand + (якісні + пошкоджені), skipped, і
 *   окремий рух defect_mark (ключ manual:<uuid>:return_defect) on_hand − пошкоджені, defective + пошкоджені — його дельта
 *   надсилається в Shopify як звичайне позначення браку (available − пошкоджені, рівно один раз: ключ руху й
 *   @idempotent передачі). Облік повернень (inventory-sync/returns.server.ts) рахує on_hand надходжень — тобто всі
 *   одиниці, які Shopify поповнює сам, — і звірка сходиться без ручного виправлення. Якщо ж у Shopify на склад
 *   повернули лише якісні одиниці (пошкоджені не відшкодовано або відшкодовано без поповнення) — явний вибір
 *   damagedRestockedInShopify: false: одне надходження без розділення (on_hand + якісні, defective + пошкоджені), у
 *   Shopify нічого не знімається (там цих одиниць і не додавали);
 * - дозволи перевіряються тут (сервер): надходження/позначення браку/ремонт — warehouse.receive; інвентаризація,
 *   списання браку, пороги — warehouse.adjust; собівартість надходження — лише finance.view;
 * - примітки — без персональних даних: телефони, email, номери карток/IBAN маскуються (privacy/redact).
 *
 * Невідкритий товар (облік ще не ініціалізовано): ці операції дозволені й лишаються внутрішніми (не надсилаються в
 * Shopify); при відкритті вони ДОДАЮТЬСЯ до знімка Shopify і власник отримує розбіжність на перевірку (opening.server.ts).
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { DbOrTx, Tx } from "~/db/client.server";
import { inventoryMovements, orders, stockItems, type ShopifySyncState, type StockItemKind } from "~/db/schema";
import { ForbiddenError, can, requirePermission, type Permission } from "~/domain/permissions";
import { DomainError, NotFoundError } from "~/lib/errors";
import { fromMinor, isDecimalString, toMinor } from "~/lib/money";
import { writeAudit } from "~/modules/audit/audit.server";
import { inventoryKeys } from "~/modules/inventory/keys";
import {
  applyMovements,
  evaluateStockAlerts,
  lockBalances,
  lockExistingBalances,
  movementOptionsFor,
  setLowStockThreshold as ledgerSetLowStockThreshold,
  type AppliedMovement,
  type BalanceState,
  type MovementInput,
  type OpenedAlert,
} from "~/modules/inventory/ledger.server";
import type { MovementType } from "~/modules/inventory/movement-types";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import { enqueueInventoryPushIfPending } from "~/modules/inventory-sync/schedule.server";
import { maskFreeTextNote } from "~/modules/privacy/notes";
import type { ServiceContext } from "~/server/types";
import {
  DEFECT_REASONS,
  MAX_BULK_ITEMS,
  MAX_COUNTED_QUANTITY,
  MAX_NOTE_LENGTH,
  MAX_OPERATION_QUANTITY,
  MAX_THRESHOLD,
  OPERATION_ID_RE,
  RECEIPT_REASONS,
  REPAIR_REASON,
  SHOPIFY_RESTOCK_REASONS,
  STOCKTAKE_REASON,
  WRITE_OFF_REASONS,
  type DefectReason,
  type ReceiptReason,
  type WriteOffReason,
} from "./constants";

/** Новий uuid форми/команди (ключ ідемпотентності manual:<uuid>). Викликати в loader під час відкриття форми. */
export function newOperationId(): string {
  return randomUUID();
}

/** Дозвіл, потрібний для кожної операції (для інтерфейсу й сервісного шару команд). */
export const OPERATION_PERMISSIONS = {
  receiveStock: "warehouse.receive",
  markDefective: "warehouse.receive",
  repairDefective: "warehouse.receive",
  writeOffDefective: "warehouse.adjust",
  adjustToCount: "warehouse.adjust",
  stocktake: "warehouse.adjust",
  setLowStockThreshold: "warehouse.adjust",
  setLowStockThresholds: "warehouse.adjust",
} as const satisfies Record<string, Permission>;

export interface OperationResult {
  /** true — повтор тієї самої форми: рух уже був записаний раніше, залишок не змінено вдруге. */
  replay: boolean;
  movementId: string;
  stockItemId: string;
  type: MovementType;
  /** Баланс позиції після операції (на складі за замовчуванням). */
  balance: BalanceState;
  /** Попередження, відкриті цією операцією (для сповіщень). */
  openedAlerts: OpenedAlert[];
  /** Стан передачі руху в Shopify (none — не надсилається ніколи; pending — у черзі; skipped — не надсилається). */
  shopifySyncState: ShopifySyncState;
  /** true — рух чекає передачі в Shopify, завдання inventory.push поставлено в чергу. */
  shopifyPushQueued: boolean;
  /**
   * Лише надходження повернення покупця, яке Shopify поповнив сам, з пошкодженими одиницями (товар): окремий рух браку,
   * що знімає їх з on_hand (і з «доступно» Shopify, якщо передача діє — shopifySyncState pending).
   */
  returnDefect?: { movementId: string; quantity: number; shopifySyncState: ShopifySyncState };
}

interface CommonInput {
  /** uuid форми (newOperationId). */
  operationId: string;
  stockItemId: string;
  /** Примітка без персональних даних (до 500 символів). */
  note?: string | null;
}

export interface ReceiveStockInput extends CommonInput {
  /** Якісні одиниці (on_hand +). */
  quantity: number;
  /** Одиниці, що надійшли пошкодженими (defective +), напр. повернення покупця з дефектом. */
  defectiveQuantity?: number;
  reason: ReceiptReason;
  /** Пов'язане замовлення (повернення покупця). */
  orderId?: string | null;
  /**
   * Лише для причин SHOPIFY_RESTOCK_REASONS (повернення покупця): true (за замовчуванням) — Shopify поповнює залишок
   * сам під час оформлення повернення (restock) — усі одиниці, також пошкоджені, — тож надходження в Shopify НЕ
   * надсилається (skipped), а пошкоджені одиниці товару знімаються з «доступно» Shopify окремим рухом браку (див. вгорі
   * файлу); false — повернення в Shopify оформлено без поповнення: якісні одиниці надсилаються дельтою, як звичайне
   * надходження, пошкоджені — одразу в брак. Для інших причин ігнорується.
   */
  restockedInShopify?: boolean;
  /**
   * Лише разом із restockedInShopify (не false): чи Shopify поповнив також пошкоджені одиниці. true (за замовчуванням) —
   * усе повернення поповнено, пошкоджені знімаються з «доступно» Shopify окремим рухом браку; false — у Shopify на склад
   * повернули лише якісні одиниці (пошкоджені не відшкодовано або відшкодовано без поповнення): одне надходження без
   * розділення, пошкоджені — одразу в брак, у Shopify нічого не надсилається. Повтор форми з іншим вибором — повтор
   * (записано, як у першому надсиланні).
   */
  damagedRestockedInShopify?: boolean;
  /** Собівартість одиниці ("12.50") — лише з finance.view; разом із costCurrency. */
  unitCost?: string | null;
  costCurrency?: string | null;
}

export interface MarkDefectiveInput extends CommonInput {
  quantity: number;
  reason: DefectReason;
  orderId?: string | null;
}

export interface RepairDefectiveInput extends CommonInput {
  quantity: number;
}

export interface WriteOffDefectiveInput extends CommonInput {
  quantity: number;
  reason: WriteOffReason;
}

export interface AdjustToCountInput extends CommonInput {
  /** Фактично пораховано (новий on_hand). */
  countedOnHand: number;
  /** on_hand, який бачив працівник, відкриваючи форму (перевірка «залишок змінився, поки рахували»). */
  expectedOnHand?: number | null;
}

export interface AdjustToCountResult extends OperationResult {
  /** on_hand до інвентаризації (null для повтору). */
  previousOnHand: number | null;
  countedOnHand: number;
  /** Записана дельта on_hand (0 — підрахунок збігся). */
  delta: number;
}

export interface StocktakeCount {
  stockItemId: string;
  countedOnHand: number;
  expectedOnHand?: number | null;
}

export interface StocktakeInput {
  operationId: string;
  counts: StocktakeCount[];
  note?: string | null;
}

export interface StocktakeLineResult {
  stockItemId: string;
  movementId: string;
  previousOnHand: number;
  countedOnHand: number;
  delta: number;
}

export interface StocktakeResult {
  /** true — усі позиції вже були записані цією формою раніше (повторне надсилання). */
  replay: boolean;
  applied: StocktakeLineResult[];
  /** Позиції, уже записані цією формою раніше (не змінювалися). */
  replayed: string[];
  changed: number;
  unchanged: number;
  unitsAdded: number;
  unitsRemoved: number;
  openedAlerts: OpenedAlert[];
  /** true — частина рухів чекає передачі в Shopify (завдання inventory.push у черзі). */
  shopifyPushQueued: boolean;
}

export interface StocktakeConflict {
  stockItemId: string;
  expectedOnHand: number;
  currentOnHand: number;
  countedOnHand: number;
}

/** Масова інвентаризація: залишок частини позицій змінився, поки рахували (нічого не записано). */
export class StocktakeConflictError extends DomainError {
  constructor(readonly conflicts: StocktakeConflict[]) {
    const first = conflicts[0];
    super(conflicts.length === 1 && first ? "warehouse.error.stocktakeChanged" : "warehouse.error.stocktakeChangedMany", 409, {
      count: conflicts.length,
      expected: first?.expectedOnHand ?? 0,
      current: first?.currentOnHand ?? 0,
      counted: first?.countedOnHand ?? 0,
    });
    this.name = "StocktakeConflictError";
  }
}

export interface StocktakeAlreadySaved {
  stockItemId: string;
  /** on_hand зараз (під блокуванням). */
  currentOnHand: number;
  /** Пораховане в повторному надсиланні. */
  countedOnHand: number;
}

/**
 * Форму інвентаризації (uuid) уже збережено, а повторне надсилання містить інше значення, ніж зараз в обліку
 * (виправлений підрахунок у вже збереженій формі або залишок змінився після збереження). Нічого не записано.
 */
export class StocktakeAlreadySavedError extends DomainError {
  constructor(
    readonly items: StocktakeAlreadySaved[],
    variant: "count" | "sheet",
  ) {
    const first = items[0];
    super(variant === "count" ? "warehouse.error.countAlreadySaved" : "warehouse.error.sheetAlreadySaved", 409, {
      count: items.length,
      current: first?.currentOnHand ?? 0,
      counted: first?.countedOnHand ?? 0,
    });
    this.name = "StocktakeAlreadySavedError";
  }
}

// ---------------------------------------------------------------------------
// Перевірка введення
// ---------------------------------------------------------------------------

function manualKey(operationId: string, suffix?: string): string {
  if (typeof operationId !== "string" || !OPERATION_ID_RE.test(operationId)) {
    throw new DomainError("warehouse.error.operationId", 400);
  }
  return inventoryKeys.manual(operationId.toLowerCase(), suffix);
}

function assertUuid(value: string, entity: string): string {
  if (typeof value !== "string" || !OPERATION_ID_RE.test(value)) throw new NotFoundError(entity);
  return value.toLowerCase();
}

function assertQuantity(value: number, field: string, min = 1, max = MAX_OPERATION_QUANTITY): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new DomainError("warehouse.error.quantity", 400, { field, min, max });
  }
  return value;
}

function assertReason<T extends string>(value: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(value)) throw new DomainError("warehouse.error.reason", 400);
  return value as T;
}

/** Примітка: обрізана, без телефонів/email/карток/IBAN; порожня → null (спільне правило privacy/notes). */
export function cleanNote(note: string | null | undefined): string | null {
  return maskFreeTextNote(note, MAX_NOTE_LENGTH);
}

/** Собівартість одиниці: десятковий рядок ≥ 0 (кома або крапка), до 12 цифр; валюта ISO 4217. */
export function normalizeUnitCost(unitCost: string, currency: string | null | undefined): { unitCost: string; costCurrency: string } {
  const raw = unitCost.trim().replace(",", ".");
  if (!isDecimalString(raw) || raw.startsWith("-")) throw new DomainError("warehouse.error.unitCost", 400);
  const minor = toMinor(raw);
  if (minor < 0n || minor > 99_999_999_999_999n) throw new DomainError("warehouse.error.unitCost", 400);
  const code = (currency ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new DomainError("warehouse.error.currency", 400);
  return { unitCost: fromMinor(minor), costCurrency: code };
}

async function loadStockItemKind(tx: Tx, stockItemId: string): Promise<StockItemKind> {
  const [row] = await tx.select({ kind: stockItems.kind }).from(stockItems).where(eq(stockItems.id, stockItemId));
  if (!row) throw new NotFoundError("stockItem");
  return row.kind;
}

async function assertOrderExists(tx: Tx, orderId: string): Promise<void> {
  const [row] = await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId));
  if (!row) throw new DomainError("warehouse.error.orderNotFound", 404);
}

type ExistingMovement = Pick<
  typeof inventoryMovements.$inferSelect,
  | "id"
  | "idempotencyKey"
  | "stockItemId"
  | "type"
  | "onHandDelta"
  | "defectiveDelta"
  | "reservedDelta"
  | "inProductionDelta"
  | "shopifySyncState"
>;

async function findMovementsByKeys(tx: DbOrTx, keys: readonly string[]): Promise<Map<string, ExistingMovement>> {
  if (keys.length === 0) return new Map();
  const rows = await tx
    .select({
      id: inventoryMovements.id,
      idempotencyKey: inventoryMovements.idempotencyKey,
      stockItemId: inventoryMovements.stockItemId,
      type: inventoryMovements.type,
      onHandDelta: inventoryMovements.onHandDelta,
      defectiveDelta: inventoryMovements.defectiveDelta,
      reservedDelta: inventoryMovements.reservedDelta,
      inProductionDelta: inventoryMovements.inProductionDelta,
      shopifySyncState: inventoryMovements.shopifySyncState,
    })
    .from(inventoryMovements)
    .where(inArray(inventoryMovements.idempotencyKey, [...keys]));
  return new Map(rows.map((r) => [r.idempotencyKey, r]));
}

function operationReused(): DomainError {
  return new DomainError("warehouse.error.operationReused", 409);
}

/** Суфікс ключа руху браку для пошкоджених одиниць повернення, яке Shopify поповнив сам (manual:<uuid>:return_defect). */
export const RETURN_DEFECT_KEY_SUFFIX = "return_defect";

/**
 * Записані рухи надходження з uuid форми — та сама операція (якісні/пошкоджені одиниці тієї самої позиції)? Приймаються
 * обидва записи: без розділення (надходження on_hand + якісні, defective + пошкоджені; також записані до розділення) і з
 * розділенням (надходження on_hand + якісні + пошкоджені і рух браку on_hand − пошкоджені, defective + пошкоджені).
 */
function isSameReceipt(
  receipt: ExistingMovement | undefined,
  defect: ExistingMovement | undefined,
  stockItemId: string,
  good: number,
  damaged: number,
): boolean {
  if (!receipt || receipt.stockItemId !== stockItemId || receipt.type !== "receipt_manual") return false;
  if (receipt.reservedDelta !== 0 || receipt.inProductionDelta !== 0) return false;
  const split = defect ? defect.defectiveDelta : 0;
  if (
    defect &&
    (defect.stockItemId !== stockItemId || defect.type !== "defect_mark" || split <= 0 || defect.onHandDelta !== -split)
  ) {
    return false;
  }
  return receipt.onHandDelta - split === good && receipt.defectiveDelta + split === damaged;
}

/**
 * Чи вже записано надходження з цим uuid (для попереднього перегляду команд, commands.server.ts): none — ні;
 * same — так, та сама операція (повтор нічого не змінить); other — uuid уже використано для іншої операції.
 */
export async function recordedReceiptState(
  db: DbOrTx,
  input: { operationId: string; stockItemId: string; quantity: number; defectiveQuantity?: number },
): Promise<"none" | "same" | "other"> {
  const key = manualKey(input.operationId);
  const defectKey = manualKey(input.operationId, RETURN_DEFECT_KEY_SUFFIX);
  const existing = await findMovementsByKeys(db, [key, defectKey]);
  if (existing.size === 0) return "none";
  const same = isSameReceipt(existing.get(key), existing.get(defectKey), input.stockItemId.toLowerCase(), input.quantity, input.defectiveQuantity ?? 0);
  return same ? "same" : "other";
}


// ---------------------------------------------------------------------------
// Операції з дельтою (надходження, брак)
// ---------------------------------------------------------------------------

interface DeltaSpec {
  permission: Permission;
  audit: string;
  operationId: string;
  stockItemId: string;
  type: MovementType;
  onHandDelta: number;
  defectiveDelta: number;
  reason: string;
  note?: string | null;
  orderId?: string | null;
  unitCost?: string | null;
  costCurrency?: string | null;
  /** true — Shopify уже врахував цю зміну сам (повернення з поповненням): рух товару не надсилається (skipped). */
  shopifyAlreadyApplied?: boolean;
  /**
   * Лише надходження з shopifyAlreadyApplied: скільки з defectiveDelta — пошкоджені одиниці, які Shopify поповнив як
   * доступні. Для товару вони записуються в on_hand надходження і окремим рухом браку (ключ manual:<uuid>:return_defect)
   * переходять у брак — його −дельта on_hand надсилається в Shopify (див. вгорі файлу). Для матеріалу — без розділення.
   */
  restockedDefective?: number;
}

async function applyDeltaOperation(ctx: ServiceContext, spec: DeltaSpec): Promise<OperationResult> {
  requirePermission(ctx.actor, spec.permission);
  const key = manualKey(spec.operationId);
  const defectKey = manualKey(spec.operationId, RETURN_DEFECT_KEY_SUFFIX);
  const stockItemId = assertUuid(spec.stockItemId, "stockItem");
  const orderId = spec.orderId ? assertUuid(spec.orderId, "order") : null;
  const note = cleanNote(spec.note);
  const isReceipt = spec.type === "receipt_manual";
  /** Записані рухи з цим uuid — та сама операція (повтор)? */
  const sameAs = (existing: Map<string, ExistingMovement>): boolean => {
    if (isReceipt) return isSameReceipt(existing.get(key), existing.get(defectKey), stockItemId, spec.onHandDelta, spec.defectiveDelta);
    const m = existing.get(key);
    return Boolean(
      m && m.stockItemId === stockItemId && m.type === spec.type && m.onHandDelta === spec.onHandDelta && m.defectiveDelta === spec.defectiveDelta,
    );
  };
  const replayOf = (existing: Map<string, ExistingMovement>, balance: BalanceState): OperationResult => {
    const m = existing.get(key)!;
    const defect = isReceipt ? existing.get(defectKey) : undefined;
    return {
      replay: true,
      movementId: m.id,
      stockItemId,
      type: spec.type,
      balance,
      openedAlerts: [],
      shopifySyncState: m.shopifySyncState,
      shopifyPushQueued: false,
      ...(defect ? { returnDefect: { movementId: defect.id, quantity: defect.defectiveDelta, shopifySyncState: defect.shopifySyncState } } : {}),
    };
  };
  return ctx.db.transaction(async (tx): Promise<OperationResult> => {
    const kind = await loadStockItemKind(tx, stockItemId);
    if (orderId) await assertOrderExists(tx, orderId);
    const warehouse = await getDefaultWarehouse(tx);
    // Пошкоджені одиниці повернення, яке Shopify поповнив сам: у надходження (як у Shopify), потім — у брак окремим рухом.
    const split =
      isReceipt && spec.shopifyAlreadyApplied === true && kind === "product"
        ? Math.min(Math.max(0, spec.restockedDefective ?? 0), spec.defectiveDelta)
        : 0;
    const onHandDelta = spec.onHandDelta + split;
    const defectiveDelta = spec.defectiveDelta - split;
    // Перевизначення лише там, де рух узагалі міг би піти в Shopify (товар, зміна on_hand); інакше — правило ядра (none).
    const skipPush = spec.shopifyAlreadyApplied === true && kind === "product" && onHandDelta !== 0;
    const inputs: MovementInput[] = [
      {
        warehouseId: warehouse.id,
        stockItemId,
        type: spec.type,
        idempotencyKey: key,
        onHandDelta,
        defectiveDelta,
        reason: spec.reason,
        note,
        orderId,
        unitCost: spec.unitCost ?? null,
        costCurrency: spec.unitCost ? (spec.costCurrency ?? null) : null,
        ...(skipPush ? { shopifySyncState: "skipped" as const } : {}),
      },
    ];
    if (split > 0) {
      // Стан передачі — за правилом ядра: pending (передача діє, товар відкрито) → Shopify available − пошкоджені.
      inputs.push({
        warehouseId: warehouse.id,
        stockItemId,
        type: "defect_mark",
        idempotencyKey: defectKey,
        onHandDelta: -split,
        defectiveDelta: split,
        reason: spec.reason,
        note,
        orderId,
      });
      // Повтор перевіряється ДО запису, під блокуванням балансу (повтори тієї самої позиції серіалізовані): інакше
      // повтор форми, записаної без розділення (до цієї зміни), дописав би рух браку другим надсиланням.
      const locked = await lockBalances(tx, [{ warehouseId: warehouse.id, stockItemId }]);
      const existing = await findMovementsByKeys(tx, [key, defectKey]);
      if (existing.size > 0) {
        if (!sameAs(existing)) throw operationReused();
        return replayOf(existing, [...locked.values()][0]!);
      }
    }
    const res = await applyMovements(tx, ctx.actor, inputs, movementOptionsFor(ctx));
    const balance = res.balances.find((b) => b.stockItemId === stockItemId)!;
    if (res.applied.length === 0) {
      const existing = await findMovementsByKeys(tx, isReceipt ? [key, defectKey] : [key]);
      if (!sameAs(existing)) throw operationReused();
      return replayOf(existing, balance);
    }
    // Частковий запис (ключ одного з рухів уже використано іншою операцією) — відкат усієї операції.
    if (res.applied.length !== inputs.length) throw operationReused();
    const applied = res.applied.find((a) => a.idempotencyKey === key)!;
    const defect = res.applied.find((a) => a.idempotencyKey === defectKey);
    await writeAudit(
      tx,
      ctx.actor,
      spec.audit,
      { type: "stock_item", id: stockItemId },
      {
        movementId: applied.id,
        movementType: spec.type,
        onHandDelta: spec.onHandDelta,
        defectiveDelta: spec.defectiveDelta,
        reason: spec.reason,
        orderId,
        withCost: Boolean(spec.unitCost),
        shopifySyncState: applied.shopifySyncState,
        ...(skipPush ? { shopifyAlreadyApplied: true } : {}),
        ...(defect ? { returnDefect: { movementId: defect.id, quantity: split, shopifySyncState: defect.shopifySyncState } } : {}),
      },
    );
    // Останнім кроком транзакції (після цього — лише фіксація): очікування на рядок черги не тримає інших блокувань довше.
    const pushQueued = await enqueueInventoryPushIfPending(tx, res.applied);
    return {
      replay: false,
      movementId: applied.id,
      stockItemId,
      type: spec.type,
      balance,
      openedAlerts: res.openedAlerts,
      shopifySyncState: applied.shopifySyncState,
      shopifyPushQueued: pushQueued,
      ...(defect ? { returnDefect: { movementId: defect.id, quantity: split, shopifySyncState: defect.shopifySyncState } } : {}),
    };
  });
}

/**
 * Надходження без партії (повернення покупця, закупівля, знахідка): on_hand + якісні, defective + пошкоджені.
 * Дозвіл warehouse.receive; собівартість — лише finance.view (інакше ForbiddenError).
 * Повернення покупця за замовчуванням не надсилається в Shopify (Shopify поповнює сам) — див. restockedInShopify;
 * його пошкоджені одиниці товару — надходження + рух браку (returnDefect у результаті), див. вгорі файлу.
 */
export async function receiveStock(ctx: ServiceContext, input: ReceiveStockInput): Promise<OperationResult> {
  requirePermission(ctx.actor, OPERATION_PERMISSIONS.receiveStock);
  const good = assertQuantity(input.quantity, "quantity", 0);
  const damaged = assertQuantity(input.defectiveQuantity ?? 0, "defectiveQuantity", 0);
  if (good + damaged < 1 || good + damaged > MAX_OPERATION_QUANTITY) {
    throw new DomainError("warehouse.error.quantity", 400, { field: "quantity", min: 1, max: MAX_OPERATION_QUANTITY });
  }
  const reason = assertReason(input.reason, RECEIPT_REASONS);
  let cost: { unitCost: string; costCurrency: string } | null = null;
  if (input.unitCost != null && input.unitCost.trim() !== "") {
    if (!can(ctx.actor, "finance.view")) throw new ForbiddenError("finance.view");
    cost = normalizeUnitCost(input.unitCost, input.costCurrency);
  }
  const restocked = isShopifyRestockReason(reason) && input.restockedInShopify !== false;
  return applyDeltaOperation(ctx, {
    permission: OPERATION_PERMISSIONS.receiveStock,
    audit: "inventory.received",
    operationId: input.operationId,
    stockItemId: input.stockItemId,
    type: "receipt_manual",
    onHandDelta: good,
    defectiveDelta: damaged,
    reason,
    note: input.note,
    orderId: input.orderId,
    unitCost: cost?.unitCost ?? null,
    costCurrency: cost?.costCurrency ?? null,
    shopifyAlreadyApplied: restocked,
    // Shopify поповнив і пошкоджені одиниці: для товару — надходження + окремий рух браку (див. вгорі файлу); якщо
    // лише якісні (damagedRestockedInShopify: false) — без розділення, у Shopify пошкоджених і не додавали.
    restockedDefective: restocked && input.damagedRestockedInShopify !== false ? damaged : 0,
  });
}

/** Причина, для якої Shopify сам поповнює залишок (повернення покупця з поверненням на склад). */
export function isShopifyRestockReason(reason: string): boolean {
  return (SHOPIFY_RESTOCK_REASONS as readonly string[]).includes(reason);
}

/** Позначити брак: on_hand → defective (пошкоджено на складі / повернення покупця / виробничий дефект). warehouse.receive. */
export async function markDefective(ctx: ServiceContext, input: MarkDefectiveInput): Promise<OperationResult> {
  requirePermission(ctx.actor, OPERATION_PERMISSIONS.markDefective);
  const quantity = assertQuantity(input.quantity, "quantity");
  return applyDeltaOperation(ctx, {
    permission: OPERATION_PERMISSIONS.markDefective,
    audit: "inventory.defect_marked",
    operationId: input.operationId,
    stockItemId: input.stockItemId,
    type: "defect_mark",
    onHandDelta: -quantity,
    defectiveDelta: quantity,
    reason: assertReason(input.reason, DEFECT_REASONS),
    note: input.note,
    orderId: input.orderId,
  });
}

/** Брак відремонтовано: defective → on_hand (знову в продажу). warehouse.receive. */
export async function repairDefective(ctx: ServiceContext, input: RepairDefectiveInput): Promise<OperationResult> {
  requirePermission(ctx.actor, OPERATION_PERMISSIONS.repairDefective);
  const quantity = assertQuantity(input.quantity, "quantity");
  return applyDeltaOperation(ctx, {
    permission: OPERATION_PERMISSIONS.repairDefective,
    audit: "inventory.defect_repaired",
    operationId: input.operationId,
    stockItemId: input.stockItemId,
    type: "defect_repair",
    onHandDelta: quantity,
    defectiveDelta: -quantity,
    reason: REPAIR_REASON,
    note: input.note,
  });
}

/** Списати брак (утилізація, повернення виробнику, втрата): defective −. warehouse.adjust. */
export async function writeOffDefective(ctx: ServiceContext, input: WriteOffDefectiveInput): Promise<OperationResult> {
  requirePermission(ctx.actor, OPERATION_PERMISSIONS.writeOffDefective);
  const quantity = assertQuantity(input.quantity, "quantity");
  return applyDeltaOperation(ctx, {
    permission: OPERATION_PERMISSIONS.writeOffDefective,
    audit: "inventory.defect_written_off",
    operationId: input.operationId,
    stockItemId: input.stockItemId,
    type: "defect_writeoff",
    onHandDelta: 0,
    defectiveDelta: -quantity,
    reason: assertReason(input.reason, WRITE_OFF_REASONS),
    note: input.note,
  });
}

// ---------------------------------------------------------------------------
// Інвентаризація («встановити значення»)
// ---------------------------------------------------------------------------

interface PreparedCount {
  stockItemId: string;
  key: string;
  countedOnHand: number;
  expectedOnHand: number | null;
}

/**
 * Спільне ядро інвентаризації: блокування балансів → повтори → перевірка «змінилося» → один applyMovements.
 * Викликати в транзакції.
 */
async function applyCounts(
  tx: Tx,
  ctx: ServiceContext,
  counts: readonly PreparedCount[],
  note: string | null,
  variant: "count" | "sheet",
): Promise<{
  lines: StocktakeLineResult[];
  replayed: ExistingMovement[];
  balances: BalanceState[];
  openedAlerts: OpenedAlert[];
  applied: AppliedMovement[];
}> {
  const warehouse = await getDefaultWarehouse(tx);
  const found = await tx
    .select({ id: stockItems.id })
    .from(stockItems)
    .where(
      inArray(
        stockItems.id,
        counts.map((c) => c.stockItemId),
      ),
    );
  if (found.length !== counts.length) throw new NotFoundError("stockItem");
  const locked = await lockBalances(
    tx,
    counts.map((c) => ({ warehouseId: warehouse.id, stockItemId: c.stockItemId })),
  );
  const byItem = new Map([...locked.values()].map((b) => [b.stockItemId, b]));
  const existing = await findMovementsByKeys(
    tx,
    counts.map((c) => c.key),
  );

  const replayed: ExistingMovement[] = [];
  const pending: PreparedCount[] = [];
  const alreadySaved: StocktakeAlreadySaved[] = [];
  for (const c of counts) {
    const prior = existing.get(c.key);
    if (prior) {
      if (prior.stockItemId !== c.stockItemId || prior.type !== "adjustment") throw operationReused();
      // Повтор лише тоді, коли повторне значення й зараз відповідає обліку (див. вгорі файлу).
      const current = byItem.get(c.stockItemId)!.onHand;
      if (current !== c.countedOnHand) {
        alreadySaved.push({ stockItemId: c.stockItemId, currentOnHand: current, countedOnHand: c.countedOnHand });
      }
      replayed.push(prior);
    } else {
      pending.push(c);
    }
  }
  if (alreadySaved.length > 0) throw new StocktakeAlreadySavedError(alreadySaved, variant);

  const conflicts: StocktakeConflict[] = [];
  for (const c of pending) {
    const current = byItem.get(c.stockItemId)!.onHand;
    if (c.expectedOnHand !== null && current !== c.expectedOnHand && current !== c.countedOnHand) {
      conflicts.push({
        stockItemId: c.stockItemId,
        expectedOnHand: c.expectedOnHand,
        currentOnHand: current,
        countedOnHand: c.countedOnHand,
      });
    }
  }
  if (conflicts.length > 0) throw new StocktakeConflictError(conflicts);

  const inputs = pending.map((c): MovementInput => ({
    warehouseId: warehouse.id,
    stockItemId: c.stockItemId,
    type: "adjustment",
    idempotencyKey: c.key,
    onHandDelta: c.countedOnHand - byItem.get(c.stockItemId)!.onHand,
    reason: STOCKTAKE_REASON,
    note,
  }));
  const res = await applyMovements(tx, ctx.actor, inputs, movementOptionsFor(ctx));
  // Під блокуванням інша транзакція не могла вставити рух із цим ключем — кожен рух записано.
  if (res.applied.length !== inputs.length) throw operationReused();
  const movementByKey = new Map(res.applied.map((a) => [a.idempotencyKey, a.id]));
  const lines = pending.map((c): StocktakeLineResult => {
    const previous = byItem.get(c.stockItemId)!.onHand;
    return {
      stockItemId: c.stockItemId,
      movementId: movementByKey.get(c.key)!,
      previousOnHand: previous,
      countedOnHand: c.countedOnHand,
      delta: c.countedOnHand - previous,
    };
  });
  const balances = new Map<string, BalanceState>([...byItem]);
  for (const b of res.balances) balances.set(b.stockItemId, b);
  return { lines, replayed, balances: [...balances.values()], openedAlerts: res.openedAlerts, applied: res.applied };
}

function prepareCount(c: StocktakeCount, key: string): PreparedCount {
  const counted = assertQuantity(c.countedOnHand, "countedOnHand", 0, MAX_COUNTED_QUANTITY);
  let expected: number | null = null;
  if (c.expectedOnHand !== undefined && c.expectedOnHand !== null) {
    if (!Number.isSafeInteger(c.expectedOnHand))
      throw new DomainError("warehouse.error.quantity", 400, { field: "expectedOnHand", min: 0, max: MAX_COUNTED_QUANTITY });
    expected = c.expectedOnHand;
  }
  return { stockItemId: assertUuid(c.stockItemId, "stockItem"), key, countedOnHand: counted, expectedOnHand: expected };
}

/**
 * Інвентаризація позиції: on_hand := пораховане (рух adjustment, причина stocktake, дельта від поточного під
 * блокуванням). warehouse.adjust. Див. опис expectedOnHand вгорі файлу.
 */
export async function adjustToCount(ctx: ServiceContext, input: AdjustToCountInput): Promise<AdjustToCountResult> {
  requirePermission(ctx.actor, OPERATION_PERMISSIONS.adjustToCount);
  const prepared = prepareCount(input, manualKey(input.operationId));
  const note = cleanNote(input.note);
  return ctx.db.transaction(async (tx): Promise<AdjustToCountResult> => {
    const { lines, replayed, balances, openedAlerts, applied } = await applyCounts(tx, ctx, [prepared], note, "count");
    const balance = balances.find((b) => b.stockItemId === prepared.stockItemId)!;
    const prior = replayed[0];
    if (prior) {
      return {
        replay: true,
        movementId: prior.id,
        stockItemId: prepared.stockItemId,
        type: "adjustment",
        balance,
        openedAlerts: [],
        shopifySyncState: prior.shopifySyncState,
        shopifyPushQueued: false,
        previousOnHand: null,
        countedOnHand: prepared.countedOnHand,
        delta: prior.onHandDelta,
      };
    }
    const line = lines[0]!;
    const movement = applied[0]!;
    await writeAudit(
      tx,
      ctx.actor,
      "inventory.stocktake",
      { type: "stock_item", id: prepared.stockItemId },
      {
        movementId: line.movementId,
        previousOnHand: line.previousOnHand,
        countedOnHand: line.countedOnHand,
        delta: line.delta,
        shopifySyncState: movement.shopifySyncState,
      },
    );
    const pushQueued = await enqueueInventoryPushIfPending(tx, applied);
    return {
      replay: false,
      movementId: line.movementId,
      stockItemId: prepared.stockItemId,
      type: "adjustment",
      balance,
      openedAlerts,
      shopifySyncState: movement.shopifySyncState,
      shopifyPushQueued: pushQueued,
      previousOnHand: line.previousOnHand,
      countedOnHand: line.countedOnHand,
      delta: line.delta,
    };
  });
}

/**
 * Масова інвентаризація (лист підрахунку): усі позиції — ОДИН виклик applyMovements в одній транзакції
 * (ключі manual:<uuid форми>:<позиція>). Якщо залишок хоч однієї позиції змінився, поки рахували, — нічого не
 * записується (StocktakeConflictError з переліком). warehouse.adjust.
 */
export async function stocktake(ctx: ServiceContext, input: StocktakeInput): Promise<StocktakeResult> {
  requirePermission(ctx.actor, OPERATION_PERMISSIONS.stocktake);
  if (!OPERATION_ID_RE.test(input.operationId ?? "")) throw new DomainError("warehouse.error.operationId", 400);
  if (input.counts.length === 0) throw new DomainError("warehouse.error.noItems", 400);
  if (input.counts.length > MAX_BULK_ITEMS) throw new DomainError("warehouse.error.tooManyItems", 400, { max: MAX_BULK_ITEMS });
  const seen = new Set<string>();
  const prepared = input.counts.map((c) => {
    const id = assertUuid(c.stockItemId, "stockItem");
    if (seen.has(id)) throw new DomainError("warehouse.error.duplicateItem", 400);
    seen.add(id);
    return prepareCount({ ...c, stockItemId: id }, manualKey(input.operationId, id));
  });
  const note = cleanNote(input.note);
  return ctx.db.transaction(async (tx) => {
    const { lines, replayed, openedAlerts, applied } = await applyCounts(tx, ctx, prepared, note, "sheet");
    const changed = lines.filter((l) => l.delta !== 0);
    const result: StocktakeResult = {
      replay: lines.length === 0,
      applied: lines,
      replayed: replayed.map((r) => r.stockItemId),
      changed: changed.length,
      unchanged: lines.length - changed.length,
      unitsAdded: changed.reduce((s, l) => s + Math.max(0, l.delta), 0),
      unitsRemoved: changed.reduce((s, l) => s + Math.max(0, -l.delta), 0),
      openedAlerts,
      shopifyPushQueued: false,
    };
    if (lines.length > 0) {
      await writeAudit(
        tx,
        ctx.actor,
        "inventory.stocktake_bulk",
        { type: "warehouse" },
        {
          items: lines.length,
          changed: result.changed,
          unitsAdded: result.unitsAdded,
          unitsRemoved: result.unitsRemoved,
          replayed: result.replayed.length,
          pendingShopify: applied.filter((a) => a.shopifySyncState === "pending").length,
        },
      );
    }
    result.shopifyPushQueued = await enqueueInventoryPushIfPending(tx, applied);
    return result;
  });
}

// ---------------------------------------------------------------------------
// Пороги «мало на складі»
// ---------------------------------------------------------------------------

function assertThreshold(threshold: number | null): number | null {
  if (threshold === null) return null;
  if (!Number.isSafeInteger(threshold) || threshold < 0 || threshold > MAX_THRESHOLD) {
    throw new DomainError("warehouse.error.threshold", 400, { max: MAX_THRESHOLD });
  }
  return threshold;
}

/** Власний поріг «мало» позиції (null — типовий із налаштувань). Переоцінює попередження. warehouse.adjust. */
export async function setLowStockThreshold(ctx: ServiceContext, input: { stockItemId: string; threshold: number | null }): Promise<void> {
  requirePermission(ctx.actor, OPERATION_PERMISSIONS.setLowStockThreshold);
  const threshold = assertThreshold(input.threshold);
  const stockItemId = assertUuid(input.stockItemId, "stockItem");
  await ctx.db.transaction(async (tx) => {
    await ledgerSetLowStockThreshold(tx, stockItemId, threshold);
    await writeAudit(tx, ctx.actor, "inventory.threshold_set", { type: "stock_item", id: stockItemId }, { threshold });
  });
}

/** Масово: однаковий поріг для вибраних позицій (одне оновлення + одна оцінка попереджень). warehouse.adjust. */
export async function setLowStockThresholds(
  ctx: ServiceContext,
  input: { stockItemIds: readonly string[]; threshold: number | null },
): Promise<{ updated: number; openedAlerts: number; resolvedAlerts: number }> {
  requirePermission(ctx.actor, OPERATION_PERMISSIONS.setLowStockThresholds);
  const threshold = assertThreshold(input.threshold);
  const ids = [...new Set(input.stockItemIds.map((id) => assertUuid(id, "stockItem")))];
  if (ids.length === 0) throw new DomainError("warehouse.error.noItems", 400);
  if (ids.length > MAX_BULK_ITEMS) throw new DomainError("warehouse.error.tooManyItems", 400, { max: MAX_BULK_ITEMS });
  return ctx.db.transaction(async (tx) => {
    // Баланси — першими (порядок блокувань applyMovements): оцінка нижче бачить зафіксований стан і попередження
    // паралельного руху, а не стару версію (інакше лишаються суперечливі «мало» + «немає» до наступного руху).
    await lockExistingBalances(tx, ids);
    const updated = await tx
      .update(stockItems)
      .set({ lowStockThreshold: threshold })
      .where(inArray(stockItems.id, ids))
      .returning({ id: stockItems.id });
    if (updated.length !== ids.length) throw new NotFoundError("stockItem");
    const alerts = await evaluateStockAlerts(tx, ids);
    await writeAudit(tx, ctx.actor, "inventory.threshold_bulk", { type: "warehouse" }, { items: ids.length, threshold });
    return { updated: updated.length, openedAlerts: alerts.opened.length, resolvedAlerts: alerts.resolved.length };
  });
}
