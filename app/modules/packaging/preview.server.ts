/**
 * Перевірка шаблонів на конкретному замовленні: матеріали комплектації (усі шаблони, що підходять) і запропонована
 * коробка — для сторінки «Комплектація» та чекліста пакувальника. Нічого не змінює.
 */
import { asc, eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { kitTemplates, orders } from "~/db/schema";
import { NotFoundError } from "~/lib/errors";
import type { GoodsSummary, SelectBoxFlags, SelectBoxReason } from "./box-selection";
import { resolveKitMaterials, type KitMaterialNeed } from "./kits.server";
import { selectBoxForOrder } from "./parcel.server";

export interface OrderPackingPreview {
  orderId: string;
  orderNumber: string;
  materials: Array<KitMaterialNeed & { templateNames: string[] }>;
  box: { materialId: string; code: string; name: string; onHand: number } | null;
  boxReason: SelectBoxReason;
  boxFlags: SelectBoxFlags;
  goods: GoodsSummary;
}

/** Замовлення за номером: «#1001», «1001» (номер у базі — як у Shopify, з «#»). */
export async function findOrderIdByNumber(db: DbOrTx, query: string): Promise<{ id: string; orderNumber: string } | null> {
  const raw = query.trim().slice(0, 40);
  if (!raw) return null;
  const bare = raw.replace(/^#/, "");
  const [row] = await db
    .select({ id: orders.id, orderNumber: orders.orderNumber })
    .from(orders)
    .where(inArray(orders.orderNumber, [...new Set([raw, `#${bare}`, bare])]))
    .orderBy(asc(orders.orderNumber))
    .limit(1);
  return row ?? null;
}

export async function previewOrderPacking(db: DbOrTx, orderId: string): Promise<OrderPackingPreview> {
  const [order] = await db.select({ id: orders.id, orderNumber: orders.orderNumber }).from(orders).where(eq(orders.id, orderId));
  if (!order) throw new NotFoundError("order");
  const [kit, box] = await Promise.all([resolveKitMaterials(db, order.id), selectBoxForOrder(db, order.id)]);
  const templateIds = [...new Set(kit.flatMap((k) => k.templateIds))];
  const names = templateIds.length
    ? new Map((await db.select({ id: kitTemplates.id, name: kitTemplates.name }).from(kitTemplates).where(inArray(kitTemplates.id, templateIds))).map((r) => [r.id, r.name]))
    : new Map<string, string>();
  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    materials: kit.map((k) => ({ ...k, templateNames: k.templateIds.map((id) => names.get(id) ?? id) })),
    box: box.box ? { materialId: box.box.id, code: box.box.code, name: box.box.name, onHand: box.box.onHand } : null,
    boxReason: box.reason,
    boxFlags: box.flags,
    goods: box.goods,
  };
}
