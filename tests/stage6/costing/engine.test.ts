/**
 * Етап 6, WP2: чистий рушій собівартості (docs/stage6-design.md §6.3, §6.8, золотий G5; інваріанти I1, I2).
 * Числа — точно (BigInt), як у документі.
 */
import { describe, expect, it } from "vitest";
import { allocateQ, averageUnit, cumulativeShares, currencyQuantum, mulDivQ, valueOfUnits } from "~/modules/costing/engine";
import { outflowWeights, remainingShare, splitRevaluation } from "~/modules/costing/revalue-calc";
import { toMinor } from "~/lib/money";
import { Sim, dec } from "./engine-sim";

const ORDER = "00000000-0000-4000-8000-000000000001";

describe("helpers", () => {
  it("valueOfUnits: the last unit takes the exact remainder", () => {
    expect(valueOfUnits(100000n, 1, 9)).toBe(11111n);
    expect(valueOfUnits(100000n, 9, 9)).toBe(100000n);
    expect(valueOfUnits(0n, 3, 5)).toBe(0n);
  });
  it("cumulativeShares sums exactly", () => {
    const parts = cumulativeShares(100000n, [3, 3, 3], 9);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(100000n);
    expect(parts).toEqual([33333n, 33334n, 33333n]);
  });
  it("averageUnit has 10 decimals in major units", () => {
    expect(averageUnit(100000n, 9)).toBe("111.1111111111");
    expect(averageUnit(80000n, 8)).toBe("100");
    expect(averageUnit(5n, 0)).toBeNull();
  });
});

