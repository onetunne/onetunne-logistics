/**
 * Аналітика складу — чисті функції: періоди (Київ), швидкість, днів запасу, дата вичерпання, ризик, рекомендації
 * партій (округлення, нульові продажі, від'ємний доступний залишок), тренд, групування, посилання «Створити партію»,
 * CSV (екранування, захист від формул, BOM, роздільник).
 */
import { describe, expect, it } from "vitest";
import {
  addDays,
  daysInclusive,
  demandForDays,
  forecastItem,
  groupSales,
  parseProductionPrefill,
  productionPrefill,
  PREFILL_MAX_PRODUCTS,
  recommendBatch,
  resolvePeriod,
  roundUpTo,
  trendOf,
  velocity30,
  velocity90,
  velocityWindows,
  weightedVelocity,
  type ForecastSettings,
} from "~/modules/warehouse-analytics/calc";
import { buildCsv, CSV_BOM, csvAmount, csvCell, CsvDecimal, csvDecimal, csvFileName } from "~/modules/warehouse-analytics/csv";
import { EXPORT_HEADERS, exportResponseOutcome, MAX_EXPORT_MOVEMENTS } from "~/modules/warehouse-analytics/export-contract";
import { analyticsSearch, filtersOf, parseAnalyticsQuery, parseExportParams } from "~/modules/warehouse-analytics/params";
import { inventoryValueOf } from "~/modules/warehouse-analytics/queries.server";

const SETTINGS: ForecastSettings = { productionLeadDays: 30, targetCoverDays: 60, batchRounding: 10 };
const TODAY = "2026-11-27";

describe("periods (Kyiv calendar days)", () => {
  it("calendar arithmetic crosses months, years and DST changes without drift", () => {
    expect(addDays("2026-11-27", 5)).toBe("2026-12-02");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2026-03-29", 1)).toBe("2026-03-30"); // перехід на літній час
    expect(addDays("2026-10-25", -1)).toBe("2026-10-24"); // перехід на зимовий час
    expect(daysInclusive("2026-11-01", "2026-11-30")).toBe(30);
    expect(daysInclusive("2026-03-01", "2026-03-31")).toBe(31);
    expect(daysInclusive("2026-11-27", "2026-11-27")).toBe(1);
  });

  it("presets are the last N days up to today inclusive, with an equally long previous period", () => {
    expect(resolvePeriod({ key: "7", today: TODAY })).toEqual({
      key: "7",
      from: "2026-11-21",
      to: "2026-11-27",
      days: 7,
      previousFrom: "2026-11-14",
      previousTo: "2026-11-20",
      invalid: false,
    });
    const p30 = resolvePeriod({ key: "30", today: TODAY });
    expect([p30.from, p30.to, p30.days, p30.previousFrom, p30.previousTo]).toEqual(["2026-10-29", "2026-11-27", 30, "2026-09-29", "2026-10-28"]);
    expect(resolvePeriod({ key: "90", today: TODAY }).from).toBe("2026-08-30");
    // Невідомий ключ → 30 днів (не помилка).
    expect(resolvePeriod({ key: "365", today: TODAY })).toMatchObject({ key: "30", days: 30, invalid: false });
    expect(resolvePeriod({ today: TODAY })).toMatchObject({ key: "30", days: 30 });
  });

  it("custom periods are validated; the future is clipped to today", () => {
    expect(resolvePeriod({ key: "custom", from: "2026-11-01", to: "2026-11-10", today: TODAY })).toEqual({
      key: "custom",
      from: "2026-11-01",
      to: "2026-11-10",
      days: 10,
      previousFrom: "2026-10-22",
      previousTo: "2026-10-31",
      invalid: false,
    });
    expect(resolvePeriod({ key: "custom", from: "2026-11-20", to: "2027-01-01", today: TODAY })).toMatchObject({ to: TODAY, days: 8 });
    for (const bad of [
      { from: "2026-11-10", to: "2026-11-01" },
      { from: "2026-02-30", to: "2026-03-01" },
      { from: null, to: "2026-11-01" },
      { from: "2024-01-01", to: "2026-11-01" },
      { from: "2026-12-01", to: "2026-12-05" }, // цілком у майбутньому → to обрізано до сьогодні < from
    ]) {
      expect(resolvePeriod({ key: "custom", ...bad, today: TODAY }), JSON.stringify(bad)).toMatchObject({ key: "30", invalid: true, days: 30 });
    }
    expect(() => resolvePeriod({ today: "27.11.2026" })).toThrow(RangeError);
  });

  it("velocity windows are the last 30 and 90 days including today", () => {
    expect(velocityWindows(TODAY)).toEqual({ short: { from: "2026-10-29", to: TODAY }, long: { from: "2026-08-30", to: TODAY } });
  });
});

