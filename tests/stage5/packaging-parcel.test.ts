import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { orderLineItems, orders, packagingMaterials, productVariants, shipments } from "~/db/schema";
import { loadLineItems, loadOrderRow } from "~/modules/orders/repository.server";
import { validateOrderById } from "~/modules/orders/workflow.server";
import { resolveKitMaterials } from "~/modules/packaging/kits.server";
import { applyMaterialStock, createMaterial } from "~/modules/packaging/materials.server";
import { chooseParcelPackage, parcelGoods, parcelWeightItems } from "~/modules/packaging/parcel";
import { loadBoxCandidates, planParcelBox, selectBoxForOrder } from "~/modules/packaging/parcel.server";
import { loadSettings } from "~/modules/settings/settings.server";
import { buildShipmentRequest, createWaybill } from "~/modules/shipments/waybill.server";
import { OWNER, createTestEnv, type TestEnv } from "../helpers";

/**
 * Підбір коробки для замовлення з ефективних габаритів/ваги товарів і джерело параметрів посилки в накладній:
 * ручне коригування замовлення → коробка (вручну / автоматично) → типова упаковка; джерело — у знімку запиту.
 */
let env: TestEnv;
const box: Record<string, string> = {};
beforeAll(async () => {
  env = await createTestEnv();
  for (const m of await env.handle.db.select().from(packagingMaterials)) box[m.code] = m.id;
});
afterAll(async () => {
  await env.close();
});

/** Габарити варіантів позицій замовлення — через перевизначення застосунку (як у розділі «Товари»). */
async function setDims(orderNumber: string, dims: Record<string, { lengthMm: number; widthMm: number; heightMm: number; weightGrams?: number } | null>) {
  const orderId = await env.orderId(orderNumber);
  const lines = await env.handle.db.select().from(orderLineItems).where(eq(orderLineItems.orderId, orderId));
  for (const line of lines) {
    const [v] = await env.handle.db.select().from(productVariants).where(eq(productVariants.id, line.variantId!));
    const o = dims[v!.sku!];
    if (o === undefined) continue;
    await env.handle.db.update(productVariants).set({ customsOverrides: o }).where(eq(productVariants.id, v!.id));
  }
  return orderId;
}

async function settings() {
  return (await loadSettings(env.handle.db)).values;
}

