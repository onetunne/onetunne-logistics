import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { orderChanges, orderLineItems, orderPacking, orders, shipments } from "~/db/schema";
import { buildCommercialInvoice, transactionUnitValues } from "~/modules/customs/invoice";
import { loadLineItems, loadOrderRow } from "~/modules/orders/repository.server";
import { validateOrderById } from "~/modules/orders/workflow.server";
import { planParcelBox } from "~/modules/packaging/parcel.server";
import { isManualWeightPlausible } from "~/modules/packaging/parcel";
import { savePackingParcel, startPacking } from "~/modules/packing/packing.server";
import { loadPackingScreen } from "~/modules/packing/view.server";
import { loadSettings } from "~/modules/settings/settings.server";
import { loadOrderInvoice } from "~/modules/shipments/documents.server";
import { PARCEL_RESET_REASON, buildShipmentRequest, cancelWaybill, createWaybill, findActiveShipment } from "~/modules/shipments/waybill.server";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";

/**
 * Регресії рецензії G1b (production-2, packing-2, regressions-3, production-3): митні позиції, задекларована вартість,
 * інвойс і вага посилки в ОДНОМУ запиті до перевізника — з тих самих ефективних кількостей (Shopify currentQuantity),
 * що пакуються й списуються; ручні параметри посилки не потрапляють у накладну застарілими чи неправдоподібними.
 */
let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});

async function settings() {
  return (await loadSettings(env.handle.db)).values;
}
async function lineBySku(orderId: string, sku: string) {
  const line = (await loadLineItems(env.handle.db, orderId)).find((i) => i.variant?.sku === sku);
  if (!line) throw new Error(`line ${sku}`);
  return line;
}

