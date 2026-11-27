import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  inventoryBalances,
  inventoryMovements,
  kitTemplates,
  orderChanges,
  orderLineItems,
  orderPacking,
  orders,
  packagingMaterials,
  productVariants,
  stockItems,
} from "~/db/schema";
import { ForbiddenError, makeActor } from "~/domain/permissions";
import { ConflictError } from "~/lib/errors";
import { loadOrderRow } from "~/modules/orders/repository.server";
import { validateOrderById } from "~/modules/orders/workflow.server";
import { loadPrintBatch } from "~/modules/packing/documents.server";
import {
  adjustPackedLine,
  confirmPacked,
  recordScan,
  saveOrderParcel,
  savePackingParcel,
  startPacking,
  unpackOrder,
} from "~/modules/packing/packing.server";
import { loadPickList } from "~/modules/packing/pick-list.server";
import { parseQueueFilters } from "~/modules/packing/queue-filters";
import { listPackingQueue } from "~/modules/packing/queue.server";
import { loadPackingScreen, loadPackingSummary } from "~/modules/packing/view.server";
import { createWaybill, findActiveShipment } from "~/modules/shipments/waybill.server";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";

/**
 * G1b2 (пакування, база): коробка за розміром для однієї одиниці в накладній і пакуванні (production-1), повторне
 * пакування в іншу коробку списує нову коробку один раз (packing-6 / inventory-6), списується перелік, який бачив
 * пакувальник (production-5), пакувальний лист до початку — з коробкою накладної (production-m1), неоднозначний код у
 * каталозі (packing-9), порожній чекліст (packing-10), −1 для зайвих одиниць (packing-8), дані покупця й дозволи
 * (security-3), посилка до накладної (gap-5), зведений лист комплектації (gap-7).
 */
let env: TestEnv;
const ids: Record<string, string> = {};

const NO_PACKING = makeActor({ id: "np", displayName: "NP", role: "staff", overrides: { revoke: ["packing.perform"] } });
/** Пакувальник без перегляду й редагування замовлень (гнучкі права, розділ «Працівники»). */
const PACKER = makeActor({ id: "packer-only", displayName: "Packer", role: "staff", overrides: { revoke: ["orders.view", "orders.edit"] } });

async function prepare(number: string, opts: { waybill?: boolean } = {}) {
  const id = await env.orderId(number);
  await validateOrderById(env.ctx(OWNER), id);
  if (opts.waybill !== false) {
    const r = await createWaybill(env.ctx(OWNER), id, { source: "manual" });
    if (r.kind !== "created") throw new Error(`waybill for ${number}: ${r.kind}`);
  }
  ids[number] = id;
  return id;
}

beforeAll(async () => {
  env = await createTestEnv();
  // production-1: крило Model X (одна одиниця) майже точно за розміром коробки S (200 × 150 × 80).
  await env.handle.db.update(productVariants).set({ lengthMm: 200, widthMm: 150, heightMm: 75 }).where(eq(productVariants.sku, "OT-FK-X"));
  for (const number of ["#1001", "#1002", "#1009", "#1011", "#1012"]) await prepare(number);
  ids["#0998"] = await env.orderId("#0998"); // накладна вже є (історія демо)
  await prepare("#1003", { waybill: false }); // «Очікує перевірки», без накладної
});
afterAll(async () => {
  await env.close();
});

