/**
 * Етап 6, WP9: чисті правила розділу «Повернення» (docs/stage6-design.md §11).
 * - які повернення коштів утворюють випадок (RETURN завжди; NO_RESTOCK / LEGACY_RESTOCK — лише після відвантаження;
 *   CANCEL і рядки без кількості — ніколи);
 * - план синхронізації: ідемпотентність (повторний план над результатом порожній), зв'язування в обох порядках
 *   (повернення коштів → надходження, надходження → повернення коштів), «Лише повернення коштів» + надходження →
 *   «Повернення покупця», закриті випадки не змінюються, друге повернення — новий випадок;
 * - одиниці = max(заявлено, оглянуто) на позицію; середні дні й частка — точно, без float, порожнє → null;
 * - CARRIER_RETURN_CODES — за ключем перевізника (nova_post 102/103/131/132, test TEST-RETURN), чужий код → null;
 * - детерміновані id позицій.
 */
import { describe, expect, it } from "vitest";
import { RETURN_KINDS, RETURN_LINE_CONDITIONS, RETURN_REASON_CODES, RETURN_SOURCES, RETURN_STATUSES } from "~/domain/finance";
import { DICTIONARIES } from "~/i18n";
import { NOVA_POST_CODE } from "~/integrations/carriers/nova-post/mapping";
import { NOVA_POST_TRACKING_CODES } from "~/integrations/carriers/nova-post/tracking-codes";
import { TEST_CARRIER_CODE } from "~/integrations/carriers/test-carrier";
import { CARRIER_RETURN_CODES, CARRIER_RETURN_SIGNALS, carrierReturnSignal, SIGNAL_CASE_KIND, SIGNAL_REASON } from "~/modules/returns/carrier-codes";
import { returnLineId, returnSourceKeys } from "~/modules/returns/keys";
import { returnsLabelKeys } from "~/modules/returns/labels";
import { returnsPeriodOf } from "~/modules/returns/period";
import {
  averageDays,
  caseUnits,
  classifyRefund,
  groupCounts,
  isReturnRestock,
  isUncertainRestock,
  planReturnSync,
  receiptLineIds,
  refundLineIds,
  sharePercent,
  statusDates,
  type ExistingCase,
  type PlanInput,
  type ReceiptSource,
  type RefundSource,
  type ReturnSyncPlan,
} from "~/modules/returns/rules";

const T0 = new Date("2026-11-01T10:00:00Z");
const day = (n: number) => new Date(T0.getTime() + n * 86_400_000);
const SHIPPED = { shippedAt: day(0), shipped: true };
const NOT_SHIPPED = { shippedAt: null, shipped: false };

function refund(id: string, at: Date, lines: Array<Partial<RefundSource["lines"][number]>>): RefundSource {
  return {
    refundId: id,
    at,
    lines: lines.map((l, i) => ({
      shopifyLineItemId: `gid://shopify/LineItem/${i + 1}`,
      orderLineItemId: `li-${i + 1}`,
      variantId: `v-${i + 1}`,
      quantity: 1,
      restockType: "RETURN",
      ...l,
    })),
  };
}

function receipt(id: string, at: Date, good: number, damaged = 0, over: Partial<ReceiptSource> = {}): ReceiptSource {
  return {
    movementId: id,
    at,
    seq: 1,
    variantId: "v-1",
    orderLineItemId: "li-1",
    good,
    damaged,
    ...over,
  };
}

let counter = 0;
const newId = () => `case-${++counter}`;

/** Застосовує план до стану (як sync.server.ts), щоб перевірити повторний запуск. */
function applyPlan(input: PlanInput, plan: ReturnSyncPlan): Pick<PlanInput, "cases" | "lines"> {
  const cases: ExistingCase[] = input.cases.map((c) => {
    const u = plan.updates.find((x) => x.id === c.id);
    return u
      ? {
          ...c,
          kind: u.kind,
          status: u.status,
          firstSignalAt: u.firstSignalAt,
          receivedAt: u.receivedAt,
          version: c.version + 1,
        }
      : c;
  });
  for (const c of plan.creates) cases.push({ ...c, createdAt: c.firstSignalAt, version: 1 });
  return {
    cases,
    lines: [...input.lines, ...plan.lines.map((l) => ({ id: l.id, returnId: l.returnId }))],
  };
}