describe("selectBoxForOrder", () => {
  it("uses effective (overridden) product dimensions and weights and effective quantities", async () => {
    // #1001: тримач (120 г) + гріпси (90 г).
    const id = await setDims("#1001", { "OT-PH-BLK": { lengthMm: 150, widthMm: 80, heightMm: 40 }, "OT-GR-BLK": { lengthMm: 120, widthMm: 60, heightMm: 40 } });
    const r = await selectBoxForOrder(env.handle.db, id);
    expect(r).toMatchObject({ reason: "fits", box: { code: "box_s", inStock: true }, goods: { units: 2, measuredUnits: 2, weightGrams: 210 } });
    // Вага з перевизначення важить більше за Shopify: 2,5 кг → S (макс. 2 кг) не підходить.
    await setDims("#1001", { "OT-PH-BLK": { lengthMm: 150, widthMm: 80, heightMm: 40, weightGrams: 2500 } });
    expect((await selectBoxForOrder(env.handle.db, id)).box?.code).toBe("box_m");
    await setDims("#1001", { "OT-PH-BLK": { lengthMm: 150, widthMm: 80, heightMm: 40 } });
    // Повернені одиниці не пакуються: 3 замовлено, 1 до відправлення.
    const [line] = await env.handle.db.select().from(orderLineItems).where(eq(orderLineItems.orderId, id));
    await env.handle.db.update(orderLineItems).set({ quantity: 30, currentQuantity: 1 }).where(eq(orderLineItems.id, line!.id));
    expect((await selectBoxForOrder(env.handle.db, id)).box?.code).toBe("box_s");
    await env.handle.db.update(orderLineItems).set({ quantity: 1, currentQuantity: null }).where(eq(orderLineItems.id, line!.id));
  });

  it("prefers boxes in stock (stock is not mandatory)", async () => {
    const id = await env.orderId("#1001");
    const candidates = await loadBoxCandidates(env.handle.db);
    expect(candidates.find((c) => c.code === "box_s")).toMatchObject({ onHand: 40, inStock: true });
    await applyMaterialStock(env.ctx(OWNER), { operationId: globalThis.crypto.randomUUID(), operation: "count", lines: [{ materialId: box.box_s!, quantity: 0 }] });
    const r = await selectBoxForOrder(env.handle.db, id);
    expect(r.box?.code).toBe("mailer_m"); // наступна за об'ємом, у наявності
    expect(r.flags.outOfStock).toBe(false);
    const noPreference = await selectBoxForOrder(env.handle.db, id, { preferInStock: false });
    expect(noPreference).toMatchObject({ box: { code: "box_s" }, flags: { outOfStock: true } });
    await applyMaterialStock(env.ctx(OWNER), { operationId: globalThis.crypto.randomUUID(), operation: "count", lines: [{ materialId: box.box_s!, quantity: 40 }] });
  });

  it("inactive boxes are never selected", async () => {
    const id = await env.orderId("#1001");
    await env.handle.db.update(packagingMaterials).set({ active: false }).where(eq(packagingMaterials.id, box.box_s!));
    expect((await selectBoxForOrder(env.handle.db, id)).box?.code).toBe("mailer_m");
    await env.handle.db.update(packagingMaterials).set({ active: true }).where(eq(packagingMaterials.id, box.box_s!));
  });
});

