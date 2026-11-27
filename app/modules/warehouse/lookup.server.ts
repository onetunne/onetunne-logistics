/**
 * Пошукові довідки для сторінок «Склад» (історія руху, форми операцій): замовлення за номером, позиції за
 * SKU/назвою, виконавці рухів. Лише ідентифікатори, номери й назви — без даних покупців.
 */
import { and, asc, eq, ilike, inArray, max, or, sql } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { inventoryMovements, orders, packagingMaterials, productVariants, products, stockItems, type StockItemKind } from "~/db/schema";
import { MAX_BULK_ITEMS, MAX_SEARCH_LENGTH, UUID_RE } from "./constants";

const likePattern = (search: string) =>
  `%${search
    .trim()
    .slice(0, MAX_SEARCH_LENGTH)
    .replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export interface OrderRef {
  id: string;
  orderNumber: string;
}

/** Замовлення за номером (точний збіг; «1001» знаходить «#1001»). */
export async function findOrderByNumber(db: DbOrTx, value: string): Promise<OrderRef | null> {
  const number = value.trim().slice(0, 64);
  if (!number) return null;
  const candidates = [...new Set([number, number.startsWith("#") ? number.slice(1) : `#${number}`])].filter(Boolean);
  const rows = await db
    .select({ id: orders.id, orderNumber: orders.orderNumber })
    .from(orders)
    .where(inArray(orders.orderNumber, candidates))
    .orderBy(asc(orders.createdAt))
    .limit(2);
  return rows.find((r) => r.orderNumber === number) ?? rows[0] ?? null;
}

export async function findOrderById(db: DbOrTx, id: string): Promise<OrderRef | null> {
  if (!UUID_RE.test(id)) return null;
  const [row] = await db.select({ id: orders.id, orderNumber: orders.orderNumber }).from(orders).where(eq(orders.id, id));
  return row ?? null;
}

/** Позиції обліку за SKU, штрихкодом, назвою товару/варіанта або матеріалу (до MAX_BULK_ITEMS). */
export async function searchStockItemIds(
  db: DbOrTx,
  search: string,
  opts: { kind?: StockItemKind; limit?: number } = {},
): Promise<string[]> {
  if (!search.trim()) return [];
  const pattern = likePattern(search);
  const limit = Math.min(Math.max(opts.limit ?? MAX_BULK_ITEMS, 1), 500);
  const rows = await db
    .select({ id: stockItems.id })
    .from(stockItems)
    .leftJoin(productVariants, eq(productVariants.id, stockItems.variantId))
    .leftJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(packagingMaterials, eq(packagingMaterials.id, stockItems.materialId))
    .where(
      and(
        opts.kind ? eq(stockItems.kind, opts.kind) : undefined,
        or(
          ilike(productVariants.sku, pattern),
          ilike(productVariants.barcode, pattern),
          ilike(productVariants.title, pattern),
          ilike(products.title, pattern),
          ilike(packagingMaterials.code, pattern),
          ilike(packagingMaterials.name, pattern),
        ),
      ),
    )
    .orderBy(asc(stockItems.id))
    .limit(limit);
  return rows.map((r) => r.id);
}

export interface StockItemLabel {
  stockItemId: string;
  kind: StockItemKind;
  title: string;
  variantTitle: string | null;
  sku: string | null;
}

/** Підпис позиції обліку (для фільтра «позиція» в історії руху). */
export async function getStockItemLabel(db: DbOrTx, stockItemId: string): Promise<StockItemLabel | null> {
  if (!UUID_RE.test(stockItemId)) return null;
  const [row] = await db
    .select({
      id: stockItems.id,
      kind: stockItems.kind,
      productTitle: products.title,
      variantTitle: productVariants.title,
      sku: productVariants.sku,
      materialName: packagingMaterials.name,
      materialCode: packagingMaterials.code,
    })
    .from(stockItems)
    .leftJoin(productVariants, eq(productVariants.id, stockItems.variantId))
    .leftJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(packagingMaterials, eq(packagingMaterials.id, stockItems.materialId))
    .where(eq(stockItems.id, stockItemId));
  if (!row) return null;
  return {
    stockItemId: row.id,
    kind: row.kind,
    title: row.productTitle ?? row.materialName ?? "—",
    variantTitle: row.kind === "product" ? row.variantTitle : null,
    sku: row.kind === "product" ? row.sku : row.materialCode,
  };
}

export interface MovementActorOption {
  id: string;
  name: string;
}

/** Виконавці рухів (для фільтра історії): id + останнє відоме ім'я. */
export async function listMovementActors(db: DbOrTx, limit = 200): Promise<MovementActorOption[]> {
  const rows = await db
    .select({ id: inventoryMovements.actorId, name: max(inventoryMovements.actorName) })
    .from(inventoryMovements)
    .groupBy(inventoryMovements.actorId)
    .orderBy(sql`2 asc`, asc(inventoryMovements.actorId))
    .limit(Math.min(Math.max(limit, 1), 500));
  return rows.map((r) => ({ id: r.id, name: r.name ?? r.id }));
}