describe("sales velocity and demand", () => {
  it("v30, v90 and the weighted velocity (2·v30 + v90) / 3", () => {
    const steady = { units30: 30, units90: 90 };
    expect(velocity30(steady)).toBe(1);
    expect(velocity90(steady)).toBe(1);
    expect(weightedVelocity(steady)).toBe(1);
    const recentSpike = { units30: 30, units90: 30 };
    expect(weightedVelocity(recentSpike)).toBeCloseTo((2 * 1 + 1 / 3) / 3, 12);
    expect(weightedVelocity({ units30: 0, units90: 0 })).toBe(0);
    // Некоректні значення не ламають розрахунок.
    expect(weightedVelocity({ units30: -5, units90: Number.NaN })).toBe(0);
  });

  it("demand is rounded up with exact integer arithmetic (no float drift on exact boundaries)", () => {
    // 7·6 + 21 = 63 → 63/270 × 90 = 21 рівно (у float 0.2333…×90 могло б дати 21.000000000000004 → 22).
    expect(demandForDays({ units30: 7, units90: 21 }, 90)).toBe(21);
    expect(demandForDays({ units30: 30, units90: 90 }, 90)).toBe(90);
    expect(demandForDays({ units30: 10, units90: 16 }, 90)).toBe(26); // 76/270 × 90 = 25.33 → 26
    expect(demandForDays({ units30: 1, units90: 1 }, 1)).toBe(1); // будь-який ненульовий попит → щонайменше 1
    expect(demandForDays({ units30: 0, units90: 0 }, 90)).toBe(0);
    expect(demandForDays({ units30: 5, units90: 5 }, 0)).toBe(0);
  });

  it("roundUpTo rounds up to the batch rounding; non-positive → 0", () => {
    expect(roundUpTo(0, 10)).toBe(0);
    expect(roundUpTo(-4, 10)).toBe(0);
    expect(roundUpTo(1, 10)).toBe(10);
    expect(roundUpTo(10, 10)).toBe(10);
    expect(roundUpTo(11, 10)).toBe(20);
    expect(roundUpTo(7, 1)).toBe(7);
    expect(roundUpTo(7, 0)).toBe(7); // некоректне округлення → 1
  });
});

describe("forecast: cover, stock-out date, risk", () => {
  it("days of cover = available / v30 and stock-out date = today + ⌊cover⌋", () => {
    const f = forecastItem({ units30: 15, units90: 45, available: 10, inProduction: 0, planned: 0 }, SETTINGS, TODAY);
    expect(f.velocity30).toBe(0.5);
    expect(f.coverDays).toBe(20);
    expect(f.stockOutDate).toBe("2026-12-17");
    expect(f.risk).toBe("critical"); // 20 днів < 30 днів виробництва
    const g = forecastItem({ units30: 3, units90: 3, available: 7, inProduction: 0, planned: 0 }, SETTINGS, TODAY);
    expect(g.coverDays).toBe(70); // 7 ÷ 0.1
    expect(g.stockOutDate).toBe(addDays(TODAY, 70));
    expect(g.risk).toBe("none");
    // Дробові дні — униз до 0,1; дата — за цілими днями.
    const h = forecastItem({ units30: 7, units90: 7, available: 10, inProduction: 0, planned: 0 }, SETTINGS, TODAY);
    expect(h.coverDays).toBe(42.8); // 300/7 = 42.857…
    expect(h.stockOutDate).toBe(addDays(TODAY, 42));
  });

  it("zero sales: no cover/date while stock exists; nothing available + demand = out today", () => {
    const idle = forecastItem({ units30: 0, units90: 0, available: 12, inProduction: 0, planned: 0 }, SETTINGS, TODAY);
    expect(idle).toMatchObject({ coverDays: null, stockOutDate: null, risk: "none", velocity: 0 });
    expect(idle.recommendation.quantity).toBe(0);
    const emptyIdle = forecastItem({ units30: 0, units90: 0, available: 0, inProduction: 0, planned: 0 }, SETTINGS, TODAY);
    expect(emptyIdle).toMatchObject({ coverDays: 0, stockOutDate: TODAY, risk: "none" });
    // Продажів за 30 днів немає (бо нічого не було), але за 90 — є: товар закінчився, ризик «немає в наявності».
    const sold90 = forecastItem({ units30: 0, units90: 9, available: 0, inProduction: 0, planned: 0 }, SETTINGS, TODAY);
    expect(sold90).toMatchObject({ coverDays: 0, stockOutDate: TODAY, risk: "out" });
    expect(sold90.recommendation.quantity).toBe(10); // ⌈(9/270)·90⌉ = 3 → округлення 10
    const oversold = forecastItem({ units30: 3, units90: 3, available: -2, inProduction: 0, planned: 0 }, SETTINGS, TODAY);
    expect(oversold).toMatchObject({ coverDays: 0, stockOutDate: TODAY, risk: "out" });
  });
});