function plan(input: Partial<PlanInput>): {
  input: PlanInput;
  plan: ReturnSyncPlan;
} {
  const full: PlanInput = {
    refunds: [],
    receipts: [],
    shipping: SHIPPED,
    cases: [],
    lines: [],
    newId,
    ...input,
  };
  return { input: full, plan: planReturnSync(full) };
}

describe("classifyRefund", () => {
  it("RETURN always creates a customer return, even before a known handover (fulfilled elsewhere)", () => {
    expect(classifyRefund(refund("r1", day(3), [{ restockType: "RETURN" }]), NOT_SHIPPED)).toMatchObject({ kind: "customer_return" });
    expect(classifyRefund(refund("r1", day(3), [{ restockType: "return" }]), SHIPPED)).toMatchObject({ kind: "customer_return" });
  });

  it("NO_RESTOCK after shipment → refund only; before shipment (or CANCEL / no lines / qty 0) → not a return", () => {
    expect(classifyRefund(refund("r1", day(3), [{ restockType: "NO_RESTOCK" }]), SHIPPED)).toMatchObject({ kind: "refund_only" });
    expect(classifyRefund(refund("r1", day(3), [{ restockType: null }]), SHIPPED)).toMatchObject({ kind: "refund_only" });
    expect(classifyRefund(refund("r1", day(-1), [{ restockType: "NO_RESTOCK" }]), SHIPPED)).toBeNull();
    expect(classifyRefund(refund("r1", day(3), [{ restockType: "NO_RESTOCK" }]), NOT_SHIPPED)).toBeNull();
    expect(classifyRefund(refund("r1", day(3), [{ restockType: "CANCEL" }]), SHIPPED)).toBeNull();
    expect(classifyRefund(refund("r1", day(3), []), SHIPPED)).toBeNull();
    expect(classifyRefund(refund("r1", day(3), [{ quantity: 0 }]), SHIPPED)).toBeNull();
    // Відвантажено (час невідомий) — як після відвантаження.
    expect(
      classifyRefund(refund("r1", day(3), [{ restockType: "NO_RESTOCK" }]), {
        shippedAt: null,
        shipped: true,
      }),
    ).toMatchObject({ kind: "refund_only" });
  });

  it("LEGACY_RESTOCK counts as returned only after shipment; mixed lines keep only the qualifying ones", () => {
    expect(classifyRefund(refund("r1", day(3), [{ restockType: "LEGACY_RESTOCK" }]), SHIPPED)).toMatchObject({ kind: "customer_return" });
    expect(classifyRefund(refund("r1", day(3), [{ restockType: "LEGACY_RESTOCK" }]), NOT_SHIPPED)).toBeNull();
    const mixed = classifyRefund(refund("r1", day(3), [{ restockType: "CANCEL" }, { restockType: "RETURN" }]), SHIPPED);
    expect(mixed?.lines.map((l) => l.restockType)).toEqual(["RETURN"]);
    expect(mixed?.uncertain).toBe(false);
  });

  // Ревізія WP9 №1: WP3 об'єднує кілька рядків повернення однієї позиції з різними видами в один рядок `MIXED`
  // (розподіл кількості втрачено). Такий рядок МОЖЕ містити повернення товару — НІКОЛИ не «Лише повернення коштів» мовчки.
  it("MIXED (WP3 merge of different restock types) → possibly a customer return, flagged uncertain; never refund-only", () => {
    const m = classifyRefund(refund("r1", day(3), [{ restockType: "MIXED", quantity: 3 }]), SHIPPED);
    expect(m).toMatchObject({ kind: "customer_return", uncertain: true });
    expect(m?.lines).toHaveLength(1);
    // MIXED + NO_RESTOCK — так само можливе повернення (вид не «Лише повернення коштів»).
    expect(classifyRefund(refund("r1", day(3), [{ restockType: "MIXED" }, { restockType: "NO_RESTOCK" }]), SHIPPED)).toMatchObject({
      kind: "customer_return",
      uncertain: true,
    });
    // RETURN поруч — вид напевно «Повернення покупця», але рядок MIXED лишається неточним.
    expect(classifyRefund(refund("r1", day(3), [{ restockType: "RETURN" }, { restockType: "mixed" }]), SHIPPED)).toMatchObject({
      kind: "customer_return",
      uncertain: true,
    });
    // До відвантаження MIXED (напр. CANCEL + NO_RESTOCK невідвантаженого) — випадку не утворює, як і інші рядки не RETURN.
    expect(classifyRefund(refund("r1", day(3), [{ restockType: "MIXED" }]), NOT_SHIPPED)).toBeNull();
    expect(isReturnRestock("MIXED")).toBe(true);
    expect(isUncertainRestock("MIXED")).toBe(true);
    expect(isUncertainRestock("RETURN")).toBe(false);
    expect(isReturnRestock("NO_RESTOCK")).toBe(false);
    expect(isReturnRestock("CANCEL")).toBe(false);
  });

  it("a MIXED refund plans a customer-return case with the whole merged quantity as an upper bound (condition unknown)", () => {
    const { plan: p } = plan({ refunds: [refund("r1", day(3), [{ restockType: "MIXED", quantity: 3 }])] });
    expect(p.creates).toEqual([expect.objectContaining({ kind: "customer_return", status: "open", source: "shopify_refund" })]);
    expect(p.lines).toEqual([expect.objectContaining({ quantity: 3, condition: "unknown", restockedQty: 0 })]);
  });
});

