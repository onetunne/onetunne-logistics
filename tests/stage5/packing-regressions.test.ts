import { and, count, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, inventoryMovements, orderPacking, orders, packagingMaterials, productVariants, shipmentEvents, shipments } from "~/db/schema";
import { DomainError } from "~/lib/errors";
import { validateOrderById } from "~/modules/orders/workflow.server";
import { confirmPacked, recordScan, startPacking, startPackingBulk, unpackOrder } from "~/modules/packing/packing.server";
import { parseQueueFilters } from "~/modules/packing/queue-filters";
import { countPackingQueue, listPackingQueue } from "~/modules/packing/queue.server";
import { loadPackingScreen, loadPackingSummary } from "~/modules/packing/view.server";
import { cancelWaybill, createWaybill, findActiveShipment } from "~/modules/shipments/waybill.server";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";

/**
 * Регресії пакування (рецензія):
 * 1) коробка за замовчуванням узгоджена з накладною — неточний підбір (лише за вагою / частина без габаритів) не
 *    підставляється, тож одразу після «Почати пакування» немає хибного «Посилка відрізняється від накладної»;
 *    точний підбір (усі товари з габаритами) — підставляється;
 * 2) накладну запакованого замовлення скасовано → замовлення не в черзі, а в «Потрібна накладна»; «Розпакувати» →
 *    «Очікує перевірки» → нова накладна → продовжити те саме пакування без повторного списання;
 * 3) паралельність на справжньому PostgreSQL (блокування рядків; на PGlite запити виконуються послідовно).
 */
let env: TestEnv;
const ids: Record<string, string> = {};

async function setVariantDims(sku: string, dims: [number, number, number]) {
  await env.handle.db.update(productVariants).set({ lengthMm: dims[0], widthMm: dims[1], heightMm: dims[2] }).where(eq(productVariants.sku, sku));
}
async function prepare(number: string) {
  const id = await env.orderId(number);
  await validateOrderById(env.ctx(OWNER), id);
  const r = await createWaybill(env.ctx(OWNER), id, { source: "manual" });
  if (r.kind !== "created") throw new Error(`waybill for ${number}: ${r.kind}`);
  ids[number] = id;
  return id;
}

beforeAll(async () => {
  env = await createTestEnv();
  // Накладні з типовою упаковкою (демо-товари без габаритів).
  for (const number of ["#1001", "#1002", "#1011", "#1012"]) await prepare(number);
  // #1009 (тримач чорний ×1): габарити товару задано ДО накладної → накладна з автоматично підібраною коробкою.
  await setVariantDims("OT-PH-BLK", [120, 80, 40]);
  await prepare("#1009");
});
afterAll(async () => {
  await env.close();
});

async function orderStatus(id: string) {
  const [row] = await env.handle.db.select({ status: orders.status }).from(orders).where(eq(orders.id, id));
  return row!.status;
}
async function activePacking(id: string) {
  const rows = await env.handle.db.select().from(orderPacking).where(and(eq(orderPacking.orderId, id), inArray(orderPacking.status, ["queued", "in_progress", "packed"])));
  expect(rows).toHaveLength(1);
  return rows[0]!;
}
async function consumeMovements(packingId: string) {
  return env.handle.db
    .select()
    .from(inventoryMovements)
    .where(and(eq(inventoryMovements.packingId, packingId), eq(inventoryMovements.type, "material_consume")));
}
async function boxCode(materialId: string | null) {
  if (!materialId) return null;
  const [m] = await env.handle.db.select({ code: packagingMaterials.code }).from(packagingMaterials).where(eq(packagingMaterials.id, materialId));
  return m?.code ?? null;
}
async function scanAll(orderId: string) {
  const screen = await loadPackingScreen(env.ctx(), orderId);
  for (const line of screen.lines) {
    for (let i = line.packed; i < line.required; i += 1) {
      expect((await recordScan(env.ctx(STAFF), orderId, line.barcode ?? line.sku ?? "")).kind).toBe("matched");
    }
  }
}
const queue = (search = "") => listPackingQueue(env.ctx(), parseQueueFilters(new URLSearchParams(search)));
const numbersOf = async (search: string) => (await queue(search)).rows.map((r) => r.orderNumber);

