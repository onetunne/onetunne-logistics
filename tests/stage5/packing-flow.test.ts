import { and, count, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  auditLog,
  inventoryBalances,
  inventoryMovements,
  orderChanges,
  orderPacking,
  orders,
  packagingMaterials,
  shipmentEvents,
  stockItems,
} from "~/db/schema";
import { ForbiddenError, makeActor } from "~/domain/permissions";
import { ConflictError, DomainError } from "~/lib/errors";
import { validateOrderById } from "~/modules/orders/workflow.server";
import {
  adjustPackedLine,
  confirmPacked,
  recordScan,
  savePackingParcel,
  setOrderPriority,
  setOrdersPriority,
  startPacking,
  startPackingBulk,
  unpackOrder,
} from "~/modules/packing/packing.server";
import { parseQueueFilters } from "~/modules/packing/queue-filters";
import { listPackingQueue } from "~/modules/packing/queue.server";
import { loadPackingScreen, loadPackingSummary } from "~/modules/packing/view.server";
import { createWaybill, findActiveShipment } from "~/modules/shipments/waybill.server";
import { markHandedOver } from "~/modules/tracking/tracking.server";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";

/**
 * Підготовка замовлень (пакування): початок (у т. ч. паралельний), сканування, «Запаковано» лише з повним
 * комплектом, ідемпотентне списання матеріалів, розпакування й повторне пакування, посилка й розбіжність
 * з накладною, пріоритет, черга (сортування й фільтри), дозволи. Демо-дані: тестовий перевізник.
 */
let env: TestEnv;
const ids: Record<string, string> = {};

beforeAll(async () => {
  env = await createTestEnv();
  // Накладні для кількох чистих демо-замовлень (крім #0998 — у неї накладна вже є).
  for (const number of ["#1001", "#1002", "#1009", "#1011", "#1012"]) {
    const id = await env.orderId(number);
    await validateOrderById(env.ctx(OWNER), id);
    const r = await createWaybill(env.ctx(OWNER), id, { source: "manual" });
    if (r.kind !== "created") throw new Error(`waybill for ${number}: ${r.kind}`);
    ids[number] = id;
  }
  ids["#0998"] = await env.orderId("#0998");
  // «Потрібна накладна»: перевірене замовлення без накладної.
  ids["#1003"] = await env.orderId("#1003");
  await validateOrderById(env.ctx(OWNER), ids["#1003"]);
});
afterAll(async () => {
  await env.close();
});

const NO_PACKING = makeActor({ id: "np", displayName: "Без пакування", role: "staff", overrides: { revoke: ["packing.perform"] } });
const NO_EDIT = makeActor({ id: "ne", displayName: "Без редагування", role: "staff", overrides: { revoke: ["orders.edit"] } });

async function orderStatus(id: string) {
  const [row] = await env.handle.db.select({ status: orders.status }).from(orders).where(eq(orders.id, id));
  return row!.status;
}
async function packingsOf(id: string) {
  return env.handle.db.select().from(orderPacking).where(eq(orderPacking.orderId, id));
}
/** #1001 починають паралельно працівник і власник — переможець недетермінований на справжньому PostgreSQL. */
const CONCURRENT_STARTER = expect.stringMatching(new RegExp(`^(${STAFF.displayName}|${OWNER.displayName})$`));