describe("G5 — engine sequences (§6.8)", () => {
  it("batch 9 good + 1 defective × 100 → V = 1000.00, nine sales 111.11 × 7, 111.12, 111.11 = 1000.00; defect write-off 0", () => {
    const s = new Sim();
    const r = s.apply("receipt_production", { onHandDelta: 9, defectiveDelta: 1 }, { valueMinor: "1000.00" });
    expect(dec(r.valuation!.value)).toBe("1000.00");
    expect(r.effects).toEqual([{ type: "production_capitalized_memo", minor: 100000n, source: "production" }]);
    expect(s.state).toMatchObject({ knownQty: 9, knownValue: 100000n });
    const sales: string[] = [];
    for (let i = 0; i < 9; i++) sales.push(dec(s.apply("consume_sale", { onHandDelta: -1, orderId: ORDER }).valuation!.value)!);
    expect(sales).toEqual(["111.11", "111.11", "111.11", "111.11", "111.11", "111.11", "111.11", "111.12", "111.11"]);
    expect(sales.reduce((a, b) => a + toMinor(b), 0n)).toBe(100000n);
    const w = s.apply("defect_writeoff", { defectiveDelta: -1 });
    expect(w.effects).toEqual([]);
    expect(dec(w.valuation!.value)).toBeNull();
    expect(s.state).toMatchObject({ knownQty: 0, knownValue: 0n });
    expect(s.c0).toBe(true);
  });

  it("warehouse: 10 × 100, defect_mark 1 → loss 100.00, write-off → 0, sale 9 → 900.00", () => {
    const s = new Sim();
    s.apply("receipt_manual", { onHandDelta: 10, reason: "purchase" }, { valueMinor: "1000.00" });
    const mark = s.apply("defect_mark", { onHandDelta: -1, defectiveDelta: 1 });
    expect(mark.effects).toEqual([{ type: "inventory_loss", minor: 10000n, lossKind: "defect" }]);
    expect(s.layers.find((l) => l.kind === "defect")).toMatchObject({ qtyOpen: 1, valueOpen: 10000n });
    expect(s.apply("defect_writeoff", { defectiveDelta: -1 }).effects).toEqual([]);
    expect(s.layers.some((l) => l.kind === "defect")).toBe(false);
    expect(dec(s.apply("consume_sale", { onHandDelta: -9, orderId: ORDER }).valuation!.value)).toBe("900.00");
    expect(s.c0).toBe(true);
  });

  it("with defect_repair instead: inventory_gain +100.00, pool 10 on 1000.00, sale 10 → 1000.00; N = −100 + 100 = 0", () => {
    const s = new Sim();
    s.apply("receipt_manual", { onHandDelta: 10, reason: "purchase" }, { valueMinor: "1000.00" });
    const mark = s.apply("defect_mark", { onHandDelta: -1, defectiveDelta: 1 });
    const repair = s.apply("defect_repair", { onHandDelta: 1, defectiveDelta: -1 });
    expect(repair.effects).toEqual([{ type: "inventory_gain", minor: 10000n, gainKind: "repair" }]);
    expect(s.state).toMatchObject({ knownQty: 10, knownValue: 100000n });
    expect(dec(s.apply("consume_sale", { onHandDelta: -10, orderId: ORDER }).valuation!.value)).toBe("1000.00");
    const n = [...mark.effects, ...repair.effects].reduce((a, e) => a + (e.type === "inventory_loss" ? -e.minor : e.type === "inventory_gain" ? e.minor : 0n), 0n);
    expect(n).toBe(0n);
  });

  it("opening completion setup: 5 unknown, sale 3 (unknown), receipt 10 × 100, sale 4 → 2 unknown + 200.00", () => {
    const s = new Sim();
    s.apply("opening", { onHandDelta: 5, occurredOn: "2026-09-01" });
    expect(s.layers).toMatchObject([{ kind: "unknown", reason: "opening", qtyOpen: 5 }]);
    const s1 = s.apply("consume_sale", { onHandDelta: -3, orderId: ORDER, occurredOn: "2026-09-10" });
    expect(s1.valuation).toMatchObject({ knownQty: 0, unknownQty: 3, value: null, valueSource: "none" });
    expect(s1.valuation!.drawnLayers).toEqual([{ layerId: "L1", qty: 3 }]);
    s.apply("receipt_production", { onHandDelta: 10, occurredOn: "2026-09-15" }, { valueMinor: "1000.00" });
    const s2 = s.apply("consume_sale", { onHandDelta: -4, orderId: ORDER, occurredOn: "2026-09-20" });
    expect(s2.valuation).toMatchObject({ knownQty: 2, unknownQty: 2, value: 20000n });
    expect(s.state).toMatchObject({ knownQty: 8, knownValue: 80000n, unknownQty: 0 });
    // Шар відкриття вичерпано витратами, але НЕ закрито: витрачені одиниці ще чекають вартості.
    expect(s.c0).toBe(true);
  });

  it("negative stock: empty pool, sale 2 → deficit (no data); receipt 10 × 100 → completion 200.00 of that sale; pool 8 on 800.00", () => {
    const s = new Sim();
    const sale = s.apply("consume_sale", { onHandDelta: -2, orderId: ORDER, occurredOn: "2026-09-10" });
    expect(sale.valuation).toMatchObject({ deficitQty: 2, value: null });
    expect(s.state.deficitQty).toBe(2);
    const receipt = s.apply("receipt_production", { onHandDelta: 10, occurredOn: "2026-09-15" }, { valueMinor: "1000.00" });
    expect(receipt.deficitCompletions).toEqual([{ layerId: "L1", saleValuationId: sale.valuation!.id, qty: 2, minor: 20000n }]);
    expect(s.state).toMatchObject({ knownQty: 8, knownValue: 80000n, deficitQty: 0 });
    expect(receipt.valuation!.details).toMatchObject({ poolQty: 8, poolValue: "800.00", deficitClosedQty: 2, deficitClosedValue: "200.00" });
    expect(s.c0).toBe(true);
  });

  it("receipt without cost closes the deficit by quantity only (those sales stay without cost)", () => {
    const s = new Sim();
    s.apply("consume_sale", { onHandDelta: -2, orderId: ORDER });
    const r = s.apply("receipt_manual", { onHandDelta: 5, reason: "found" });
    expect(r.deficitCompletions).toEqual([{ layerId: "L1", saleValuationId: "V1", qty: 2, minor: null }]);
    expect(s.state).toMatchObject({ deficitQty: 0, unknownQty: 3, knownQty: 0 });
    expect(s.layers).toMatchObject([{ reason: "receipt_without_cost", qtyOpen: 3 }]);
    expect(s.c0).toBe(true);
  });

  it("all-defective production receipt: V to the pool if known units exist, else inventory_loss production_defect", () => {
    const empty = new Sim();
    const r1 = empty.apply("receipt_production", { onHandDelta: 0, defectiveDelta: 2 }, { valueMinor: "200.00" });
    expect(r1.effects).toEqual([{ type: "inventory_loss", minor: 20000n, lossKind: "production_defect" }]);
    const s = new Sim();
    s.apply("receipt_production", { onHandDelta: 2 }, { valueMinor: "200.00" });
    s.apply("receipt_production", { onHandDelta: 0, defectiveDelta: 1 }, { valueMinor: "100.00" });
    expect(s.state).toMatchObject({ knownQty: 2, knownValue: 30000n });
  });

  it("fx_pending: no rate → layer with the original unit cost; the layer does not close deficits", () => {
    const s = new Sim();
    s.apply("consume_sale", { onHandDelta: -1, orderId: ORDER });
    const r = s.apply("receipt_production", { onHandDelta: 4 }, { value: { status: "no_rate", originalAmount: "40.00", originalCurrency: "EUR", unitCost: "10.00" } });
    expect(r.valuation).toMatchObject({ value: null, originalAmount: "40.00", originalCurrency: "EUR", unknownQty: 4 });
    expect(s.layers.find((l) => l.reason === "fx_pending")).toMatchObject({ qtyOpen: 4, pendingUnitCost: "10.00", pendingCurrency: "EUR" });
    expect(s.state).toMatchObject({ unknownQty: 4, deficitQty: 1 });
    expect(s.c0).toBe(true);
  });

  it("owner standard values draws from unknown layers (owner_standard) but never fx_pending layers or deficits", () => {
    const s = new Sim();
    s.apply("opening", { onHandDelta: 2 });
    const std = { minor: 9000n, source: "owner_standard" as const, costId: "c1" };
    const r = s.apply("consume_sale", { onHandDelta: -3, orderId: ORDER }, { standard: std });
    expect(r.valuation).toMatchObject({ knownQty: 2, unknownQty: 0, deficitQty: 1, value: 18000n, valueSource: "owner_standard" });
    expect(r.valuation!.details).toMatchObject({ standardQty: 2, standardValue: "180.00", poolQty: 0 });
  });

  it("opening with an owner manual cost → known at owner_standard", () => {
    const s = new Sim();
    const r = s.apply("opening", { onHandDelta: 5 }, { standard: { minor: 21000n, source: "owner_standard", costId: "c" } });
    expect(r.valuation).toMatchObject({ value: 105000n, valueSource: "owner_standard", knownQty: 5 });
    expect(s.state).toMatchObject({ knownQty: 5, knownValue: 105000n, unknownQty: 0 });
  });

  it("adjustment / shopify_external: + at the current average (inventory_gain) or surplus layer; − loss", () => {
    const s = new Sim();
    const surplus = s.apply("adjustment", { onHandDelta: 2 });
    expect(surplus.effects).toEqual([]);
    expect(s.layers).toMatchObject([{ reason: "surplus_without_cost", qtyOpen: 2 }]);
    s.apply("receipt_manual", { onHandDelta: 4, reason: "purchase" }, { valueMinor: "400.00" });
    const gain = s.apply("adjustment", { onHandDelta: 2 });
    expect(gain.effects).toEqual([{ type: "inventory_gain", minor: 20000n, gainKind: "surplus" }]);
    const loss = s.apply("shopify_external", { onHandDelta: -3 });
    // 2 одиниці з шару надлишку (без вартості) + 1 з пулу (100.00).
    expect(loss.valuation).toMatchObject({ unknownQty: 2, knownQty: 1, value: 10000n });
    expect(loss.effects).toEqual([{ type: "inventory_loss", minor: 10000n, lossKind: "shopify_external" }]);
    expect(s.c0).toBe(true);
  });

  it("material_consume without an order → packaging_unlinked; material receipt without price → catalogue", () => {
    const s = new Sim();
    const cat = { minor: 1200n, source: "catalogue" as const, costId: null };
    const r = s.apply("receipt_manual", { onHandDelta: 10, stockKind: "material", reason: "material_receipt" }, { standard: cat });
    expect(r.valuation).toMatchObject({ value: 12000n, valueSource: "catalogue" });
    expect(r.effects).toEqual([]);
    const c = s.apply("material_consume", { onHandDelta: -2, stockKind: "material" });
    expect(c.effects).toEqual([{ type: "packaging_unlinked", minor: 2400n }]);
    const withOrder = s.apply("material_consume", { onHandDelta: -1, stockKind: "material", orderId: ORDER });
    expect(withOrder.effects).toEqual([]);
    expect(withOrder.valuation!.details.effect).toBe("order");
    const purchase = s.apply("receipt_manual", { onHandDelta: 5, stockKind: "material", reason: "material_receipt" }, { valueMinor: "50.00" });
    expect(purchase.effects).toEqual([{ type: "materials_purchased_memo", minor: 5000n }]);
  });
});

