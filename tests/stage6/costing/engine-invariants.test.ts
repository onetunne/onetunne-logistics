/**
 * Етап 6, WP2: інваріанти чистого рушія на випадкових послідовностях (docs/stage6-design.md §20.2; власний генератор із
 * зерном, без нової залежності):
 * - I1: C0 після КОЖНОГО кроку (on_hand = known + unknown − deficit), кількості й вартість пулу ніколи не від'ємні;
 * - I2 НЕЗАЛЕЖНО від розкладу рушія: Σ вартостей, що входять (контрольовані тестом: V надходжень, ручна собівартість /
 *   каталожна ціна × кількість, приріст за середньою — перераховано тестом із попереднього стану, повернення — з джерел,
 *   які передає тест, ремонт браку) = Σ відомих вартостей виходів + Σ завершень дефіциту + Σ збитків надходжень лише з
 *   браком у порожній пул + вартість пулу наприкінці;
 * - кожен вихід із пулу — за ковзною середньою попереднього стану (одне округлення до кванта; останні одиниці — точна решта);
 * - валюта з 0 знаками (JPY): усі частки кратні 100 сотим.
 * Генератор: надходження з вартістю / без / без курсу (fx_pending, також лише брак), продажі (зокрема з від'ємного
 * залишку), повернення покупців, пов'язані з попередніми продажами (з парним браком повернення і без), брак / ремонт /
 * утилізація, коригування й shopify_external ±, відкриття ± (з ручною собівартістю і без), матеріали з каталожною ціною.
 */
import { describe, expect, it } from "vitest";
import { currencyQuantum, mulDivQ, valueOfUnits, type ReturnSources, type SaleSource, type StandardUnit } from "~/modules/costing/engine";
import { Sim, type SimStep } from "./engine-sim";

