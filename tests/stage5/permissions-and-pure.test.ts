import { describe, expect, it } from "vitest";
import { SECTIONS, sectionByPath } from "~/domain/navigation";
import { OWNER_ONLY_PERMISSIONS, PERMISSIONS, ROLE_PERMISSIONS, can, makeActor, resolvePermissions } from "~/domain/permissions";
import { DICTIONARIES } from "~/i18n";
import { alertKindsFor, stockLevelStatus } from "~/modules/inventory/alerts";
import { effectiveLineQuantity } from "~/modules/inventory/quantities";
import { inventoryKeys } from "~/modules/inventory/keys";
import { MOVEMENT_TYPES, assertMovementShape, defaultShopifySyncState } from "~/modules/inventory/movement-types";
import { planReservationChanges, reservationModeFor } from "~/modules/inventory/reservations.server";
import { DEFAULT_SETTINGS, warehouseSchema } from "~/modules/settings/schema";
import {
  MATERIAL_UNITS,
  PACKAGING_MATERIAL_KINDS,
  PRODUCTION_BATCH_STATUSES,
  SHOPIFY_SYNC_STATES,
  STOCK_ALERT_KINDS,
} from "~/db/schema";
import { STOCK_LEVEL_STATUSES } from "~/modules/inventory/alerts";

describe("stage 5 permissions", () => {
  const owner = makeActor({ id: "o", displayName: "O", role: "owner" });
  const staff = makeActor({ id: "s", displayName: "S", role: "staff" });

  it("staff defaults: view, receive, pack — not adjust, production or finance", () => {
    for (const p of ["warehouse.view", "warehouse.receive", "packing.perform"] as const) expect(can(staff, p)).toBe(true);
    for (const p of ["warehouse.adjust", "production.manage", "finance.view"] as const) expect(can(staff, p)).toBe(false);
    for (const p of ["warehouse.view", "warehouse.receive", "warehouse.adjust", "production.manage", "packing.perform"] as const) {
      expect(can(owner, p)).toBe(true);
    }
  });

  it("owner can grant warehouse.adjust / production.manage to staff, never finance.view", () => {
    const set = resolvePermissions("staff", { grant: ["warehouse.adjust", "production.manage", "finance.view"] });
    expect(set.has("warehouse.adjust")).toBe(true);
    expect(set.has("production.manage")).toBe(true);
    expect(set.has("finance.view")).toBe(false);
    expect(OWNER_ONLY_PERMISSIONS).toContain("finance.view");
    expect(resolvePermissions("staff", { revoke: ["packing.perform"] }).has("packing.perform")).toBe(false);
  });

  it("existing permissions are unchanged", () => {
    expect(ROLE_PERMISSIONS.owner).toEqual(PERMISSIONS);
    for (const p of ["orders.view", "orders.edit", "orders.bulk", "waybills.create", "problems.view"] as const) expect(can(staff, p)).toBe(true);
    for (const p of ["orders.cancel", "waybills.manage", "settings.view", "settings.manage", "automation.manage", "staff.manage", "demo.reset"] as const) {
      expect(can(staff, p)).toBe(false);
    }
  });

  it("sections picking / warehouse / production are implemented and permission-gated", () => {
    expect(sectionByPath("picking")).toMatchObject({ implemented: true, permission: "packing.perform" });
    expect(sectionByPath("warehouse")).toMatchObject({ implemented: true, permission: "warehouse.view" });
    expect(sectionByPath("production")).toMatchObject({ implemented: true, permission: "warehouse.view" });
    expect(SECTIONS).toHaveLength(18);
  });
});

describe("warehouse settings", () => {
  it("defaults and backwards-compatible parsing of an empty stored value", () => {
    expect(warehouseSchema.parse({})).toEqual(DEFAULT_SETTINGS.warehouse);
    expect(DEFAULT_SETTINGS.warehouse).toMatchObject({
      lowStockThreshold: 5,
      productionLeadDays: 30,
      targetCoverDays: 60,
      batchRounding: 10,
      shopifyPush: "off",
      externalShopifyChanges: "review",
      allowNegativeOnHand: true,
    });
    expect(warehouseSchema.safeParse({ shopifyPush: "all" }).success).toBe(false);
    expect(warehouseSchema.safeParse({ lowStockThreshold: -1 }).success).toBe(false);
  });
});

