/**
 * Витрата пакувальних матеріалів при підтвердженні пакування (docs/stage5-design.md §5) — для модуля пакування.
 *
 * - Що списується: коробка пакування (1 шт., якщо вказана) + матеріали комплектації замовлення (resolveKitMaterials).
 * - Як: ОДИН виклик applyMovements, тип material_consume (on_hand −q), ключ inventoryKeys.materialConsume(packing,
 *   material) → повтор того самого підтвердження не списує вдруге. Додатково: якщо для пакування вже є хоч один рух
 *   material_consume — повторний виклик нічого не записує (alreadyConsumed), навіть якщо шаблони тим часом змінилися.
 * - Блокування: функція САМА блокує рядок пакування (order_packing, FOR NO KEY UPDATE) до перевірки повтору, далі —
 *   баланси (порядок: пакування → баланси, як вимагає ledger.server.ts). Паралельні повтори того самого підтвердження
 *   чекають на рядку пакування й після звільнення бачать уже записані рухи → alreadyConsumed (а не хибну нестачу).
 *   Якщо викликач уже тримає це блокування (рекомендовано: замовлення → пакування), повторне нічого не змінює.
 *   FOR NO KEY UPDATE не конфліктує з перевіркою зовнішніх ключів (KEY SHARE) під час вставки рухів з packing_id.
 * - Пакування має належати замовленню (input.orderId), інакше packaging.error.packingOrderMismatch (нічого не записано).
 * - Нестача: матеріал не може піти в мінус (правило журналу). За замовчуванням — DomainError
 *   packaging.error.consumeInsufficient (нічого не записано, транзакція викликача придатна — точка збереження).
 *   allowShortage: true — списати наявне (min(потрібно, є)) і повернути нестачу в результаті (shortage > 0):
 *   фізичне пакування не блокується, а нестача видна (попередження out_of_stock відкриває refreshMaterialAlerts).
 */
import { and, count, eq, inArray } from "drizzle-orm";
import type { DbOrTx, Tx } from "~/db/client.server";
import {
  inventoryBalances,
  inventoryMovements,
  orderPacking,
  packagingMaterials,
  stockItems,
  type MaterialUnit,
  type PackagingMaterialKind,
} from "~/db/schema";
import { DomainError, NotFoundError } from "~/lib/errors";
import { inventoryKeys } from "~/modules/inventory/keys";
import {
  applyMovements,
  ensureStockItemForMaterial,
  lockBalances,
  type AppliedMovement,
  type MovementActor,
  type MovementInput,
} from "~/modules/inventory/ledger.server";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import { resolveKitMaterials } from "./kits.server";
import { refreshMaterialAlerts } from "./materials.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PackingMaterialLine {
  materialId: string;
  code: string;
  name: string;
  kind: PackagingMaterialKind;
  unit: MaterialUnit;
  /** Потрібно за коробкою й шаблонами. */
  required: number;
  /** Шаблони комплектації, що дали матеріал (порожньо — лише коробка). */
  templateIds: string[];
  /** Це коробка пакування. */
  isBox: boolean;
  /** Фактичний залишок зараз (до списання). */
  onHand: number;
}

/**
 * Що потрібно покласти/списати для пакування замовлення (без змін у базі) — для чекліста пакувальника.
 * boxMaterialId — коробка пакування (null — без коробки). Порядок: коробка, далі як у resolveKitMaterials.
 */
export async function planPackingMaterials(db: DbOrTx, orderId: string, boxMaterialId: string | null): Promise<PackingMaterialLine[]> {
  const kit = await resolveKitMaterials(db, orderId);
  const lines: PackingMaterialLine[] = [];
  if (boxMaterialId) {
    const [box] = await db.select().from(packagingMaterials).where(eq(packagingMaterials.id, boxMaterialId));
    if (!box) throw new NotFoundError("material");
    const fromKit = kit.find((k) => k.materialId === box.id);
    lines.push({
      materialId: box.id,
      code: box.code,
      name: box.name,
      kind: box.kind,
      unit: box.unit,
      required: 1 + (fromKit?.quantity ?? 0),
      templateIds: fromKit?.templateIds ?? [],
      isBox: true,
      onHand: 0,
    });
  }
  for (const k of kit) {
    if (k.materialId === boxMaterialId) continue;
    lines.push({ materialId: k.materialId, code: k.code, name: k.name, kind: k.kind, unit: k.unit, required: k.quantity, templateIds: k.templateIds, isBox: false, onHand: 0 });
  }
  if (lines.length === 0) return lines;
  const warehouse = await getDefaultWarehouse(db);
  const balances = await db
    .select({ materialId: stockItems.materialId, onHand: inventoryBalances.onHand })
    .from(stockItems)
    .innerJoin(inventoryBalances, and(eq(inventoryBalances.stockItemId, stockItems.id), eq(inventoryBalances.warehouseId, warehouse.id)))
    .where(inArray(stockItems.materialId, lines.map((l) => l.materialId)));
  const onHandBy = new Map(balances.map((b) => [b.materialId, b.onHand]));
  for (const line of lines) line.onHand = onHandBy.get(line.materialId) ?? 0;
  return lines;
}