describe("batch recommendation", () => {
  it("ceil(v × (lead + cover)) − (available + in production + planned), rounded up, only when > 0", () => {
    const r = recommendBatch({ units30: 30, units90: 90, available: 20, inProduction: 10, planned: 5 }, SETTINGS);
    expect(r).toEqual({
      horizonDays: 90,
      demand: 90,
      available: 20,
      inProduction: 10,
      planned: 5,
      supply: 35,
      shortfall: 55,
      rounding: 10,
      quantity: 60,
    });
    expect(recommendBatch({ units30: 30, units90: 90, available: 20, inProduction: 10, planned: 5 }, { ...SETTINGS, batchRounding: 1 }).quantity).toBe(55);
    // Нестача рівно кратна округленню — без зайвого.
    expect(recommendBatch({ units30: 30, units90: 90, available: 40, inProduction: 0, planned: 0 }, SETTINGS).quantity).toBe(50);
    // Запасу вистачає — рекомендації немає (від'ємна нестача).
    const enough = recommendBatch({ units30: 30, units90: 90, available: 100, inProduction: 0, planned: 0 }, SETTINGS);
    expect(enough).toMatchObject({ shortfall: -10, quantity: 0 });
    // Заплановані партії враховуються: після створення партії з рекомендації вона зникає.
    expect(recommendBatch({ units30: 30, units90: 90, available: 0, inProduction: 0, planned: 90 }, SETTINGS).quantity).toBe(0);
  });

  it("edge cases: zero sales, negative available (oversold), different lead/cover settings", () => {
    expect(recommendBatch({ units30: 0, units90: 0, available: 0, inProduction: 0, planned: 0 }, SETTINGS).quantity).toBe(0);
    // Продано більше, ніж є: 3 одиниці винні покупцям — потрібна партія навіть без нових продажів.
    expect(recommendBatch({ units30: 0, units90: 0, available: -3, inProduction: 0, planned: 0 }, SETTINGS)).toMatchObject({
      supply: -3,
      shortfall: 3,
      quantity: 10,
    });
    const short = recommendBatch({ units30: 10, units90: 30, available: 0, inProduction: 0, planned: 0 }, { productionLeadDays: 10, targetCoverDays: 20, batchRounding: 5 });
    // v = (60 + 30)/270 = 1/3 → ×30 = 10 → кратне 5 = 10
    expect(short).toMatchObject({ horizonDays: 30, demand: 10, quantity: 10 });
  });
});