async function activePacking(id: string) {
  const rows = await env.handle.db.select().from(orderPacking).where(and(eq(orderPacking.orderId, id), inArray(orderPacking.status, ["queued", "in_progress", "packed"])));
  expect(rows).toHaveLength(1);
  return rows[0]!;
}
async function materialId(code: string) {
  const [m] = await env.handle.db.select({ id: packagingMaterials.id }).from(packagingMaterials).where(eq(packagingMaterials.code, code));
  return m!.id;
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
async function consumed(packingId: string) {
  const rows = await env.handle.db
    .select({ code: packagingMaterials.code, delta: inventoryMovements.onHandDelta })
    .from(inventoryMovements)
    .innerJoin(stockItems, eq(stockItems.id, inventoryMovements.stockItemId))
    .innerJoin(packagingMaterials, eq(packagingMaterials.id, stockItems.materialId))
    .where(and(eq(inventoryMovements.packingId, packingId), eq(inventoryMovements.type, "material_consume")));
  return rows.map((r) => `${r.code}:${-r.delta}`).sort();
}
async function scanAll(orderId: string) {
  const screen = await loadPackingScreen(env.ctx(), orderId);
  for (const line of screen.lines) {
    for (let i = line.packed; i < line.required; i += 1) {
      expect((await recordScan(env.ctx(STAFF), orderId, line.barcode ?? line.sku ?? "")).kind).toBe("matched");
    }
  }
}

describe("gap-7: consolidated pick list", () => {
  it("sums units per variant across the selected orders, with per-order split, stock, materials and skipped orders", async () => {
    await expect(loadPickList(env.ctx(NO_PACKING), [ids["#1001"]!])).rejects.toBeInstanceOf(ForbiddenError);
    const list = await loadPickList(env.ctx(PACKER), [ids["#1001"]!, ids["#1009"]!, ids["#1002"]!, ids["#1012"]!, ids["#1003"]!, "00000000-0000-4000-8000-000000000000"]);
    expect(list.included.map((o) => o.orderNumber).sort()).toEqual(["#1001", "#1002", "#1009", "#1012"]);
    expect(list.skipped).toEqual([{ orderId: ids["#1003"], orderNumber: "#1003", reason: "not_in_queue" }]);
    expect(list.missing).toBe(1);
    const bySku = new Map(list.items.map((i) => [i.sku, i]));
    // Тримач чорний: #1001 ×1 + #1009 ×1; крило Model X: #1002 ×1 + #1012 ×1.
    expect(bySku.get("OT-PH-BLK")).toMatchObject({ quantity: 2, color: "Чорний", barcode: "4820000000017" });
    expect(bySku.get("OT-PH-BLK")!.orders.map((o) => `${o.orderNumber}×${o.quantity}`).sort()).toEqual(["#1001×1", "#1009×1"]);
    expect(bySku.get("OT-FK-X")).toMatchObject({ quantity: 2, model: "Model X" });
    expect(bySku.get("OT-GR-BLK")!.quantity).toBe(1);
    expect(bySku.get("OT-PH-WHT")!.quantity).toBe(1);
    expect(list.totalUnits).toBe(6);
    expect(list.items.every((i) => i.onHand === null || Number.isInteger(i.onHand))).toBe(true);
    // Коробка S для #1002 (одна одиниця за розміром коробки) — у матеріалах до збирання.
    expect(list.materials.find((m) => m.code === "box_s")).toMatchObject({ isBox: true, quantity: 1 });
    // Без персональних даних покупця.
    expect(JSON.stringify(list)).not.toMatch(/ship(First|Last)Name|recipient/);
  });
});

describe("production-1: a single unit goes into the box that fits it", () => {
  it("the waybill uses box S (not a bigger box) and packing starts with the same box", async () => {
    const id = ids["#1002"]!;
    const shipment = await findActiveShipment(env.handle.db, id);
    const boxS = await materialId("box_s");
    expect(shipment!.requestSnapshot).toMatchObject({ parcelSource: "auto_box", autoBoxReason: "fits", parcelBoxMaterialId: boxS });
    expect((shipment!.requestSnapshot as { parcels: unknown[] }).parcels[0]).toMatchObject({ lengthCm: 20, widthCm: 15, heightCm: 8 });
    expect((await startPacking(env.ctx(STAFF), id)).kind).toBe("started");
    expect((await activePacking(id)).boxMaterialId).toBe(boxS);
    const screen = await loadPackingScreen(env.ctx(), id);
    expect(screen.suggestion).toMatchObject({ code: "box_s", source: "waybill", differsFromWaybill: false });
    expect(screen.mismatch).toBeNull();
  });
});

describe("production-m1: the packing slip printed before packing lists the waybill's box", () => {
  it("an auto-box waybill gives a slip with that box before «Start packing»", async () => {
    const id = ids["#1012"]!; // крило (з габаритами) + тримач білий (з габаритами) → точний підбір для накладної
    const shipment = await findActiveShipment(env.handle.db, id);
    const snapshot = shipment!.requestSnapshot as { parcelSource: string; parcelBoxMaterialId: string };
    expect(snapshot.parcelSource).toBe("auto_box");
    expect(await env.handle.db.select().from(orderPacking).where(eq(orderPacking.orderId, id))).toEqual([]);
    const batch = await loadPrintBatch(env.ctx(STAFF), [id], ["slip"], "uk");
    const [boxM] = await env.handle.db.select().from(packagingMaterials).where(eq(packagingMaterials.id, snapshot.parcelBoxMaterialId));
    expect(batch.entries[0]!.slip!.materials.filter((m) => m.isBox)).toEqual([expect.objectContaining({ code: boxM!.code, quantity: 1 })]);
    // Екран пакування до початку показує той самий перелік; «Почати» підставляє ту саму коробку.
    const screen = await loadPackingScreen(env.ctx(), id);
    expect(screen.materials.filter((m) => m.isBox).map((m) => m.code)).toEqual([boxM!.code]);
    await startPacking(env.ctx(STAFF), id);
    expect((await activePacking(id)).boxMaterialId).toBe(boxM!.id);
  });
});

describe("security-3: packing.perform alone shows no customer data", () => {
  it("without orders.view the screen and queue hide name and city; parcel measurements stay with packing.perform", async () => {
    const id = ids["#1012"]!;
    await expect(loadPackingScreen(env.ctx(NO_PACKING), id)).rejects.toBeInstanceOf(ForbiddenError);
    const full = await loadPackingScreen(env.ctx(STAFF), id);
    expect(full.order.recipientName).toBeTruthy();
    expect(full.order.city).toBeTruthy();
    expect(full.customerDataHidden).toBe(false);
    const limited = await loadPackingScreen(env.ctx(PACKER), id);
    expect(limited.order).toMatchObject({ recipientName: null, city: null, countryCode: full.order.countryCode });
    expect(limited.customerDataHidden).toBe(true);
    const queueRow = async (actor: typeof STAFF) => (await listPackingQueue(env.ctx(actor), parseQueueFilters(new URLSearchParams()))).rows.find((r) => r.id === id)!;
    expect((await queueRow(STAFF)).city).toBeTruthy();
    expect((await queueRow(PACKER)).city).toBeNull();
    // Рішення: фізичні параметри посилки (вага/габарити/коробка) — частина пакування (packing.perform), з історією.
    const saved = await savePackingParcel(env.ctx(PACKER), id, { expectedVersion: limited.packing!.version, boxMaterialId: limited.packing!.boxMaterialId, weightGrams: "4321" });
    expect(saved.changed).toContain("parcel.weightGrams");
    const history = await env.handle.db.select().from(orderChanges).where(and(eq(orderChanges.orderId, id), eq(orderChanges.field, "parcel.weightGrams")));
    expect(history.map((h) => [h.actorId, h.newValue, h.source])).toEqual([["packer-only", "4321", "manual"]]);
  });
});

describe("packing-6 / inventory-6: re-pack in another box writes off the box actually used, once", () => {
  it("box S → Packed → unpack → box M → Packed: M −1, S and the kit are not written off again", async () => {
    const id = ids["#1009"]!; // тримач чорний ×1, без габаритів → накладна з типовою упаковкою
    const [boxS, boxM] = [await materialId("box_s"), await materialId("box_m")];
    await startPacking(env.ctx(STAFF), id);
    await savePackingParcel(env.ctx(STAFF), id, { expectedVersion: (await activePacking(id)).version, boxMaterialId: boxS });
    await scanAll(id);
    const first = await confirmPacked(env.ctx(STAFF), id, (await activePacking(id)).version);
    expect(first).toMatchObject({ kind: "packed", materials: { alreadyConsumed: false } });
    const packingId = (await activePacking(id)).id;
    const afterFirst = await consumed(packingId);
    expect(afterFirst).toContain("box_s:1");
    const stock = { s: await materialOnHand("box_s"), m: await materialOnHand("box_m"), sticker: await materialOnHand("sticker_logo") };

    expect((await unpackOrder(env.ctx(STAFF), id)).kind).toBe("unpacked");
    await savePackingParcel(env.ctx(STAFF), id, { expectedVersion: (await activePacking(id)).version, boxMaterialId: boxM });
    const screen = await loadPackingScreen(env.ctx(), id);
    expect(screen.previousBoxes).toEqual([{ code: "box_s", name: expect.any(String) }]);
    const second = await confirmPacked(env.ctx(STAFF), id, screen.packing!.version, { expectedMaterials: screen.materialsKey });
    if (second.kind !== "packed") throw new Error("expected packed");
    expect(second.materials.alreadyConsumed).toBe(false);
    expect(second.materials.lines.map((l) => [l.code, l.consumed]).filter(([, q]) => q !== 0)).toEqual([["box_m", 1]]);
    expect(await consumed(packingId)).toEqual([...afterFirst, "box_m:1"].sort());
    expect({ s: await materialOnHand("box_s"), m: await materialOnHand("box_m"), sticker: await materialOnHand("sticker_logo") }).toEqual({
      s: stock.s,
      m: stock.m - 1,
      sticker: stock.sticker,
    });

    // Ще раз у ту саму коробку M — нічого нового.
    await unpackOrder(env.ctx(STAFF), id);
    const third = await confirmPacked(env.ctx(STAFF), id, (await activePacking(id)).version);
    expect(third).toMatchObject({ kind: "packed", materials: { alreadyConsumed: true } });
    expect(await consumed(packingId)).toEqual([...afterFirst, "box_m:1"].sort());
    expect(await materialOnHand("box_m")).toBe(stock.m - 1);
  });
});

describe("production-5: what is written off is what the packer saw", () => {
  it("a kit template changed after the screen was loaded → «materials changed», nothing written; the fresh list is consumed", async () => {
    const id = ids["#1011"]!;
    await startPacking(env.ctx(STAFF), id);
    await scanAll(id);
    const seen = await loadPackingScreen(env.ctx(), id);
    expect(seen.materials.length).toBeGreaterThan(0);
    const packingId = seen.packing!.id;
    // Власник вимикає шаблони комплектації, поки пакувальник дивиться на екран.
    const templates = await env.handle.db.select({ id: kitTemplates.id, active: kitTemplates.active }).from(kitTemplates);
    await env.handle.db.update(kitTemplates).set({ active: false });
    try {
      await expect(confirmPacked(env.ctx(STAFF), id, seen.packing!.version, { expectedMaterials: seen.materialsKey })).rejects.toMatchObject({
        code: "packing.error.materialsChanged",
      });
      expect(await consumed(packingId)).toEqual([]);
      expect((await activePacking(id)).status).toBe("in_progress");
      const fresh = await loadPackingScreen(env.ctx(), id);
      expect(fresh.materialsKey).not.toBe(seen.materialsKey);
      const r = await confirmPacked(env.ctx(STAFF), id, fresh.packing!.version, { expectedMaterials: fresh.materialsKey });
      expect(r.kind).toBe("packed");
      expect(await consumed(packingId)).toEqual(fresh.materials.map((m) => `${m.code}:${m.required}`).sort());
    } finally {
      for (const t of templates) await env.handle.db.update(kitTemplates).set({ active: t.active }).where(eq(kitTemplates.id, t.id));
    }
  });
});

describe("packing-9: a barcode/SKU shared in the catalogue is ambiguous", () => {
  it("a barcode copied to another variant (outside the order) is not a confident match; the checklist is unchanged", async () => {
    const id = ids["#1001"]!; // тримач чорний ×1 + гріпси чорні ×1
    await startPacking(env.ctx(STAFF), id);
    const original = await env.handle.db.select({ id: productVariants.id, sku: productVariants.sku, barcode: productVariants.barcode }).from(productVariants);
    try {
      // Сірі гріпси (не в замовленні) отримали штрихкод чорних — типово при копіюванні варіанта в Shopify.
      await env.handle.db.update(productVariants).set({ barcode: "4820000000055" }).where(eq(productVariants.sku, "OT-GR-GRY"));
      const r = await recordScan(env.ctx(STAFF), id, "4820000000055");
      expect(r).toMatchObject({ kind: "ambiguous", scope: "catalog", code: "4820000000055", count: 2 });
      if (r.kind !== "ambiguous") throw new Error("unreachable");
      expect(r.variants.map((v) => v.variantTitle).sort()).toEqual(["Сірі", "Чорні"]);
      expect((await activePacking(id)).checklist).toEqual({});
      // SKU позиції, який є ШТРИХКОДОМ іншого товару, — теж неоднозначний.
      await env.handle.db.update(productVariants).set({ barcode: "OT-PH-BLK" }).where(eq(productVariants.sku, "OT-BG-BLK"));
      expect(await recordScan(env.ctx(STAFF), id, "ot-ph-blk")).toMatchObject({ kind: "ambiguous", scope: "catalog", count: 2 });
      expect((await activePacking(id)).checklist).toEqual({});
      // Унікальний штрихкод — звичайний збіг.
      expect(await recordScan(env.ctx(STAFF), id, "4820000000017")).toMatchObject({ kind: "matched" });
    } finally {
      for (const v of original) await env.handle.db.update(productVariants).set({ barcode: v.barcode }).where(eq(productVariants.id, v.id));
    }
  });
});

describe("packing-8: staff can remove extra units with −1", () => {
  it("a line over-packed by 3 (quantity reduced after scanning) is fixed by three −1 without the owner", async () => {
    const id = ids["#1001"]!;
    const screen = await loadPackingScreen(env.ctx(), id);
    const line = screen.lines.find((l) => l.sku === "OT-PH-BLK")!;
    const p = await activePacking(id);
    await env.handle.db.update(orderPacking).set({ checklist: { ...p.checklist, [line.id]: 4 } }).where(eq(orderPacking.id, p.id));
    for (const expected of [3, 2, 1]) {
      expect(await adjustPackedLine(env.ctx(STAFF), id, line.id, -1, "correction")).toMatchObject({ kind: "ok", line: { packed: expected, required: 1 } });
    }
    expect(await adjustPackedLine(env.ctx(STAFF), id, line.id, 1, "correction")).toMatchObject({ kind: "over_quantity" });
    // Позиція, якої вже немає в замовленні (кількість 0): одиниці видно на екрані й знімаються −1.
    await env.handle.db.update(orderLineItems).set({ currentQuantity: 0 }).where(eq(orderLineItems.id, line.id));
    try {
      const stale = await loadPackingScreen(env.ctx(), id);
      expect(stale.staleLines).toEqual([expect.objectContaining({ id: line.id, packed: 1, title: expect.any(String) })]);
      expect(await adjustPackedLine(env.ctx(STAFF), id, line.id, -1, "correction")).toMatchObject({ kind: "ok", line: { packed: 0 } });
      expect((await loadPackingScreen(env.ctx(), id)).staleLines).toEqual([]);
    } finally {
      await env.handle.db.update(orderLineItems).set({ currentQuantity: null }).where(eq(orderLineItems.id, line.id));
    }
  });
});

describe("packing-10: an empty checklist is not a complete set", () => {
  it("staff cannot confirm a parcel with nothing to check; the owner can, with a reason", async () => {
    const id = ids["#0998"]!; // світло ×1, накладна вже є
    await startPacking(env.ctx(STAFF), id);
    await env.handle.db.update(orderLineItems).set({ currentQuantity: 0 }).where(eq(orderLineItems.orderId, id));
    const screen = await loadPackingScreen(env.ctx(), id);
    expect(screen.progress).toMatchObject({ requiredUnits: 0, complete: true });
    await expect(confirmPacked(env.ctx(STAFF), id, screen.packing!.version)).rejects.toMatchObject({ code: "packing.error.nothingToPack" });
    await expect(confirmPacked(env.ctx(OWNER), id, screen.packing!.version)).rejects.toMatchObject({ code: "packing.error.nothingToPack" });
    expect((await activePacking(id)).status).toBe("in_progress");
    const r = await confirmPacked(env.ctx(OWNER), id, screen.packing!.version, { override: { reason: "усі позиції повернено, порожня посилка" } });
    expect(r).toMatchObject({ kind: "packed", override: true });
  });
});

describe("gap-5: parcel weight and dimensions before the waybill", () => {
  it("are saved on the order with history and used by the next waybill", async () => {
    const id = ids["#1003"]!; // «Очікує перевірки», без накладної
    const before = await loadPackingScreen(env.ctx(), id);
    expect(before.parcelTarget).toBe("order");
    expect((await loadPackingSummary(env.handle.db, id)).parcelBeforeWaybill).toBe(true);
    const order = await loadOrderRow(env.handle.db, id);
    expect(before.order.version).toBe(order.version);
    await expect(saveOrderParcel(env.ctx(NO_PACKING), id, { expectedVersion: order.version, weightGrams: "1800" })).rejects.toBeInstanceOf(ForbiddenError);
    const r = await saveOrderParcel(env.ctx(STAFF), id, { expectedVersion: order.version, weightGrams: "1800", lengthMm: "300", widthMm: "200", heightMm: "100" });
    expect(r.changed.sort()).toEqual(["parcel.heightMm", "parcel.lengthMm", "parcel.weightGrams", "parcel.widthMm"]);
    expect(r.version).toBe(order.version + 1);
    // Застаріла форма (стара версія замовлення) — конфлікт.
    await expect(saveOrderParcel(env.ctx(STAFF), id, { expectedVersion: order.version, weightGrams: "1900" })).rejects.toBeInstanceOf(ConflictError);
    const history = await env.handle.db.select({ field: orderChanges.field, actorId: orderChanges.actorId }).from(orderChanges).where(eq(orderChanges.orderId, id));
    expect(history.filter((h) => h.field.startsWith("parcel.")).map((h) => h.actorId)).toEqual(Array(4).fill(STAFF.id));

    const created = await createWaybill(env.ctx(OWNER), id, { source: "manual" });
    expect(created.kind).toBe("created");
    const shipment = await findActiveShipment(env.handle.db, id);
    expect(shipment!.requestSnapshot).toMatchObject({ parcelSource: "manual", parcelWeightSource: "manual" });
    expect((shipment!.requestSnapshot as { parcels: unknown[] }).parcels[0]).toMatchObject({ lengthCm: 30, widthCm: 20, heightCm: 10, actualWeightGrams: 1800 });
    const [row] = await env.handle.db.select({ w: orders.parcelWeightGrams }).from(orders).where(eq(orders.id, id));
    expect(row!.w).toBe(1800);
    // Після накладної — шлях пакування (порівняння з накладною), а не цей.
    const fresh = await loadOrderRow(env.handle.db, id);
    await expect(saveOrderParcel(env.ctx(STAFF), id, { expectedVersion: fresh.version, weightGrams: "1900" })).rejects.toMatchObject({ code: "packing.error.status" });
    expect((await loadPackingScreen(env.ctx(), id)).parcelTarget).toBeNull();
    expect((await loadPackingSummary(env.handle.db, id)).parcelBeforeWaybill).toBe(false);
  });
});

describe("gap-7: pick list after packing", () => {
  it("skips packed orders with a reason", async () => {
    const list = await loadPickList(env.ctx(STAFF), [ids["#1009"]!, ids["#1002"]!]);
    expect(list.skipped).toEqual([{ orderId: ids["#1009"], orderNumber: "#1009", reason: "packed" }]);
    expect(list.included.map((o) => o.orderNumber)).toEqual(["#1002"]);
  });
});
