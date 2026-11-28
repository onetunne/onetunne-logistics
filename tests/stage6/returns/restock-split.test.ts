/**
 * Етап 6, WP9 (інтеграційний раунд ядра, міграція 0013): рядок повернення коштів `MIXED` з точним розподілом
 * `restock_quantities` (WP3 writeRefunds) рахує ЛИШЕ одиниці, що є поверненням (RETURN — завжди; CANCEL — ніколи;
 * NO_RESTOCK / LEGACY_RESTOCK / без виду — лише після відвантаження), з ТОЧНОЮ кількістю і без позначки «неточно».
 * Без розподілу (рядки до 0013) або з пошкодженим розподілом — як раніше: верхня межа, «неточно». Вигадані дані.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { orderRefundLines } from "~/db/schema";
import { caseInsight, isUncertainCaseLine, lineOrigins, refundLineRestockType } from "~/modules/returns/attribution";
import { getReturnCase } from "~/modules/returns/cases.server";
import { classifyRefund, exactRestockSplit, refundLineIds, resolveMixedLine, type RefundSource } from "~/modules/returns/rules";
import { returnStats } from "~/modules/returns/stats.server";
import { createTestEnv, STAFF, type TestEnv } from "../../helpers";
import { addRefund, addShipment, casesOf, ctxAt, insertOrder, makeVariant, syncCases } from "./helpers";

const AT = new Date("2027-05-04T09:00:00Z");
const SHIPPED = { shippedAt: new Date("2027-05-01T08:00:00Z"), shipped: true };
const NOT_SHIPPED = { shippedAt: null, shipped: false };
const mixed = (quantity: number, split: Record<string, number> | null): RefundSource => ({
  refundId: "r1",
  at: AT,
  lines: [{ shopifyLineItemId: "gid://shopify/LineItem/1", orderLineItemId: null, variantId: null, quantity, restockType: "MIXED", restockQuantities: split }],
});

describe("classifyRefund with restock_quantities (pure)", () => {
  it("CANCEL 1 + RETURN 2: two exact returned units (shipped or not — RETURN always counts), never uncertain", () => {
    for (const shipping of [SHIPPED, NOT_SHIPPED]) {
      const c = classifyRefund(mixed(3, { CANCEL: 1, RETURN: 2 }), shipping);
      expect(c).toMatchObject({ kind: "customer_return", uncertain: false });
      expect(c!.lines).toEqual([expect.objectContaining({ quantity: 2, restockType: "RETURN", restockQuantities: null })]);
    }
  });

  it("CANCEL + NO_RESTOCK / LEGACY_RESTOCK / unknown count only after shipment; all-CANCEL never forms a case", () => {
    expect(classifyRefund(mixed(3, { CANCEL: 1, NO_RESTOCK: 2 }), NOT_SHIPPED)).toBeNull();
    expect(classifyRefund(mixed(3, { CANCEL: 1, NO_RESTOCK: 2 }), SHIPPED)).toMatchObject({ kind: "refund_only", uncertain: false, lines: [{ quantity: 2, restockType: "NO_RESTOCK" }] });
    expect(classifyRefund(mixed(4, { LEGACY_RESTOCK: 1, NO_RESTOCK: 1, UNKNOWN: 1, CANCEL: 1 }), SHIPPED)).toMatchObject({
      kind: "customer_return",
      uncertain: false,
      lines: [{ quantity: 3, restockType: "LEGACY_RESTOCK" }],
    });
    expect(classifyRefund(mixed(2, { RETURN: 1, LEGACY_RESTOCK: 1 }), NOT_SHIPPED)).toMatchObject({ lines: [{ quantity: 1, restockType: "RETURN" }] });
    expect(classifyRefund(mixed(3, { CANCEL: 3 }), SHIPPED)).toBeNull();
  });

  it("no split, a damaged split (sum ≠ quantity, fractions, negatives, empty) or a non-MIXED line → unchanged (upper bound, uncertain)", () => {
    const splits: Array<Record<string, number> | null> = [null, { CANCEL: 1, RETURN: 1 }, { RETURN: 1.5, CANCEL: 1.5 }, { RETURN: 4, CANCEL: -1 }, {}];
    for (const split of splits) {
      expect(exactRestockSplit(mixed(3, split).lines[0]!)).toBeNull();
      expect(classifyRefund(mixed(3, split), SHIPPED)).toMatchObject({ kind: "customer_return", uncertain: true, lines: [{ quantity: 3, restockType: "MIXED" }] });
    }
    const plain = { ...mixed(2, { RETURN: 2 }).lines[0]!, restockType: "RETURN" };
    expect(exactRestockSplit(plain)).toBeNull();
    expect(resolveMixedLine(plain, true)).toBe(plain);
  });

  it("line origins and case insight: the resolved line is exact (no uncertain units) and still awaits a stock receipt", () => {
    const r = mixed(3, { CANCEL: 1, RETURN: 2 });
    const origins = lineOrigins([r], []);
    const [lineId] = refundLineIds(r);
    expect(origins.get(lineId!)).toEqual({ kind: "refund", refundId: "r1", restockType: "MIXED", exact: [{ quantity: 2, restockType: "RETURN" }] });
    const insight = caseInsight({ kind: "customer_return", status: "open" }, [{ id: lineId!, orderLineItemId: "l1", variantId: null, quantity: 2, condition: "unknown", restockedQty: 0 }], origins);
    expect(insight).toMatchObject({ awaitingReceipt: true, awaitingReceiptUncertain: false, quantityUncertain: false });
    expect(insight.units.uncertainUnits).toBe(0);
    expect(refundLineRestockType(origins.get(lineId!), 2)).toBe("RETURN");
    expect(isUncertainCaseLine(origins.get(lineId!), 2)).toBe(false);
  });

  it("a case line created BEFORE the split (upper bound incl. CANCEL) stays uncertain once the split arrives; a matching quantity is exact", () => {
    const line = (quantity: number) => ({ orderLineItemId: "l1", variantId: null, quantity, condition: "unknown" as const, restockedQty: 0 });
    // CANCEL 1 + RETURN 2: позиція до 0013 — 3 (верхня межа) → лишається «неточно» (можливо ще до 3), не «3 точно».
    const r = mixed(3, { CANCEL: 1, RETURN: 2 });
    const [id] = refundLineIds(r);
    const origins = lineOrigins([r], []);
    const stale = caseInsight({ kind: "customer_return", status: "open" }, [{ id: id!, ...line(3) }], origins);
    expect(stale).toMatchObject({ quantityUncertain: true, awaitingReceipt: true, awaitingReceiptUncertain: true, units: { units: 0, uncertainUnits: 3 } });
    expect(isUncertainCaseLine(origins.get(id!), 3)).toBe(true);
    // Без CANCEL верхня межа і є точна кількість (позиція до 0013 з відвантаженням): точно.
    const noCancel = mixed(3, { NO_RESTOCK: 1, RETURN: 2 });
    const [id2] = refundLineIds(noCancel);
    const o2 = lineOrigins([noCancel], []);
    expect(o2.get(id2!)).toMatchObject({ exact: [{ quantity: 3, restockType: "RETURN" }, { quantity: 2, restockType: "RETURN" }] });
    expect(caseInsight({ kind: "customer_return", status: "open" }, [{ id: id2!, ...line(3) }], o2)).toMatchObject({ quantityUncertain: false, units: { units: 3, uncertainUnits: 0 } });
    // Позиція після 0013 без відвантаження: лише RETURN (2) — точно.
    expect(caseInsight({ kind: "customer_return", status: "open" }, [{ id: id2!, ...line(2) }], o2)).toMatchObject({ quantityUncertain: false, units: { units: 2, uncertainUnits: 0 } });
    // Лише CANCEL: точних кількостей немає — будь-яка позиція неточна.
    const allCancel = mixed(2, { CANCEL: 2 });
    const [id3] = refundLineIds(allCancel);
    expect(lineOrigins([allCancel], []).get(id3!)).toMatchObject({ restockType: "MIXED", exact: [] });
    expect(isUncertainCaseLine(lineOrigins([allCancel], []).get(id3!), 2)).toBe(true);
  });
});

describe("returns DB flow with restock_quantities", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await createTestEnv({ seed: false });
  });
  afterAll(async () => {
    await env.close();
  });
  const NOW = "2027-05-28T10:00:00Z";

  it("a MIXED refund line with a split → a case with the exact RETURN units; stats/detail without uncertain units", async () => {
    const db = env.handle.db;
    const v = await makeVariant(db, { model: "Сумка" });
    const o = await insertOrder(db, { variants: [{ variantId: v.variantId, quantity: 3 }], country: "PL" });
    await addShipment(db, o, { handedOverAt: "2027-05-01T08:00:00Z" });
    await addRefund(db, o, { at: "2027-05-04T09:00:00Z", lines: [{ line: 0, quantity: 3, restockType: "MIXED", restockQuantities: { CANCEL: 1, RETURN: 2 } }] });
    await syncCases(env, o.orderId);
    const [c] = await casesOf(db, o.orderId);
    expect(c).toMatchObject({ kind: "customer_return", status: "open" });
    const detail = await getReturnCase(ctxAt(env, NOW, STAFF), c!.id);
    expect(detail).toMatchObject({ quantityUncertain: false, units: { uncertainUnits: 0 } });
    expect(detail.lines).toEqual([expect.objectContaining({ quantity: 2, uncertain: false, origin: "shopify" })]);
    const s = await returnStats(ctxAt(env, NOW, STAFF), { range: { from: "2027-05-01", to: "2027-05-31" } });
    expect(s.units).toMatchObject({ total: 2, uncertain: 0, uncertainCases: 0 });
    expect(s.awaitingReceipt).toBe(1);
  });

  it("without the split (pre-0013 row) the same line stays an uncertain upper bound", async () => {
    const db = env.handle.db;
    const v = await makeVariant(db, { model: "Гаманець" });
    const o = await insertOrder(db, { variants: [{ variantId: v.variantId, quantity: 3 }], country: "PL" });
    await addShipment(db, o, { handedOverAt: "2027-06-01T08:00:00Z" });
    await addRefund(db, o, { at: "2027-06-04T09:00:00Z", lines: [{ line: 0, quantity: 3, restockType: "MIXED" }] });
    await syncCases(env, o.orderId);
    const [c] = await casesOf(db, o.orderId);
    const detail = await getReturnCase(ctxAt(env, "2027-06-28T10:00:00Z", STAFF), c!.id);
    expect(detail).toMatchObject({ quantityUncertain: true, units: { uncertainUnits: 3 } });
  });

  it("a pre-0013 case line (upper bound 3 incl. CANCEL 1) is NOT shown as exact after WP3 re-reads the refund and writes the split", async () => {
    const db = env.handle.db;
    const v = await makeVariant(db, { model: "Пояс" });
    const o = await insertOrder(db, { variants: [{ variantId: v.variantId, quantity: 3 }], country: "PL" });
    await addShipment(db, o, { handedOverAt: "2027-07-01T08:00:00Z" });
    const refundId = await addRefund(db, o, { at: "2027-07-04T09:00:00Z", lines: [{ line: 0, quantity: 3, restockType: "MIXED" }] });
    await syncCases(env, o.orderId);
    const [c] = await casesOf(db, o.orderId);
    const ctx = ctxAt(env, "2027-07-28T10:00:00Z", STAFF);
    expect(await getReturnCase(ctx, c!.id)).toMatchObject({ quantityUncertain: true, units: { units: 0, uncertainUnits: 3 } });
    // Повторне читання WP3 (новий refund замовлення → upsert усіх) дописує розподіл старому рядку MIXED.
    await db.update(orderRefundLines).set({ restockQuantities: { CANCEL: 1, RETURN: 2 } }).where(eq(orderRefundLines.refundId, refundId));
    await syncCases(env, o.orderId);
    const after = await getReturnCase(ctx, c!.id);
    // Позицію не переписано (3), але й не показано «3 точно»: лишається верхня межа з позначкою «неточно».
    expect(after.lines).toEqual([expect.objectContaining({ quantity: 3, uncertain: true })]);
    expect(after).toMatchObject({ quantityUncertain: true, units: { units: 0, uncertainUnits: 3 } });
    const s = await returnStats(ctx, { range: { from: "2027-07-01", to: "2027-07-31" } });
    expect(s.units).toMatchObject({ total: 0, uncertain: 3, uncertainCases: 1 });
  });
});