describe("default box is consistent with the waybill", () => {
  it("inexact selection (partial dimensions) is only a suggestion: no box, no mismatch right after start", async () => {
    const id = ids["#1001"]!; // тримач (з габаритами) + гріпси (без габаритів)
    expect((await startPacking(env.ctx(STAFF), id)).kind).toBe("started");
    expect((await activePacking(id)).boxMaterialId).toBeNull();
    const screen = await loadPackingScreen(env.ctx(), id);
    expect(screen.suggestion).toMatchObject({ reason: "partial_dimensions" });
    expect(screen.suggestion.boxId).not.toBeNull();
    expect(screen.mismatch).toBeNull();
    expect(screen.materials.some((m) => m.isBox)).toBe(false);
    expect((await loadPackingSummary(env.handle.db, id)).mismatch).toBeNull();
  });

  it("exact selection used for the waybill becomes the packing box: no mismatch", async () => {
    const id = ids["#1009"]!;
    const shipment = await findActiveShipment(env.handle.db, id);
    expect(shipment!.requestSnapshot).toMatchObject({ parcelSource: "auto_box", autoBoxReason: "fits" });
    await startPacking(env.ctx(STAFF), id);
    const p = await activePacking(id);
    expect(p.boxMaterialId).toBe((shipment!.requestSnapshot as { parcelBoxMaterialId: string }).parcelBoxMaterialId);
    expect(await boxCode(p.boxMaterialId)).toBe("box_s");
    expect((await loadPackingScreen(env.ctx(), id)).mismatch).toBeNull();
  });

  it("an exact fit computed after the waybill (default package) is preselected and its real difference is reported", async () => {
    const id = ids["#1012"]!; // крило Model X + тримач білий; накладна вже з типовою упаковкою
    await setVariantDims("OT-FK-X", [180, 120, 30]);
    await setVariantDims("OT-PH-WHT", [120, 80, 40]);
    await startPacking(env.ctx(STAFF), id);
    const p = await activePacking(id);
    const screen = await loadPackingScreen(env.ctx(), id);
    expect(screen.suggestion.reason).toBe("fits");
    expect(p.boxMaterialId).toBe(screen.suggestion.boxId);
    const box = screen.boxes.find((b) => b.id === p.boxMaterialId)!;
    expect(screen.mismatch?.dims).toMatchObject({ waybillMm: [350, 250, 80], packedMm: [...box.innerDimsMm!].sort((a, b) => b - a) });
  });
});

describe("waybill cancelled after «Packed» (regression)", () => {
  it("leaves the packing queue, unpack returns the order to review, a new waybill continues the same packing", async () => {
    const id = ids["#1001"]!;
    await scanAll(id);
    const packed = await confirmPacked(env.ctx(STAFF), id, (await activePacking(id)).version);
    expect(packed.kind).toBe("packed");
    const packing = await activePacking(id);
    const consumed = (await consumeMovements(packing.id)).length;
    expect(consumed).toBeGreaterThan(0);

    const old = await findActiveShipment(env.handle.db, id);
    await cancelWaybill(env.ctx(OWNER), old!.id, { purpose: "correction" });
    // Скасування накладної повертає до перевірки лише «Накладна створена»/«Очікує комплектації».
    expect(await orderStatus(id)).toBe("packed");
    expect(await findActiveShipment(env.handle.db, id)).toBeNull();

    // Черга: лише замовлення з активною створеною накладною; без неї — «Потрібна накладна».
    expect(await numbersOf("tab=packed")).not.toContain("#1001");
    expect(await numbersOf("")).not.toContain("#1001");
    const needs = await queue("tab=needs_waybill");
    expect(needs.rows.find((r) => r.id === id)).toMatchObject({ status: "packed", waybill: null });
    const all = await queue("");
    expect(all.counts.queue).toBe(all.counts.waybill_created + all.counts.awaiting_picking + all.counts.packed);
    expect(all.counts.queue).toBe(all.total);
    expect(all.counts.needs_waybill).toBe(needs.total);
    expect(await countPackingQueue(env.handle.db)).toBe(all.counts.queue);

    const screen = await loadPackingScreen(env.ctx(), id);
    expect(screen).toMatchObject({ packedWithoutWaybill: true, canStart: false, mismatch: null, shipment: null });
    expect(await loadPackingSummary(env.handle.db, id)).toMatchObject({ packedWithoutWaybill: true, inQueue: false });
    expect(await startPacking(env.ctx(STAFF), id)).toMatchObject({ kind: "already_packed" });

    // «Розпакувати» → «Очікує комплектації» → «Очікує перевірки» (активної накладної немає).
    expect(await unpackOrder(env.ctx(STAFF), id)).toEqual({ kind: "unpacked", packingId: packing.id, materialsConsumed: true, status: "awaiting_review" });
    expect(await orderStatus(id)).toBe("awaiting_review");
    expect(await activePacking(id)).toMatchObject({ id: packing.id, status: "in_progress" });
    const [unpackEvent] = await env.handle.db
      .select({ c: count() })
      .from(shipmentEvents)
      .where(and(eq(shipmentEvents.shipmentId, old!.id), eq(shipmentEvents.type, "unpacked")));
    expect(Number(unpackEvent?.c)).toBe(1);
    const transitions = await env.handle.db
      .select({ details: auditLog.details })
      .from(auditLog)
      .where(and(eq(auditLog.entityId, id), eq(auditLog.action, "order.status_changed")));
    expect(transitions.map((t) => t.details)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "packed", to: "awaiting_picking", source: "packing" }),
        expect.objectContaining({ from: "awaiting_picking", to: "awaiting_review", source: "packing" }),
      ]),
    );
    expect((await queue("tab=needs_waybill")).rows.find((r) => r.id === id)).toMatchObject({ status: "awaiting_review" });

    // Нова накладна → «Продовжити пакування» (те саме пакування, чекліст збережено) → «Запаковано» без повторного списання.
    const next = await createWaybill(env.ctx(OWNER), id, { source: "manual" });
    expect(next.kind).toBe("created");
    expect(await orderStatus(id)).toBe("waybill_created");
    expect(await numbersOf("tab=waybill_created")).toContain("#1001");
    expect((await loadPackingScreen(env.ctx(), id)).canStart).toBe(true);
    expect(await startPacking(env.ctx(STAFF), id)).toMatchObject({ kind: "already_started", packingId: packing.id });
    expect(await orderStatus(id)).toBe("awaiting_picking");
    const again = await confirmPacked(env.ctx(STAFF), id, (await activePacking(id)).version);
    expect(again).toMatchObject({ kind: "packed", materials: { alreadyConsumed: true }, mismatch: null });
    expect(await consumeMovements(packing.id)).toHaveLength(consumed);
    expect(await numbersOf("tab=packed")).toContain("#1001");
  });

  it("unpacking with an active waybill still returns to picking (not to review)", async () => {
    const id = ids["#1001"]!;
    expect(await unpackOrder(env.ctx(STAFF), id)).toMatchObject({ kind: "unpacked", status: "awaiting_picking" });
    expect(await orderStatus(id)).toBe("awaiting_picking");
  });
});

