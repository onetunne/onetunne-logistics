/**
 * Стан, від якого залежить синхронізація залишків: встановлений магазин, надані дозволи, налаштування складу,
 * склад за замовчуванням і його локація Shopify.
 */
import { sql } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { shopInstallations } from "~/db/schema";
import { getSetting } from "~/modules/settings/settings.server";
import { getDefaultWarehouse, type WarehouseRow } from "~/modules/inventory/warehouse.server";

export const WRITE_INVENTORY_SCOPE = "write_inventory";
export const READ_INVENTORY_SCOPE = "read_inventory";

export function scopeList(scopes: string | null | undefined): string[] {
  return (scopes ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** write_inventory включає читання («Any scope that writes a resource also grants read access»). */
export function inventoryScopes(scopes: string | null | undefined): { read: boolean; write: boolean } {
  const list = scopeList(scopes);
  const write = list.includes(WRITE_INVENTORY_SCOPE);
  return { write, read: write || list.includes(READ_INVENTORY_SCOPE) };
}

export interface InventorySyncEnvironment {
  /** Домен встановленого магазину; null — застосунок не встановлено. */
  shop: string | null;
  scopes: string | null;
  canRead: boolean;
  canWrite: boolean;
  pushMode: "off" | "deltas";
  externalMode: "review" | "apply";
  warehouse: WarehouseRow;
}

export async function installedShop(db: DbOrTx): Promise<{ shop: string; scopes: string | null } | null> {
  const [row] = await db
    .select({ shop: shopInstallations.shop, scopes: shopInstallations.scopes })
    .from(shopInstallations)
    .where(sql`${shopInstallations.uninstalledAt} is null`)
    .orderBy(sql`${shopInstallations.installedAt} desc`)
    .limit(1);
  return row ?? null;
}

export async function loadSyncEnvironment(db: DbOrTx): Promise<InventorySyncEnvironment> {
  const [installation, settings, warehouse] = [await installedShop(db), await getSetting(db, "warehouse"), await getDefaultWarehouse(db)];
  const scopes = inventoryScopes(installation?.scopes);
  return {
    shop: installation?.shop ?? null,
    scopes: installation?.scopes ?? null,
    canRead: scopes.read,
    canWrite: scopes.write,
    pushMode: settings.shopifyPush,
    externalMode: settings.externalShopifyChanges,
    warehouse,
  };
}
