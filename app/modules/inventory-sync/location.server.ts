/**
 * Локація Shopify складу за замовчуванням (warehouses.shopify_location_id).
 *
 * Автоматично зберігається лише ОДНОЗНАЧНА локація (у магазині одна активна локація). Кілька локацій → власник
 * обирає на сторінці «Склад → Shopify»; до вибору передача й звірка не виконуються (рухи лишаються pending).
 * Власник підтверджує локацію (запис у журналі inventory_sync.location_confirmed) — сторінка показує, чи підтверджено.
 */
import { createHash } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { auditLog, warehouses } from "~/db/schema";
import { SYSTEM_ACTOR, requirePermission } from "~/domain/permissions";
import { DomainError } from "~/lib/errors";
import type { AdminGraphql } from "~/integrations/shopify/admin-client.server";
import {
  LOCATIONS_MAX_PAGES,
  LOCATIONS_PAGE_SIZE,
  LOCATIONS_QUERY,
  type GqlLocation,
  type GqlLocationsResult,
} from "~/integrations/shopify/inventory-graphql";
import { writeAudit } from "~/modules/audit/audit.server";
import type { WarehouseRow } from "~/modules/inventory/warehouse.server";
import type { ServiceContext } from "~/server/types";
import { installedShop } from "./environment.server";
import { pickLocation } from "./pure";
import { enqueueFullReconcile, enqueueInventoryPush } from "./schedule.server";

export interface LocationOption {
  id: string;
  name: string;
  fulfillsOnlineOrders: boolean;
}

export type LocationState =
  | { status: "ready"; locationId: string; source: "stored" | "auto" }
  | { status: "ambiguous"; candidates: LocationOption[] }
  | { status: "none" };

const toOption = (l: GqlLocation): LocationOption => ({ id: l.id, name: l.name, fulfillsOnlineOrders: l.fulfillsOnlineOrders });

/**
 * Відбиток id локації для журналу: журнал маскує довгі послідовності цифр (як телефони), тож gid локації там
 * зберегти не можна. Відбиток — лише літери (sha-256 → a…p), порівнюється з відбитком поточної локації.
 */
export function locationFingerprint(locationId: string): string {
  return createHash("sha256")
    .update(locationId)
    .digest("hex")
    .slice(0, 24)
    .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
}

/**
 * Локації магазину сторінками (до LOCATIONS_MAX_PAGES). hasMore — є ще локації понад прочитані (вибір неоднозначний).
 * until — зупинитися, щойно знайдено потрібну (перевірка вибору власника).
 */
export async function fetchLocations(
  admin: AdminGraphql,
  opts: { until?: (l: GqlLocation) => boolean } = {},
): Promise<{ nodes: GqlLocation[]; hasMore: boolean }> {
  const nodes: GqlLocation[] = [];
  let after: string | null = null;
  for (let page = 0; page < LOCATIONS_MAX_PAGES; page++) {
    const data: GqlLocationsResult = await admin<GqlLocationsResult>(LOCATIONS_QUERY, { first: LOCATIONS_PAGE_SIZE, after });
    nodes.push(...data.locations.nodes);
    const { hasNextPage, endCursor } = data.locations.pageInfo;
    if (!hasNextPage) return { nodes, hasMore: false };
    if (opts.until && data.locations.nodes.some(opts.until)) return { nodes, hasMore: true };
    // Без курсора далі читати неможливо — решта невідома (неоднозначно).
    if (!endCursor) return { nodes, hasMore: true };
    after = endCursor;
  }
  return { nodes, hasMore: true };
}