describe("pure rules", () => {
  it("alert kinds and level status", () => {
    expect(alertKindsFor({ onHand: 10, reserved: 0, threshold: 5 })).toEqual([]);
    expect(alertKindsFor({ onHand: 10, reserved: 5, threshold: 5 })).toEqual(["low_stock"]);
    expect(alertKindsFor({ onHand: 3, reserved: 3, threshold: 5 })).toEqual(["out_of_stock"]);
    expect(alertKindsFor({ onHand: 1, reserved: 3, threshold: 5 })).toEqual(["out_of_stock", "oversold"]);
    expect(alertKindsFor({ onHand: -1, reserved: 0, threshold: 0 })).toEqual(["out_of_stock", "negative_on_hand"]);
    expect(stockLevelStatus({ onHand: -1, reserved: 0, threshold: 5 })).toBe("negative");
    expect(stockLevelStatus({ onHand: 1, reserved: 2, threshold: 5 })).toBe("oversold");
    expect(stockLevelStatus({ onHand: 2, reserved: 2, threshold: 5 })).toBe("out");
    expect(stockLevelStatus({ onHand: 7, reserved: 2, threshold: 5 })).toBe("low");
    expect(stockLevelStatus({ onHand: 7, reserved: 1, threshold: 5 })).toBe("ok");
  });

  it("movement shapes and default Shopify sync state", () => {
    expect(() => assertMovementShape("receipt_production", "product", { onHand: 5, reserved: 0, defective: 1, inProduction: -6 })).not.toThrow();
    expect(() => assertMovementShape("receipt_production", "material", { onHand: 5, reserved: 0, defective: 0, inProduction: 0 })).toThrow();
    expect(() => assertMovementShape("adjustment", "product", { onHand: 0, reserved: 1, defective: 0, inProduction: 0 })).toThrow();
    expect(defaultShopifySyncState("receipt_production", "product", 5, "deltas")).toBe("pending");
    expect(defaultShopifySyncState("receipt_production", "product", 5, "off")).toBe("skipped");
    expect(defaultShopifySyncState("consume_sale", "product", -1, "deltas")).toBe("none");
    expect(defaultShopifySyncState("opening", "product", 5, "deltas")).toBe("none");
    expect(defaultShopifySyncState("adjustment", "material", 5, "deltas")).toBe("none");
  });

  it("reservation mode by order status", () => {
    expect(reservationModeFor("paid")).toBe("reserve");
    expect(reservationModeFor("packed")).toBe("reserve");
    expect(reservationModeFor("handed_to_carrier")).toBe("consume");
    expect(reservationModeFor("returned")).toBe("consume");
    expect(reservationModeFor("cancelled")).toBe("none");
  });

  it("planReservationChanges: reserve, adjust, consume once, snapshot rules, untracked, orphans, variant change", () => {
    const w = "w1";
    const reserve = planReservationChanges({ mode: "reserve", warehouseId: w, lines: [{ lineItemId: "l1", stockItemId: "s1", quantity: 2, inSnapshot: false }], reservations: [] });
    expect(reserve.movements).toEqual([
      expect.objectContaining({ type: "reserve", idempotencyKey: "reserve:l1:1", reservedDelta: 2, stockItemId: "s1" }),
    ]);
    expect(reserve.rows[0]).toMatchObject({ id: null, reservedQty: 2, status: "reserved", seq: 1 });

    const existing = { id: "r1", lineItemId: "l1", stockItemId: "s1", warehouseId: w, reservedQty: 2, consumedQty: 0, status: "reserved" as const, seq: 1 };
    expect(planReservationChanges({ mode: "reserve", warehouseId: w, lines: [{ lineItemId: "l1", stockItemId: "s1", quantity: 2, inSnapshot: false }], reservations: [existing] })).toEqual({
      movements: [],
      rows: [],
    });
    const consume = planReservationChanges({ mode: "consume", warehouseId: w, lines: [{ lineItemId: "l1", stockItemId: "s1", quantity: 2, inSnapshot: false }], reservations: [existing] });
    expect(consume.movements).toEqual([
      expect.objectContaining({ type: "consume_sale", idempotencyKey: "consume:l1", onHandDelta: -2, reservedDelta: -2 }),
    ]);
    const consumed = { ...existing, reservedQty: 0, consumedQty: 2, status: "consumed" as const };
    for (const mode of ["consume", "reserve", "none"] as const) {
      expect(planReservationChanges({ mode, warehouseId: w, lines: [{ lineItemId: "l1", stockItemId: "s1", quantity: 2, inSnapshot: false }], reservations: [consumed] }).movements).toEqual([]);
    }
    // Уперше побачене переданим і створене ДО знімка — історичне, не списується.
    expect(planReservationChanges({ mode: "consume", warehouseId: w, lines: [{ lineItemId: "l9", stockItemId: "s1", quantity: 2, inSnapshot: true }], reservations: [] }).movements).toEqual([]);
    // Уперше побачене переданим, створене ПІСЛЯ знімка — знімок містить ці одиниці → списання без резерву.
    const late = planReservationChanges({ mode: "consume", warehouseId: w, lines: [{ lineItemId: "l9", stockItemId: "s1", quantity: 2, inSnapshot: false }], reservations: [] });
    expect(late.movements).toEqual([expect.objectContaining({ type: "consume_sale", idempotencyKey: "consume:l9", onHandDelta: -2, reservedDelta: 0 })]);
    expect(late.rows[0]).toMatchObject({ id: null, consumedQty: 2, reservedQty: 0, status: "consumed" });
    // Перший резерв замовлення, створеного ДО знімка: корекція on_hand (раз на позицію) + резерв.
    const committed = planReservationChanges({ mode: "reserve", warehouseId: w, lines: [{ lineItemId: "l8", stockItemId: "s1", quantity: 3, inSnapshot: true }], reservations: [] });
    expect(committed.movements.map((m) => [m.type, m.idempotencyKey, m.onHandDelta ?? 0, m.reservedDelta ?? 0])).toEqual([
      ["opening", "opening_line:l8", 3, 0],
      ["reserve", "reserve:l8:1", 0, 3],
    ]);
    // Наявний резерв: корекції вже немає, лише різниця.
    const existing8 = { id: "r8", lineItemId: "l8", stockItemId: "s1", warehouseId: w, reservedQty: 3, consumedQty: 0, status: "reserved" as const, seq: 1 };
    expect(
      planReservationChanges({ mode: "reserve", warehouseId: w, lines: [{ lineItemId: "l8", stockItemId: "s1", quantity: 1, inSnapshot: true }], reservations: [existing8] }).movements.map((m) => m.idempotencyKey),
    ).toEqual(["release:l8:2"]);
    // Передано, але всі одиниці видалено/повернено (currentQuantity 0) — резерв знімається, не списується.
    expect(
      planReservationChanges({ mode: "consume", warehouseId: w, lines: [{ lineItemId: "l8", stockItemId: "s1", quantity: 0, inSnapshot: true }], reservations: [existing8] }).movements.map((m) => [m.type, m.reservedDelta]),
    ).toEqual([["release", -3]]);
    // Невідкритий товар (stockItemId null): нічого не резервується.
    expect(planReservationChanges({ mode: "reserve", warehouseId: w, lines: [{ lineItemId: "l7", stockItemId: null, quantity: 2, inSnapshot: false }], reservations: [] })).toEqual({ movements: [], rows: [] });
    // Видалена позиція → зняття.
    const orphan = planReservationChanges({ mode: "reserve", warehouseId: w, lines: [], reservations: [existing] });
    expect(orphan.movements).toEqual([expect.objectContaining({ type: "release", idempotencyKey: "release:l1:2", reservedDelta: -2 })]);
    // Варіант змінився → зняття зі старої позиції, резерв на новій.
    const changed = planReservationChanges({ mode: "reserve", warehouseId: w, lines: [{ lineItemId: "l1", stockItemId: "s2", quantity: 2, inSnapshot: false }], reservations: [existing] });
    expect(changed.movements.map((m) => [m.type, m.stockItemId, m.idempotencyKey])).toEqual([
      ["release", "s1", "release:l1:2"],
      ["reserve", "s2", "reserve:l1:3"],
    ]);
  });

  it("idempotency key builders", () => {
    expect(inventoryKeys.reserve("l", 2)).toBe("reserve:l:2");
    expect(inventoryKeys.consume("l")).toBe("consume:l");
    expect(inventoryKeys.openingLine("l")).toBe("opening_line:l");
    // Склад рахує currentQuantity (без повернених/видалених одиниць); null → quantity.
    expect(effectiveLineQuantity({ quantity: 5, currentQuantity: 3 })).toBe(3);
    expect(effectiveLineQuantity({ quantity: 5, currentQuantity: 0 })).toBe(0);
    expect(effectiveLineQuantity({ quantity: 5, currentQuantity: null })).toBe(5);
    expect(effectiveLineQuantity({ quantity: 2 })).toBe(2);
    expect(inventoryKeys.materialConsume("p", "m")).toBe("material:p:m");
    expect(() => inventoryKeys.manual("x".repeat(250))).toThrow();
  });
});

describe("i18n for stage-5 enums", () => {
  it("every enum value has uk and en labels", () => {
    const keys = [
      ...MOVEMENT_TYPES.map((t) => `movementType.${t}`),
      ...STOCK_ALERT_KINDS.map((k) => `stockAlert.${k}`),
      ...STOCK_LEVEL_STATUSES.map((k) => `stockLevel.${k}`),
      ...PRODUCTION_BATCH_STATUSES.map((k) => `productionStatus.${k}`),
      ...PACKAGING_MATERIAL_KINDS.map((k) => `materialKind.${k}`),
      ...MATERIAL_UNITS.map((k) => `materialUnit.${k}`),
      ...SHOPIFY_SYNC_STATES.map((k) => `shopifySyncState.${k}`),
      "inventory.insufficient",
      "inventory.invalidMovement",
    ];
    expect(keys.filter((k) => !(k in DICTIONARIES.uk) || !(k in DICTIONARIES.en))).toEqual([]);
  });
});