describe("waybill parcel source precedence", () => {
  it("auto box (dims + tare) when all items are measured", async () => {
    const id = await env.orderId("#1001");
    const order = await loadOrderRow(env.handle.db, id);
    const items = await loadLineItems(env.handle.db, id);
    const plan = await planParcelBox(env.handle.db, order, items);
    expect(plan).toMatchObject({ box: { source: "auto_box", code: "box_s", materialId: box.box_s }, autoReason: "fits" });
    const req = buildShipmentRequest(order, items, await settings(), "OT-T-1", new Date(), plan);
    expect(req).toMatchObject({ packageCode: "box_s", parcelSource: "auto_box", parcelBoxMaterialId: box.box_s, autoBoxReason: "fits", parcelWeightSource: "computed" });
    expect(req.parcels[0]).toMatchObject({ packageCode: "box_s", lengthCm: 20, widthCm: 15, heightCm: 8, actualWeightGrams: 210 + 120 });
  });

  it("a manually chosen box (orders.parcel_box_material_id) wins over the automatic one", async () => {
    const id = await env.orderId("#1001");
    const order = { ...(await loadOrderRow(env.handle.db, id)), parcelBoxMaterialId: box.box_l! };
    const items = await loadLineItems(env.handle.db, id);
    const plan = await planParcelBox(env.handle.db, order, items);
    expect(plan).toEqual({ box: expect.objectContaining({ source: "manual_box", code: "box_l" }), autoReason: null });
    const req = buildShipmentRequest(order, items, await settings(), "OT-T-2", new Date(), plan);
    expect(req.parcels[0]).toMatchObject({ lengthCm: 40, widthCm: 30, heightCm: 20, actualWeightGrams: 210 + 380 });
    expect(req.parcelSource).toBe("manual_box");
    // Ручна коробка без габаритів → автоматичний підбір.
    const sticker = { ...order, parcelBoxMaterialId: box.sticker_logo! };
    expect((await planParcelBox(env.handle.db, sticker, items)).box?.source).toBe("auto_box");
  });

  it("manual parcel dimensions and weight win over any box", async () => {
    const id = await env.orderId("#1001");
    const base = await loadOrderRow(env.handle.db, id);
    const items = await loadLineItems(env.handle.db, id);
    const manual = { ...base, parcelLengthMm: 301, parcelWidthMm: 200, parcelHeightMm: 95, parcelWeightGrams: 1234 };
    const plan = await planParcelBox(env.handle.db, manual, items);
    expect(plan).toEqual({ box: null, autoReason: null });
    const req = buildShipmentRequest(manual, items, await settings(), "OT-T-3", new Date(), plan);
    expect(req).toMatchObject({ parcelSource: "manual", parcelWeightSource: "manual", parcelBoxMaterialId: null });
    expect(req.parcels[0]).toMatchObject({ lengthCm: 31, widthCm: 20, heightCm: 10, actualWeightGrams: 1234 });
    // Зважена вага з автоматичною коробкою: габарити коробки, вага — ручна.
    const weightOnly = { ...base, parcelWeightGrams: 999 };
    const req2 = buildShipmentRequest(weightOnly, items, await settings(), "OT-T-4", new Date(), await planParcelBox(env.handle.db, weightOnly, items));
    expect(req2).toMatchObject({ parcelSource: "auto_box", parcelWeightSource: "manual" });
    expect(req2.parcels[0]).toMatchObject({ lengthCm: 20, actualWeightGrams: 999 });
  });

  it("default package when items lack dimensions (weight-only selection is not used for waybills) or nothing fits", async () => {
    const s = await settings();
    const pkg = s.packaging.packages.find((p) => p.code === s.packaging.defaultPackageCode)!;
    const id = await env.orderId("#1003"); // сумка без габаритів
    const order = await loadOrderRow(env.handle.db, id);
    const items = await loadLineItems(env.handle.db, id);
    const plan = await planParcelBox(env.handle.db, order, items);
    expect(plan).toEqual({ box: null, autoReason: "weight_only" });
    const req = buildShipmentRequest(order, items, s, "OT-T-5", new Date(), plan);
    expect(req).toMatchObject({ packageCode: pkg.code, parcelSource: "default_package", autoBoxReason: "weight_only" });
    expect(req.parcels[0]).toMatchObject({ lengthCm: pkg.lengthCm, widthCm: pkg.widthCm, heightCm: pkg.heightCm });
    // Завеликий товар → немає коробки → типова упаковка.
    await setDims("#1003", { "OT-BG-BLK": { lengthMm: 900, widthMm: 400, heightMm: 300 } });
    expect(await planParcelBox(env.handle.db, order, await loadLineItems(env.handle.db, id))).toEqual({ box: null, autoReason: "too_large" });
    await setDims("#1003", { "OT-BG-BLK": null });
    // Без плану (як до етапу 5) — типова упаковка.
    expect(buildShipmentRequest(order, items, s, "OT-T-6", new Date()).parcelSource).toBe("default_package");
  });

  it("createWaybill records the parcel source in the request snapshot", async () => {
    const ctx = env.ctx(OWNER);
    const id = await env.orderId("#1001");
    await validateOrderById(ctx, id);
    const r = await createWaybill(ctx, id);
    expect(r.kind).toBe("created");
    const [row] = await env.handle.db.select().from(shipments).where(eq(shipments.orderId, id));
    expect(row!.packageCode).toBe("box_s");
    expect(row!.actualWeightGrams).toBe(330);
    expect(row!.requestSnapshot).toMatchObject({
      packageCode: "box_s",
      parcelSource: "auto_box",
      parcelBoxMaterialId: box.box_s,
      autoBoxReason: "fits",
      parcelWeightSource: "computed",
      parcels: [expect.objectContaining({ lengthCm: 20, widthCm: 15, heightCm: 8 })],
    });
    // Товари без габаритів — типова упаковка, причина записана.
    await env.handle.db.update(productVariants).set({ customsOverrides: null });
    const other = await env.orderId("#1009");
    await validateOrderById(ctx, other);
    const r2 = await createWaybill(ctx, other);
    expect(r2.kind).toBe("created");
    const [row2] = await env.handle.db.select().from(shipments).where(eq(shipments.orderId, other));
    expect(row2!.requestSnapshot).toMatchObject({ parcelSource: "default_package", autoBoxReason: "weight_only" });
    const statuses = await env.handle.db.select({ status: orders.status }).from(orders).where(inArray(orders.id, [id, other]));
    expect(statuses.every((s) => s.status === "waybill_created")).toBe(true);
  });
});

