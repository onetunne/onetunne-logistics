/**
 * Етап 6, WP9: внутрішня `syncReturnCasesForOrder` на БД (docs/stage6-design.md §11, F8, §14.1).
 * - автостворення ідемпотентно: повернення коштів Shopify з RETURN → випадок `ret:refund:<id>`; повторні виклики нічого
 *   не додають (ні випадків, ні позицій, ні записів журналу);
 * - надходження повернення на склад (справжня операція етапу 5, працівник) приєднується до випадку → «Отримано на
 *   склад», придатні й пошкоджені позиції (зокрема парний рух браку `…:return_defect`), поповнено склад;
 * - зворотний порядок (надходження → повернення коштів) дає один випадок; NO_RESTOCK після передачі → «Лише повернення
 *   коштів», до передачі / CANCEL — нічого;
 * - F8: працює з актором-працівником без фінансових дозволів, нічого не повертає, пише лише id (created_by, audit_log без
 *   сум); блокування FINO повторно-вхідне;
 * - PostgreSQL (TEST_DATABASE_URL): паралельні синхронізації того самого замовлення → один випадок.
 */
import { and, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, orderReturnLines, orderReturns } from "~/db/schema";
import { makeActor } from "~/domain/permissions";
import { lockFinanceOrder } from "~/modules/finance/core/locks.server";
import { getReturnCase, listReturnCases } from "~/modules/returns/cases.server";
import { returnSourceKeys } from "~/modules/returns/keys";
import { syncReturnCasesForOrder } from "~/modules/returns/sync.server";
import { createTestEnv, STAFF, type TestEnv } from "../../helpers";
import { addRefund, addShipment, casesOf, ctxAt, insertOrder, makeVariant, receiveReturn, syncCases } from "./helpers";

let env: TestEnv;
const NOW = "2026-11-28T10:00:00Z";
/** Працівник складу без orders.* і без фінансів — потік надходження все одно створює випадок (F8). */
const WAREHOUSE_ONLY = makeActor({
  id: "wh-staff",
  displayName: "Склад",
  role: "staff",
  overrides: { revoke: ["orders.view", "orders.edit"] },
});

beforeAll(async () => {
  env = await createTestEnv({ seed: false });
});
afterAll(async () => {
  await env.close();
});

async function countAll() {
  const [c] = await env.handle.db.select({ n: count() }).from(orderReturns);
  const [l] = await env.handle.db.select({ n: count() }).from(orderReturnLines);
  const [a] = await env.handle.db.select({ n: count() }).from(auditLog).where(eq(auditLog.entityType, "order_return"));
  return { cases: c!.n, lines: l!.n, audit: a!.n };
}