function rng(seed: number) {
  let x = seed >>> 0;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

const ORDER = "00000000-0000-4000-8000-000000000001";

interface SaleBook {
  valuationId: string;
  knownUnits: number;
  knownValue: bigint;
  unvaluedUnits: number;
}

function run(seed: number, opts: { currency: string; material: boolean; withStandard: boolean }) {
  const r = rng(seed);
  const q = currencyQuantum(opts.currency);
  const s = new Sim(opts.currency);
  if (opts.material) s.stockKind = "material";
  const std: StandardUnit | null = opts.withStandard ? { minor: BigInt(40 + Math.floor(r() * 60)) * 100n * (q === 100n ? 10n : 1n), source: opts.material ? "catalogue" : "owner_standard", costId: "std" } : null;
  let defective = 0;
  let sources = 0n;
  let outflowValues = 0n;
  let completions = 0n;
  let lossesNoPool = 0n;
  const sales: SaleBook[] = [];
  const money = (units: number) => BigInt(units) * BigInt(50 + Math.floor(r() * 150)) * 100n * (q === 100n ? 10n : 1n) + (q === 100n ? 0n : BigInt(Math.floor(r() * 100)));

  const check = (st: SimStep, before: { knownQty: number; knownValue: bigint }, label: string) => {
    expect(s.c0, `${label}: C0`).toBe(true);
    expect(s.state.knownValue >= 0n && s.state.knownQty >= 0 && s.state.unknownQty >= 0 && s.state.deficitQty >= 0, `${label}: non-negative`).toBe(true);
    const v = st.valuation;
    if (v?.value !== null && v?.value !== undefined) expect(v.value % q, `${label}: quantum`).toBe(0n);
    expect(s.state.knownValue % q, `${label}: pool quantum`).toBe(0n);
    for (const c of st.deficitCompletions) {
      if (c.minor !== null) {
        expect(c.minor % q).toBe(0n);
        completions += c.minor;
        const sale = sales.find((x) => x.valuationId === c.saleValuationId);
        if (sale) {
          sale.knownUnits += c.qty;
          sale.knownValue += c.minor;
          sale.unvaluedUnits -= c.qty;
        }
      }
    }
    // Вихід із пулу — за середньою попереднього стану.
    if (v?.kind === "outflow" && v.details.pairedReturnDefect !== true) {
      const poolQty = Number(v.details.poolQty ?? 0);
      if (poolQty > 0) {
        const expected = valueOfUnits(before.knownValue, poolQty, before.knownQty, q);
        const stdPart = BigInt(Number(v.details.standardQty ?? 0)) * (std?.minor ?? 0n);
        expect((v.value ?? 0n) - stdPart, `${label}: MWA`).toBe(expected);
      }
    }
  };

  for (let i = 0; i < 90; i++) {
    const k = r();
    const n = 1 + Math.floor(r() * 5);
    const before = { knownQty: s.state.knownQty, knownValue: s.state.knownValue };
    const hasUnknown = s.layers.some((l) => l.kind === "unknown" && l.qtyOpen > 0 && l.reason !== "fx_pending");
    const label = `seed ${seed} step ${i}`;
    let st: SimStep;
    if (k < 0.16) {
      const f = r() < 0.25 ? 1 : 0;
      const g = r() < 0.08 ? 0 : n;
      const V = money(g + f);
      st = s.apply(r() < 0.5 ? "receipt_production" : "receipt_manual", { onHandDelta: g, defectiveDelta: f, reason: "purchase" }, { value: { status: "valued", minor: V, originalAmount: "0", originalCurrency: opts.currency, rateDate: null, rateSource: null } });
      defective += f;
      sources += V;
      if (g === 0 && before.knownQty === 0) lossesNoPool += V;
    } else if (k < 0.22) {
      // Без вартості (матеріал — за каталожною ціною).
      st = s.apply("receipt_manual", { onHandDelta: n, reason: "found" }, { standard: opts.material ? std : null });
      if (opts.material && std) sources += std.minor * BigInt(n);
    } else if (k < 0.26) {
      // Іноземна валюта без курсу: шар fx_pending (вартість — пізніше, завершенням на рівні БД).
      const g = r() < 0.3 ? 0 : n;
      st = s.apply("receipt_production", { onHandDelta: g, defectiveDelta: 1 }, { value: { status: "no_rate", originalAmount: "10.00", originalCurrency: "PLN", unitCost: "10.00" } });
      defective += 1;
    } else if (k < 0.52) {
      st = s.apply("consume_sale", { onHandDelta: -n, orderId: ORDER }, { standard: hasUnknown ? std : null });
      const v = st.valuation!;
      sales.push({ valuationId: v.id, knownUnits: v.knownQty, knownValue: v.value ?? 0n, unvaluedUnits: v.unknownQty + v.deficitQty });
      outflowValues += v.value ?? 0n;
      sources += BigInt(Number(v.details.standardQty ?? 0)) * (std?.minor ?? 0n);
    } else if (k < 0.62 && sales.length > 0) {
      // Повернення покупця, пов'язане з продажами замовлення (джерела — як saleSourcesFor).
      const g = Math.max(1, Math.floor(r() * 3));
      const damaged = r() < 0.3 ? 1 : 0;
      const paired = damaged > 0 && r() < 0.5;
      const srcSales: SaleSource[] = sales.filter((x) => x.knownUnits + x.unvaluedUnits > 0).map((x) => ({ ...x }));
      const src: ReturnSources = { pairedDefectQty: paired ? damaged : null, sales: srcSales, standards: [] };
      const key = `ret:${i}`;
      st = s.apply(
        "receipt_manual",
        { onHandDelta: g + (paired ? damaged : 0), defectiveDelta: paired ? 0 : damaged, reason: "customer_return", orderId: ORDER, idempotencyKey: key },
        { returnSources: src },
      );
      // Очікувана вартість повернення — з джерел тесту: відомі одиниці продажів, далі без вартості, далі середня пулу.
      let left = g;
      let expected = 0n;
      for (const x of srcSales) {
        const t = Math.min(x.knownUnits, left);
        if (t <= 0) continue;
        const val = valueOfUnits(x.knownValue, t, x.knownUnits, q);
        expected += val;
        left -= t;
        const book = sales.find((b) => b.valuationId === x.valuationId)!;
        book.knownUnits -= t;
        book.knownValue -= val;
      }
      for (const x of srcSales) {
        const t = Math.min(x.unvaluedUnits, left);
        if (t <= 0) continue;
        left -= t;
        sales.find((b) => b.valuationId === x.valuationId)!.unvaluedUnits -= t;
      }
      if (left > 0 && before.knownQty > 0) expected += mulDivQ(before.knownValue, BigInt(left), BigInt(before.knownQty), q);
      expect(st.valuation!.value ?? 0n, `${label}: return value`).toBe(expected);
      sources += expected;
      check(st, before, label);
      if (paired) {
        const before2 = { knownQty: s.state.knownQty, knownValue: s.state.knownValue };
        const pair = s.apply("defect_mark", { onHandDelta: -damaged, defectiveDelta: damaged, idempotencyKey: `${key}:return_defect` }, { pairedReturnDefect: true });
        expect(pair.valuation!.value, `${label}: paired defect at zero`).toBe(0n);
        check(pair, before2, `${label} pair`);
      }
      defective += damaged;
      continue;
    } else if (k < 0.68 && s.onHand > 0) {
      st = s.apply("defect_mark", { onHandDelta: -1, defectiveDelta: 1 }, { standard: hasUnknown ? std : null });
      defective += 1;
      outflowValues += st.valuation!.value ?? 0n;
      sources += BigInt(Number(st.valuation!.details.standardQty ?? 0)) * (std?.minor ?? 0n);
    } else if (k < 0.73 && defective > 0) {
      st = s.apply("defect_repair", { onHandDelta: 1, defectiveDelta: -1 });
      defective -= 1;
      sources += st.valuation!.value ?? 0n;
    } else if (k < 0.77 && defective > 0) {
      st = s.apply("defect_writeoff", { defectiveDelta: -1 });
      defective -= 1;
    } else if (k < 0.87) {
      const type = r() < 0.5 ? "adjustment" : "shopify_external";
      const up = r() < 0.5;
      st = s.apply(type, { onHandDelta: up ? n : -n, reason: "stocktake" }, { standard: !up && hasUnknown ? std : null });
      const v = st.valuation!;
      if (up) {
        const gain = before.knownQty > 0 ? mulDivQ(before.knownValue, BigInt(n), BigInt(before.knownQty), q) : 0n;
        expect(before.knownQty > 0 ? v.value : null, `${label}: surplus at the average`).toBe(before.knownQty > 0 ? gain : null);
        sources += gain;
      } else {
        outflowValues += v.value ?? 0n;
        sources += BigInt(Number(v.details.standardQty ?? 0)) * (std?.minor ?? 0n);
      }
    } else {
      const down = r() < 0.25;
      st = s.apply("opening", { onHandDelta: down ? -n : n, idempotencyKey: `opening:${i}` }, { standard: down ? (hasUnknown ? std : null) : std });
      const v = st.valuation!;
      if (down) {
        outflowValues += v.value ?? 0n;
        sources += BigInt(Number(v.details.standardQty ?? 0)) * (std?.minor ?? 0n);
      } else if (std) sources += std.minor * BigInt(n);
    }
    check(st, before, label);
  }
  // I2: усе, що увійшло, = усе, що вийшло + завершення дефіциту + збитки браку без пулу + пул.
  expect(sources, `seed ${seed}: I2`).toBe(outflowValues + completions + lossesNoPool + s.state.knownValue);
}

describe("I1 / I2 — random sequences (independent conservation check)", () => {
  it("UAH products, with and without an owner manual cost", () => {
    for (let seed = 1; seed <= 80; seed++) run(seed, { currency: "UAH", material: false, withStandard: seed % 2 === 0 });
  });
  it("materials at the catalogue price", () => {
    for (let seed = 101; seed <= 130; seed++) run(seed, { currency: "UAH", material: true, withStandard: true });
  });
  it("JPY valuation currency (0 decimals): every share is a whole yen", () => {
    for (let seed = 201; seed <= 240; seed++) run(seed, { currency: "JPY", material: false, withStandard: seed % 2 === 1 });
  });
});