describe("parcel goods: one source for the box selection and the waybill weight", () => {
  /** Позиція замовлення за SKU варіанта. */
  async function lineBySku(orderId: string, sku: string) {
    const items = await loadLineItems(env.handle.db, orderId);
    const line = items.find((i) => i.variant?.sku === sku);
    if (!line) throw new Error(`line ${sku} not found`);
    return line;
  }

  it("parcel weight uses the same effective quantities as the box selection (returned/removed units are not shipped)", async () => {
    // Регресія: вага посилки рахувалась з quantity (разом із поверненими), а коробка — з currentQuantity.
    const id = await setDims("#1001", {
      "OT-PH-BLK": { lengthMm: 150, widthMm: 80, heightMm: 40, weightGrams: 900 },
      "OT-GR-BLK": { lengthMm: 120, widthMm: 60, heightMm: 40 },
    });
    const holder = await lineBySku(id, "OT-PH-BLK");
    await env.handle.db.update(orderLineItems).set({ quantity: 5, currentQuantity: 1 }).where(eq(orderLineItems.id, holder.id));
    try {
      const order = await loadOrderRow(env.handle.db, id);
      const items = await loadLineItems(env.handle.db, id);
      const selection = await selectBoxForOrder(env.handle.db, id, { items });
      expect(selection).toMatchObject({ reason: "fits", box: { code: "box_s" }, goods: { units: 2, weightGrams: 990 } });
      const plan = await planParcelBox(env.handle.db, order, items);
      expect(plan.box).toMatchObject({ source: "auto_box", code: "box_s" });
      const req = buildShipmentRequest(order, items, await settings(), "OT-T-7", new Date(), plan);
      const [boxS] = await env.handle.db.select().from(packagingMaterials).where(eq(packagingMaterials.id, box.box_s!));
      expect(req).toMatchObject({ parcelSource: "auto_box", parcelBoxMaterialId: box.box_s });
      // 1 × 900 + 1 × 90 + тара коробки S; вага вмісту — та, на яку коробку перевірено (≤ макс. ваги коробки).
      expect(req.parcels[0]!.actualWeightGrams).toBe(990 + boxS!.tareWeightGrams!);
      expect(req.parcels[0]!.actualWeightGrams - boxS!.tareWeightGrams!).toBeLessThanOrEqual(boxS!.maxWeightGrams!);
      expect(parcelWeightItems(items)).toEqual([
        { weightGrams: 900, quantity: 1 },
        { weightGrams: 90, quantity: 1 },
      ]);

      // Усі одиниці повернено/видалено → немає товарів для пакування: типова упаковка, вага — лише тара.
      await env.handle.db.update(orderLineItems).set({ currentQuantity: 0 }).where(eq(orderLineItems.orderId, id));
      const emptyItems = await loadLineItems(env.handle.db, id);
      const emptyPlan = await planParcelBox(env.handle.db, order, emptyItems);
      expect(emptyPlan).toEqual({ box: null, autoReason: "no_items" });
      const s = await settings();
      const pkg = s.packaging.packages.find((p) => p.code === s.packaging.defaultPackageCode)!;
      expect(buildShipmentRequest(order, emptyItems, s, "OT-T-8", new Date(), emptyPlan).parcels[0]!.actualWeightGrams).toBe(pkg.tareWeightGrams);
    } finally {
      await env.handle.db.update(orderLineItems).set({ currentQuantity: null }).where(eq(orderLineItems.orderId, id));
      await env.handle.db.update(orderLineItems).set({ quantity: 1 }).where(eq(orderLineItems.id, holder.id));
    }
  });

  it("a custom Shopify line without a variant is not packed: it neither disables the automatic box nor changes the kit", async () => {
    // Регресія: позиція без варіанта вважалась «товаром без габаритів» → partial_dimensions → типова упаковка.
    const id = await setDims("#1001", {
      "OT-PH-BLK": { lengthMm: 150, widthMm: 80, heightMm: 40 },
      "OT-GR-BLK": { lengthMm: 120, widthMm: 60, heightMm: 40 },
    });
    const order = await loadOrderRow(env.handle.db, id);
    const before = await planParcelBox(env.handle.db, order);
    const kitBefore = await resolveKitMaterials(env.handle.db, id);
    const reqBefore = buildShipmentRequest(order, await loadLineItems(env.handle.db, id), await settings(), "OT-T-9", new Date(), before);
    const holder = await lineBySku(id, "OT-PH-BLK");
    const [custom] = await env.handle.db
      .insert(orderLineItems)
      .values({ orderId: id, variantId: null, title: "Подарункове пакування", quantity: 2, unitPrice: "2.00", currency: holder.currency, position: 99 })
      .returning({ id: orderLineItems.id });
    try {
      const items = await loadLineItems(env.handle.db, id);
      expect(items.some((i) => i.variant === null)).toBe(true);
      expect(parcelGoods(items)).toHaveLength(2);
      const plan = await planParcelBox(env.handle.db, order, items);
      expect(plan).toEqual(before);
      expect(plan).toMatchObject({ box: { source: "auto_box", code: "box_s" }, autoReason: "fits" });
      expect((await selectBoxForOrder(env.handle.db, id)).flags.missingDimensionsUnits).toBe(0);
      const req = buildShipmentRequest(order, items, await settings(), "OT-T-10", new Date(), plan);
      expect(req).toMatchObject({ parcelSource: "auto_box", packageCode: "box_s" });
      expect(req.parcels[0]!.actualWeightGrams).toBe(reqBefore.parcels[0]!.actualWeightGrams);
      expect(await resolveKitMaterials(env.handle.db, id)).toEqual(kitBefore);
    } finally {
      await env.handle.db.delete(orderLineItems).where(eq(orderLineItems.id, custom!.id));
    }
  });
});