describe("automatic cases from Shopify refunds and warehouse receipts (idempotent)", () => {
  it("refund (RETURN) after handover → one open case; the staff receipt links to it (received, restocked); re-runs add nothing", async () => {
    const db = env.handle.db;
    const v = await makeVariant(db, { model: "Тримач", color: "Чорний" });
    const order = await insertOrder(db, {
      variants: [{ variantId: v.variantId, quantity: 2 }],
    });
    await addShipment(db, order, {
      handedOverAt: "2026-10-05T08:00:00Z",
      deliveredAt: "2026-10-12T08:00:00Z",
    });
    const refundId = await addRefund(db, order, {
      at: "2026-11-04T09:00:00Z",
      lines: [{ line: 0, quantity: 1, restockType: "RETURN" }],
    });

    const result = await syncCases(env, order.orderId);
    expect(result).toBeUndefined();
    let cases = await casesOf(db, order.orderId);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      kind: "customer_return",
      status: "open",
      source: "shopify_refund",
      sourceKey: returnSourceKeys.refund(refundId),
      reasonCode: "unknown",
      createdBy: "system",
    });
    expect(cases[0]!.lines.map((l) => [l.condition, l.quantity, l.restockedQty, l.orderLineItemId, l.variantId])).toEqual([
      ["unknown", 1, 0, order.lines[0]!.id, v.variantId],
    ]);

    // Працівник складу оприбутковує посилку (warehouse.receive) — справжня операція етапу 5.
    const staffCtx = ctxAt(env, NOW, STAFF);
    await receiveReturn(env, staffCtx, {
      orderId: order.orderId,
      stockItemId: v.stockItemId,
      good: 1,
    });
    await syncCases(env, order.orderId, { id: STAFF.id });
    cases = await casesOf(db, order.orderId);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      status: "received",
      kind: "customer_return",
      version: 2,
    });
    expect(cases[0]!.receivedAt).not.toBeNull();
    expect(cases[0]!.lines.map((l) => [l.condition, l.quantity, l.restockedQty])).toEqual([
      ["resellable", 1, 1],
      ["unknown", 1, 0],
    ]);

    const before = await countAll();
    for (let i = 0; i < 3; i++) await syncCases(env, order.orderId);
    expect(await countAll()).toEqual(before);
    expect(await casesOf(db, order.orderId)).toEqual(cases);

    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, "order_return"), eq(auditLog.entityId, cases[0]!.id)));
    expect(audit.map((a) => a.action).sort()).toEqual(["returns.case_created", "returns.source_linked", "returns.status_changed"]);
    expect(JSON.stringify(audit.map((a) => a.details))).not.toMatch(/\d+\.\d{2}|EUR|UAH/);
  });

  it("receipt first (with a damaged unit split by the stage-5 return_defect move), refund later → still one case", async () => {
    const db = env.handle.db;
    const v = await makeVariant(db);
    const order = await insertOrder(db, {
      variants: [{ variantId: v.variantId, quantity: 3 }],
    });
    await addShipment(db, order, { handedOverAt: "2026-10-05T08:00:00Z" });
    // Shopify поповнив усі одиниці (типово) → надходження on_hand 3 + рух браку on_hand −1 / defective +1.
    await receiveReturn(env, ctxAt(env, NOW, STAFF), {
      orderId: order.orderId,
      stockItemId: v.stockItemId,
      good: 2,
      damaged: 1,
    });
    await syncCases(env, order.orderId);
    let cases = await casesOf(db, order.orderId);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      kind: "customer_return",
      status: "received",
      source: "stock_receipt",
    });
    expect(cases[0]!.lines.map((l) => [l.condition, l.quantity, l.restockedQty])).toEqual([
      ["damaged", 1, 0],
      ["resellable", 2, 2],
    ]);
    await addRefund(db, order, {
      at: "2026-11-30T09:00:00Z",
      lines: [{ line: 0, quantity: 3, restockType: "RETURN" }],
    });
    await syncCases(env, order.orderId);
    await syncCases(env, order.orderId);
    cases = await casesOf(db, order.orderId);
    expect(cases).toHaveLength(1);
    expect(cases[0]!.lines.map((l) => l.condition).sort()).toEqual(["damaged", "resellable", "unknown"]);
  });

  it("NO_RESTOCK after handover → «Refund only»; before handover or CANCEL → no case", async () => {
    const db = env.handle.db;
    const v = await makeVariant(db);
    const shipped = await insertOrder(db, {
      variants: [{ variantId: v.variantId }],
    });
    await addShipment(db, shipped, { handedOverAt: "2026-10-05T08:00:00Z" });
    await addRefund(db, shipped, {
      at: "2026-10-20T09:00:00Z",
      lines: [{ line: 0, quantity: 1, restockType: "NO_RESTOCK" }],
    });
    await syncCases(env, shipped.orderId);
    expect((await casesOf(db, shipped.orderId)).map((c) => [c.kind, c.status])).toEqual([["refund_only", "open"]]);

    const early = await insertOrder(db, {
      variants: [{ variantId: v.variantId }],
      status: "paid",
    });
    await addRefund(db, early, {
      at: "2026-10-02T09:00:00Z",
      lines: [{ line: 0, quantity: 1, restockType: "NO_RESTOCK" }],
    });
    await addRefund(db, early, {
      at: "2026-10-03T09:00:00Z",
      lines: [{ line: 0, quantity: 1, restockType: "CANCEL" }],
    });
    await syncCases(env, early.orderId);
    expect(await casesOf(db, early.orderId)).toEqual([]);

    const cancelAfter = await insertOrder(db, {
      variants: [{ variantId: v.variantId }],
    });
    await addShipment(db, cancelAfter, {
      handedOverAt: "2026-10-05T08:00:00Z",
    });
    await addRefund(db, cancelAfter, {
      at: "2026-10-20T09:00:00Z",
      lines: [{ line: 0, quantity: 1, restockType: "CANCEL" }],
    });
    await syncCases(env, cancelAfter.orderId);
    expect(await casesOf(db, cancelAfter.orderId)).toEqual([]);
  });

  // Ревізія WP9 №1: WP3 зберігає 3-одиничну позицію, повернену як CANCEL 1 + RETURN 2, одним рядком (кількість 3,
  // restockType MIXED, restocked null). Випадок — «Повернення покупця» (не «Лише повернення коштів»), позиція — верхня межа
  // з неточною кількістю (у точні одиниці не входить), «можливо очікує надходження»; огляд на складі уточнює.
  it("a MIXED refund line (CANCEL 1 + RETURN 2 merged by WP3) → customer return with an uncertain quantity, never refund-only", async () => {
    const db = env.handle.db;
    const v = await makeVariant(db);
    const order = await insertOrder(db, { variants: [{ variantId: v.variantId, quantity: 3 }] });
    await addShipment(db, order, { handedOverAt: "2026-10-05T08:00:00Z" });
    await addRefund(db, order, {
      at: "2026-11-04T09:00:00Z",
      lines: [{ line: 0, quantity: 3, restockType: "MIXED" }],
    });
    await syncCases(env, order.orderId);
    await syncCases(env, order.orderId);
    const [c] = await casesOf(db, order.orderId);
    expect(c).toMatchObject({ kind: "customer_return", status: "open", source: "shopify_refund" });
    expect(c!.lines.map((l) => [l.condition, l.quantity, l.restockedQty])).toEqual([["unknown", 3, 0]]);
    const staff = ctxAt(env, NOW, STAFF);
    let d = await getReturnCase(staff, c!.id);
    expect(d).toMatchObject({ quantityUncertain: true, awaitingReceipt: true, awaitingReceiptUncertain: true });
    expect(d.units).toEqual({ units: 0, restocked: 0, damaged: 0, uncertainUnits: 3 });
    expect(d.lines.map((l) => [l.origin, l.uncertain, l.quantity])).toEqual([["shopify", true, 3]]);
    // Склад отримав 2 придатні — точно 2, можливо ще 1; надходження є — уже не «очікує».
    await receiveReturn(env, staff, { orderId: order.orderId, stockItemId: v.stockItemId, good: 2 });
    await syncCases(env, order.orderId);
    d = await getReturnCase(staff, c!.id);
    expect(d.case.status).toBe("received");
    expect(d.units).toEqual({ units: 2, restocked: 2, damaged: 0, uncertainUnits: 1 });
    expect(d.awaitingReceipt).toBe(false);
    const row = (await listReturnCases(staff, { q: order.orderNumber.slice(1) })).rows[0]!;
    expect(row).toMatchObject({ kind: "customer_return", units: 2, uncertainUnits: 1, awaitingReceipt: false });
  });

  it("an order without refunds or receipts: nothing is written (cheap no-op for every syncOrderFinance)", async () => {
    const db = env.handle.db;
    const v = await makeVariant(db);
    const order = await insertOrder(db, {
      variants: [{ variantId: v.variantId }],
    });
    const before = await countAll();
    await syncCases(env, order.orderId);
    expect(await countAll()).toEqual(before);
  });
});