describe("customs items, declared value, invoice and parcel weight use the same effective quantities", () => {
  it("quantity 3 / currentQuantity 1: one holder is declared, valued and weighed (not three)", async () => {
    // #1001: тримач 29.00 (120 г) + гріпси 14.90 (90 г). Shopify: замовлено 3 тримачі, 2 повернено/видалено.
    const id = await env.orderId("#1001");
    const baseOrder = await loadOrderRow(env.handle.db, id);
    const baseItems = await loadLineItems(env.handle.db, id);
    const baseline = buildShipmentRequest(baseOrder, baseItems, await settings(), "OT-T-C0", new Date(), await planParcelBox(env.handle.db, baseOrder, baseItems));
    const holder = await lineBySku(id, "OT-PH-BLK");
    await env.handle.db.update(orderLineItems).set({ quantity: 3, currentQuantity: 1 }).where(eq(orderLineItems.id, holder.id));
    // Order.subtotalPriceSet — «before returns»: включає повернені одиниці (3 × 29.00 + 14.90).
    await env.handle.db.update(orders).set({ subtotal: "101.90" }).where(eq(orders.id, id));
    const order = await loadOrderRow(env.handle.db, id);
    const items = await loadLineItems(env.handle.db, id);
    const req = buildShipmentRequest(order, items, await settings(), "OT-T-C1", new Date(), await planParcelBox(env.handle.db, order, items));
    expect(req.customsItems.map((c) => [c.sku, c.quantity, c.unitValue.amount, c.weightGrams])).toEqual([
      ["OT-PH-BLK", 1, "29.00", 120],
      ["OT-GR-BLK", 1, "14.90", 90],
    ]);
    expect(req.declaredValue).toEqual({ amount: "43.90", currency: "EUR" });
    expect(req.customs?.totalValue.amount).toBe("43.90");
    // Вага митних позицій = вага товарів у посилці; посилка важить стільки ж, скільки без повернених одиниць.
    expect(req.customsItems.reduce((s, c) => s + c.weightGrams * c.quantity, 0)).toBe(210);
    expect(req.parcels[0]!.actualWeightGrams).toBe(baseline.parcels[0]!.actualWeightGrams);
    expect(req.customsItems).toEqual(baseline.customsItems);
  });

  it("the created waybill, the packing checklist and the printed invoice agree", async () => {
    const id = await env.orderId("#1001");
    await validateOrderById(env.ctx(OWNER), id);
    const r = await createWaybill(env.ctx(OWNER), id);
    expect(r.kind).toBe("created");
    const [row] = await env.handle.db.select().from(shipments).where(eq(shipments.orderId, id));
    const snap = row!.requestSnapshot as { customsItems: Array<{ sku: string; quantity: number }>; declaredValue: { amount: string } };
    expect(snap.customsItems.map((c) => [c.sku, c.quantity])).toEqual([
      ["OT-PH-BLK", 1],
      ["OT-GR-BLK", 1],
    ]);
    expect(row!.declaredValue).toBe("43.90");
    const screen = await loadPackingScreen(env.ctx(STAFF), id);
    expect(screen.lines.map((l) => [l.sku, l.required])).toEqual(snap.customsItems.map((c) => [c.sku, c.quantity]));
    // Друкований інвойс (order-invoice.tsx і пакетний друк — loadOrderInvoice) = електронний інвойс перевізника.
    const invoice = await loadOrderInvoice(env.ctx(STAFF), id);
    expect(invoice.lines.map((l) => [l.sku, l.quantity, l.lineValue])).toEqual([
      ["OT-PH-BLK", 1, "29.00"],
      ["OT-GR-BLK", 1, "14.90"],
    ]);
    expect(invoice).toMatchObject({ goodsTotal: "43.90", totalWeightGrams: 210 });
  });

  it("a fully removed line (currentQuantity 0) is not declared at all", async () => {
    const id = await env.orderId("#1012"); // крило + тримач білий
    const order = await loadOrderRow(env.handle.db, id);
    const before = await loadLineItems(env.handle.db, id);
    const removed = before.find((i) => i.variant?.sku !== before[0]!.variant?.sku) ?? before[1]!;
    await env.handle.db.update(orderLineItems).set({ currentQuantity: 0 }).where(eq(orderLineItems.id, removed.id));
    const items = await loadLineItems(env.handle.db, id);
    const req = buildShipmentRequest(order, items, await settings(), "OT-T-C2", new Date());
    expect(req.customsItems).toHaveLength(1);
    expect(req.customsItems[0]!.sku).not.toBe(removed.variant?.sku);
    const invoice = buildCommercialInvoice({ order, items, settings: await settings(), issuedAt: new Date() });
    expect(invoice.lines.map((l) => l.position)).toEqual([1]);
  });

  it("a discount keeps its per-unit allocation (computed on the ordered quantities) and is applied to the shipped units", () => {
    // 10 % знижки на все замовлення: 3 × 29.00 + 14.90 = 101.90 → subtotal 91.71.
    expect(transactionUnitValues([{ unitPrice: "29.00", quantity: 3 }, { unitPrice: "14.90", quantity: 1 }], "91.71")).toEqual(["26.10", "13.41"]);
    const invoice = buildCommercialInvoice({
      order: {
        orderNumber: "#T-1",
        currency: "EUR",
        subtotal: "91.71",
        shippingPaid: "0",
        email: null,
        shipFirstName: null,
        shipLastName: null,
        shipCompany: null,
        shipAddress1: null,
        shipAddress2: null,
        shipCity: null,
        shipProvince: null,
        shipPostalCode: null,
        shipCountryCode: "DE",
        shipPhone: null,
      },
      items: [
        { title: "Holder", sku: "H", quantity: 3, currentQuantity: 1, unitPrice: "29.00", currency: "EUR", variant: null },
        { title: "Grips", sku: "G", quantity: 1, unitPrice: "14.90", currency: "EUR", variant: null },
      ],
      settings: { shipper: { contactName: "Demo", companyName: "", taxId: "", eori: "", ioss: "", phone: "", email: "", address1: "", address2: "", postalCode: "", city: "", countryCode: "UA" } as never, customs: { invoiceType: "commercial", incoterm: "DAP", exportReason: "sale" } as never },
      issuedAt: new Date("2026-11-27T10:00:00Z"),
    });
    expect(invoice.lines.map((l) => [l.sku, l.quantity, l.unitValue, l.lineValue])).toEqual([
      ["H", 1, "26.10", "26.10"],
      ["G", 1, "13.41", "13.41"],
    ]);
    expect(invoice.goodsTotal).toBe("39.51");
  });
});