describe("planReturnSync", () => {
  it("refund → open case with refund lines; receipt → links (received, restocked), idempotent on re-run", () => {
    const r = refund("r1", day(4), [{ quantity: 1 }]);
    const m = receipt("m1", day(6), 1);
    const first = plan({ refunds: [r], receipts: [m] });
    expect(first.plan.creates).toHaveLength(1);
    const created = first.plan.creates[0]!;
    expect(created).toMatchObject({
      kind: "customer_return",
      status: "received",
      source: "shopify_refund",
      sourceKey: returnSourceKeys.refund("r1"),
    });
    expect(created.firstSignalAt).toEqual(day(4));
    expect(created.receivedAt).toEqual(day(6));
    expect(first.plan.lines.map((l) => [l.condition, l.quantity, l.restockedQty])).toEqual([
      ["unknown", 1, 0],
      ["resellable", 1, 1],
    ]);
    expect(first.plan.linked).toEqual([{ returnId: created.id, sourceKey: returnSourceKeys.receipt("m1") }]);
    const state = applyPlan(first.input, first.plan);
    const again = planReturnSync({ ...first.input, ...state });
    expect(again).toEqual({ creates: [], updates: [], lines: [], linked: [] });
  });

  it("receipt first, refund later: the refund joins the receipt case (one case, not two)", () => {
    const m = receipt("m1", day(5), 0, 1);
    const step1 = plan({ receipts: [m] });
    expect(step1.plan.creates[0]).toMatchObject({
      kind: "customer_return",
      status: "received",
      source: "stock_receipt",
    });
    const state = applyPlan(step1.input, step1.plan);
    const r = refund("r1", day(7), [{ quantity: 1 }]);
    const step2 = planReturnSync({ ...step1.input, ...state, refunds: [r] });
    expect(step2.creates).toEqual([]);
    expect(step2.lines).toHaveLength(1);
    expect(step2.lines[0]!.returnId).toBe(step1.plan.creates[0]!.id);
    expect(step2.linked).toEqual([
      {
        returnId: step1.plan.creates[0]!.id,
        sourceKey: returnSourceKeys.refund("r1"),
      },
    ]);
  });

  it("refund only + goods arriving later → customer return; the earlier signal date wins", () => {
    const r = refund("r1", day(4), [{ restockType: "NO_RESTOCK" }]);
    const step1 = plan({ refunds: [r] });
    expect(step1.plan.creates[0]).toMatchObject({
      kind: "refund_only",
      status: "open",
    });
    const state = applyPlan(step1.input, step1.plan);
    const step2 = planReturnSync({
      ...step1.input,
      ...state,
      receipts: [receipt("m1", day(9), 1)],
    });
    expect(step2.updates).toEqual([
      expect.objectContaining({
        id: step1.plan.creates[0]!.id,
        kind: "customer_return",
        status: "received",
        firstSignalAt: day(4),
        receivedAt: day(9),
        expectedVersion: 1,
      }),
    ]);
  });

  it("closed cases are never targets: a second refund and a second receipt start a new case", () => {
    const closed: ExistingCase = {
      id: "closed-1",
      kind: "customer_return",
      status: "closed",
      source: "shopify_refund",
      sourceKey: returnSourceKeys.refund("old"),
      firstSignalAt: day(1),
      receivedAt: day(2),
      createdAt: day(1),
      version: 3,
    };
    const p = plan({
      cases: [closed],
      refunds: [refund("r2", day(20), [{ shopifyLineItemId: "gid://shopify/LineItem/9" }])],
      receipts: [receipt("m2", day(22), 1)],
    });
    expect(p.plan.updates).toEqual([]);
    expect(p.plan.creates).toHaveLength(1);
    expect(p.plan.creates[0]).toMatchObject({
      status: "received",
      source: "shopify_refund",
    });
    expect(p.plan.lines.every((l) => l.returnId === p.plan.creates[0]!.id)).toBe(true);
  });

  it("a carrier/manual case in transit receives the parcel; a refund then joins it", () => {
    const hint: ExistingCase = {
      id: "hint-1",
      kind: "refused",
      status: "in_transit",
      source: "carrier_hint",
      sourceKey: returnSourceKeys.carrier("s1"),
      firstSignalAt: day(3),
      receivedAt: null,
      createdAt: day(3),
      version: 1,
    };
    const p = plan({
      cases: [hint],
      receipts: [receipt("m1", day(8), 2)],
      refunds: [refund("r1", day(10), [{ quantity: 2 }])],
    });
    expect(p.plan.creates).toEqual([]);
    expect(p.plan.updates).toEqual([
      expect.objectContaining({
        id: "hint-1",
        kind: "refused",
        status: "received",
        receivedAt: day(8),
      }),
    ]);
    expect(p.plan.lines.map((l) => l.returnId)).toEqual(["hint-1", "hint-1"]);
  });

  it("a non-qualifying refund (before shipment) creates nothing; a receipt without units is ignored", () => {
    const p = plan({
      refunds: [refund("r1", day(-2), [{ restockType: "NO_RESTOCK" }])],
      receipts: [receipt("m0", day(3), 0, 0)],
    });
    expect(p.plan).toEqual({ creates: [], updates: [], lines: [], linked: [] });
  });

  it("a source already claimed by line ids (linked to a case with another key) is skipped", () => {
    const r = refund("r1", day(4), [{}]);
    const existing: ExistingCase = {
      id: "c-1",
      kind: "customer_return",
      status: "received",
      source: "stock_receipt",
      sourceKey: returnSourceKeys.receipt("m1"),
      firstSignalAt: day(3),
      receivedAt: day(3),
      createdAt: day(3),
      version: 2,
    };
    const lines = [...refundLineIds(r), ...receiptLineIds({ movementId: "m1" })].map((id) => ({ id, returnId: "c-1" }));
    const p = plan({
      refunds: [r],
      receipts: [receipt("m1", day(3), 1)],
      cases: [existing],
      lines,
    });
    expect(p.plan).toEqual({ creates: [], updates: [], lines: [], linked: [] });
  });
});