describe("G5 — customer returns", () => {
  it("(a) variant without consumption: return valued by the stdcogs entry (owner_standard), pool 1 at 210.00; resale 210.00", () => {
    const s = new Sim();
    const ret = s.apply(
      "receipt_manual",
      { onHandDelta: 1, reason: "customer_return", orderId: ORDER },
      { returnSources: { pairedDefectQty: null, sales: [], standards: [{ entryId: "E1", unitMinor: 21000n, qty: 1 }] } },
    );
    expect(ret.valuation).toMatchObject({ value: 21000n, valueSource: "owner_standard", knownQty: 1 });
    expect(ret.effects).toEqual([]); // cogs_return замовлення проводить syncOrderFinance (WP4)
    expect(s.state).toMatchObject({ knownQty: 1, knownValue: 21000n });
    expect(dec(s.apply("consume_sale", { onHandDelta: -1, orderId: ORDER }).valuation!.value)).toBe("210.00");
  });

  it("(b) sale 3 = 2 unknown + 1 known 100.00; return 1 → 100.00 (known first); return 1 more → return_without_cost layer linked to the sale", () => {
    const s = new Sim();
    s.apply("opening", { onHandDelta: 2 });
    s.apply("receipt_manual", { onHandDelta: 1, reason: "purchase" }, { valueMinor: "100.00" });
    const sale = s.apply("consume_sale", { onHandDelta: -3, orderId: ORDER });
    expect(sale.valuation).toMatchObject({ knownQty: 1, unknownQty: 2, value: 10000n });
    const r1 = s.apply(
      "receipt_manual",
      { onHandDelta: 1, reason: "customer_return", orderId: ORDER },
      { returnSources: { pairedDefectQty: null, sales: [{ valuationId: sale.valuation!.id, knownUnits: 1, knownValue: 10000n, unvaluedUnits: 2 }], standards: [] } },
    );
    expect(r1.valuation).toMatchObject({ value: 10000n, valueSource: "original_sale" });
    expect(r1.valuation!.details.fromSales).toEqual([`${sale.valuation!.id}:1:100.00:0`]);
    const r2 = s.apply(
      "receipt_manual",
      { onHandDelta: 1, reason: "customer_return", orderId: ORDER },
      { returnSources: { pairedDefectQty: null, sales: [{ valuationId: sale.valuation!.id, knownUnits: 0, knownValue: 0n, unvaluedUnits: 2 }], standards: [] } },
    );
    expect(r2.valuation).toMatchObject({ value: null, unknownQty: 1 });
    expect(s.layers.find((l) => l.reason === "return_without_cost")).toMatchObject({ qtyOpen: 1, sourceValuationId: sale.valuation!.id });
    expect(s.state).toMatchObject({ knownQty: 1, knownValue: 10000n, unknownQty: 1 });
    expect(s.c0).toBe(true);
  });

  it("damaged unit — both stage-5 records give the same valuation: sale 2 × 100; return 1 good + 1 damaged → +100.00 only", () => {
    const setup = () => {
      const s = new Sim();
      s.apply("receipt_manual", { onHandDelta: 2, reason: "purchase" }, { valueMinor: "200.00" });
      const sale = s.apply("consume_sale", { onHandDelta: -2, orderId: ORDER });
      return { s, saleId: sale.valuation!.id };
    };
    const src = (saleId: string, paired: number | null) => ({ pairedDefectQty: paired, sales: [{ valuationId: saleId, knownUnits: 2, knownValue: 20000n, unvaluedUnits: 0 }], standards: [] });
    // З розділенням: надходження on_hand 2 (якісна + пошкоджена), потім парний defect_mark 1.
    const a = setup();
    const ra = a.s.apply("receipt_manual", { onHandDelta: 2, reason: "customer_return", orderId: ORDER, idempotencyKey: "manual:x" }, { returnSources: src(a.saleId, 1) });
    const pa = a.s.apply("defect_mark", { onHandDelta: -1, defectiveDelta: 1, orderId: ORDER, idempotencyKey: "manual:x:return_defect" }, { pairedReturnDefect: true });
    // Без розділення: on_hand 1, defective 1.
    const b = setup();
    const rb = b.s.apply("receipt_manual", { onHandDelta: 1, defectiveDelta: 1, reason: "customer_return", orderId: ORDER }, { returnSources: src(b.saleId, null) });
    expect(ra.valuation!.value).toBe(10000n);
    expect(rb.valuation!.value).toBe(10000n);
    expect(pa.effects).toEqual([]);
    expect(pa.valuation).toMatchObject({ value: 0n, valueSource: "zero" });
    expect({ ...a.s.state, lastSeq: 0 }).toEqual({ ...b.s.state, lastSeq: 0 });
    // Собівартість замовлення: −200 + 100 = −100.
    expect(-20000n + ra.valuation!.value!).toBe(-10000n);
    expect(a.s.c0 && b.s.c0).toBe(true);
  });

  it("return without order → pool average, cogs_return without order (period)", () => {
    const s = new Sim();
    s.apply("receipt_manual", { onHandDelta: 4, reason: "purchase" }, { valueMinor: "400.00" });
    const r = s.apply("receipt_manual", { onHandDelta: 1, reason: "customer_return" }, { returnSources: { pairedDefectQty: null, sales: [], standards: [] } });
    expect(r.valuation).toMatchObject({ value: 10000n, valueSource: "pool_average" });
    expect(r.effects).toEqual([{ type: "cogs_return_unlinked", minor: 10000n }]);
    const empty = new Sim();
    const r2 = empty.apply("receipt_manual", { onHandDelta: 1, reason: "customer_return" }, { returnSources: { pairedDefectQty: null, sales: [], standards: [] } });
    expect(r2.valuation).toMatchObject({ value: null, unknownQty: 1 });
    expect(empty.layers).toMatchObject([{ reason: "return_without_cost", sourceValuationId: null }]);
  });
});

