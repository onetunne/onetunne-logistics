import { ShopifyApiError, type AdminGraphql } from "~/integrations/shopify/admin-client.server";
import type { GqlAdjustUserError, GqlLocation } from "~/integrations/shopify/inventory-graphql";

/**
 * Імітація GraphQL Admin API 2026-10 для залишків (як tests/stage2/fixtures.ts): локації, InventoryLevel.quantities,
 * inventoryAdjustQuantities з @idempotent (24-годинний кеш ключа: успіх → та сама відповідь без повторного
 * застосування; інші параметри → IDEMPOTENCY_KEY_PARAMETER_MISMATCH; ключ невдалої спроби →
 * IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED) і CAS changeFromQuantity (CHANGE_FROM_QUANTITY_STALE). Вигадані дані.
 */
export const LOC = "gid://shopify/Location/9001";
export const LOC2 = "gid://shopify/Location/9002";

export interface FakeLevel {
  available: number;
  onHand: number;
  committed: number;
  tracked?: boolean;
  /** false — товар не ведеться в локації (inventoryLevel = null). */
  stocked?: boolean;
}

type Injection = { userErrors: GqlAdjustUserError[] } | { throw: Error } | { applyThenThrow: Error };

export interface FakeInventoryAdmin {
  admin: AdminGraphql;
  levels: Map<string, FakeLevel>;
  locations: GqlLocation[];
  calls: Array<{ op: string; variables?: Record<string, unknown>; query: string }>;
  adjustCalls: () => Array<{ key: string; input: Record<string, any> }>;
  /** Наступні відповіді inventoryAdjustQuantities (по одній на виклик). */
  inject: (...items: Injection[]) => void;
  setLevel: (gid: string, level: Partial<FakeLevel>) => void;
}

export function location(id: string, name: string, over: Partial<GqlLocation> = {}): GqlLocation {
  return { id, name, isActive: true, isFulfillmentService: false, fulfillsOnlineOrders: true, ...over };
}

export function fakeInventoryAdmin(): FakeInventoryAdmin {
  const levels = new Map<string, FakeLevel>();
  const locations: GqlLocation[] = [location(LOC, "Склад Київ")];
  const calls: FakeInventoryAdmin["calls"] = [];
  const cache = new Map<string, { params: string; response?: unknown; failed?: boolean }>();
  const injections: Injection[] = [];

  const adjust = (variables: Record<string, any>) => {
    const key = String(variables.idempotencyKey ?? "");
    const input = variables.input as { name: string; reason: string; changes: Array<Record<string, any>> };
    const params = JSON.stringify(input);
    const cached = cache.get(key);
    if (cached) {
      if (cached.params !== params) return errors("IDEMPOTENCY_KEY_PARAMETER_MISMATCH");
      if (cached.failed) return errors("IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED");
      return cached.response;
    }
    const injected = injections.shift();
    if (injected && "throw" in injected) throw injected.throw;
    if (injected && "userErrors" in injected) {
      const transient = injected.userErrors.every((e) => e.code === "IDEMPOTENCY_CONCURRENT_REQUEST");
      if (!transient) cache.set(key, { params, failed: true });
      return { inventoryAdjustQuantities: { inventoryAdjustmentGroup: null, userErrors: injected.userErrors } };
    }
    for (const c of input.changes) {
      if (!("changeFromQuantity" in c)) throw new ShopifyApiError("changeFromQuantity is required", false, "INVALID");
      const level = levels.get(c.inventoryItemId);
      if (!level) {
        cache.set(key, { params, failed: true });
        return errors("INVALID_INVENTORY_ITEM");
      }
      if (c.changeFromQuantity !== null && c.changeFromQuantity !== level.available) {
        cache.set(key, { params, failed: true });
        return errors("CHANGE_FROM_QUANTITY_STALE");
      }
    }
    for (const c of input.changes) {
      const level = levels.get(c.inventoryItemId)!;
      level.available += c.delta;
      level.onHand += c.delta;
    }
    const response = {
      inventoryAdjustQuantities: {
        inventoryAdjustmentGroup: {
          id: `gid://shopify/InventoryAdjustmentGroup/${cache.size + 1}`,
          createdAt: new Date().toISOString(),
          reason: input.reason,
          referenceDocumentUri: (input as { referenceDocumentUri?: string }).referenceDocumentUri ?? null,
          changes: input.changes.flatMap((c) => [
            { name: "available", delta: c.delta },
            { name: "on_hand", delta: c.delta },
          ]),
        },
        userErrors: [],
      },
    };
    cache.set(key, { params, response });
    if (injected && "applyThenThrow" in injected) throw injected.applyThenThrow;
    return response;
  };

  const errors = (code: string) => ({
    inventoryAdjustQuantities: { inventoryAdjustmentGroup: null, userErrors: [{ field: null, message: code, code }] },
  });

  const admin: AdminGraphql = async <T,>(query: string, variables?: Record<string, unknown>) => {
    const op = /(query|mutation)\s+(\w+)/.exec(query)?.[2] ?? "unknown";
    calls.push({ op, variables, query });
    let data: unknown;
    switch (op) {
      case "OtLocations":
        data = { locations: { pageInfo: { hasNextPage: false }, nodes: locations } };
        break;
      case "OtInventoryLevels": {
        const ids = (variables?.ids as string[]) ?? [];
        if (variables?.locationId !== LOC && variables?.locationId !== LOC2) throw new ShopifyApiError("bad location", false, "INVALID");
        data = {
          nodes: ids.map((id) => {
            const l = levels.get(id);
            if (!l) return null;
            return {
              id,
              tracked: l.tracked ?? true,
              inventoryLevel:
                l.stocked === false
                  ? null
                  : {
                      id: `gid://shopify/InventoryLevel/1?inventory_item_id=${id.split("/").pop()}`,
                      quantities: [
                        { name: "available", quantity: l.available },
                        { name: "on_hand", quantity: l.onHand },
                        { name: "committed", quantity: l.committed },
                      ],
                    },
            };
          }),
        };
        break;
      }
      case "OtInventoryAdjust":
        if (!/inventoryAdjustQuantities\(input: \$input\) @idempotent\(key: \$idempotencyKey\)/.test(query)) {
          throw new ShopifyApiError("idempotency key is required", false, "BAD_REQUEST");
        }
        data = adjust(variables ?? {});
        break;
      case "OtInventoryItem":
        data = { inventoryItem: { id: variables?.id, variant: { id: "v", product: { id: "gid://shopify/Product/1" } } } };
        break;
      default:
        throw new Error(`fakeInventoryAdmin: unexpected operation ${op}`);
    }
    return data as T;
  };

  return {
    admin,
    levels,
    locations,
    calls,
    adjustCalls: () =>
      calls
        .filter((c) => c.op === "OtInventoryAdjust")
        .map((c) => ({ key: String(c.variables?.idempotencyKey), input: c.variables?.input as Record<string, any> })),
    inject: (...items) => injections.push(...items),
    setLevel: (gid, level) => levels.set(gid, { available: 0, onHand: 0, committed: 0, ...levels.get(gid), ...level }),
  };
}