describe("trend", () => {
  it("compares with the previous period", () => {
    expect(trendOf(10, 5)).toEqual({ current: 10, previous: 5, direction: "up", percent: 100 });
    expect(trendOf(5, 10)).toEqual({ current: 5, previous: 10, direction: "down", percent: -50 });
    expect(trendOf(2, 3)).toMatchObject({ direction: "down", percent: -33 });
    expect(trendOf(7, 7)).toMatchObject({ direction: "flat", percent: 0 });
    expect(trendOf(5, 0)).toMatchObject({ direction: "new", percent: null });
    expect(trendOf(0, 0)).toMatchObject({ direction: "none", percent: null });
    expect(trendOf(0, 4)).toMatchObject({ direction: "down", percent: -100 });
  });
});

describe("grouping and top lists", () => {
  const lines = [
    { variantId: "v1", productId: "p1", productTitle: "Тримач", model: "X", color: "Чорний", imageUrl: null, units: 5, previousUnits: 1 },
    { variantId: "v2", productId: "p1", productTitle: "Тримач", model: "S", color: "Білий", imageUrl: "https://cdn.example/1.png", units: 3, previousUnits: 3 },
    { variantId: "v3", productId: "p2", productTitle: "Грипси", model: null, color: "Чорний", imageUrl: null, units: 2, previousUnits: 0 },
    { variantId: "v4", productId: "p3", productTitle: "Сумка", model: null, color: null, imageUrl: null, units: 0, previousUnits: 7 },
  ];

  it("groups by product, color and model; only groups with sales; share of total", () => {
    const byProduct = groupSales(lines, "product");
    expect(byProduct.map((g) => [g.label, g.units, g.sharePercent, g.variants])).toEqual([
      ["Тримач", 8, 80, 2],
      ["Грипси", 2, 20, 1],
    ]);
    expect(byProduct[0]!.imageUrl).toBe("https://cdn.example/1.png");
    expect(byProduct[0]!.trend).toMatchObject({ direction: "up", previous: 4, percent: 100 });
    const byColor = groupSales(lines, "color");
    expect(byColor.map((g) => [g.key, g.units])).toEqual([
      ["Чорний", 7],
      ["Білий", 3],
    ]);
    const byModel = groupSales(lines, "model");
    expect(byModel.map((g) => [g.label, g.units])).toEqual([
      ["X", 5],
      ["S", 3],
      [null, 2],
    ]);
    expect(groupSales(lines, "model", 1)).toHaveLength(1);
    expect(groupSales([], "color")).toEqual([]);
  });
});

describe("«Create batch» prefill link", () => {
  it("lists products for the batch grid and quantities as qty.<variantId>", () => {
    const p = productionPrefill([
      { productId: "p1", variantId: "v1", quantity: 20 },
      { productId: "p1", variantId: "v2", quantity: 10 },
      { productId: "p2", variantId: "v3", quantity: 30 },
      { productId: "p2", variantId: "v3", quantity: 99 }, // дубль варіанта — ігнорується
      { productId: "p3", variantId: "v4", quantity: 0 }, // не рекомендовано — пропускається
    ]);
    expect(p).toMatchObject({ products: 2, variants: 3, units: 60, truncated: false });
    const params = new URLSearchParams(p.search);
    expect(params.getAll("product")).toEqual(["p1", "p2"]);
    expect(params.get("qty.v1")).toBe("20");
    expect(params.get("qty.v3")).toBe("30");
    expect(params.has("qty.v4")).toBe(false);
    expect(productionPrefill([]).search).toBe("");
  });

  it("stops at the batch form's product limit", () => {
    const items = Array.from({ length: PREFILL_MAX_PRODUCTS + 3 }, (_, i) => ({ productId: `p${i}`, variantId: `v${i}`, quantity: 10 }));
    const p = productionPrefill(items);
    expect(p).toMatchObject({ products: PREFILL_MAX_PRODUCTS, variants: PREFILL_MAX_PRODUCTS, truncated: true });
    expect(new URLSearchParams(p.search).has(`qty.v${PREFILL_MAX_PRODUCTS}`)).toBe(false);
  });
});