describe("G5 — batch adjustment split (§6.7)", () => {
  const pct = (d: string) => toMinor(d);
  it("10 × 100 (01.10), sold 4; 05.11 cost → 110: Δ 100 → Δ_stock 60.00, cogs_adjustment −40.00", () => {
    const split = splitRevaluation({
      delta: pct("100.00"),
      goodQty: 10,
      deficitClosedQty: 0,
      outflows: [{ knownBefore: 10, knownAfter: 6, bucket: "sales" }],
      currentKnownQty: 6,
      currentKnownValue: pct("600.00"),
    });
    expect(split).toEqual({ deltaDeficit: 0n, deltaStock: 6000n, buckets: { sales: 4000n, loss: 0n } });
  });
  it("(A) all 10 sold, then B arrives: r = 0 → Δ_stock 0, cogs −100.00", () => {
    const split = splitRevaluation({
      delta: pct("100.00"),
      goodQty: 10,
      deficitClosedQty: 0,
      outflows: [{ knownBefore: 10, knownAfter: 0, bucket: "sales" }],
      currentKnownQty: 10,
      currentKnownValue: pct("1200.00"),
    });
    expect(split).toEqual({ deltaDeficit: 0n, deltaStock: 0n, buckets: { sales: 10000n, loss: 0n } });
  });
  it("(Б) sold 4, then B, then sold 14 (16 → 2): r = 6/10 × 2/16 → Δ_stock 7.50, cogs −92.50", () => {
    const outflows = [
      { knownBefore: 10, knownAfter: 6, bucket: "sales" as const },
      { knownBefore: 16, knownAfter: 2, bucket: "sales" as const },
    ];
    expect(remainingShare(outflows)).toEqual({ num: 12n, den: 160n });
    expect(outflowWeights(outflows)).toEqual([64n, 84n]);
    const split = splitRevaluation({ delta: pct("100.00"), goodQty: 10, deficitClosedQty: 0, outflows, currentKnownQty: 2, currentKnownValue: pct("240.00") });
    expect(split).toEqual({ deltaDeficit: 0n, deltaStock: 750n, buckets: { sales: 9250n, loss: 0n } });
  });
  it("(В) pool 5 × 10; A 10 × 100; sold 10; A → 0 (Δ −1000.00): Δ_stock −333.33 (pool 16.67), cogs +666.67; pool never negative", () => {
    const split = splitRevaluation({
      delta: pct("-1000.00"),
      goodQty: 10,
      deficitClosedQty: 0,
      outflows: [{ knownBefore: 15, knownAfter: 5, bucket: "sales" }],
      currentKnownQty: 5,
      currentKnownValue: pct("350.00"),
    });
    expect(split).toEqual({ deltaDeficit: 0n, deltaStock: -33333n, buckets: { sales: -66667n, loss: 0n } });
    expect(pct("350.00") + split.deltaStock).toBe(1667n);
    const clipped = splitRevaluation({ delta: pct("-1000.00"), goodQty: 10, deficitClosedQty: 0, outflows: [], currentKnownQty: 5, currentKnownValue: pct("100.00") });
    expect(clipped.deltaStock).toBe(-10000n);
    expect(clipped.buckets.loss).toBe(-90000n);
  });
  it("closed deficits take their share (s of g) to sales; defects/shortages → loss", () => {
    const split = splitRevaluation({
      delta: pct("100.00"),
      goodQty: 10,
      deficitClosedQty: 2,
      outflows: [{ knownBefore: 8, knownAfter: 6, bucket: "loss" }],
      currentKnownQty: 6,
      currentKnownValue: pct("600.00"),
    });
    // Δ_deficit = 100 × 2/10 = 20; Δ_pool = 80; r = 6/8 → 60; loss 20.
    expect(split).toEqual({ deltaDeficit: 2000n, deltaStock: 6000n, buckets: { sales: 2000n, loss: 2000n } });
  });
});