describe("manual parcel override (orders.parcel_*) is invalidated and sanity-checked", () => {
  it("is reset (with history) when the order lines change after the parcel was weighed; the new waybill uses computed values", async () => {
    const ctx = env.ctx(OWNER);
    const id = await env.orderId("#1009"); // тримач чорний ×1 (120 г)
    await validateOrderById(ctx, id);
    expect((await createWaybill(ctx, id)).kind).toBe("created");
    await startPacking(env.ctx(STAFF), id);
    const screen = await loadPackingScreen(env.ctx(STAFF), id);
    await savePackingParcel(env.ctx(STAFF), id, { expectedVersion: screen.packing!.version, boxMaterialId: null, weightGrams: 300 });
    expect((await loadOrderRow(env.handle.db, id)).parcelWeightGrams).toBe(300);
    await cancelWaybill(ctx, (await findActiveShipment(env.handle.db, id))!.id, { purpose: "correction" });
    expect((await loadOrderRow(env.handle.db, id)).status).toBe("awaiting_review");

    // Без зміни позицій ручне зважування лишається в силі (накладна — зі зваженою вагою).
    expect((await createWaybill(ctx, id)).kind).toBe("created");
    const kept = (await findActiveShipment(env.handle.db, id))!;
    expect(kept.requestSnapshot).toMatchObject({ parcelWeightSource: "manual", manualWeightIgnored: null });
    expect(kept.actualWeightGrams).toBe(300);
    await cancelWaybill(ctx, kept.id, { purpose: "correction" });

    // Shopify-синхронізація застосувала нові позиції (6 тримачів) — як applyOrderInTx: рядки + історія «lineItems».
    const holder = await lineBySku(id, "OT-PH-BLK");
    await env.handle.db.update(orderLineItems).set({ quantity: 6, currentQuantity: 6 }).where(eq(orderLineItems.id, holder.id));
    await env.handle.db
      .insert(orderChanges)
      .values({ orderId: id, field: "lineItems", oldValue: "OT-PH-BLK × 1", newValue: "OT-PH-BLK × 6", source: "shopify_sync", reason: "shopify.updated", actorId: "system" });
    await validateOrderById(ctx, id);
    expect((await createWaybill(ctx, id)).kind).toBe("created");
    const fresh = (await findActiveShipment(env.handle.db, id))!;
    expect(fresh.requestSnapshot).toMatchObject({ parcelWeightSource: "computed" });
    expect(fresh.actualWeightGrams).toBeGreaterThanOrEqual(6 * 120);
    const order = await loadOrderRow(env.handle.db, id);
    expect(order.parcelWeightGrams).toBeNull();
    const resets = await env.handle.db
      .select()
      .from(orderChanges)
      .where(and(eq(orderChanges.orderId, id), eq(orderChanges.reason, PARCEL_RESET_REASON)));
    expect(resets.map((r) => [r.field, r.oldValue, r.newValue, r.source])).toEqual([["parcel.weightGrams", "300", null, "system"]]);
    // Розпочате пакування теж не тримає застарілу вагу (інакше порівняння з накладною мовчало б).
    const [packing] = await env.handle.db.select().from(orderPacking).where(and(eq(orderPacking.orderId, id), eq(orderPacking.status, "in_progress")));
    expect(packing!.parcelWeightGrams).toBeNull();
  });

  it("a manual weight below the goods weight (stale or a typo) is not sent; the computed weight is, and the snapshot says so", async () => {
    const id = await env.orderId("#1003"); // сумка
    const base = await loadOrderRow(env.handle.db, id);
    const items = await loadLineItems(env.handle.db, id);
    const goods = items.reduce((s, i) => s + (i.variant?.weightGrams ?? 0) * i.quantity, 0);
    expect(goods).toBeGreaterThan(100);
    const typo = { ...base, parcelWeightGrams: Math.floor(goods / 10) };
    const req = buildShipmentRequest(typo, items, await settings(), "OT-T-W1", new Date());
    expect(req.parcelWeightSource).toBe("computed");
    expect(req.manualWeightIgnored).toEqual({ manualGrams: Math.floor(goods / 10), goodsGrams: goods });
    expect(req.parcels[0]!.actualWeightGrams).toBeGreaterThanOrEqual(goods);
    // Правдоподібна (≥ 90 % ваги товарів) — приймається.
    const ok = buildShipmentRequest({ ...base, parcelWeightGrams: goods + 50 }, items, await settings(), "OT-T-W2", new Date());
    expect(ok).toMatchObject({ parcelWeightSource: "manual", manualWeightIgnored: null });
    expect(ok.parcels[0]!.actualWeightGrams).toBe(goods + 50);
    expect(isManualWeightPlausible(90, 100)).toBe(true);
    expect(isManualWeightPlausible(89, 100)).toBe(false);
    expect(isManualWeightPlausible(30, 0)).toBe(true);
  });
});
