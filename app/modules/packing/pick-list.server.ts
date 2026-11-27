/**
 * Зведений лист комплектації (pick list) для вибраних замовлень черги пакування: що зібрати з полиць ОДНИМ обходом —
 * сума одиниць кожного варіанта (модель, колір, SKU, штрихкод, фото) по всіх вибраних замовленнях, з розкладом
 * «скільки в яке замовлення», залишком на полиці й переліком пакувальних матеріалів (коробки й комплектація).
 *
 * - Кількість — effectiveLineQuantity (Shopify currentQuantity: без повернених/видалених одиниць) — ті самі одиниці,
 *   що в чеклісті пакування й накладній. Позиції без товару в каталозі не збираються (окремий перелік).
 * - Включаються замовлення «Накладна створена» / «Очікує комплектації»; запаковані, виконані в Shopify поза
 *   застосунком та інші — пропускаються з причиною (PICK_LIST_SKIP_REASONS). Позиції, які Shopify змінив і застосунок
 *   ще не застосував, — включаються з позначкою (кількості можуть змінитися).
 * - Матеріали — той самий план, що в пакувальному листі й на екрані пакування (коробка пакування або defaultBoxFor).
 * - Лише читання; дозвіл packing.perform (персональних даних покупця немає: номери замовлень і товари).
 */
import { and, eq, inArray } from "drizzle-orm";
import { inventoryBalances, stockItems } from "~/db/schema";
import { isOrderFulfilledInShopify, type OrderStatus } from "~/domain/order-status";
import { requirePermission } from "~/domain/permissions";
import { effectiveLineQuantity } from "~/modules/inventory/quantities";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import { loadLineItems, loadOrderRow } from "~/modules/orders/repository.server";
import { planPackingMaterials } from "~/modules/packaging/consumption.server";
import { shopifyLinesPending } from "~/modules/shopify-sync/pending-lines.server";
import { findActiveShipment } from "~/modules/shipments/waybill.server";
import type { ServiceContext } from "~/server/types";
import { MAX_PICK_LIST_ORDERS, STARTABLE_STATUSES, type PickListSkipReason } from "./constants";
import { defaultBoxFor, loadActivePacking } from "./packing.server";
import { parseOrderIds } from "./queue-filters";
import { sortOrderIdsLikeQueue } from "./queue.server";

export interface PickListItem {
  variantId: string;
  productTitle: string;
  variantTitle: string | null;
  sku: string | null;
  barcode: string | null;
  model: string | null;
  color: string | null;
  imageUrl: string | null;
  /** Усього одиниць по вибраних замовленнях. */
  quantity: number;
  /** Розклад по замовленнях (у порядку черги). */
  orders: Array<{ orderNumber: string; quantity: number }>;
  /** Фактичний залишок на складі за замовчуванням; null — позиція ще не обліковується. */
  onHand: number | null;
}

export interface PickListMaterial {
  materialId: string;
  code: string;
  name: string;
  isBox: boolean;
  quantity: number;
  onHand: number;
}

export interface PickList {
  items: PickListItem[];
  /** Позиції без товару в каталозі — не збираються з полиць (послуги, довільні позиції Shopify). */
  otherLines: Array<{ orderNumber: string; title: string; quantity: number }>;
  materials: PickListMaterial[];
  included: Array<{ orderId: string; orderNumber: string; units: number }>;
  skipped: Array<{ orderId: string; orderNumber: string; reason: PickListSkipReason }>;
  /** Номери замовлень, позиції яких Shopify змінив і застосунок ще не застосував (кількості можуть змінитися). */
  linesPending: string[];
  totalUnits: number;
  /** Ідентифікатори, яких немає в базі. */
  missing: number;
  truncated: boolean;
}

const collator = new Intl.Collator("uk", { sensitivity: "base", numeric: true });

