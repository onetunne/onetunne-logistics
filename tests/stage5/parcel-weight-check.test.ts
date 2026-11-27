import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { orderChanges } from "~/db/schema";
import { DomainError } from "~/lib/errors";
import { loadOrderRow } from "~/modules/orders/repository.server";
import { validateOrderById } from "~/modules/orders/workflow.server";
import { manualWeightIgnoredOf, manualWeightUse, minPlausibleManualWeight, parcelWeightCheck } from "~/modules/packaging/parcel";
import { PARCEL_WEIGHT_VERIFIED_REASON } from "~/modules/packaging/parcel.server";
import { mismatchNeedsReissue, type ParcelMismatch } from "~/modules/packing/parcel-compare";
import { confirmParcelWeight, saveOrderParcel, savePackingParcel, startPacking } from "~/modules/packing/packing.server";
import { loadPackingScreen, loadPackingSummary } from "~/modules/packing/view.server";
import { reissueWaybill } from "~/modules/shipments/reissue.server";
import { createWaybill, findActiveShipment } from "~/modules/shipments/waybill.server";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";

/**
 * Регресія NEW-1 (повторна рецензія G1b): зважена вага, менша за 90 % ваги товарів за Shopify, не надсилається в
 * накладну (production-3) — і тепер це видно: попередження при збереженні, на екрані пакування й у картці замовлення;
 * власник може підтвердити вагу (тоді її надсилає нова/переоформлена накладна); розбіжність ваги, яку нова накладна
 * теж проігнорує, не радить «Переоформити» (кожне переоформлення — реальне скасування + створення у перевізника).
 */
let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});

describe("pure rules", () => {
  it("manualWeightUse / parcelWeightCheck / minPlausibleManualWeight", () => {
    expect(manualWeightUse(225, 250, false)).toBe("plausible");
    expect(manualWeightUse(224, 250, false)).toBe("ignored");
    expect(manualWeightUse(212, 250, true)).toBe("owner_verified");
    expect(manualWeightUse(0, 250, true)).toBe("ignored");
    expect(minPlausibleManualWeight(250)).toBe(225);
    expect(minPlausibleManualWeight(251)).toBe(226);
    expect(minPlausibleManualWeight(0)).toBe(0);
    expect(parcelWeightCheck(212, 250, false)).toEqual({ manualGrams: 212, goodsGrams: 250, minGrams: 225, use: "ignored" });
    expect(parcelWeightCheck(300, 250, false)).toBeNull();
    expect(parcelWeightCheck(null, 250, false)).toBeNull();
    expect(manualWeightIgnoredOf({ manualWeightIgnored: { manualGrams: 212, goodsGrams: 250 } })).toEqual({ manualGrams: 212, goodsGrams: 250 });
    expect(manualWeightIgnoredOf({ manualWeightIgnored: null })).toBeNull();
    expect(manualWeightIgnoredOf(null)).toBeNull();
  });

  it("mismatchNeedsReissue: a weight the new waybill would ignore alone does not need a re-issue", () => {
    const ignored: ParcelMismatch = { weight: { waybillGrams: 320, packedGrams: 212, ignoredByWaybill: { goodsGrams: 250, minGrams: 225 } }, dims: null };
    expect(mismatchNeedsReissue(ignored)).toBe(false);
    expect(mismatchNeedsReissue({ weight: { waybillGrams: 320, packedGrams: 400 }, dims: null })).toBe(true);
    expect(mismatchNeedsReissue({ ...ignored, dims: { waybillMm: [300, 200, 100], packedMm: [400, 200, 100] } })).toBe(true);
    expect(mismatchNeedsReissue(null)).toBe(false);
  });
});