describe("F8: internal function (no actor check, no money)", () => {
  it("a warehouse-only staff actor creates the case through the receipt flow; created_by is just the id", async () => {
    const db = env.handle.db;
    const v = await makeVariant(db);
    const order = await insertOrder(db, {
      variants: [{ variantId: v.variantId }],
    });
    await addShipment(db, order, { handedOverAt: "2026-10-05T08:00:00Z" });
    await receiveReturn(env, ctxAt(env, NOW, makeActor({ id: "wh-receiver", displayName: "R", role: "staff" })), {
      orderId: order.orderId,
      stockItemId: v.stockItemId,
      good: 1,
    });
    const out = await env.handle.db.transaction((tx) => syncReturnCasesForOrder(tx, WAREHOUSE_ONLY, order.orderId));
    expect(out).toBeUndefined();
    const cases = await casesOf(db, order.orderId);
    expect(cases).toHaveLength(1);
    expect(cases[0]!.createdBy).toBe("wh-staff");
    const [a] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, cases[0]!.id), eq(auditLog.action, "returns.case_created")));
    expect(a).toMatchObject({ actorType: "user", actorId: "wh-staff" });
    expect(Object.keys(a!.details).sort()).toEqual(["kind", "orderId", "source", "status"]);
  });

  it("the finance order lock is re-entrant: a caller already holding it (syncOrderFinance) can call the sync", async () => {
    const db = env.handle.db;
    const v = await makeVariant(db);
    const order = await insertOrder(db, {
      variants: [{ variantId: v.variantId }],
    });
    await addShipment(db, order, { handedOverAt: "2026-10-05T08:00:00Z" });
    await addRefund(db, order, {
      at: "2026-11-01T09:00:00Z",
      lines: [{ line: 0, quantity: 1, restockType: "RETURN" }],
    });
    await db.transaction(async (tx) => {
      await lockFinanceOrder(tx, order.orderId);
      await syncReturnCasesForOrder(tx, { id: "system" }, order.orderId);
      await syncReturnCasesForOrder(tx, { id: "system" }, order.orderId);
    });
    expect(await casesOf(db, order.orderId)).toHaveLength(1);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("PostgreSQL: concurrent syncs of one order", () => {
  it("eight parallel syncs (each in its own transaction) create exactly one case and one line", async () => {
    const db = env.handle.db;
    const v = await makeVariant(db);
    const order = await insertOrder(db, {
      variants: [{ variantId: v.variantId }],
    });
    await addShipment(db, order, { handedOverAt: "2026-10-05T08:00:00Z" });
    await addRefund(db, order, {
      at: "2026-11-01T09:00:00Z",
      lines: [{ line: 0, quantity: 1, restockType: "RETURN" }],
    });
    await Promise.all(Array.from({ length: 8 }, () => syncCases(env, order.orderId)));
    const cases = await casesOf(db, order.orderId);
    expect(cases).toHaveLength(1);
    expect(cases[0]!.lines).toHaveLength(1);
  });
});