export async function loadPickList(ctx: ServiceContext, orderIds: readonly string[]): Promise<PickList> {
  requirePermission(ctx.actor, "packing.perform");
  const ids = parseOrderIds(orderIds, MAX_PICK_LIST_ORDERS + 1);
  const truncated = ids.length > MAX_PICK_LIST_ORDERS;
  const sorted = await sortOrderIdsLikeQueue(ctx.db, ids.slice(0, MAX_PICK_LIST_ORDERS));
  const byVariant = new Map<string, PickListItem>();
  const materials = new Map<string, PickListMaterial>();
  const out: PickList = {
    items: [],
    otherLines: [],
    materials: [],
    included: [],
    skipped: [],
    linesPending: [],
    totalUnits: 0,
    missing: Math.min(ids.length, MAX_PICK_LIST_ORDERS) - sorted.length,
    truncated,
  };
  for (const { id, orderNumber, status } of sorted) {
    const order = await loadOrderRow(ctx.db, id);
    if (status === "packed") {
      out.skipped.push({ orderId: id, orderNumber, reason: "packed" });
      continue;
    }
    if (!(STARTABLE_STATUSES as readonly OrderStatus[]).includes(status)) {
      out.skipped.push({ orderId: id, orderNumber, reason: "not_in_queue" });
      continue;
    }
    if (isOrderFulfilledInShopify(order)) {
      out.skipped.push({ orderId: id, orderNumber, reason: "fulfilled_in_shopify" });
      continue;
    }
    if (shopifyLinesPending(order)) out.linesPending.push(orderNumber);
    const [items, packing, shipment] = await Promise.all([loadLineItems(ctx.db, id), loadActivePacking(ctx.db, id), findActiveShipment(ctx.db, id)]);
    let units = 0;
    for (const item of items) {
      const quantity = effectiveLineQuantity(item);
      if (quantity <= 0) continue;
      if (!item.variant) {
        out.otherLines.push({ orderNumber, title: item.title, quantity });
        continue;
      }
      units += quantity;
      const v = item.variant;
      const entry =
        byVariant.get(v.id) ??
        ({
          variantId: v.id,
          productTitle: v.productTitle,
          variantTitle: v.title ?? item.variantTitle,
          sku: v.sku ?? item.sku,
          barcode: v.barcode,
          model: v.model,
          color: v.color,
          imageUrl: v.imageUrl ?? v.productImageUrl ?? item.imageUrl,
          quantity: 0,
          orders: [],
          onHand: null,
        } satisfies PickListItem);
      entry.quantity += quantity;
      const last = entry.orders[entry.orders.length - 1];
      if (last && last.orderNumber === orderNumber) last.quantity += quantity;
      else entry.orders.push({ orderNumber, quantity });
      byVariant.set(v.id, entry);
    }
    out.included.push({ orderId: id, orderNumber, units });
    out.totalUnits += units;
    const boxId = packing ? packing.boxMaterialId : await defaultBoxFor(ctx.db, order, shipment);
    for (const m of await planPackingMaterials(ctx.db, id, boxId)) {
      const cur = materials.get(m.materialId) ?? { materialId: m.materialId, code: m.code, name: m.name, isBox: m.isBox, quantity: 0, onHand: m.onHand };
      cur.quantity += m.required;
      cur.isBox = cur.isBox || m.isBox;
      materials.set(m.materialId, cur);
    }
  }
  const items = [...byVariant.values()];
  if (items.length > 0) {
    const warehouse = await getDefaultWarehouse(ctx.db);
    const balances = await ctx.db
      .select({ variantId: stockItems.variantId, onHand: inventoryBalances.onHand })
      .from(stockItems)
      .innerJoin(inventoryBalances, and(eq(inventoryBalances.stockItemId, stockItems.id), eq(inventoryBalances.warehouseId, warehouse.id)))
      .where(inArray(stockItems.variantId, items.map((i) => i.variantId)));
    const onHandBy = new Map(balances.map((b) => [b.variantId, b.onHand]));
    for (const item of items) item.onHand = onHandBy.get(item.variantId) ?? null;
  }
  out.items = items.sort(
    (a, b) =>
      collator.compare(a.productTitle, b.productTitle) ||
      collator.compare(a.model ?? "", b.model ?? "") ||
      collator.compare(a.color ?? "", b.color ?? "") ||
      collator.compare(a.variantTitle ?? "", b.variantTitle ?? "") ||
      collator.compare(a.sku ?? "", b.sku ?? "") ||
      (a.variantId < b.variantId ? -1 : 1),
  );
  out.materials = [...materials.values()].sort((a, b) => Number(b.isBox) - Number(a.isBox) || collator.compare(a.name, b.name));
  return out;
}
