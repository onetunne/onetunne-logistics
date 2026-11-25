import { describe, expect, it } from "vitest";
import { addMoney, compareMoney, fromMinor, isPositiveMoney, multiplyMoney, toMinor } from "~/lib/money";
import { ORDER_STATUSES, ORDER_TRANSITIONS, assertTransition, canTransition, isShipped } from "~/domain/order-status";
import { OWNER_ONLY_PERMISSIONS, PERMISSIONS, can, makeActor, resolvePermissions } from "~/domain/permissions";
import { redact } from "~/lib/logger.server";
import { readEnv } from "~/lib/env.server";
import { safeRedirectPath } from "~/server/http.server";
import { packagingSchema, DEFAULT_SETTINGS, shipperSchema } from "~/modules/settings/schema";
import { SECTIONS } from "~/domain/navigation";

describe("money (exact decimals)", () => {
  it("adds and multiplies without float errors", () => {
    expect(addMoney("0.10", "0.20")).toBe("0.30");
    expect(multiplyMoney("29.90", 3)).toBe("89.70");
    expect(addMoney("-1.05", "1")).toBe("-0.05");
    expect(fromMinor(toMinor("12.3"))).toBe("12.30");
    expect(compareMoney("1.00", "0.99")).toBe(1);
    expect(isPositiveMoney("0.00")).toBe(false);
    expect(isPositiveMoney("0.01")).toBe(true);
  });
  it("rejects invalid amounts", () => {
    expect(() => toMinor("1.234")).toThrow();
    expect(() => toMinor("abc")).toThrow();
    expect(() => multiplyMoney("1.00", 1.5)).toThrow();
  });
});

describe("order status machine", () => {
  it("never allows waybill creation to mean shipped", () => {
    expect(isShipped("waybill_created")).toBe(false);
    expect(canTransition("awaiting_review", "handed_to_carrier")).toBe(false);
    expect(canTransition("waybill_created", "in_transit")).toBe(false);
    expect(canTransition("packed", "handed_to_carrier")).toBe(true);
  });
  it("terminal states and full coverage", () => {
    for (const s of ORDER_STATUSES) expect(ORDER_TRANSITIONS[s]).toBeDefined();
    expect(ORDER_TRANSITIONS.cancelled).toEqual([]);
    expect(() => assertTransition("delivered", "paid")).toThrow();
    expect(() => assertTransition("handed_to_carrier", "cancelled")).toThrow();
  });
});

describe("permissions", () => {
  it("owner has everything, staff has no finance/settings/automation", () => {
    const owner = makeActor({ id: "o", displayName: "O", role: "owner" });
    const staff = makeActor({ id: "s", displayName: "S", role: "staff" });
    for (const p of PERMISSIONS) expect(can(owner, p)).toBe(true);
    for (const p of OWNER_ONLY_PERMISSIONS) expect(can(staff, p)).toBe(false);
    expect(can(staff, "settings.view")).toBe(false);
    expect(can(staff, "orders.edit")).toBe(true);
  });
  it("overrides can never grant owner-only permissions to staff", () => {
    const set = resolvePermissions("staff", { grant: ["finance.view", "settings.manage", "orders.cancel", "bogus"] });
    expect(set.has("finance.view")).toBe(false);
    expect(set.has("settings.manage")).toBe(false);
    expect(set.has("orders.cancel")).toBe(true);
    const revoked = resolvePermissions("staff", { revoke: ["orders.edit"] });
    expect(revoked.has("orders.edit")).toBe(false);
  });
  it("finance section requires finance.view", () => {
    expect(SECTIONS.find((s) => s.key === "finance")?.permission).toBe("finance.view");
    expect(SECTIONS).toHaveLength(17);
  });
});

describe("PII redaction in logs", () => {
  it("masks phones, emails and sensitive keys", () => {
    const out = JSON.stringify(
      redact({
        message: "call +49 151 23456789 or mail a.b@example.com",
        phone: "+380671234567",
        shipAddress1: "Main st 1",
        nested: { accessToken: "shpat_secret", orderId: "abc" },
      }),
    );
    expect(out).not.toContain("23456789");
    expect(out).not.toContain("example.com");
    expect(out).not.toContain("Main st");
    expect(out).not.toContain("shpat_secret");
    expect(out).toContain("abc");
  });
});

describe("environment safety", () => {
  const shopify = { SHOPIFY_API_KEY: "k", SHOPIFY_API_SECRET: "s", SHOPIFY_APP_URL: "https://x.example.com" };
  it("refuses DEMO_MODE together with Shopify keys in production", () => {
    expect(() => readEnv({ NODE_ENV: "production", DEMO_MODE: "true", ...shopify })).toThrow(/DEMO_MODE/);
    expect(() => readEnv({ NODE_ENV: "production", DEMO_MODE: "true" })).not.toThrow();
    expect(readEnv({ NODE_ENV: "production", ...shopify }).shopifyConfigured).toBe(true);
  });
  it("requires a strong SESSION_SECRET for demo password", () => {
    expect(() => readEnv({ DEMO_MODE: "true", DEMO_PASSWORD: "x" })).toThrow(/SESSION_SECRET/);
    expect(() => readEnv({ DEMO_MODE: "true", DEMO_PASSWORD: "x", SESSION_SECRET: "short" })).toThrow();
    expect(() => readEnv({ DEMO_MODE: "true", DEMO_PASSWORD: "x", SESSION_SECRET: "a".repeat(32) })).not.toThrow();
  });
  it("parses owner ids", () => {
    expect([...readEnv({ OWNER_SHOPIFY_USER_IDS: "1, 2,,3" }).ownerShopifyUserIds]).toEqual(["1", "2", "3"]);
  });
});

describe("open redirect protection", () => {
  it("allows only local paths", () => {
    expect(safeRedirectPath("/demo/orders?x=1", "/")).toBe("/demo/orders?x=1");
    expect(safeRedirectPath("//evil.example.com", "/")).toBe("/");
    expect(safeRedirectPath("https://evil.example.com", "/")).toBe("/");
    expect(safeRedirectPath("/\\evil", "/")).toBe("/");
  });
});

describe("settings schemas", () => {
  it("defaults are valid", () => {
    expect(packagingSchema.safeParse(DEFAULT_SETTINGS.packaging).success).toBe(true);
    expect(shipperSchema.safeParse(DEFAULT_SETTINGS.shipper).success).toBe(true);
  });
  it("packaging default must reference existing package", () => {
    expect(packagingSchema.safeParse({ ...DEFAULT_SETTINGS.packaging, defaultPackageCode: "nope" }).success).toBe(false);
    expect(packagingSchema.safeParse({ ...DEFAULT_SETTINGS.packaging, volumetricDivisor: 10 }).success).toBe(false);
  });
});