describe("units and statistics helpers", () => {
  it("units per item = max(announced, inspected); restocked and damaged are summed", () => {
    const u = caseUnits([
      {
        id: "a",
        orderLineItemId: "li-1",
        variantId: "v-1",
        quantity: 2,
        condition: "unknown",
        restockedQty: 0,
      },
      {
        id: "b",
        orderLineItemId: "li-1",
        variantId: "v-1",
        quantity: 1,
        condition: "resellable",
        restockedQty: 1,
      },
      {
        id: "c",
        orderLineItemId: "li-1",
        variantId: "v-1",
        quantity: 1,
        condition: "damaged",
        restockedQty: 0,
      },
      {
        id: "d",
        orderLineItemId: "li-2",
        variantId: "v-2",
        quantity: 1,
        condition: "resellable",
        restockedQty: 1,
      },
    ]);
    expect(u).toMatchObject({ units: 3, restocked: 2, damaged: 1 });
    expect(u.items.map((i) => [i.key, i.units, i.announced, i.inspected])).toEqual([
      ["li:li-1", 2, 2, 2],
      ["li:li-2", 1, 0, 1],
    ]);
    expect(caseUnits([])).toEqual({
      units: 0,
      restocked: 0,
      damaged: 0,
      uncertainUnits: 0,
      items: [],
    });
  });

  it("uncertain (MIXED) announced units are not added to the exact units: «up to N more»; inspection settles them", () => {
    const mixed = {
      id: "m",
      orderLineItemId: "li-1",
      variantId: "v-1",
      quantity: 3,
      condition: "unknown" as const,
      restockedQty: 0,
      uncertain: true,
    };
    expect(caseUnits([mixed])).toMatchObject({ units: 0, uncertainUnits: 3 });
    // Склад оглянув 2 — точно 2, можливо ще 1 (верхня межа 3).
    const u = caseUnits([mixed, { ...mixed, id: "g", quantity: 2, condition: "resellable", restockedQty: 2, uncertain: false }]);
    expect(u).toMatchObject({ units: 2, restocked: 2, uncertainUnits: 1 });
    expect(u.items[0]).toMatchObject({ announced: 0, announcedUncertain: 3, inspected: 2, units: 2, uncertain: 1 });
    // Точно заявлено 2 (RETURN) + неточно 3 (MIXED) іншої позиції: точні 2, можливо ще 3.
    expect(caseUnits([{ ...mixed, id: "r", orderLineItemId: "li-2", quantity: 2, uncertain: false }, mixed])).toMatchObject({ units: 2, uncertainUnits: 3 });
    // Огляд не менший за верхню межу — неточності більше немає.
    expect(caseUnits([mixed, { ...mixed, id: "g", quantity: 3, condition: "resellable", restockedQty: 3, uncertain: false }])).toMatchObject({
      units: 3,
      uncertainUnits: 0,
    });
  });

  it("averages and shares are exact decimal strings (half away from zero); empty → null, never 0", () => {
    expect(averageDays([6, 7])).toBe("6.5");
    expect(averageDays([1, 1, 2])).toBe("1.3");
    expect(averageDays([1, 2, 2])).toBe("1.7");
    expect(averageDays([])).toBeNull();
    expect(sharePercent(1, 3)).toBe("33.3");
    expect(sharePercent(2, 3)).toBe("66.7");
    expect(sharePercent(0, 4)).toBe("0.0");
    expect(sharePercent(0, 0)).toBeNull();
  });

  it("groupCounts sums and orders by cases, units, key", () => {
    expect(
      groupCounts([
        { key: "b", cases: 1, units: 1 },
        { key: "a", cases: 1, units: 3 },
        { key: "b", cases: 1, units: 1 },
      ]),
    ).toEqual([
      { key: "b", cases: 2, units: 2 },
      { key: "a", cases: 1, units: 3 },
    ]);
  });

  it("status dates: received keeps the factual receipt date, closed sets and reopening clears the close date", () => {
    const now = day(30);
    expect(statusDates({ receivedAt: null, closedAt: null }, "received", now)).toEqual({ receivedAt: now, closedAt: null });
    expect(statusDates({ receivedAt: day(5), closedAt: null }, "received", now)).toEqual({ receivedAt: day(5), closedAt: null });
    expect(statusDates({ receivedAt: day(5), closedAt: null }, "closed", now)).toEqual({ receivedAt: day(5), closedAt: now });
    expect(statusDates({ receivedAt: day(5), closedAt: day(9) }, "open", now)).toEqual({ receivedAt: day(5), closedAt: null });
  });

  it("the statistics period defaults to 30 days and validates custom ranges", () => {
    expect(returnsPeriodOf(new URLSearchParams(""), "2026-11-28")).toEqual({
      preset: "last30",
      range: { from: "2026-10-30", to: "2026-11-28" },
    });
    expect(returnsPeriodOf(new URLSearchParams("period=custom&from=2026-10-01&to=2026-10-31"), "2026-11-28").range).toEqual({
      from: "2026-10-01",
      to: "2026-10-31",
    });
    expect(returnsPeriodOf(new URLSearchParams("period=custom&from=2026-10-31&to=2026-10-01"), "2026-11-28").preset).toBe("last30");
  });
});