export interface ConsumedMaterialLine extends Omit<PackingMaterialLine, "onHand"> {
  /** Фактично списано цим викликом (0 — повтор або нічого немає на складі). */
  consumed: number;
  /** Не вистачило (лише з allowShortage). */
  shortage: number;
  /** Залишок до списання. */
  onHandBefore: number;
  status: "applied" | "duplicate" | "shortage";
}

export interface ConsumeMaterialsResult {
  /** Для цього пакування матеріали вже списувалися раніше — нових рухів немає. */
  alreadyConsumed: boolean;
  lines: ConsumedMaterialLine[];
  applied: AppliedMovement[];
  /** Сумарна нестача (одиниць), якщо allowShortage. */
  totalShortage: number;
}

export interface ConsumeMaterialsInput {
  packingId: string;
  orderId: string;
  /** Коробка, у яку запаковано (null — без коробки / пакет не обліковується). */
  boxMaterialId: string | null;
}

/**
 * Списує матеріали пакування (коробка + комплектація) — ідемпотентно й безпечно для паралельних повторів. Викликати
 * в транзакції підтвердження пакування («Запаковано»). Рядок пакування блокується тут (див. правила вгорі файлу).
 */
export async function consumeMaterialsForPacking(
  tx: Tx,
  actor: MovementActor,
  input: ConsumeMaterialsInput,
  opts: { allowShortage?: boolean } = {},
): Promise<ConsumeMaterialsResult> {
  if (!UUID_RE.test(input.packingId)) throw new NotFoundError("packing");
  const [packing] = await tx
    .select({ id: orderPacking.id, orderId: orderPacking.orderId })
    .from(orderPacking)
    .where(eq(orderPacking.id, input.packingId))
    .for("no key update");
  if (!packing) throw new NotFoundError("packing");
  if (packing.orderId !== input.orderId.toLowerCase()) throw new DomainError("packaging.error.packingOrderMismatch", 409);
  // Перевірка повтору — ПІСЛЯ блокування: новий знімок READ COMMITTED бачить рухи паралельного підтвердження.
  const [prior] = await tx
    .select({ c: count() })
    .from(inventoryMovements)
    .where(and(eq(inventoryMovements.packingId, input.packingId), eq(inventoryMovements.type, "material_consume")));
  const plan = await planPackingMaterials(tx, input.orderId, input.boxMaterialId);
  const toLine = (l: PackingMaterialLine, consumed: number, status: ConsumedMaterialLine["status"]): ConsumedMaterialLine => {
    const { onHand, ...rest } = l;
    return { ...rest, onHandBefore: onHand, consumed, shortage: status === "shortage" ? l.required - consumed : 0, status };
  };
  if (Number(prior?.c ?? 0) > 0) {
    return { alreadyConsumed: true, lines: plan.map((l) => toLine(l, 0, "duplicate")), applied: [], totalShortage: 0 };
  }
  if (plan.length === 0) return { alreadyConsumed: false, lines: [], applied: [], totalShortage: 0 };

  const warehouse = await getDefaultWarehouse(tx);
  const stockIds = new Map<string, string>();
  for (const l of [...plan].sort((a, b) => (a.materialId < b.materialId ? -1 : 1))) {
    stockIds.set(l.materialId, await ensureStockItemForMaterial(tx, l.materialId));
  }
  const locked = await lockBalances(
    tx,
    plan.map((l) => ({ warehouseId: warehouse.id, stockItemId: stockIds.get(l.materialId)! })),
  );
  const lines: ConsumedMaterialLine[] = [];
  const movements: MovementInput[] = [];
  for (const l of plan) {
    const stockItemId = stockIds.get(l.materialId)!;
    const onHand = locked.get(`${warehouse.id}|${stockItemId}`)?.onHand ?? 0;
    const line = { ...l, onHand };
    let quantity = l.required;
    if (onHand < l.required) {
      if (!opts.allowShortage) {
        throw new DomainError("packaging.error.consumeInsufficient", 409, { code: l.code, current: onHand, required: l.required });
      }
      quantity = Math.max(0, onHand);
    }
    lines.push(toLine(line, quantity, quantity < l.required ? "shortage" : "applied"));
    if (quantity === 0) continue;
    movements.push({
      warehouseId: warehouse.id,
      stockItemId,
      type: "material_consume",
      idempotencyKey: inventoryKeys.materialConsume(input.packingId, l.materialId),
      onHandDelta: -quantity,
      orderId: input.orderId,
      packingId: input.packingId,
      reason: l.isBox ? "packing_box" : "packing_kit",
    });
  }
  // Попередження — refreshMaterialAlerts (коробка може бути неактивною: для неактивних матеріалів їх немає); баланси
  // заблоковані вище.
  const result = await applyMovements(tx, actor, movements, { evaluateAlerts: false });
  await refreshMaterialAlerts(tx, plan.map((l) => l.materialId));
  const skippedItems = new Set(result.skipped.map((s) => s.stockItemId));
  for (const line of lines) {
    if (line.consumed > 0 && skippedItems.has(stockIds.get(line.materialId)!)) {
      line.consumed = 0;
      line.status = "duplicate";
      line.shortage = 0;
    }
  }
  return {
    alreadyConsumed: false,
    lines,
    applied: result.applied,
    totalShortage: lines.reduce((s, l) => s + l.shortage, 0),
  };
}