async function activePacking(id: string) {
  const rows = await packingsOf(id);
  const active = rows.filter((r) => r.status !== "cancelled");
  expect(active).toHaveLength(1);
  return active[0]!;
}
async function consumeMovements(packingId: string) {
  return env.handle.db
    .select()
    .from(inventoryMovements)
    .where(and(eq(inventoryMovements.packingId, packingId), eq(inventoryMovements.type, "material_consume")));
}
async function materialOnHand(code: string) {
  const [row] = await env.handle.db
    .select({ onHand: inventoryBalances.onHand })
    .from(packagingMaterials)
    .innerJoin(stockItems, eq(stockItems.materialId, packagingMaterials.id))
    .innerJoin(inventoryBalances, eq(inventoryBalances.stockItemId, stockItems.id))
    .where(eq(packagingMaterials.code, code));
  return row?.onHand ?? 0;
}
async function events(orderId: string) {
  const shipment = await findActiveShipment(env.handle.db, orderId);
  const rows = await env.handle.db.select({ type: shipmentEvents.type, message: shipmentEvents.message }).from(shipmentEvents).where(eq(shipmentEvents.shipmentId, shipment!.id));
  return rows;
}
/** Сканує всі позиції замовлення за штрихкодом до повного комплекту. */
async function scanAll(orderId: string) {
  const screen = await loadPackingScreen(env.ctx(), orderId);
  for (const line of screen.lines) {
    for (let i = line.packed; i < line.required; i += 1) {
      const r = await recordScan(env.ctx(STAFF), orderId, line.barcode ?? line.sku ?? "");
      expect(r.kind).toBe("matched");
    }
  }
}