describe("CARRIER_RETURN_CODES (keyed by carrier)", () => {
  it("nova_post 102/103/131/132 and test TEST-RETURN; keys are the real carrier codes", () => {
    expect(Object.keys(CARRIER_RETURN_CODES).sort()).toEqual([NOVA_POST_CODE, TEST_CARRIER_CODE].sort());
    expect(carrierReturnSignal("nova_post", "102")).toBe("return_ordered");
    expect(carrierReturnSignal("nova_post", "103")).toBe("refused");
    expect(carrierReturnSignal("nova_post", " 131 ")).toBe("return_uncleared");
    expect(carrierReturnSignal("nova_post", "132")).toBe("return_preparing");
    expect(carrierReturnSignal("test", "TEST-RETURN")).toBe("return_ordered");
  });

  it("a code of one carrier means nothing for another; unknown carrier / code / empty → null", () => {
    expect(carrierReturnSignal("test", "102")).toBeNull();
    expect(carrierReturnSignal("nova_post", "TEST-RETURN")).toBeNull();
    expect(carrierReturnSignal("nova_global", "102")).toBeNull();
    expect(carrierReturnSignal("nova_post", "9")).toBeNull();
    expect(carrierReturnSignal(null, "102")).toBeNull();
    expect(carrierReturnSignal("nova_post", null)).toBeNull();
    expect(carrierReturnSignal("__proto__", "toString")).toBeNull();
  });

  it("every Nova Post return code exists in the stage-3 tracking map (as exception — tracking code is unchanged)", () => {
    for (const code of Object.keys(CARRIER_RETURN_CODES.nova_post)) expect(NOVA_POST_TRACKING_CODES[code]).toBe("exception");
  });

  it("refused → «Refused by recipient» with reason refused_delivery; other signals → carrier return", () => {
    expect(SIGNAL_CASE_KIND.refused).toBe("refused");
    expect(SIGNAL_REASON.refused).toBe("refused_delivery");
    expect(SIGNAL_REASON.return_uncleared).toBe("customs_refused");
    for (const s of CARRIER_RETURN_SIGNALS.filter((x) => x !== "refused")) expect(SIGNAL_CASE_KIND[s]).toBe("carrier_return");
  });
});