describe("manually chosen box together with manual parcel dimensions", () => {
  it("keeps the chosen box's tare, code and id even when the box has no inner dimensions", async () => {
    // Регресія: коробка без габаритів відкидалась → тара/код типової упаковки, parcelBoxMaterialId = null.
    const { id: mailerId } = await createMaterial(env.ctx(OWNER), {
      code: "mailer_nodims",
      name: "Пакет без розмірів",
      kind: "mailer",
      unit: "pcs",
      tareWeightGrams: "35",
      active: true,
    });
    const id = await setDims("#1001", {
      "OT-PH-BLK": { lengthMm: 150, widthMm: 80, heightMm: 40 },
      "OT-GR-BLK": { lengthMm: 120, widthMm: 60, heightMm: 40 },
    });
    const base = await loadOrderRow(env.handle.db, id);
    const items = await loadLineItems(env.handle.db, id);
    const manual = { ...base, parcelBoxMaterialId: mailerId, parcelLengthMm: 260, parcelWidthMm: 180, parcelHeightMm: 30 };
    const plan = await planParcelBox(env.handle.db, manual, items);
    expect(plan).toEqual({
      box: { source: "manual_box", materialId: mailerId, code: "mailer_nodims", innerLengthMm: null, innerWidthMm: null, innerHeightMm: null, tareWeightGrams: 35 },
      autoReason: null,
    });
    const req = buildShipmentRequest(manual, items, await settings(), "OT-T-11", new Date(), plan);
    expect(req).toMatchObject({ parcelSource: "manual", packageCode: "mailer_nodims", parcelBoxMaterialId: mailerId });
    expect(req.parcels[0]).toMatchObject({ lengthCm: 26, widthCm: 18, heightCm: 3, actualWeightGrams: 210 + 35 });

    // Регресія (production-4): та сама коробка без ручних габаритів посилки НЕ підміняється автоматично підібраною
    // іншою коробкою — код, тара й id вибраної, габарити — типової упаковки (manual_box_default_dims).
    const noDims = { ...base, parcelBoxMaterialId: mailerId };
    const noDimsPlan = await planParcelBox(env.handle.db, noDims, items);
    expect(noDimsPlan.box).toMatchObject({ source: "manual_box", code: "mailer_nodims", materialId: mailerId });
    const s0 = await settings();
    const pkg0 = s0.packaging.packages.find((p) => p.code === s0.packaging.defaultPackageCode)!;
    const noDimsReq = buildShipmentRequest(noDims, items, s0, "OT-T-11b", new Date(), noDimsPlan);
    expect(noDimsReq).toMatchObject({ parcelSource: "manual_box_default_dims", packageCode: "mailer_nodims", parcelBoxMaterialId: mailerId });
    expect(noDimsReq.parcels[0]).toMatchObject({ lengthCm: pkg0.lengthCm, widthCm: pkg0.widthCm, heightCm: pkg0.heightCm, actualWeightGrams: 210 + 35 });

    // Матеріал не-коробка (наклейка) як «коробка» ігнорується: ручні габарити + тара типової упаковки.
    const s = await settings();
    const pkg = s.packaging.packages.find((p) => p.code === s.packaging.defaultPackageCode)!;
    const sticker = { ...manual, parcelBoxMaterialId: box.sticker_logo! };
    const stickerPlan = await planParcelBox(env.handle.db, sticker, items);
    expect(stickerPlan).toEqual({ box: null, autoReason: null });
    const stickerReq = buildShipmentRequest(sticker, items, s, "OT-T-12", new Date(), stickerPlan);
    expect(stickerReq).toMatchObject({ parcelSource: "manual", packageCode: pkg.code, parcelBoxMaterialId: null });
    expect(stickerReq.parcels[0]!.actualWeightGrams).toBe(210 + pkg.tareWeightGrams);
  });

  it("chooseParcelPackage keeps a manual box without dimensions (its code and tare, default dims) and uses manual dims when given", () => {
    const pkg = { code: "default", lengthCm: 30, widthCm: 20, heightCm: 10, tareWeightGrams: 50 };
    const plan = {
      box: { source: "manual_box" as const, materialId: "m", code: "nodims", innerLengthMm: null, innerWidthMm: null, innerHeightMm: null, tareWeightGrams: 20 },
      autoReason: null,
    };
    expect(chooseParcelPackage({ parcelLengthMm: null, parcelWidthMm: null, parcelHeightMm: null }, pkg, plan)).toEqual({
      pkg: { code: "nodims", lengthCm: 30, widthCm: 20, heightCm: 10, tareWeightGrams: 20 },
      source: "manual_box_default_dims",
      boxMaterialId: "m",
    });
    // Автоматично підібрана коробка без габаритів (не буває, але) — типова упаковка.
    expect(chooseParcelPackage({ parcelLengthMm: null, parcelWidthMm: null, parcelHeightMm: null }, pkg, { ...plan, box: { ...plan.box, source: "auto_box" as const } })).toEqual({
      pkg,
      source: "default_package",
      boxMaterialId: null,
    });
    expect(chooseParcelPackage({ parcelLengthMm: 101, parcelWidthMm: 100, parcelHeightMm: 9 }, pkg, plan)).toEqual({
      pkg: { code: "nodims", lengthCm: 11, widthCm: 10, heightCm: 1, tareWeightGrams: 20 },
      source: "manual",
      boxMaterialId: "m",
    });
  });
});