describe("startPacking", () => {
  it("requires packing.perform, a startable status and a created waybill", async () => {
    await expect(startPacking(env.ctx(NO_PACKING), ids["#0998"]!)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(startPacking(env.ctx(STAFF), await env.orderId("#1004"))).rejects.toMatchObject({ code: "packing.error.status" });
    await expect(startPacking(env.ctx(STAFF), ids["#1003"]!)).rejects.toMatchObject({ code: "packing.error.status" });
    await expect(startPacking(env.ctx(STAFF), "not-a-uuid")).rejects.toMatchObject({ code: "error.notFound" });
  });

  it("starts packing: order → awaiting_picking, worker recorded, box only suggested, history event", async () => {
    const r = await startPacking(env.ctx(STAFF), ids["#0998"]!);
    expect(r.kind).toBe("started");
    expect(await orderStatus(ids["#0998"]!)).toBe("awaiting_picking");
    const p = await activePacking(ids["#0998"]!);
    expect(p).toMatchObject({ status: "in_progress", startedBy: STAFF.id, startedByName: STAFF.displayName, generation: 1 });
    // Демо-товари без габаритів: підбір лише за вагою — коробка рекомендована (★), але не підставлена (як і для
    // накладної: типова упаковка). Розбіжності з накладною одразу після початку немає.
    expect(p.boxMaterialId).toBeNull();
    const screen = await loadPackingScreen(env.ctx(), ids["#0998"]!);
    expect(screen.suggestion).toMatchObject({ code: "box_s", reason: "weight_only" });
    expect(screen.mismatch).toBeNull();
    expect(screen.parcel).toMatchObject({ saved: false, savedWeightGrams: null, savedDimsMm: null, lengthMm: null });
    expect((await events(ids["#0998"]!)).map((e) => e.type)).toContain("packing_started");
    // Повтор: те саме пакування, без нового переходу.
    expect(await startPacking(env.ctx(OWNER), ids["#0998"]!)).toMatchObject({ kind: "already_started", startedByName: STAFF.displayName });
    expect(await packingsOf(ids["#0998"]!)).toHaveLength(1);
  });

  it("concurrent starts create exactly one packing and one status transition", async () => {
    const id = ids["#1001"]!;
    const results = await Promise.all([startPacking(env.ctx(STAFF), id), startPacking(env.ctx(OWNER), id), startPacking(env.ctx(STAFF), id)]);
    expect(results.map((r) => r.kind).sort()).toEqual(["already_started", "already_started", "started"]);
    expect(await packingsOf(id)).toHaveLength(1);
    const [transitions] = await env.handle.db
      .select({ c: count() })
      .from(auditLog)
      .where(and(eq(auditLog.entityId, id), eq(auditLog.action, "order.status_changed")));
    // waybill_created → awaiting_picking — рівно один раз (створення накладної пише власні записи).
    const rows = await env.handle.db.select({ details: auditLog.details }).from(auditLog).where(and(eq(auditLog.entityId, id), eq(auditLog.action, "order.status_changed")));
    expect(rows.filter((r) => (r.details as Record<string, unknown>).source === "packing")).toHaveLength(1);
    expect(Number(transitions?.c)).toBeGreaterThanOrEqual(1);
  });

  it("bulk start reports started / already started / skipped", async () => {
    const s = await startPackingBulk(env.ctx(STAFF), [ids["#1002"]!, ids["#1001"]!, ids["#1003"]!, ids["#1002"]!]);
    expect(s).toMatchObject({ started: 1, alreadyStarted: 1, alreadyPacked: 0 });
    expect(s.skipped).toEqual([{ orderId: ids["#1003"], code: "packing.error.status", params: { status: "awaiting_review" } }]);
  });

  it("right after start on a default-package waybill there is no parcel mismatch (regression)", async () => {
    // Накладна, створена createWaybill: товари без габаритів → типова упаковка (35 × 25 × 8 см), підбір «лише за вагою».
    for (const number of ["#1001", "#1002"]) {
      const id = ids[number]!;
      const shipment = await findActiveShipment(env.handle.db, id);
      expect(shipment!.requestSnapshot).toMatchObject({ parcelSource: "default_package", autoBoxReason: "weight_only", parcelBoxMaterialId: null });
      expect((await activePacking(id)).boxMaterialId).toBeNull();
      const screen = await loadPackingScreen(env.ctx(), id);
      expect(screen.suggestion).toMatchObject({ code: "box_s", reason: "weight_only" });
      expect(screen.waybillParcel).toMatchObject({ dimsMm: [350, 250, 80] });
      expect(screen.mismatch).toBeNull();
      expect((await loadPackingSummary(env.handle.db, id)).mismatch).toBeNull();
    }
  });
});

describe("scanning and manual adjustments", () => {
  it("each scan adds one unit; wrong item, unknown code and over-quantity are clear errors", async () => {
    const id = ids["#1001"]!; // тримач чорний ×1 + гріпси чорні ×1
    const first = await recordScan(env.ctx(STAFF), id, "4820000000017\r\n");
    expect(first).toMatchObject({ kind: "matched", line: { sku: "OT-PH-BLK", packed: 1, required: 1 } });
    expect(await recordScan(env.ctx(STAFF), id, "4820000000017")).toMatchObject({ kind: "over_quantity", line: { packed: 1, required: 1 } });
    expect(await recordScan(env.ctx(STAFF), id, "OT-FK-X")).toMatchObject({ kind: "wrong_item", code: "OT-FK-X", productTitle: expect.any(String) });
    expect(await recordScan(env.ctx(STAFF), id, "NO-SUCH-CODE")).toEqual({ kind: "unknown_code", code: "NO-SUCH-CODE" });
    expect(await recordScan(env.ctx(STAFF), id, "  ")).toEqual({ kind: "empty" });
    const done = await recordScan(env.ctx(STAFF), id, "ot-gr-blk");
    expect(done).toMatchObject({ kind: "matched", progress: { complete: true, packedUnits: 2, requiredUnits: 2 } });
    await expect(recordScan(env.ctx(NO_PACKING), id, "x")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("manual ±1 requires a reason code and stays within bounds", async () => {
    const id = ids["#1002"]!; // крило Model X ×1
    const screen = await loadPackingScreen(env.ctx(), id);
    const line = screen.lines[0]!;
    await expect(adjustPackedLine(env.ctx(STAFF), id, line.id, 1, "nope" as never)).rejects.toMatchObject({ code: "packing.error.reasonRequired" });
    expect(await adjustPackedLine(env.ctx(STAFF), id, line.id, -1, "correction")).toEqual({ kind: "below_zero" });
    expect(await adjustPackedLine(env.ctx(STAFF), id, line.id, 1, "barcode_unreadable")).toMatchObject({ kind: "ok", line: { packed: 1 } });
    expect(await adjustPackedLine(env.ctx(STAFF), id, line.id, 1, "barcode_unreadable")).toMatchObject({ kind: "over_quantity" });
    expect(await adjustPackedLine(env.ctx(STAFF), id, line.id, -1, "correction")).toMatchObject({ kind: "ok", line: { packed: 0 } });
    const [audit] = await env.handle.db.select({ c: count() }).from(auditLog).where(and(eq(auditLog.entityId, id), eq(auditLog.action, "packing.manual_adjust")));
    expect(Number(audit?.c)).toBe(2);
  });

  it("scanning requires a started packing", async () => {
    await expect(recordScan(env.ctx(STAFF), ids["#1009"]!, "4820000000017")).rejects.toMatchObject({ code: "packing.error.notStarted" });
  });
});

describe("confirm «Packed»", () => {
  it("is blocked while the checklist is incomplete; only the owner may override, with a reason", async () => {
    const id = ids["#1009"]!; // тримач чорний ×1
    await startPacking(env.ctx(STAFF), id);
    const p = await activePacking(id);
    await expect(confirmPacked(env.ctx(STAFF), id, p.version)).rejects.toMatchObject({ code: "packing.error.checklistIncomplete", params: { packed: 0, required: 1 } });
    await expect(confirmPacked(env.ctx(STAFF), id, p.version, { override: { reason: "погоджено з клієнтом" } })).rejects.toMatchObject({
      code: "packing.error.overrideOwnerOnly",
    });
    await expect(confirmPacked(env.ctx(OWNER), id, p.version, { override: { reason: " x " } })).rejects.toMatchObject({ code: "packing.error.overrideReasonRequired" });
    await expect(confirmPacked(env.ctx(OWNER), id, p.version + 5)).rejects.toBeInstanceOf(ConflictError);
    expect(await orderStatus(id)).toBe("awaiting_picking");
    expect(await consumeMovements(p.id)).toHaveLength(0);
  });

  it("is idempotent: confirming twice (or concurrently) consumes materials once and transitions once", async () => {
    const id = ids["#1001"]!; // повний комплект відскановано вище
    // Пакувальник вибирає рекомендовану коробку S (лише коробку: вага й габарити не вводилися).
    const [boxS] = await env.handle.db.select().from(packagingMaterials).where(eq(packagingMaterials.code, "box_s"));
    const saved = await savePackingParcel(env.ctx(STAFF), id, { expectedVersion: (await activePacking(id)).version, boxMaterialId: boxS!.id });
    expect(saved.changed).toEqual(["parcel.box"]);
    // Рекомендована коробка S (200 × 150 × 80) вміщується в габарити типової упаковки накладної (35 × 25 × 8 см —
    // верхня межа, а не вимір) → не розбіжність (e2e-3): вибір ★ сам по собі не вимагає переоформлення.
    expect(saved.mismatch).toBeNull();
    const p = await activePacking(id);
    const before = { box: await materialOnHand("box_s"), sticker: await materialOnHand("sticker_logo"), card: await materialOnHand("card_thanks") };
    const [a, b] = await Promise.all([confirmPacked(env.ctx(STAFF), id, p.version), confirmPacked(env.ctx(STAFF), id, p.version)]);
    expect([a.kind, b.kind].sort()).toEqual(["already_packed", "packed"]);
    const packedResult = a.kind === "packed" ? a : b;
    if (packedResult.kind !== "packed") throw new Error("unreachable");
    expect(packedResult.override).toBe(false);
    expect(packedResult.materials.alreadyConsumed).toBe(false);
    expect(packedResult.materials.lines.map((l) => [l.code, l.consumed]).sort()).toEqual([
      ["box_s", 1],
      ["card_thanks", 1],
      ["sticker_logo", 1],
    ]);
    expect(await orderStatus(id)).toBe("packed");
    expect(await activePacking(id)).toMatchObject({ status: "packed", packedBy: STAFF.id, packedByName: STAFF.displayName });
    expect(await consumeMovements(p.id)).toHaveLength(3);
    // Ще раз (стара версія, повторне натискання) — нічого не змінює.
    expect(await confirmPacked(env.ctx(STAFF), id, p.version)).toMatchObject({ kind: "already_packed" });
    expect(await consumeMovements(p.id)).toHaveLength(3);
    expect({ box: await materialOnHand("box_s"), sticker: await materialOnHand("sticker_logo"), card: await materialOnHand("card_thanks") }).toEqual({
      box: before.box - 1,
      sticker: before.sticker - 1,
      card: before.card - 1,
    });
    expect((await events(id)).map((e) => e.type)).toContain("packed");
    // Запаковане замовлення не скануємо й пакування не починаємо вдруге.
    await expect(recordScan(env.ctx(STAFF), id, "4820000000017")).rejects.toMatchObject({ code: "packing.error.alreadyPacked" });
    expect(await startPacking(env.ctx(STAFF), id)).toMatchObject({ kind: "already_packed" });
  });

  it("owner override with a reason is recorded in the order history and the audit log", async () => {
    const id = ids["#1009"]!;
    const p = await activePacking(id);
    const r = await confirmPacked(env.ctx(OWNER), id, p.version, { override: { reason: "Частина товару — окремою посилкою, тел. +380 67 123 45 67" } });
    expect(r).toMatchObject({ kind: "packed", override: true });
    const ev = (await events(id)).find((e) => e.type === "packed_override");
    expect(ev?.message).toContain("окремою посилкою");
    expect(ev?.message).not.toContain("123 45 67");
    const [audit] = await env.handle.db.select({ details: auditLog.details }).from(auditLog).where(and(eq(auditLog.entityId, id), eq(auditLog.action, "packing.confirmed_override")));
    expect(audit?.details).toMatchObject({ packedUnits: 0, requiredUnits: 1 });
    expect(JSON.stringify(audit?.details)).not.toContain("посилкою");
  });
});

describe("unpack and repack", () => {
  it("returns the order to picking; repacking never consumes materials twice", async () => {
    const id = ids["#1001"]!;
    const p = await activePacking(id);
    const movements = (await consumeMovements(p.id)).length;
    expect(await unpackOrder(env.ctx(STAFF), id)).toEqual({ kind: "unpacked", packingId: p.id, materialsConsumed: true, status: "awaiting_picking" });
    expect(await orderStatus(id)).toBe("awaiting_picking");
    expect(await activePacking(id)).toMatchObject({ id: p.id, status: "in_progress", packedBy: null, packedAt: null });
    expect(await unpackOrder(env.ctx(STAFF), id)).toEqual({ kind: "not_packed" });
    const again = await confirmPacked(env.ctx(STAFF), id, (await activePacking(id)).version);
    expect(again).toMatchObject({ kind: "packed", materials: { alreadyConsumed: true } });
    expect(await consumeMovements(p.id)).toHaveLength(movements);
    // Розпакування зі скиданням чекліста → «Запаковано» знову лише з повним комплектом.
    await unpackOrder(env.ctx(STAFF), id, { resetChecklist: true });
    const reset = await activePacking(id);
    expect(reset.checklist).toEqual({});
    await expect(confirmPacked(env.ctx(STAFF), id, reset.version)).rejects.toMatchObject({ code: "packing.error.checklistIncomplete" });
    await scanAll(id);
    expect(await confirmPacked(env.ctx(STAFF), id, (await activePacking(id)).version)).toMatchObject({ kind: "packed" });
    expect((await events(id)).filter((e) => e.type === "unpacked")).toHaveLength(2);
  });

  it("a handed-over order cannot be unpacked", async () => {
    const id = ids["#1009"]!; // запаковано (рішення власника)
    const shipment = await findActiveShipment(env.handle.db, id);
    await markHandedOver(env.ctx(OWNER), shipment!.id);
    await expect(unpackOrder(env.ctx(STAFF), id)).rejects.toMatchObject({ code: "packing.error.status" });
  });
});

describe("parcel and mismatch with the waybill", () => {
  it("saves box/weight/dimensions as a manual order correction with history; warns about waybill mismatch", async () => {
    const id = ids["#0998"]!;
    const shipment = await findActiveShipment(env.handle.db, id);
    const waybillWeight = shipment!.actualWeightGrams!;
    const [boxM] = await env.handle.db.select().from(packagingMaterials).where(eq(packagingMaterials.code, "box_m"));
    let p = await activePacking(id);
    await expect(savePackingParcel(env.ctx(NO_PACKING), id, { expectedVersion: p.version, boxMaterialId: boxM!.id })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(savePackingParcel(env.ctx(STAFF), id, { expectedVersion: p.version, boxMaterialId: null, lengthMm: "300" })).rejects.toBeInstanceOf(ZodError);
    await expect(savePackingParcel(env.ctx(STAFF), id, { expectedVersion: p.version + 1, boxMaterialId: null })).rejects.toBeInstanceOf(ConflictError);

    // Коробка M (300×200×120) ≠ типова упаковка накладної (350×250×80) → попередження за габаритами.
    const r1 = await savePackingParcel(env.ctx(STAFF), id, { expectedVersion: p.version, boxMaterialId: boxM!.id, weightGrams: String(waybillWeight) });
    expect(r1.changed.sort()).toEqual(["parcel.box", "parcel.weightGrams"]);
    expect(r1.mismatch).toMatchObject({ weight: null, dims: { packedMm: [300, 200, 120] } });
    const [order] = await env.handle.db.select().from(orders).where(eq(orders.id, id));
    expect(order).toMatchObject({ parcelBoxMaterialId: boxM!.id, parcelWeightGrams: waybillWeight, parcelLengthMm: null });
    const history = await env.handle.db.select().from(orderChanges).where(and(eq(orderChanges.orderId, id), inArray(orderChanges.field, ["parcel.box", "parcel.weightGrams"])));
    expect(history.map((h) => [h.field, h.newValue, h.source]).sort()).toEqual([
      ["parcel.box", "box_m", "manual"],
      ["parcel.weightGrams", String(waybillWeight), "manual"],
    ]);

    // Габарити як у накладній, вага в межах 10 % → без попередження.
    p = await activePacking(id);
    const ok = await savePackingParcel(env.ctx(STAFF), id, {
      expectedVersion: p.version,
      boxMaterialId: boxM!.id,
      weightGrams: String(Math.round(waybillWeight * 1.1)),
      lengthMm: "80",
      widthMm: "250",
      heightMm: "350",
    });
    expect(ok.mismatch).toBeNull();
    // Зважена вага більша на 50 % → попередження за вагою; видно й на сторінці замовлення.
    p = await activePacking(id);
    const heavy = await savePackingParcel(env.ctx(STAFF), id, {
      expectedVersion: p.version,
      boxMaterialId: boxM!.id,
      weightGrams: String(Math.round(waybillWeight * 1.5)),
      lengthMm: "350",
      widthMm: "250",
      heightMm: "80",
    });
    expect(heavy.mismatch).toMatchObject({ weight: { waybillGrams: waybillWeight }, dims: null });
    expect((await loadPackingSummary(env.handle.db, id)).mismatch).toMatchObject({ weight: { waybillGrams: waybillWeight } });
    expect((await loadPackingScreen(env.ctx(), id)).shipment).toMatchObject({ reissuable: true });

    // Після «Запаковано» коробку не змінити (матеріали вже списано) — лише вагу/габарити.
    await scanAll(id);
    p = await activePacking(id);
    const packed = await confirmPacked(env.ctx(STAFF), id, p.version);
    expect(packed).toMatchObject({ kind: "packed", mismatch: { weight: { waybillGrams: waybillWeight } } });
    p = await activePacking(id);
    await expect(savePackingParcel(env.ctx(STAFF), id, { expectedVersion: p.version, boxMaterialId: null })).rejects.toMatchObject({ code: "packing.error.boxLocked" });
    const fixed = await savePackingParcel(env.ctx(STAFF), id, { expectedVersion: p.version, boxMaterialId: boxM!.id, weightGrams: String(waybillWeight), lengthMm: "350", widthMm: "250", heightMm: "80" });
    expect(fixed.mismatch).toBeNull();
    // Box M: коробку M списано один раз.
    const consumed = await consumeMovements(p.id);
    expect(consumed.filter((m) => m.reason === "packing_box")).toHaveLength(1);
  });
});

describe("priority and queue", () => {
  it("priority requires orders.edit and is not changed after handover", async () => {
    await expect(setOrderPriority(env.ctx(NO_EDIT), ids["#1011"]!, 2)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await setOrderPriority(env.ctx(STAFF), ids["#1011"]!, 2)).toEqual({ changed: true, priority: 2 });
    expect(await setOrderPriority(env.ctx(STAFF), ids["#1011"]!, 2)).toEqual({ changed: false, priority: 2 });
    await expect(setOrderPriority(env.ctx(STAFF), ids["#1009"]!, 1)).rejects.toMatchObject({ code: "packing.error.priorityStatus" });
    const bulk = await setOrdersPriority(env.ctx(STAFF), [ids["#1012"]!, ids["#1009"]!], 1);
    expect(bulk).toMatchObject({ updated: 1, unchanged: 0 });
    expect(bulk.skipped.map((s) => s.code)).toEqual(["packing.error.priorityStatus"]);
  });

  it("is sorted by priority ↓ then order date ↑ and shows worker fixation", async () => {
    const q = await listPackingQueue(env.ctx(), parseQueueFilters(new URLSearchParams()));
    const keys = q.rows.map((r) => [r.priority, new Date(r.placedAt).getTime()] as const);
    const sorted = [...keys].sort((a, b) => (a[0] !== b[0] ? b[0] - a[0] : a[1] - b[1]));
    expect(keys).toEqual(sorted);
    expect(q.rows[0]!.id).toBe(ids["#1011"]); // терміновий
    const numbers = q.rows.map((r) => r.orderNumber);
    expect(numbers).not.toContain("#1009"); // передано перевізнику
    expect(numbers).not.toContain("#1003"); // без накладної — окрема вкладка
    const row1001 = q.rows.find((r) => r.id === ids["#1001"])!;
    // Хто почав #1001 — переможець паралельного «Почати» вище (на PostgreSQL під навантаженням це може бути власник).
    expect(row1001).toMatchObject({ status: "packed", packing: { startedByName: CONCURRENT_STARTER, packedByName: STAFF.displayName }, waybill: { testMode: true, labelAvailable: true } });
    expect(q.counts.queue).toBe(q.total);
    expect(q.counts.needs_waybill).toBeGreaterThanOrEqual(1);
  });

  it("filters by tab, priority, country, model, color and worker", async () => {
    const list = async (search: string) => (await listPackingQueue(env.ctx(), parseQueueFilters(new URLSearchParams(search)))).rows.map((r) => r.orderNumber).sort();
    expect(await list("tab=packed")).toEqual(expect.arrayContaining(["#1001", "#0998"]));
    expect(await list("tab=needs_waybill")).toContain("#1003");
    expect(await list("tab=awaiting_picking")).toEqual(["#1002"]);
    expect(await list("tab=waybill_created")).toEqual(["#1011", "#1012"]);
    expect(await list("priority=2")).toEqual(["#1011"]);
    expect(await list("country=PL")).toEqual(["#1002"]);
    expect(await list("model=Model%20X")).toEqual(["#1002", "#1012"]);
    expect(await list(`color=${encodeURIComponent("Чорний")}`)).toEqual(["#1001", "#1011"]);
    expect(await list(`worker=${STAFF.id}`)).toEqual(expect.arrayContaining(["#1001", "#1002", "#0998"]));
    expect(await list("worker=nobody")).toEqual([]);
    expect(await list("q=100")).toEqual(["#1001", "#1002"]);
    expect(await list("q=%231011")).toEqual(["#1011"]);
    const q = await listPackingQueue(env.ctx(), parseQueueFilters(new URLSearchParams("tab=packed")));
    expect(q.options.models).toContain("Model X");
    expect(q.options.workers).toEqual(expect.arrayContaining([{ id: STAFF.id, name: STAFF.displayName }]));
  });
});

describe("history of the packing (order page)", () => {
  it("summary shows the worker and progress; packing events are shipment events of the order", async () => {
    const s = await loadPackingSummary(env.handle.db, ids["#1001"]!);
    expect(s).toMatchObject({ status: "packed", inQueue: true, packing: { status: "packed", startedByName: CONCURRENT_STARTER, boxCode: "box_s" }, materialsConsumed: true });
    const none = await loadPackingSummary(env.handle.db, ids["#1011"]!);
    expect(none).toMatchObject({ packing: null, inQueue: true, priority: 2 });
    await expect(loadPackingSummary(env.handle.db, "bad")).rejects.toBeInstanceOf(DomainError);
  });
});

describe("concurrency of the checklist", () => {
  it("parallel scans of the last unit count it once (the rest are over-quantity)", async () => {
    const id = ids["#1012"]!; // крило Model X ×1 + тримач білий ×1
    await startPacking(env.ctx(STAFF), id);
    const results = await Promise.all([1, 2, 3].map(() => recordScan(env.ctx(STAFF), id, "OT-FK-X")));
    expect(results.map((r) => r.kind).sort()).toEqual(["matched", "over_quantity", "over_quantity"]);
    const p = await activePacking(id);
    expect(Object.values(p.checklist)).toEqual([1]);
    // Паралельні «Запаковано» й «Розпакувати» не ламають стан: замовлення в одному з дозволених статусів.
    await recordScan(env.ctx(STAFF), id, "OT-PH-WHT");
    const ready = await activePacking(id);
    await confirmPacked(env.ctx(STAFF), id, ready.version);
    const settled = await Promise.allSettled([unpackOrder(env.ctx(STAFF), id), unpackOrder(env.ctx(STAFF), id)]);
    expect(settled.map((s) => (s.status === "fulfilled" ? s.value.kind : "error")).sort()).toEqual(["not_packed", "unpacked"]);
    expect(await orderStatus(id)).toBe("awaiting_picking");
    // Наліпка, візитка + для крила болти й інструкція — кожен матеріал один раз (коробку не вибирали — не списується).
    expect(await consumeMovements(ready.id)).toHaveLength(4);
  });
});

describe("lock ordering with the carrier handover", () => {
  it("concurrent «Packed» and handover to the carrier never deadlock (one wins, state stays consistent)", async () => {
    const id = ids["#1011"]!;
    await startPacking(env.ctx(STAFF), id);
    await scanAll(id);
    const p = await activePacking(id);
    const shipment = await findActiveShipment(env.handle.db, id);
    // Етап 5 (контроль комплектації): передача незапакованого — лише рішенням власника з причиною; з нею передача
    // фіксується завжди (з «Очікує комплектації» — пакування підтверджується під час передачі — або з «Запаковано»).
    const settled = await Promise.allSettled([
      confirmPacked(env.ctx(STAFF), id, p.version),
      markHandedOver(env.ctx(OWNER), shipment!.id, { packingOverride: { reason: "race test: courier is waiting" } }),
    ]);
    for (const s of settled) {
      if (s.status === "rejected") {
        expect(String((s.reason as Error)?.message ?? s.reason)).not.toMatch(/deadlock/i);
        expect(s.reason).toBeInstanceOf(DomainError);
      }
    }
    expect(settled[1]!.status).toBe("fulfilled");
    expect(await orderStatus(id)).toBe("handed_to_carrier");
    // Матеріали списано рівно один раз, хоч би хто виграв.
    const consumed = await consumeMovements(p.id);
    expect(new Set(consumed.map((m) => m.idempotencyKey)).size).toBe(consumed.length);
    expect(consumed.length).toBeGreaterThan(0);
  });
});