describe("keys and labels", () => {
  it("line ids are deterministic RFC-4122 v5-format uuids, distinct per source and part", () => {
    const a = returnLineId("ret:refund:x", "gid://shopify/LineItem/1");
    expect(a).toBe(returnLineId("ret:refund:x", "gid://shopify/LineItem/1"));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(
      new Set([a, returnLineId("ret:refund:x", "gid://shopify/LineItem/2"), returnLineId("ret:receipt:x", "gid://shopify/LineItem/1")]).size,
    ).toBe(3);
    expect(receiptLineIds({ movementId: "m" })).toHaveLength(2);
  });

  it("every code family has uk and en labels (§18.10 returns.kind.* / returns.reason.*)", () => {
    const keys = [
      ...RETURN_KINDS.map(returnsLabelKeys.kind),
      ...RETURN_STATUSES.map(returnsLabelKeys.status),
      ...RETURN_REASON_CODES.map(returnsLabelKeys.reason),
      ...RETURN_LINE_CONDITIONS.map(returnsLabelKeys.condition),
      ...RETURN_SOURCES.map(returnsLabelKeys.source),
      ...CARRIER_RETURN_SIGNALS.map(returnsLabelKeys.signal),
      ...(["shopify", "warehouse", "manual"] as const).map(returnsLabelKeys.origin),
      ...(["refunds", "returnShipping", "returnHandling", "cogsReturn", "retainedFees", "returnCosts"] as const).map(returnsLabelKeys.money),
      ...(["created", "replay", "existing", "opened"] as const).map((n) => `returns.notice.${n}`),
      ...(["kind", "reason", "note", "status"] as const).map((f) => `returns.field.${f}`),
      ...(
        [
          "order_placed",
          "order_change",
          "order_status",
          "order_validated",
          "order_cancelled",
          "waybill_created",
          "waybill_failed",
          "waybill_cancelled",
          "handed_over",
          "delivered",
          "tracking",
          "packing_started",
          "packed",
          "stock_consumed",
          "stock_return",
          "stock_defect",
          "refund",
          "case_created",
          "case_linked",
          "case_status",
          "case_updated",
        ] as const
      ).map(returnsLabelKeys.timeline),
    ];
    expect(keys.filter((k) => !(k in DICTIONARIES.uk) || !(k in DICTIONARIES.en))).toEqual([]);
  });

  it("English texts have no Cyrillic; texts a staff member can see have no financial words", () => {
    const en = Object.entries(DICTIONARIES.en).filter(([k]) => k.startsWith("returns."));
    expect(en.filter(([, v]) => /[А-Яа-яІіЇїЄєҐґ]/.test(v)).map(([k]) => k)).toEqual([]);
    const staffVisible = (k: string) => !k.startsWith("returns.money.");
    for (const dict of [DICTIONARIES.uk, DICTIONARIES.en]) {
      const bad = Object.entries(dict).filter(
        ([k, v]) => k.startsWith("returns.") && staffVisible(k) && /прибут|оборот|собіварт|рентаб|profit|turnover|margin/i.test(v),
      );
      expect(bad).toEqual([]);
    }
  });
});