describe("weighed parcel lighter than the Shopify goods weight (#1003: bag 250 g in Shopify, parcel 212 g)", () => {
  it("warns on save, explains on the screens, the owner confirms, and the re-issued waybill uses the weighed weight (no re-issue loop)", async () => {
    const id = await env.orderId("#1003");
    await validateOrderById(env.ctx(OWNER), id);
    const before = await loadOrderRow(env.handle.db, id);

    // 1) До накладної: збереження ваги одразу попереджає, що накладна її не використає.
    const saved = await saveOrderParcel(env.ctx(STAFF), id, { expectedVersion: before.version, boxMaterialId: null, weightGrams: 212 });
    expect(saved.changed).toEqual(["parcel.weightGrams"]);
    expect(saved.weightCheck).toEqual({ manualGrams: 212, goodsGrams: 250, minGrams: 225, use: "ignored" });
    expect((await loadPackingScreen(env.ctx(STAFF), id)).weightCheck).toMatchObject({ use: "ignored", manualGrams: 212 });
    expect((await loadPackingSummary(env.handle.db, id)).weightCheck).toMatchObject({ use: "ignored" });

    // 2) Накладна з розрахунковою вагою — і це видно в знімку, на екрані пакування й у картці замовлення.
    expect((await createWaybill(env.ctx(OWNER), id)).kind).toBe("created");
    const first = (await findActiveShipment(env.handle.db, id))!;
    expect(first.requestSnapshot).toMatchObject({ parcelWeightSource: "computed", manualWeightIgnored: { manualGrams: 212, goodsGrams: 250 }, manualWeightOwnerVerified: false });
    expect(first.actualWeightGrams).toBeGreaterThan(250);
    await startPacking(env.ctx(STAFF), id);
    const screen = await loadPackingScreen(env.ctx(STAFF), id);
    expect(screen.waybillWeightIgnored).toEqual({ manualGrams: 212, goodsGrams: 250 });
    expect(screen.mismatch?.weight).toMatchObject({ packedGrams: 212, ignoredByWaybill: { goodsGrams: 250, minGrams: 225 } });
    // Переоформлення не порадиться: нова накладна теж проігнорувала б 212 г.
    expect(mismatchNeedsReissue(screen.mismatch)).toBe(false);
    expect((await loadPackingSummary(env.handle.db, id)).waybillWeightIgnored).toEqual({ manualGrams: 212, goodsGrams: 250 });

    // Повторне збереження в пакуванні — так само з попередженням.
    const again = await savePackingParcel(env.ctx(STAFF), id, { expectedVersion: screen.packing!.version, boxMaterialId: screen.packing!.boxMaterialId, weightGrams: 212 });
    expect(again.weightCheck).toMatchObject({ use: "ignored" });
    expect(again.mismatch?.weight?.ignoredByWaybill).toBeDefined();

    // 3) Підтвердити вагу може лише власник, і лише ту, яку він бачив.
    await expect(confirmParcelWeight(env.ctx(STAFF), id, { weightGrams: 212 })).rejects.toMatchObject({ code: "packing.error.weightConfirmOwnerOnly" });
    await expect(confirmParcelWeight(env.ctx(OWNER), id, { weightGrams: 213 })).rejects.toMatchObject({ code: "error.conflict" });
    expect(await confirmParcelWeight(env.ctx(OWNER), id, { weightGrams: "212" })).toEqual({ kind: "confirmed", weightGrams: 212, goodsGrams: 250 });
    expect((await confirmParcelWeight(env.ctx(OWNER), id, { weightGrams: 212 })).kind).toBe("already_confirmed");
    const history = await env.handle.db
      .select()
      .from(orderChanges)
      .where(and(eq(orderChanges.orderId, id), eq(orderChanges.reason, PARCEL_WEIGHT_VERIFIED_REASON)));
    expect(history.map((h) => [h.field, h.oldValue, h.newValue, h.actorId])).toEqual([["parcel.weightGrams", "212", "212", OWNER.id]]);

    const verified = await loadPackingScreen(env.ctx(STAFF), id);
    expect(verified.weightCheck).toMatchObject({ use: "owner_verified", manualGrams: 212 });
    // Тепер переоформлення справді усуне розбіжність.
    expect(verified.mismatch?.weight?.ignoredByWaybill).toBeUndefined();
    expect(mismatchNeedsReissue(verified.mismatch)).toBe(true);

    // 4) Переоформлена накладна надсилає зважену вагу — розбіжність зникає (без нескінченних переоформлень).
    const re = await reissueWaybill(env.ctx(OWNER), first.id);
    expect(re.kind).toBe("reissued");
    const second = (await findActiveShipment(env.handle.db, id))!;
    expect(second.generation).toBe(2);
    expect(second.actualWeightGrams).toBe(212);
    expect(second.requestSnapshot).toMatchObject({ parcelWeightSource: "manual", manualWeightIgnored: null, manualWeightOwnerVerified: true });
    const after = await loadPackingScreen(env.ctx(STAFF), id);
    expect(after.mismatch).toBeNull();
    expect(after.waybillWeightIgnored).toBeNull();

    // 5) Перезважили — підтвердження стосувалося іншої ваги й більше не діє.
    const rewe = await savePackingParcel(env.ctx(STAFF), id, { expectedVersion: after.packing!.version, boxMaterialId: after.packing!.boxMaterialId, weightGrams: 200 });
    expect(rewe.weightCheck).toMatchObject({ use: "ignored", manualGrams: 200 });
  });

  it("a plausible weight needs no confirmation and gives no warning", async () => {
    const id = await env.orderId("#1002");
    await validateOrderById(env.ctx(OWNER), id);
    const order = await loadOrderRow(env.handle.db, id);
    const r = await saveOrderParcel(env.ctx(STAFF), id, { expectedVersion: order.version, boxMaterialId: null, weightGrams: 5000 });
    expect(r.weightCheck).toBeNull();
    expect((await confirmParcelWeight(env.ctx(OWNER), id, { weightGrams: 5000 })).kind).toBe("not_needed");
    await expect(confirmParcelWeight(env.ctx(OWNER), id, { weightGrams: "abc" })).rejects.toBeInstanceOf(DomainError);
  });
});