describe("inventory value (owner)", () => {
  it("Σ on hand × unit cost per currency with exact money arithmetic; items without cost are counted separately", () => {
    const v = inventoryValueOf([
      { onHand: 20, cost: { unitCost: "14.00", currency: "UAH" } },
      { onHand: 3, cost: { unitCost: "0.10", currency: "UAH" } },
      { onHand: 7, cost: { unitCost: "2.35", currency: "EUR" } },
      { onHand: 5, cost: null },
      { onHand: -2, cost: { unitCost: "10.00", currency: "UAH" } }, // від'ємний залишок не оцінюється
      { onHand: 0, cost: null },
    ]);
    expect(v).toEqual({
      totals: [
        { currency: "EUR", amount: "16.45" },
        { currency: "UAH", amount: "280.30" },
      ],
      itemsValued: 3,
      unitsValued: 30,
      itemsWithoutCost: 1,
      unitsWithoutCost: 5,
    });
  });
});

describe("CSV", () => {
  it("quotes separators, quotes, newlines and edge spaces; numbers stay numbers", () => {
    expect(csvCell("plain", ";")).toBe("plain");
    expect(csvCell("a;b", ";")).toBe('"a;b"');
    // Текст з будь-яким із двох роздільників — у лапках (Excel ділить за системним роздільником, security-1).
    expect(csvCell("a;b", ",")).toBe('"a;b"');
    expect(csvCell("a,b", ";")).toBe('"a,b"');
    expect(csvCell("a,b", ",")).toBe('"a,b"');
    expect(csvCell('Тримач "Pro"', ";")).toBe('"Тримач ""Pro"""');
    expect(csvCell("line1\nline2", ";")).toBe('"line1\nline2"');
    expect(csvCell(" padded", ";")).toBe('" padded"');
    expect(csvCell(-3, ";")).toBe("-3");
    expect(csvCell(0, ";")).toBe("0");
    expect(csvCell(Number.NaN, ";")).toBe("");
    expect(csvCell(null, ";")).toBe("");
    expect(csvCell(undefined, ";")).toBe("");
    expect(csvCell(true, ";")).toBe("true");
    // Числа: десятковий знак профілю («;» → кома для Excel uk/EU, «,» → крапка), без лапок.
    expect(csvCell(12.5, ";")).toBe("12,5");
    expect(csvCell(12.5, ",")).toBe("12.5");
    expect(csvCell(csvDecimal(12.5, 1), ";")).toBe("12,5");
    expect(csvCell(csvDecimal(12.5, 1), ",")).toBe("12.5");
    expect(csvCell(csvAmount("-120.00"), ";")).toBe("-120,00");
    expect(csvCell(csvAmount("120.00"), ",")).toBe("120.00");
    // Не число в CsvDecimal — як текст, з усіма захистами.
    expect(csvCell(new CsvDecimal("=1+2"), ";")).toBe("'=1+2");
  });

  it("neutralises spreadsheet formulas in text (CSV injection)", () => {
    for (const bad of ["=HYPERLINK(\"http://x\")", "+1+1", "-2+3", "@SUM(A1)", "\tcmd"]) {
      expect(csvCell(bad, ";").replace(/^"/, "").startsWith("'"), bad).toBe(true);
    }
    expect(csvCell("OT-PH-BLK", ";")).toBe("OT-PH-BLK"); // дефіс усередині — не формула
    expect(csvCell('  "=1+2"', ";").replace(/^"/, "").startsWith("'"), "formula after spaces/quotes").toBe(true);
  });

  it("neutralises formulas after the OTHER separator and line breaks (Excel splits on its own list separator)", () => {
    const pieces = (cell: string) => cell.split(/[,;\t\r\n]/).map((p) => p.replace(/^[\s"]+/, ""));
    const values = [
      "Bag,=1+2",
      "Bag;=1+2",
      "Black,=HYPERLINK(CHAR(104)),x",
      "Bag; =WEBSERVICE(CHAR(104))",
      'Bag;"=1+2"',
      "x\n=1+2",
      "x\r\n@SUM(A1)",
      "a\t+1",
      "a,-2+3;b",
    ];
    for (const v of values) {
      for (const sep of [";", ","]) {
        const cell = csvCell(v, sep);
        for (const piece of pieces(cell)) expect(/^[=+\-@]/.test(piece), `${JSON.stringify(v)} sep ${sep}: ${JSON.stringify(cell)}`).toBe(false);
      }
    }
    expect(csvCell("Bag,=1+2", ";")).toBe(`"Bag,'=1+2"`);
    expect(csvCell("Bag;=1+2", ",")).toBe(`"Bag;'=1+2"`);
    // Рядок файлу: жоден шматок після поділу комою, крапкою з комою чи переносом рядка не починається з формули.
    const csv = buildCsv([{ header: "a", value: (r: { v: string }) => r.v }, { header: "b", value: () => 5 }], [{ v: "Black,=HYPERLINK(CHAR(104)),x" }], {
      bom: false,
    });
    expect(csv).toBe(`a;b\r\n"Black,'=HYPERLINK(CHAR(104)),x";5\r\n`);
    for (const piece of pieces(csv)) expect(/^[=+\-@]/.test(piece), piece).toBe(false);
  });

  it("builds a UTF-8 BOM file with CRLF lines and the chosen separator", () => {
    const rows = [
      { sku: "A-1", qty: 3, price: "12.50" },
      { sku: "B;2", qty: -1, price: null },
    ];
    const cols = [
      { header: "sku", value: (r: (typeof rows)[number]) => r.sku },
      { header: "qty", value: (r: (typeof rows)[number]) => r.qty },
      { header: "unit_cost", value: (r: (typeof rows)[number]) => r.price },
    ];
    const csv = buildCsv(cols, rows);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    // Текстовий рядок суми лишається текстом; суми з даних передаються як csvAmount (export.server.ts).
    expect(csv.slice(1)).toBe('sku;qty;unit_cost\r\nA-1;3;12.50\r\n"B;2";-1;\r\n');
    expect(buildCsv(cols, rows, { separator: "comma", bom: false })).toBe('sku,qty,unit_cost\r\nA-1,3,12.50\r\n"B;2",-1,\r\n');
    const money = [{ header: "unit_cost", value: (r: (typeof rows)[number]) => csvAmount(r.price) }, { header: "cover", value: () => csvDecimal(12.5, 1) }];
    expect(buildCsv(money, rows, { bom: false })).toBe("unit_cost;cover\r\n12,50;12,5\r\n;12,5\r\n");
    expect(buildCsv(money, rows, { separator: "comma", bom: false })).toBe("unit_cost,cover\r\n12.50,12.5\r\n,12.5\r\n");
    expect(csvDecimal(1 / 3, 3)?.value).toBe("0.333");
    expect(csvDecimal(null, 2)).toBeNull();
    expect(csvFileName("sales", "2026-11-01", "2026-11-30")).toBe("sales_2026-11-01_2026-11-30.csv");
    expect(csvFileName("Склад ../x")).toBe("x.csv");
  });
});

describe("query parameters", () => {
  it("parses and rebuilds analytics/export queries safely", () => {
    const q = parseAnalyticsQuery(
      new URLSearchParams("period=custom&from=2026-11-01&to=2026-11-10&model=Model%20X&color=&product=00000000-0000-4000-8000-00000000000A"),
    );
    expect(q).toEqual({ period: "custom", from: "2026-11-01", to: "2026-11-10", model: "Model X", color: null, product: "00000000-0000-4000-8000-00000000000a" });
    expect(parseAnalyticsQuery(new URLSearchParams("period=999&from=x&product=1;drop"))).toMatchObject({ period: "30", from: null, product: null });
    expect(filtersOf(q)).toEqual({ productIds: ["00000000-0000-4000-8000-00000000000a"], models: ["Model X"] });
    expect(analyticsSearch({ ...q, dataset: "sales", sep: "comma" })).toBe(
      "?dataset=sales&period=custom&from=2026-11-01&to=2026-11-10&model=Model+X&product=00000000-0000-4000-8000-00000000000a&sep=comma",
    );
    expect(analyticsSearch({ period: "30", from: "2026-01-01" })).toBe("");
    expect(parseExportParams(new URLSearchParams("dataset=orders&sep=tab"))).toEqual({ dataset: null, separator: "semicolon" });
    expect(parseExportParams(new URLSearchParams("dataset=movements&sep=comma"))).toEqual({ dataset: "movements", separator: "comma" });
  });
});

// ---------------------------------------------------------------------------
// Регресія рецензії: посилання «Створити партію» ↔ форма партії, сигнал обрізаного експорту
// ---------------------------------------------------------------------------

describe("parseProductionPrefill (for the production form loader)", () => {
  const V1 = "4d158935-0000-4000-8000-000000000001";
  const V2 = "e3a7fd5e-0000-4000-8000-000000000002";
  const P1 = "aaaaaaaa-0000-4000-8000-000000000001";

  it("round-trips the quantities productionPrefill puts into the link", () => {
    const link = productionPrefill([
      { productId: P1, variantId: V1, quantity: 7 },
      { productId: P1, variantId: V2, quantity: 30 },
    ]);
    expect(parseProductionPrefill(new URLSearchParams(link.search))).toEqual({ [V1]: 7, [V2]: 30 });
    expect(parseProductionPrefill(new URLSearchParams(link.search), { allowedVariantIds: [V2.toUpperCase()] })).toEqual({ [V2]: 30 });
  });

  it("ignores anything that is not a positive whole quantity for a known variant", () => {
    const params = new URLSearchParams();
    params.append(`qty.${V1.toUpperCase()}`, " 5 ");
    params.append(`qty.${V1}`, "9"); // повтор — перше значення
    params.append(`qty.${V2}`, "0");
    params.append("qty.not-a-uuid", "3");
    params.append("qty.", "3");
    params.append(`qty.aaaaaaaa-0000-4000-8000-00000000000${"3"}`, "1.5");
    params.append(`qty.aaaaaaaa-0000-4000-8000-00000000000${"4"}`, "-2");
    params.append(`qty.aaaaaaaa-0000-4000-8000-00000000000${"5"}`, "1e3");
    params.append(`qty.aaaaaaaa-0000-4000-8000-00000000000${"6"}`, "100001");
    params.append(`cost.${V2}`, "10");
    params.append("product", P1);
    expect(parseProductionPrefill(params)).toEqual({ [V1]: 5 });
    expect(parseProductionPrefill(new URLSearchParams(`qty.${V1}=12`), { max: 10 })).toEqual({});
    expect(parseProductionPrefill(new URLSearchParams(""))).toEqual({});
  });
});

describe("export response contract (page warns about truncated files)", () => {
  const csv = (headers: Record<string, string> = {}, init: ResponseInit = {}) =>
    new Response("a;b\r\n", { status: 200, ...init, headers: { "Content-Type": "text/csv; charset=utf-8", ...headers } });

  it("reads the truncation flag and the row count from the route headers", () => {
    expect(MAX_EXPORT_MOVEMENTS).toBe(50_000);
    expect(exportResponseOutcome(csv({ [EXPORT_HEADERS.truncated]: "1", [EXPORT_HEADERS.rows]: String(MAX_EXPORT_MOVEMENTS) }))).toEqual({
      ok: true,
      truncated: true,
      rows: MAX_EXPORT_MOVEMENTS,
    });
    expect(exportResponseOutcome(csv({ [EXPORT_HEADERS.truncated]: "0", [EXPORT_HEADERS.rows]: "12" }))).toEqual({ ok: true, truncated: false, rows: 12 });
    expect(exportResponseOutcome(csv())).toEqual({ ok: true, truncated: false, rows: null });
  });

  it("maps failures to messages instead of saving them as a file", () => {
    expect(exportResponseOutcome(new Response("Forbidden", { status: 403 }))).toEqual({ ok: false, error: "warehouseAnalytics.export.error.forbidden" });
    expect(exportResponseOutcome(new Response("", { status: 401 }))).toEqual({ ok: false, error: "warehouseAnalytics.export.error.session" });
    expect(exportResponseOutcome(new Response("x", { status: 500 }))).toEqual({ ok: false, error: "warehouseAnalytics.export.error.generic" });
    // Сесія вбудованого застосунку завершилася: замість CSV — HTML-сторінка.
    expect(exportResponseOutcome(new Response("<html>", { status: 200, headers: { "Content-Type": "text/html" } }))).toEqual({
      ok: false,
      error: "warehouseAnalytics.export.error.session",
    });
    expect(exportResponseOutcome({ type: "opaqueredirect", redirected: false, status: 0, ok: false, headers: new Headers() })).toEqual({
      ok: false,
      error: "warehouseAnalytics.export.error.session",
    });
  });
});