/**
 * Паралельні запити реально конкурують лише на справжньому PostgreSQL (TEST_DATABASE_URL): PGlite має одне з'єднання
 * й виконує транзакції послідовно. Без змінної блок пропускається.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)("row locks on PostgreSQL", () => {
  it("8 concurrent starts (single + bulk) → one packing, one transition; 8 concurrent confirms → one consumption set", async () => {
    const id = ids["#1002"]!;
    const settled = await Promise.allSettled([
      ...[1, 2, 3, 4].map(() => startPacking(env.ctx(STAFF), id)),
      ...[1, 2, 3, 4].map(() => startPackingBulk(env.ctx(OWNER), [id])),
    ]);
    expect(settled.every((s) => s.status === "fulfilled")).toBe(true);
    const rows = await env.handle.db.select().from(orderPacking).where(eq(orderPacking.orderId, id));
    expect(rows).toHaveLength(1);
    const transitions = await env.handle.db.select({ details: auditLog.details }).from(auditLog).where(and(eq(auditLog.entityId, id), eq(auditLog.action, "order.status_changed")));
    expect(transitions.filter((t) => (t.details as Record<string, unknown>).source === "packing")).toHaveLength(1);

    await scanAll(id);
    const version = (await activePacking(id)).version;
    const results = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(() => confirmPacked(env.ctx(STAFF), id, version)));
    expect(results.filter((r) => r.kind === "packed")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "already_packed")).toHaveLength(7);
    const movements = await consumeMovements(rows[0]!.id);
    expect(movements.length).toBeGreaterThan(0);
    expect(new Set(movements.map((m) => m.stockItemId)).size).toBe(movements.length);
  });

  it("«Packed» racing a waybill cancel never deadlocks and always stays recoverable", async () => {
    const id = ids["#1011"]!;
    await startPacking(env.ctx(STAFF), id);
    await scanAll(id);
    const p = await activePacking(id);
    const shipment = await findActiveShipment(env.handle.db, id);
    const [confirm, cancel] = await Promise.allSettled([confirmPacked(env.ctx(STAFF), id, p.version), cancelWaybill(env.ctx(OWNER), shipment!.id, { purpose: "correction" })]);
    for (const s of [confirm, cancel]) {
      if (s.status === "rejected") {
        expect(String((s.reason as Error)?.message ?? s.reason)).not.toMatch(/deadlock/i);
        expect(s.reason).toBeInstanceOf(DomainError);
      }
    }
    expect(cancel.status).toBe("fulfilled");
    const [cancelled] = await env.handle.db.select({ status: shipments.status }).from(shipments).where(eq(shipments.id, shipment!.id));
    expect(cancelled!.status).toBe("cancelled");
    const status = await orderStatus(id);
    if (status === "packed") {
      // «Запаковано» встигло першим: розпакування повертає до перевірки.
      expect(await unpackOrder(env.ctx(STAFF), id)).toMatchObject({ kind: "unpacked", status: "awaiting_review" });
    } else {
      // Скасування першим: «Запаковано» відмовлено (накладної немає), нічого не списано.
      expect(status).toBe("awaiting_review");
      expect(confirm.status).toBe("rejected");
      expect(await consumeMovements(p.id)).toHaveLength(0);
    }
    expect(await orderStatus(id)).toBe("awaiting_review");
    expect(await activePacking(id)).toMatchObject({ id: p.id, status: "in_progress" });
  });
});
