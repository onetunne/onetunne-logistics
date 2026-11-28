/**
 * Етап 6, WP9: сервіси розділу «Повернення» на БД (docs/stage6-design.md §11, §14.2).
 * - доступ: читання — orders.view, ручні дії — orders.edit (працівник або власник); без дозволу — ForbiddenError;
 * - підказки перевізника за CARRIER_RETURN_CODES з ключем перевізника (код статусу або подія відстеження); чужий код
 *   іншого перевізника — не підказка; замовлення з незакритим випадком — без підказки; «Відкрити» — випадок «Їде назад»
 *   (відмова → «Відмова отримувача»), повтор — той самий випадок;
 * - ручний випадок: ідемпотентно за uuid форми; спершу дані Shopify / складу (наявний випадок не дублюється); позиції
 *   лише цього замовлення; примітка маскується;
 * - зміна випадку: compare-and-set за версією, дати статусу, журнал без тексту примітки;
 * - деталь: повна історія замовлення (зміни, статуси, відправлення, відстеження, пакування, склад, повернення коштів,
 *   випадки), походження позицій; список із фільтрами й сторінками.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, orderChanges, orderPacking, orderReturns, orders, shipments } from "~/db/schema";
import { ForbiddenError, makeActor } from "~/domain/permissions";
import { ConflictError, DomainError, NotFoundError } from "~/lib/errors";
import {
  createManualReturnCase,
  getReturnCase,
  listCarrierReturnHints,
  listReturnCases,
  openReturnFromCarrierHint,
  returnCasesOfOrder,
  returnFormOrder,
  updateReturnCase,
} from "~/modules/returns/cases.server";
import { createTestEnv, OWNER, STAFF, type TestEnv } from "../../helpers";
import { addRefund, addShipment, ctxAt, insertOrder, makeVariant, receiveReturn, syncCases, type TestOrder } from "./helpers";

let env: TestEnv;
const NOW = "2026-11-28T10:00:00Z";
const NO_ORDERS = makeActor({
  id: "no-orders",
  displayName: "N",
  role: "staff",
  overrides: { revoke: ["orders.view", "orders.edit"] },
});
const VIEW_ONLY = makeActor({
  id: "view-only",
  displayName: "V",
  role: "staff",
  overrides: { revoke: ["orders.edit"] },
});
const staff = () => ctxAt(env, NOW, STAFF);
const owner = () => ctxAt(env, NOW, OWNER);

let full: TestOrder; // повернення коштів + надходження
let novaHint: TestOrder; // підказка Нової пошти за кодом статусу 103
let eventHint: TestOrder; // підказка за подією відстеження 131
let foreign: TestOrder; // чужий код іншого перевізника — не підказка
let novaShipmentId = "";
let variant: Awaited<ReturnType<typeof makeVariant>>;

beforeAll(async () => {
  env = await createTestEnv({ seed: false });
  const db = env.handle.db;
  variant = await makeVariant(db, { model: "Тримач", color: "Чорний" });
  full = await insertOrder(db, {
    variants: [{ variantId: variant.variantId, quantity: 2 }],
    country: "DE",
  });
  await addShipment(db, full, {
    handedOverAt: "2026-10-05T08:00:00Z",
    deliveredAt: "2026-10-12T08:00:00Z",
    events: [{ code: "1", at: "2026-10-06T08:00:00Z", status: "in_transit" }],
  });
  await db.insert(orderChanges).values({
    orderId: full.orderId,
    field: "shipping.city",
    oldValue: "Berlinn",
    newValue: "Berlin",
    source: "auto_fix",
    actorId: "system",
  });
  await db.insert(orderPacking).values({
    orderId: full.orderId,
    status: "packed",
    startedAt: new Date("2026-10-04T08:00:00Z"),
    packedAt: new Date("2026-10-04T09:00:00Z"),
  });
  await addRefund(db, full, {
    at: "2026-11-04T09:00:00Z",
    lines: [{ line: 0, quantity: 1, restockType: "RETURN" }],
  });
  await syncCases(env, full.orderId);
  await receiveReturn(env, staff(), {
    orderId: full.orderId,
    stockItemId: variant.stockItemId,
    good: 1,
  });
  await syncCases(env, full.orderId);

  novaHint = await insertOrder(db, {
    variants: [{ variantId: variant.variantId }],
    country: "PL",
  });
  novaShipmentId = await addShipment(db, novaHint, {
    carrierCode: "nova_post",
    handedOverAt: "2026-11-01T08:00:00Z",
    statusCode: "103",
    statusAt: "2026-11-09T08:00:00Z",
  });
  eventHint = await insertOrder(db, {
    variants: [{ variantId: variant.variantId }],
    country: "SK",
  });
  await addShipment(db, eventHint, {
    carrierCode: "nova_post",
    handedOverAt: "2026-11-01T08:00:00Z",
    events: [{ code: "131", at: "2026-11-10T08:00:00Z" }],
  });
  foreign = await insertOrder(db, {
    variants: [{ variantId: variant.variantId }],
    country: "FR",
  });
  await addShipment(db, foreign, {
    carrierCode: "test",
    statusCode: "102",
    events: [{ code: "103", at: "2026-11-10T08:00:00Z" }],
  });
});
afterAll(async () => {
  await env.close();
});

describe("access (§14.2): read — orders.view, manual actions — orders.edit", () => {
  it("an actor without orders.view gets ForbiddenError on every service; view-only cannot change anything", async () => {
    const id = randomUUID();
    const c = ctxAt(env, NOW, NO_ORDERS);
    for (const call of [
      () => listReturnCases(c),
      () => listCarrierReturnHints(c),
      () => getReturnCase(c, id),
      () => returnFormOrder(c, full.orderNumber),
      () => returnCasesOfOrder(c, full.orderId),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(ForbiddenError);
    }
    const v = ctxAt(env, NOW, VIEW_ONLY);
    for (const call of [
      () =>
        createManualReturnCase(v, {
          operationId: randomUUID(),
          orderRef: full.orderNumber,
          kind: "lost",
        }),
      () => openReturnFromCarrierHint(v, { shipmentId: novaShipmentId }),
      () => updateReturnCase(v, { id, expectedVersion: 1, status: "closed" }),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(ForbiddenError);
    }
    // Перегляд дозволено.
    expect((await listReturnCases(v)).total).toBeGreaterThan(0);
  });
});

describe("carrier hints (CARRIER_RETURN_CODES keyed by carrier)", () => {
  it("Nova Post 103 (status) and 131 (event) are hints; a test-carrier shipment with Nova Post codes is not; an order with an open case has none", async () => {
    const hints = await listCarrierReturnHints(staff());
    const byOrder = new Map(hints.map((h) => [h.orderId, h]));
    expect(byOrder.get(novaHint.orderId)).toMatchObject({
      carrierCode: "nova_post",
      code: "103",
      signal: "refused",
      suggestedKind: "refused",
    });
    expect(byOrder.get(eventHint.orderId)).toMatchObject({
      carrierCode: "nova_post",
      code: "131",
      signal: "return_uncleared",
      suggestedKind: "carrier_return",
    });
    expect(byOrder.has(foreign.orderId)).toBe(false);
    expect(byOrder.has(full.orderId)).toBe(false);
    expect(JSON.stringify(hints)).not.toMatch(/"(amount|total|currency|price)"/);
  });

  it("«Open» creates an in-transit «Refused by recipient» case once; the hint disappears; a repeat is a replay", async () => {
    const r = await openReturnFromCarrierHint(staff(), {
      shipmentId: novaShipmentId,
    });
    expect(r.outcome).toBe("created");
    const [c] = await env.handle.db.select().from(orderReturns).where(eq(orderReturns.id, r.caseId));
    expect(c).toMatchObject({
      kind: "refused",
      status: "in_transit",
      reasonCode: "refused_delivery",
      source: "carrier_hint",
      createdBy: STAFF.id,
    });
    expect(c!.firstSignalAt.toISOString()).toBe("2026-11-09T08:00:00.000Z");
    expect((await listCarrierReturnHints(staff())).some((h) => h.orderId === novaHint.orderId)).toBe(false);
    expect(await openReturnFromCarrierHint(staff(), { shipmentId: novaShipmentId })).toEqual({ caseId: r.caseId, outcome: "replay" });
    await expect(openReturnFromCarrierHint(staff(), { shipmentId: randomUUID() })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("a shipment that no longer reports a return code is refused (hint gone)", async () => {
    const db = env.handle.db;
    const o = await insertOrder(db, {
      variants: [{ variantId: variant.variantId }],
    });
    const s = await addShipment(db, o, {
      carrierCode: "nova_post",
      statusCode: "9",
    });
    await expect(openReturnFromCarrierHint(staff(), { shipmentId: s })).rejects.toMatchObject({ code: "returns.error.hintGone" });
  });
});

describe("manual cases", () => {
  it("validated, idempotent by form uuid, masked note, lines of this order only", async () => {
    const db = env.handle.db;
    const o = await insertOrder(db, {
      variants: [{ variantId: variant.variantId, quantity: 2 }],
    });
    const op = randomUUID();
    await expect(
      createManualReturnCase(staff(), {
        operationId: "x",
        orderRef: o.orderNumber,
        kind: "lost",
      }),
    ).rejects.toMatchObject({ code: "returns.error.operationInvalid" });
    await expect(
      createManualReturnCase(staff(), {
        operationId: op,
        orderRef: o.orderNumber,
        kind: "nope",
      }),
    ).rejects.toMatchObject({ code: "returns.error.kindInvalid" });
    await expect(
      createManualReturnCase(staff(), {
        operationId: op,
        orderRef: "#nope",
        kind: "lost",
      }),
    ).rejects.toMatchObject({ code: "returns.error.orderNotFound" });
    await expect(
      createManualReturnCase(staff(), {
        operationId: op,
        orderRef: o.orderNumber,
        kind: "lost",
        lines: [{ orderLineItemId: full.lines[0]!.id, quantity: 1 }],
      }),
    ).rejects.toMatchObject({ code: "returns.error.lineInvalid" });
    await expect(
      createManualReturnCase(staff(), {
        operationId: op,
        orderRef: o.orderNumber,
        kind: "lost",
        lines: [{ orderLineItemId: o.lines[0]!.id, quantity: 3 }],
      }),
    ).rejects.toMatchObject({
      code: "returns.error.quantityInvalid",
      params: { max: 2 },
    });
    expect(await returnCasesOfOrder(staff(), o.orderId)).toEqual([]);

    const r = await createManualReturnCase(staff(), {
      operationId: op,
      orderRef: o.orderNumber.replace(/^#/, ""),
      kind: "lost",
      reasonCode: "address_problem",
      note: "Покупець просив передзвонити +380 67 123 45 67",
      lines: [{ orderLineItemId: o.lines[0]!.id, quantity: 2, condition: "unknown" }],
    });
    expect(r.outcome).toBe("created");
    const [c] = await db.select().from(orderReturns).where(eq(orderReturns.id, r.caseId));
    expect(c).toMatchObject({
      kind: "lost",
      status: "open",
      reasonCode: "address_problem",
      source: "manual",
    });
    expect(c!.reasonNote).not.toMatch(/123 45 67/);
    expect(
      await createManualReturnCase(staff(), {
        operationId: op,
        orderRef: o.orderNumber,
        kind: "lost",
      }),
    ).toEqual({ caseId: r.caseId, outcome: "replay" });
    // Інша форма для замовлення з незакритим випадком — новий не створюється.
    expect(
      await createManualReturnCase(staff(), {
        operationId: randomUUID(),
        orderRef: o.orderNumber,
        kind: "other",
      }),
    ).toEqual({ caseId: r.caseId, outcome: "existing" });
    const [a] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, r.caseId), eq(auditLog.action, "returns.case_created")));
    expect(JSON.stringify(a!.details)).not.toMatch(/380|передзвонити/);
  });

  it("Shopify / warehouse data come first: an unsynced refund becomes the case instead of a duplicate manual one", async () => {
    const db = env.handle.db;
    const o = await insertOrder(db, {
      variants: [{ variantId: variant.variantId }],
    });
    await addShipment(db, o, { handedOverAt: "2026-10-05T08:00:00Z" });
    await addRefund(db, o, {
      at: "2026-11-02T09:00:00Z",
      lines: [{ line: 0, quantity: 1, restockType: "RETURN" }],
    });
    const r = await createManualReturnCase(owner(), {
      operationId: randomUUID(),
      orderRef: o.orderId,
      kind: "customer_return",
    });
    expect(r.outcome).toBe("existing");
    const cases = await returnCasesOfOrder(staff(), o.orderId);
    expect(cases).toHaveLength(1);
    expect(cases[0]!.id).toBe(r.caseId);
  });
});

describe("editing a case (compare-and-set)", () => {
  it("kind / reason / note / status with version check; dates follow the status; history without the note text", async () => {
    const db = env.handle.db;
    const o = await insertOrder(db, {
      variants: [{ variantId: variant.variantId }],
    });
    const { caseId } = await createManualReturnCase(staff(), {
      operationId: randomUUID(),
      orderRef: o.orderNumber,
      kind: "other",
    });
    await expect(
      updateReturnCase(staff(), {
        id: caseId,
        expectedVersion: 7,
        status: "closed",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      updateReturnCase(staff(), {
        id: caseId,
        expectedVersion: 1,
        status: "gone",
      }),
    ).rejects.toBeInstanceOf(DomainError);
    expect(
      await updateReturnCase(staff(), {
        id: caseId,
        expectedVersion: 1,
        kind: "other",
      }),
    ).toEqual({ version: 1, changed: false });
    const r1 = await updateReturnCase(staff(), {
      id: caseId,
      expectedVersion: 1,
      kind: "customer_return",
      reasonCode: "size_or_fit",
      note: "Замалий розмір",
      status: "received",
    });
    expect(r1).toEqual({ version: 2, changed: true });
    let [c] = await db.select().from(orderReturns).where(eq(orderReturns.id, caseId));
    expect(c).toMatchObject({
      kind: "customer_return",
      reasonCode: "size_or_fit",
      reasonNote: "Замалий розмір",
      status: "received",
    });
    expect(c!.receivedAt?.toISOString()).toBe(NOW.replace("Z", ".000Z"));
    await updateReturnCase(staff(), {
      id: caseId,
      expectedVersion: 2,
      status: "closed",
    });
    [c] = await db.select().from(orderReturns).where(eq(orderReturns.id, caseId));
    expect(c!.closedAt).not.toBeNull();
    await updateReturnCase(staff(), {
      id: caseId,
      expectedVersion: 3,
      status: "open",
      note: "",
    });
    [c] = await db.select().from(orderReturns).where(eq(orderReturns.id, caseId));
    expect(c).toMatchObject({
      status: "open",
      closedAt: null,
      reasonNote: null,
      version: 4,
    });
    expect(c!.receivedAt).not.toBeNull();
    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, caseId), eq(auditLog.action, "returns.case_updated")));
    expect(audit).toHaveLength(3);
    expect(JSON.stringify(audit.map((a) => a.details))).not.toMatch(/Замалий/);
    expect(audit.map((a) => (a.details as { fields: string[] }).fields)).toContainEqual(["kind", "reason", "note", "status"]);
  });
});

describe("detail: the full order history", () => {
  it("timeline covers changes, statuses, shipments, tracking, packing, warehouse, refunds and the case; lines show their origin", async () => {
    const [c] = await env.handle.db.select().from(orderReturns).where(eq(orderReturns.orderId, full.orderId));
    const d = await getReturnCase(staff(), c!.id);
    expect(d.case).toMatchObject({
      kind: "customer_return",
      status: "received",
    });
    expect(d.order).toMatchObject({
      orderNumber: full.orderNumber,
      countryCode: "DE",
    });
    const types = new Set(d.timeline.map((e) => e.type));
    for (const t of [
      "order_placed",
      "order_change",
      "waybill_created",
      "handed_over",
      "delivered",
      "tracking",
      "packing_started",
      "packed",
      "stock_return",
      "refund",
      "case_created",
      "case_linked",
      "case_status",
    ]) {
      expect(types, t).toContain(t);
    }
    const times = d.timeline.map((e) => new Date(e.at).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(d.lines.map((l) => [l.origin, l.condition, l.model, l.color]).sort()).toEqual([
      ["shopify", "unknown", "Тримач", "Чорний"],
      ["warehouse", "resellable", "Тримач", "Чорний"],
    ]);
    expect(d.units).toEqual({ units: 1, restocked: 1, damaged: 0, uncertainUnits: 0 });
    expect(d).toMatchObject({ awaitingReceipt: false, quantityUncertain: false });
    expect(d.order.testOrder).toBe(false);
    expect(d.shipments).toHaveLength(1);
    expect(JSON.stringify(d)).not.toMatch(/(profit|прибут|cogs|собіварт|margin|rentab|рентаб|revenue|оборот|turnover)/i);
    await expect(getReturnCase(staff(), randomUUID())).rejects.toBeInstanceOf(NotFoundError);
    await expect(getReturnCase(staff(), "not-a-uuid")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("the case detail of a hint-opened case shows the carrier signal of its shipment", async () => {
    const [c] = await env.handle.db.select().from(orderReturns).where(eq(orderReturns.orderId, novaHint.orderId));
    const d = await getReturnCase(staff(), c!.id);
    expect(d.shipments[0]).toMatchObject({
      carrierCode: "nova_post",
      signal: "refused",
      code: "103",
    });
  });
});

describe("list with filters and pages", () => {
  it("filters by status, kind, reason, country, period and order number; pages by 25", async () => {
    const all = await listReturnCases(staff());
    expect(all.total).toBeGreaterThanOrEqual(4);
    expect(all.countries).toEqual([...all.countries].sort());
    const received = await listReturnCases(staff(), { status: "received" });
    expect(received.rows.every((r) => r.status === "received")).toBe(true);
    expect((await listReturnCases(staff(), { kind: "refused" })).rows.map((r) => r.orderId)).toEqual([novaHint.orderId]);
    expect((await listReturnCases(staff(), { reason: "refused_delivery" })).total).toBe(1);
    expect((await listReturnCases(staff(), { country: "pl" })).rows.map((r) => r.orderId)).toEqual([novaHint.orderId]);
    expect((await listReturnCases(staff(), { q: full.orderNumber.slice(1) })).rows.map((r) => r.orderId)).toEqual([full.orderId]);
    expect((await listReturnCases(staff(), { q: "%" })).total).toBe(0);
    expect((await listReturnCases(staff(), { from: "2026-11-09", to: "2026-11-09" })).rows.map((r) => r.orderId)).toEqual([novaHint.orderId]);
    const row = (await listReturnCases(staff(), { q: full.orderNumber.slice(1) })).rows[0]!;
    expect(row).toMatchObject({
      units: 1,
      restocked: 1,
      damaged: 0,
      countryCode: "DE",
    });
    const paged = await listReturnCases(staff(), { pageSize: 2, page: 2 });
    expect(paged.rows).toHaveLength(2);
    expect(paged.page).toBe(2);
  });
});

describe("review round: status history, «Awaiting stock receipt», test orders", () => {
  // Ревізія WP9 №4: «статуси (audit_log)» — не лише order.status_changed, а й order.validated (статус після перевірки)
  // і order.cancelled; накладна, яку перевізник не створив, — не «Створено накладну».
  it("timeline reads every order status audit action (status_changed, validated → status, cancelled); a failed waybill is not «created»", async () => {
    const db = env.handle.db;
    const o = await insertOrder(db, { variants: [{ variantId: variant.variantId }], country: "AT" });
    const failed = await addShipment(db, o, {});
    await db.update(shipments).set({ status: "failed", waybillNumber: null }).where(eq(shipments.id, failed));
    await addShipment(db, o, { handedOverAt: "2026-10-04T08:00:00Z" });
    await addRefund(db, o, { at: "2026-11-12T09:00:00Z", lines: [{ line: 0, quantity: 1, restockType: "RETURN" }] });
    await syncCases(env, o.orderId);
    const base = { actorType: "system", actorId: "system", entityType: "order", entityId: o.orderId };
    await db.insert(auditLog).values([
      { ...base, action: "order.validated", details: { trigger: "import", status: "awaiting_review", issues: [], autoFixes: [] }, createdAt: new Date("2026-10-01T10:00:00Z") },
      { ...base, action: "order.validated", details: { trigger: "after_edit", status: "needs_correction", issues: [], autoFixes: [] }, createdAt: new Date("2026-10-02T10:00:00Z") },
      { ...base, action: "order.status_changed", details: { from: "packed", to: "handed_to_carrier", source: "tracking" }, createdAt: new Date("2026-10-04T10:00:00Z") },
      { ...base, action: "order.cancelled", details: {}, createdAt: new Date("2026-10-20T10:00:00Z") },
      // Не зміна статусу замовлення (status — результат синхронізації) — у хронологію статусів не потрапляє.
      { ...base, action: "order.shopify_sync", details: { status: "skipped", reason: "invalid_data" }, createdAt: new Date("2026-10-21T10:00:00Z") },
    ]);
    const [c] = await db.select().from(orderReturns).where(eq(orderReturns.orderId, o.orderId));
    const d = await getReturnCase(staff(), c!.id);
    const statuses = d.timeline.filter((e) => e.type.startsWith("order_") && e.type !== "order_placed" && e.type !== "order_change");
    expect(statuses.map((e) => [e.type, e.params.to ?? null])).toEqual([
      ["order_cancelled", null],
      ["order_status", "handed_to_carrier"],
      ["order_validated", "needs_correction"],
      ["order_validated", "awaiting_review"],
    ]);
    expect(d.timeline.filter((e) => e.id === `ship-${failed}`).map((e) => e.type)).toEqual(["waybill_failed"]);
    expect(d.timeline.filter((e) => e.type === "waybill_created")).toHaveLength(1);
  });

  // Ревізія WP9 №3 (§6.7): повернення коштів з restockType = RETURN без надходження → «Очікує надходження на склад».
  it("a RETURN refund without a stock receipt shows «Awaiting stock receipt» on the list and the detail; the receipt clears it", async () => {
    const db = env.handle.db;
    const o = await insertOrder(db, { variants: [{ variantId: variant.variantId, quantity: 2 }], country: "CZ" });
    await addShipment(db, o, { handedOverAt: "2026-10-04T08:00:00Z" });
    await addRefund(db, o, { at: "2026-11-13T09:00:00Z", lines: [{ line: 0, quantity: 1, restockType: "RETURN" }] });
    await syncCases(env, o.orderId);
    const [c] = await db.select().from(orderReturns).where(eq(orderReturns.orderId, o.orderId));
    const row = () => listReturnCases(staff(), { q: o.orderNumber.slice(1) }).then((l) => l.rows[0]!);
    expect(await row()).toMatchObject({ status: "open", awaitingReceipt: true });
    expect(await getReturnCase(staff(), c!.id)).toMatchObject({ awaitingReceipt: true, awaitingReceiptUncertain: false });
    await receiveReturn(env, staff(), { orderId: o.orderId, stockItemId: variant.stockItemId, good: 1 });
    await syncCases(env, o.orderId);
    expect(await row()).toMatchObject({ status: "received", awaitingReceipt: false, units: 1 });
    expect((await getReturnCase(staff(), c!.id)).awaitingReceipt).toBe(false);
    // NO_RESTOCK після відвантаження («Лише повернення коштів») — товар не очікується.
    const n = await insertOrder(db, { variants: [{ variantId: variant.variantId }], country: "CZ" });
    await addShipment(db, n, { handedOverAt: "2026-10-04T08:00:00Z" });
    await addRefund(db, n, { at: "2026-11-13T09:00:00Z", lines: [{ line: 0, quantity: 1, restockType: "NO_RESTOCK" }] });
    await syncCases(env, n.orderId);
    expect((await listReturnCases(staff(), { q: n.orderNumber.slice(1) })).rows[0]).toMatchObject({ kind: "refund_only", awaitingReceipt: false });
  });

  it("a Shopify test order is labelled on the list row and the detail", async () => {
    const db = env.handle.db;
    const o = await insertOrder(db, { variants: [{ variantId: variant.variantId }], country: "HU" });
    await db.update(orders).set({ shopifyTest: true }).where(eq(orders.id, o.orderId));
    await addRefund(db, o, { at: "2026-11-14T09:00:00Z", lines: [{ line: 0, quantity: 1, restockType: "RETURN" }] });
    await syncCases(env, o.orderId);
    const r = (await listReturnCases(staff(), { q: o.orderNumber.slice(1) })).rows[0]!;
    expect(r.testOrder).toBe(true);
    expect((await getReturnCase(staff(), r.id)).order.testOrder).toBe(true);
  });
});