// I1 / I2 на випадкових послідовностях — tests/stage6/costing/engine-invariants.test.ts (незалежна перевірка збереження
// вартості з контрольованих тестом входів, повернення, брак, fx_pending, матеріали, JPY).

describe("review round — returns of deficit sales, 0-decimal valuation currency, defect-only receipt without a rate", () => {
  it("F1: a returned unit of a deficit sale cancels that sale's deficit (no layer); a later receipt values only the still-sold unit", () => {
    const s = new Sim();
    const sale = s.apply("consume_sale", { onHandDelta: -2, orderId: ORDER });
    expect(s.state).toMatchObject({ knownQty: 0, deficitQty: 2 });
    const ret = s.apply(
      "receipt_manual",
      { onHandDelta: 1, reason: "customer_return", orderId: ORDER },
      { returnSources: { pairedDefectQty: null, sales: [{ valuationId: sale.valuation!.id, knownUnits: 0, knownValue: 0n, unvaluedUnits: 2 }], standards: [] } },
    );
    expect(ret.valuation).toMatchObject({ value: null, unknownQty: 0 });
    expect(ret.valuation!.details).toMatchObject({ deficitCancelledQty: 1, fromSales: [`${sale.valuation!.id}:0:0.00:1`] });
    expect(s.state).toMatchObject({ knownQty: 0, unknownQty: 0, deficitQty: 1 });
    expect(s.c0).toBe(true);
    const receipt = s.apply("receipt_manual", { onHandDelta: 10, reason: "purchase" }, { valueMinor: "1000.00" });
    expect(receipt.deficitCompletions.map((c) => [c.saleValuationId, c.qty, dec(c.minor)])).toEqual([[sale.valuation!.id, 1, "100.00"]]);
    expect(s.state).toMatchObject({ knownQty: 9, knownValue: 90000n, unknownQty: 0, deficitQty: 0 });
  });

  it("F1: units of another sale returned without a value stay a return_without_cost layer and do not close a deficit", () => {
    const s = new Sim();
    s.apply("opening", { onHandDelta: 1 });
    const a = s.apply("consume_sale", { onHandDelta: -1, orderId: ORDER });
    s.apply("consume_sale", { onHandDelta: -1, orderId: ORDER });
    s.apply(
      "receipt_manual",
      { onHandDelta: 1, reason: "customer_return", orderId: ORDER },
      { returnSources: { pairedDefectQty: null, sales: [{ valuationId: a.valuation!.id, knownUnits: 0, knownValue: 0n, unvaluedUnits: 1 }], standards: [] } },
    );
    expect(s.state).toMatchObject({ unknownQty: 1, deficitQty: 1 });
    expect(s.layers.find((l) => l.reason === "return_without_cost")).toMatchObject({ qtyOpen: 1, sourceValuationId: a.valuation!.id });
    expect(s.c0).toBe(true);
  });

  it("F6: JPY — shares are whole yen (quantum 100), totals exact; helpers keep the remainder rule", () => {
    expect(currencyQuantum("JPY")).toBe(100n);
    expect(currencyQuantum("UAH")).toBe(1n);
    expect(valueOfUnits(400100n, 1, 4, 100n)).toBe(100000n);
    expect(cumulativeShares(400100n, [1, 1, 1, 1], 4, 100n)).toEqual([100000n, 100100n, 100000n, 100000n]);
    expect(mulDivQ(300100n, 2n, 3n, 100n)).toBe(200100n);
    expect(allocateQ(100100n, [1n, 1n, 1n], 100n).reduce((a, b) => a + b, 0n)).toBe(100100n);
    const s = new Sim("JPY");
    s.apply("receipt_manual", { onHandDelta: 3, reason: "purchase" }, { valueMinor: "3000.00" });
    s.apply("receipt_manual", { onHandDelta: 1, reason: "purchase" }, { valueMinor: "1001.00" });
    const adj = s.apply("adjustment", { onHandDelta: -1 });
    expect(adj.valuation!.value).toBe(100000n);
    expect(adj.effects).toEqual([{ type: "inventory_loss", minor: 100000n, lossKind: "shortage" }]);
    const sale = s.apply("consume_sale", { onHandDelta: -2, orderId: ORDER });
    expect(sale.valuation!.value).toBe(200100n);
    expect(s.state).toMatchObject({ knownQty: 1, knownValue: 100000n });
  });

  it("F11: a defect-only receipt without a rate leaves an fx_pending marker (qty_in = defects, no open units, outside C0)", () => {
    const s = new Sim();
    const r = s.apply("receipt_production", { onHandDelta: 0, defectiveDelta: 2 }, { value: { status: "no_rate", originalAmount: "20.00", originalCurrency: "PLN", unitCost: "10.00" } });
    expect(r.valuation).toMatchObject({ qty: 0, value: null });
    expect(r.valuation!.details).toMatchObject({ fxPending: true, defectOnly: true, defectiveQty: 2 });
    expect(s.state).toMatchObject({ knownQty: 0, unknownQty: 0, deficitQty: 0 });
    expect(s.c0).toBe(true);
  });
});
