/**
 * Етап 6, WP1: розбір сирих відповідей НБУ `exchange_site` (docs/stage6-design.md §5.6) на фікстурах із фактів:
 * JSON-масив об'єктів; три форми помилок («Wrong date format» — невалідний JSON при HTTP 200, `[{"message":…}]`, `[]` —
 * не помилка); ключ cc (не r030); rate — з сирого тексту (не Number); units/масштаби (зокрема зміна масштабу 2019 р.);
 * calcdate з пробілом → null; метали й XDR пропускаються; вікно дат; адреса — лише exchange_site (dollar_info НІКОЛИ).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ratePerUnitScaled, scaledRateToDecimal } from "~/lib/decimal";
import {
  buildExchangeSiteUrl,
  canonicalRate,
  isoToNbuQueryDate,
  nbuDateToIso,
  nbuFetchWindow,
  NbuResponseError,
  parseJsonKeepingNumbers,
  parseNbuExchangeSite,
  RawNumber,
  splitWindows,
} from "~/modules/fx/nbu-parse";
import { ALL_20261120, EUR_RANGE, fixture } from "./helpers";

const W1120 = { from: "2026-11-20", to: "2026-11-20" };
const errCode = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof NbuResponseError) return e.code;
    throw e;
  }
  return null;
};

describe("raw JSON tokenizer", () => {
  it("keeps numbers as raw strings (no float), parses strings with escapes and literals", () => {
    const doc = parseJsonKeepingNumbers('[{"rate":0.0017505,"u":1000,"t":"\\u0414\\u043e\\u043d\\u0433 \\"x\\"","n":null,"b":true,"e":-1.5e-3}]') as Array<Record<string, unknown>>;
    expect(doc[0]!.rate).toBeInstanceOf(RawNumber);
    expect((doc[0]!.rate as RawNumber).raw).toBe("0.0017505");
    expect((doc[0]!.u as RawNumber).raw).toBe("1000");
    expect(doc[0]!.t).toBe('Донг "x"');
    expect(doc[0]!.n).toBeNull();
    expect(doc[0]!.b).toBe(true);
    expect((doc[0]!.e as RawNumber).raw).toBe("-1.5e-3");
    // Значення, яке float зіпсував би, лишається точним рядком.
    expect((parseJsonKeepingNumbers("[0.1234567890123456789]") as RawNumber[])[0]!.raw).toBe("0.1234567890123456789");
  });

  it("rejects invalid JSON, trailing data, control characters and deep nesting; __proto__ is an own key", () => {
    for (const bad of ["", "[", "[1,]", "{\"a\" 1}", "[1] x", "[\"a\nb\"]", "[01]", "[.5]", "[1.]", "tru", "[[[[[[[[[1]]]]]]]]]"]) {
      expect(errCode(() => parseJsonKeepingNumbers(bad)), bad).toBe("invalid_json");
    }
    const obj = (parseJsonKeepingNumbers('[{"__proto__":{"polluted":1}}]') as Array<Record<string, unknown>>)[0]!;
    expect(Object.prototype.hasOwnProperty.call(obj, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("exchange_site fixtures (facts, 20.11.2026)", () => {
  it("all currencies: 40 currencies (metals and XDR skipped), exact rates and scales, calcdate", () => {
    const r = parseNbuExchangeSite(fixture(ALL_20261120), W1120);
    expect(r.rows).toHaveLength(40);
    expect(r.skippedNonCurrency).toBe(5);
    expect(r.skippedUnits).toBe(0);
    const by = new Map(r.rows.map((x) => [x.currency, x]));
    for (const c of ["XAU", "XAG", "XPT", "XPD", "XDR"]) expect(by.has(c)).toBe(false);
    expect(by.get("EUR")).toEqual({ currency: "EUR", effectiveDate: "2026-11-20", rate: "49.5335", units: 1, setOn: "2026-11-19" });
    expect(by.get("USD")).toMatchObject({ rate: "45.0532", units: 1 });
    expect(by.get("HUF")).toMatchObject({ rate: "13.4308", units: 100 });
    expect(by.get("JPY")).toMatchObject({ rate: "2.818", units: 10 });
    expect(by.get("VND")).toMatchObject({ rate: "1.7505", units: 1000 });
    expect(by.get("KRW")).toMatchObject({ rate: "3.3896", units: 100 });
    // Курс за одиницю — точно rate / units (rate_per_unit НБУ як float не використовується).
    expect(scaledRateToDecimal(ratePerUnitScaled(by.get("VND")!.rate, 1000))).toBe("0.0017505");
    expect(scaledRateToDecimal(ratePerUnitScaled(by.get("HUF")!.rate, 100))).toBe("0.134308");
    // Ключ — cc, а не r030: у відповіді є r030, але він не потрапляє в результат.
    expect(Object.keys(by.get("EUR")!)).toEqual(["currency", "effectiveDate", "rate", "units", "setOn"]);
  });

  it("EUR range 18–30.11: weekends repeat Friday's rate (as published), calcdate = setting date", () => {
    const r = parseNbuExchangeSite(fixture(EUR_RANGE), { from: "2026-11-18", to: "2026-11-30" });
    const rates = Object.fromEntries(r.rows.map((x) => [x.effectiveDate, x.rate]));
    expect(rates["2026-11-20"]).toBe("49.5335");
    expect(rates["2026-11-21"]).toBe("49.5335");
    expect(rates["2026-11-22"]).toBe("49.5335");
    expect(rates["2026-11-23"]).toBe("49.2763");
    expect(rates["2026-11-24"]).toBe("49.455");
    expect(rates["2026-11-27"]).toBe("49.4942");
    expect(rates["2026-11-28"]).toBe("49.4942");
    expect(r.rows.find((x) => x.effectiveDate === "2026-11-28")!.setOn).toBe("2026-11-26");
    expect(r.rows).toHaveLength(13);
  });

  it("scale change of 2019 and a blank calcdate (before 05.07.2019) → setOn null", () => {
    const r = parseNbuExchangeSite(fixture("reconstructed-usd-2019-scale-change.json"), { from: "2019-06-01", to: "2019-12-31" });
    expect(r.rows).toEqual([
      { currency: "USD", effectiveDate: "2019-06-01", rate: "2687.2573", units: 100, setOn: null },
      { currency: "USD", effectiveDate: "2019-12-28", rate: "23.6862", units: 1, setOn: "2019-12-27" },
    ]);
    expect(scaledRateToDecimal(ratePerUnitScaled("2687.2573", 100))).toBe("26.872573");
  });

  it("three error shapes: invalid JSON with HTTP 200, a message object, and an empty array (not an error)", () => {
    expect(errCode(() => parseNbuExchangeSite(fixture("wrong-date-format.txt"), W1120))).toBe("invalid_json");
    expect(errCode(() => parseNbuExchangeSite(fixture("wrong-parameters-format.json"), W1120))).toBe("nbu_message");
    expect(parseNbuExchangeSite(fixture("empty.json"), W1120)).toEqual({ rows: [], skippedNonCurrency: 0, skippedUnits: 0 });
    expect(errCode(() => parseNbuExchangeSite('{"cc":"EUR"}', W1120))).toBe("not_array");
  });

  it("row validation: cc, rate as a raw positive decimal (no exponent, ≤ 6 decimals), units, dates within the window, duplicates", () => {
    const row = (o: Record<string, string>) => `[{"exchangedate":"20.11.2026","cc":"EUR","rate":49.5335,"units":1,"calcdate":"19.11.2026",${Object.entries(o).map(([k, v]) => `"${k}":${v}`).join(",")}}]`;
    const one = (o: Record<string, string>) => errCode(() => parseNbuExchangeSite(row(o), W1120));
    expect(one({ cc: '"eur"' })).toBe("invalid_row");
    expect(one({ cc: "978" })).toBe("invalid_row");
    expect(one({ rate: '"49.5335"' })).toBe("invalid_row");
    expect(one({ rate: "4.95335e1" })).toBe("invalid_row");
    expect(one({ rate: "0" })).toBe("invalid_row");
    expect(one({ rate: "-49.5" })).toBe("invalid_row");
    expect(one({ rate: "49.1234567" })).toBe("invalid_row");
    expect(one({ units: "0" })).toBe("invalid_row");
    expect(one({ units: "1.5" })).toBe("invalid_row");
    expect(one({ exchangedate: '"2026-11-20"' })).toBe("invalid_row");
    expect(one({ exchangedate: '"21.11.2026"' })).toBe("date_outside_window");
    expect(one({ calcdate: '"19/11/2026"' })).toBe("invalid_row");
    // Масштаб поза CHECK fx_rates — рядок пропускається з лічильником, а не помилка всієї відповіді.
    expect(parseNbuExchangeSite(row({ units: "1000000" }), W1120)).toMatchObject({ rows: [], skippedUnits: 1 });
    // calcdate порожній / пробіл / відсутній → null.
    expect(parseNbuExchangeSite(row({ calcdate: '" "' }), W1120).rows[0]!.setOn).toBeNull();
    expect(parseNbuExchangeSite('[{"exchangedate":"20.11.2026","cc":"EUR","rate":49.5335,"units":1}]', W1120).rows[0]!.setOn).toBeNull();
    // Дубль з тим самим значенням — один рядок; з іншим — помилка.
    const dup = (r2: string) => `[{"exchangedate":"20.11.2026","cc":"EUR","rate":49.5335,"units":1},{"exchangedate":"20.11.2026","cc":"EUR","rate":${r2},"units":1}]`;
    expect(parseNbuExchangeSite(dup("49.533500"), W1120).rows).toHaveLength(1);
    expect(errCode(() => parseNbuExchangeSite(dup("49.6"), W1120))).toBe("duplicate_row");
  });

  it("canonicalRate keeps the published precision without trailing zeros", () => {
    expect(canonicalRate("49.533500")).toBe("49.5335");
    expect(canonicalRate("2687.2573")).toBe("2687.2573");
    expect(canonicalRate("1")).toBe("1");
    expect(canonicalRate("0.000001")).toBe("0.000001");
    expect(canonicalRate("0.0000001")).toBeNull();
    expect(canonicalRate("1234567890123.5")).toBeNull();
  });
});

describe("request URL and windows", () => {
  it("builds only exchange_site URLs: all currencies for short windows, valcode for one currency ≤ 1 year", () => {
    expect(buildExchangeSiteUrl({ from: "2026-11-25", to: "2026-12-05" })).toBe(
      "https://bank.gov.ua/NBU_Exchange/exchange_site?start=20261125&end=20261205&sort=exchangedate&order=asc&json",
    );
    expect(buildExchangeSiteUrl({ from: "2026-01-01", to: "2026-12-31", currency: "EUR" })).toBe(
      "https://bank.gov.ua/NBU_Exchange/exchange_site?start=20260101&end=20261231&valcode=EUR&sort=exchangedate&order=asc&json",
    );
    expect(() => buildExchangeSiteUrl({ from: "2026-01-01", to: "2026-03-01" })).toThrow(RangeError);
    expect(() => buildExchangeSiteUrl({ from: "2025-01-01", to: "2026-01-02", currency: "EUR" })).toThrow(RangeError);
    expect(() => buildExchangeSiteUrl({ from: "2026-02-02", to: "2026-02-01" })).toThrow(RangeError);
    expect(() => buildExchangeSiteUrl({ from: "2026-02-01", to: "2026-02-02", currency: "eur" })).toThrow(RangeError);
  });

  it("the source code never requests the 12:00 reference rate (dollar_info) or another endpoint", () => {
    // Коментарі (блокові й рядкові після пробілу) прибираються; «https://» у рядках лишається.
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
    let urls = 0;
    for (const f of ["app/integrations/fx/nbu.server.ts", "app/modules/fx/nbu-parse.ts", "app/modules/fx/nbu-fetch.server.ts", "app/modules/fx/jobs.server.ts"]) {
      const code = strip(fs.readFileSync(path.resolve(f), "utf8"));
      expect(code, f).not.toMatch(/dollar_info|statdirectory|NBUStatService/);
      for (const m of code.matchAll(/https?:\/\/[^\s"'`]+/g)) {
        expect(m[0], f).toBe("https://bank.gov.ua/NBU_Exchange/exchange_site");
        urls++;
      }
    }
    expect(urls).toBe(1);
  });

  it("fetch window is [today − 3, today + 7]; backfill windows ≤ 366 days; date helpers", () => {
    expect(nbuFetchWindow("2026-11-28")).toEqual({ from: "2026-11-25", to: "2026-12-05" });
    expect(splitWindows("2024-01-01", "2026-03-01")).toEqual([
      { from: "2024-01-01", to: "2024-12-31" },
      { from: "2025-01-01", to: "2026-01-01" },
      { from: "2026-01-02", to: "2026-03-01" },
    ]);
    expect(splitWindows("2026-11-20", "2026-11-20")).toEqual([{ from: "2026-11-20", to: "2026-11-20" }]);
    expect(() => splitWindows("2026-11-21", "2026-11-20")).toThrow(RangeError);
    expect(nbuDateToIso("20.11.2026")).toBe("2026-11-20");
    expect(nbuDateToIso("31.02.2026")).toBeNull();
    expect(nbuDateToIso(" ")).toBeNull();
    expect(isoToNbuQueryDate("2026-01-05")).toBe("20260105");
  });
});