/** Локація для передачі/звірки: збережена, або єдина локація магазину (зберігається), або потрібен вибір власника. */
export async function ensureWarehouseLocation(db: DbOrTx, admin: AdminGraphql, warehouse: WarehouseRow): Promise<LocationState> {
  if (warehouse.shopifyLocationId) return { status: "ready", locationId: warehouse.shopifyLocationId, source: "stored" };
  const { nodes, hasMore } = await fetchLocations(admin);
  const pick = pickLocation(nodes, hasMore);
  if (pick.kind === "none") return { status: "none" };
  if (pick.kind === "ambiguous") return { status: "ambiguous", candidates: pick.candidates.map(toOption) };
  const [row] = await db
    .update(warehouses)
    .set({ shopifyLocationId: pick.location.id, updatedAt: new Date() })
    .where(and(eq(warehouses.id, warehouse.id), isNull(warehouses.shopifyLocationId)))
    .returning({ locationId: warehouses.shopifyLocationId });
  if (row) {
    await writeAudit(db, SYSTEM_ACTOR, "inventory_sync.location_auto_selected", { type: "warehouse", id: warehouse.id }, {
      locationKey: locationFingerprint(pick.location.id),
    });
    return { status: "ready", locationId: pick.location.id, source: "auto" };
  }
  // Паралельно вже збережено (інший обробник або власник) — беремо збережене.
  const [current] = await db.select({ locationId: warehouses.shopifyLocationId }).from(warehouses).where(eq(warehouses.id, warehouse.id));
  return current?.locationId ? { status: "ready", locationId: current.locationId, source: "stored" } : { status: "none" };
}

/**
 * Власник обирає локацію (з активних локацій магазину) — водночас підтвердження. Зміна локації робить застарілими
 * спостереження відкритих розбіжностей (дії з ними повертають needs_reconcile) → повна звірка в черзі.
 */
export async function setWarehouseLocation(
  ctx: ServiceContext,
  admin: AdminGraphql,
  warehouse: WarehouseRow,
  locationId: string,
): Promise<LocationOption> {
  requirePermission(ctx.actor, "settings.manage");
  const { nodes } = await fetchLocations(admin, { until: (l) => l.id === locationId });
  const chosen = nodes.find((l) => l.id === locationId && l.isActive && !l.isFulfillmentService);
  if (!chosen) throw new DomainError("inventorySync.locationInvalid", 400);
  const [previous] = await ctx.db.select({ locationId: warehouses.shopifyLocationId }).from(warehouses).where(eq(warehouses.id, warehouse.id));
  const changed = (previous?.locationId ?? null) !== chosen.id;
  await ctx.db.update(warehouses).set({ shopifyLocationId: chosen.id, updatedAt: new Date() }).where(eq(warehouses.id, warehouse.id));
  await writeAudit(ctx.db, ctx.actor, "inventory_sync.location_set", { type: "warehouse", id: warehouse.id }, {
    changed,
    locationKey: locationFingerprint(chosen.id),
  });
  await writeAudit(ctx.db, ctx.actor, "inventory_sync.location_confirmed", { type: "warehouse", id: warehouse.id }, {
    locationKey: locationFingerprint(chosen.id),
  });
  // Рухи, що чекали на вибір локації, — у передачу (без pending завдання нічого не зробить).
  await enqueueInventoryPush(ctx.db);
  // Інша локація — інші залишки Shopify: звірити все заново (відкриті розбіжності оновляться спостереженнями нової).
  const shop = changed ? await installedShop(ctx.db) : null;
  if (shop) await enqueueFullReconcile(ctx.db, shop.shop, ctx.actor.id);
  return toOption(chosen);
}

/** Підтвердити збережену (автоматично обрану) локацію. */
export async function confirmWarehouseLocation(ctx: ServiceContext, warehouse: WarehouseRow): Promise<void> {
  requirePermission(ctx.actor, "settings.manage");
  if (!warehouse.shopifyLocationId) throw new DomainError("inventorySync.locationMissing", 409);
  await writeAudit(ctx.db, ctx.actor, "inventory_sync.location_confirmed", { type: "warehouse", id: warehouse.id }, {
    locationKey: locationFingerprint(warehouse.shopifyLocationId),
  });
}

export interface LocationConfirmation {
  confirmedAt: Date;
  actorId: string;
}

/** Останнє підтвердження ПОТОЧНОЇ локації складу (null — не підтверджено власником). */
export async function locationConfirmation(db: DbOrTx, warehouse: WarehouseRow): Promise<LocationConfirmation | null> {
  if (!warehouse.shopifyLocationId) return null;
  const [row] = await db
    .select({ createdAt: auditLog.createdAt, actorId: auditLog.actorId })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, "warehouse"),
        eq(auditLog.entityId, warehouse.id),
        eq(auditLog.action, "inventory_sync.location_confirmed"),
        sql`${auditLog.details}->>'locationKey' = ${locationFingerprint(warehouse.shopifyLocationId)}`,
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  return row ? { confirmedAt: row.createdAt, actorId: row.actorId } : null;
}
