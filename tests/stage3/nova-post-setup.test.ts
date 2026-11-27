/**
 * Рішення власника після етапу 3:
 * - варіант B: один тариф Nova Post для Checkout і накладних;
 * - перевірка підключення без створення накладних;
 * - підтвердження валюти/договірних тарифів перед використанням вартості в Checkout;
 * - адреса доставки як адреса реєстрації — лише з підтвердженням власника.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { orders } from "~/db/schema";
import { checkNovaPostConnection } from "~/integrations/carriers/nova-post/connection-check.server";
import { NovaPostAdapter } from "~/integrations/carriers/nova-post/adapter.server";
import { NovaPostClient } from "~/integrations/carriers/nova-post/client.server";
import type { RateRequest } from "~/integrations/carriers/types";
import { loadLineItems, loadOrderRow } from "~/modules/orders/repository.server";
import { checkoutReadiness, confirmNovaPostTariffs, revokeNovaPostTariffs, runNovaPostConnectionCheck } from "~/modules/rates/nova-post-setup.server";
import { DEFAULT_SETTINGS, isTariffConfirmed, type AllSettings } from "~/modules/settings/schema";
import { getSetting, loadSettings, updateSetting } from "~/modules/settings/settings.server";
import { buildShipmentRequest } from "~/modules/shipments/waybill.server";
import { createTestEnv, OWNER, STAFF, type TestEnv } from "../helpers";

const BASE = "https://api.example.invalid/v.1.0";

function fakeApi(handlers: Record<string, (body: unknown) => { status: number; json: unknown }>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/v\.1\.0/, "");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, path, body });
    if (path === "/clients/authorization") return new Response(JSON.stringify({ jwt: "eyJa.eyJb.sig" }), { status: 200 });
    const h = handlers[`${method} ${path}`];
    if (!h) return new Response(JSON.stringify({ errors: { "": "not found" } }), { status: 404 });
    const r = h(body);
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { "content-type": "application/json" } });
  });
  return { fetch, calls };
}

const CALC = (discount: number) => ({
  scheduledDeliveryDate: "2026-12-02T00:00:00.000000Z",
  services: [
    { deliveryType: "uuid-1", deliveryTypeName: "standard", serviceName: "Parcel", cost: 910 - discount, price: 910, discount },
    { deliveryType: "uuid-2", deliveryTypeName: "express", serviceName: "Parcel", cost: 1400, price: 1400, discount: 0 },
  ],
});

describe("Nova Post connection check (read-only)", () => {
  it("authorizes, quotes without and with contract, reads contract currency; never creates shipments", async () => {
    const api = fakeApi({
      "POST /shipments/calculations": (body) => ({ status: 200, json: CALC((body as { payerContractNumber?: string }).payerContractNumber ? 91 : 0) }),
      "GET /shipments": () => ({ status: 200, json: { total: 12, items: [{ id: "x", currencyCode: "UAH" }, { id: "y", currencyCode: "UAH" }] } }),
    });
    const r = await checkNovaPostConnection({
      apiKey: "k",
      baseUrl: BASE,
      fetch: api.fetch,
      sender: { countryCode: "UA", city: "Київ", postalCode: "01001", divisionNumber: "", companyTin: "12345678", companyName: "Shop" },
      payerType: "Sender",
      payerContractNumber: "CN-1",
    });
    expect(r.authorized).toBe(true);
    expect(r.calculations.map((c) => c.label)).toEqual(["base", "contract"]);
    expect(r.calculations[0]!.services[0]).toEqual({ deliveryType: "standard", name: "Parcel", cost: 910, price: 910, discount: 0 });
    expect(r.calculations[1]!.services[0]!.discount).toBe(91);
    expect(r.calculations[0]!.currencyFields).toEqual({});
    expect(r.calculations[0]!.responseKeys).toContain("services.cost");
    expect(r.shipments).toMatchObject({ ok: true, total: 12, currencyCodes: ["UAH"] });
    // Лише читання: жодного POST /shipments (створення), PUT чи DELETE.
    const writes = api.calls.filter((c) => c.method !== "GET" && c.path !== "/shipments/calculations");
    expect(writes).toEqual([]);
    expect(api.calls.find((c) => c.path === "/shipments/calculations" && (c.body as { payerContractNumber?: string }).payerContractNumber)?.body).toMatchObject({
      payerContractNumber: "CN-1",
      sender: { companyTin: "12345678", companyName: "Shop" },
    });
  });

  it("reports currency fields if the API ever returns them", async () => {
    const api = fakeApi({
      "POST /shipments/calculations": () => ({ status: 200, json: { ...CALC(0), currencyCode: "UAH" } }),
      "GET /shipments": () => ({ status: 500, json: { errors: { "": "boom" } } }),
    });
    const r = await checkNovaPostConnection({
      apiKey: "k",
      baseUrl: BASE,
      fetch: api.fetch,
      sender: { countryCode: "UA", city: "", postalCode: "", divisionNumber: "32521/1", companyTin: "", companyName: "" },
      payerType: "Sender",
      payerContractNumber: "",
    });
    expect(r.calculations).toHaveLength(1);
    expect(r.calculations[0]!.currencyFields).toEqual({ currencyCode: "UAH" });
    expect(r.shipments.ok).toBe(false);
  });
});

describe("option B: one tariff for quotes", () => {
  it("the adapter returns only the tariff fixed in settings", async () => {
    const api = fakeApi({ "POST /shipments/calculations": () => ({ status: 200, json: CALC(0) }) });
    const settings = (deliveryType: string) => ({
      novaPost: { ...DEFAULT_SETTINGS.novaPost, deliveryType },
      customs: DEFAULT_SETTINGS.customs,
      shipper: { companyName: "", taxId: "", carrierBranch: "32521/1" },
      checkoutRates: { fxRates: [] },
    });
    const req: RateRequest = {
      origin: { countryCode: "UA", city: "Kyiv", postalCode: "01001", province: null, address1: "x 1", address2: null },
      destination: { countryCode: "DE", city: "Berlin", postalCode: "10178", province: null, address1: "", address2: null },
      parcels: [{ packageCode: "m", lengthCm: 30, widthCm: 20, heightCm: 10, actualWeightGrams: 500, volumetricWeightGrams: 1200, chargeableWeightGrams: 1200 }],
      declaredValue: { amount: "1000.00", currency: "UAH" },
    };
    const client = new NovaPostClient({ apiKey: "k", baseUrl: BASE, fetch: api.fetch });
    const fixed = new NovaPostAdapter({ client, settings: async () => settings("express"), allowShipmentCreation: false });
    expect((await fixed.quoteRates(req)).map((q) => q.serviceCode)).toEqual(["express"]);
    const auto = new NovaPostAdapter({ client, settings: async () => settings(""), allowShipmentCreation: false });
    expect((await auto.quoteRates(req)).map((q) => q.serviceCode)).toEqual(["standard", "express"]);
  });

  it("checkout readiness requires a fixed tariff and a valid confirmation (Nova Post only)", () => {
    const np = (over: Partial<AllSettings["novaPost"]>) => ({ novaPost: { ...DEFAULT_SETTINGS.novaPost, ...over } });
    expect(checkoutReadiness("test", np({}))).toEqual({ ready: true });
    expect(checkoutReadiness("nova_post", np({}))).toEqual({ ready: false, reason: "tariff_not_fixed" });
    expect(checkoutReadiness("nova_post", np({ deliveryType: "standard" }))).toEqual({ ready: false, reason: "tariff_not_confirmed" });
    const confirmation = { confirmedAt: "x", confirmedBy: "o", tariffCurrency: "UAH", payerContractNumber: "", deliveryType: "standard" };
    expect(checkoutReadiness("nova_post", np({ deliveryType: "standard", tariffConfirmation: confirmation }))).toEqual({ ready: true });
    // Зміна тарифу/договору/валюти робить підтвердження недійсним.
    expect(isTariffConfirmed({ ...DEFAULT_SETTINGS.novaPost, deliveryType: "express", tariffConfirmation: confirmation })).toBe(false);
    expect(isTariffConfirmed({ ...DEFAULT_SETTINGS.novaPost, deliveryType: "standard", payerContractNumber: "CN", tariffConfirmation: confirmation })).toBe(false);
  });
});

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});

describe("owner services", () => {
  it("confirm / revoke tariffs is owner-only and records the current values", async () => {
    const ctx = env.ctx(OWNER);
    const { values, versions } = await loadSettings(ctx.db);
    await updateSetting(ctx.db, OWNER, "novaPost", { ...values.novaPost, deliveryType: "standard" }, versions.novaPost);
    await expect(confirmNovaPostTariffs(env.ctx(STAFF), 0)).rejects.toBeTruthy();
    const v1 = (await loadSettings(ctx.db)).versions.novaPost;
    expect((await confirmNovaPostTariffs(ctx, v1)).ok).toBe(true);
    const np = await getSetting(ctx.db, "novaPost");
    expect(np.tariffConfirmation).toMatchObject({ tariffCurrency: "UAH", deliveryType: "standard", confirmedBy: OWNER.id });
    expect(isTariffConfirmed(np)).toBe(true);
    const v2 = (await loadSettings(ctx.db)).versions.novaPost;
    expect((await revokeNovaPostTariffs(ctx, v2)).ok).toBe(true);
    expect((await getSetting(ctx.db, "novaPost")).tariffConfirmation).toBeNull();
  });

  it("connection check: owner-only, not configured in demo without a key; uses injected key read-only", async () => {
    await expect(runNovaPostConnectionCheck(env.ctx(STAFF))).rejects.toBeTruthy();
    expect(await runNovaPostConnectionCheck(env.ctx(OWNER))).toEqual({ ok: false, reason: "not_configured" });
    const api = fakeApi({
      "POST /shipments/calculations": () => ({ status: 200, json: CALC(0) }),
      "GET /shipments": () => ({ status: 200, json: { total: 0, items: [] } }),
    });
    const r = await runNovaPostConnectionCheck(env.ctx(OWNER), { apiKey: "k", baseUrl: BASE, fetch: api.fetch });
    expect(r.ok && r.check.authorized).toBe(true);
    expect(api.calls.some((c) => c.method === "POST" && c.path === "/shipments")).toBe(false);
  });
});

describe("registration address requires the owner's confirmation", () => {
  it("is sent only when 'shipping' AND confirmed", async () => {
    const db = env.handle.db;
    const [o] = await db.select().from(orders).where(eq(orders.orderNumber, "#1001"));
    const order = await loadOrderRow(db, o!.id);
    const items = await loadLineItems(db, o!.id);
    const settings = (await loadSettings(db)).values;
    const req = (customs: Partial<AllSettings["customs"]>) =>
      buildShipmentRequest(order, items, { ...settings, customs: { ...settings.customs, ...customs } }, "OT-1001-1-abcd", new Date());
    expect(req({ recipientRegistrationAddress: "none" }).recipient.registrationAddress).toBeNull();
    expect(req({ recipientRegistrationAddress: "shipping", recipientRegistrationAddressConfirmed: false }).recipient.registrationAddress).toBeNull();
    expect(req({ recipientRegistrationAddress: "shipping", recipientRegistrationAddressConfirmed: true }).recipient.registrationAddress).toMatchObject({
      countryCode: order.shipCountryCode,
      city: order.shipCity,
    });
  });
});
