import { describe, expect, it } from "vitest";
import { applyPlurals, DICTIONARIES, LOCALES, MESSAGE_MODULES, makeT, translate } from "~/i18n";

/** Множина в перекладах (ui-9): «1 позиція», «2 позиції», «5 позицій», «21 позиція»; «1 item» / «2 items». */
describe("plural forms in translate()", () => {
  const uk = makeT("uk");
  const en = makeT("en");

  it("selects Ukrainian one/few/many forms", () => {
    expect(uk("warehouse.stocktake.subtitle", { count: 1 })).toBe("Лист підрахунку: 1 позиція");
    expect(uk("warehouse.stocktake.subtitle", { count: 2 })).toBe("Лист підрахунку: 2 позиції");
    expect(uk("warehouse.stocktake.subtitle", { count: 4 })).toBe("Лист підрахунку: 4 позиції");
    expect(uk("warehouse.stocktake.subtitle", { count: 5 })).toBe("Лист підрахунку: 5 позицій");
    expect(uk("warehouse.stocktake.subtitle", { count: 11 })).toBe("Лист підрахунку: 11 позицій");
    expect(uk("warehouse.stocktake.subtitle", { count: 21 })).toBe("Лист підрахунку: 21 позиція");
    expect(uk("warehouse.stocktake.subtitle", { count: 0 })).toBe("Лист підрахунку: 0 позицій");
    expect(uk("warehouse.bulk.threshold.done", { count: 1, threshold: 3 })).toBe("Поріг 3 встановлено для 1 позиції.");
    expect(uk("warehouse.bulk.threshold.done", { count: 3, threshold: 3 })).toBe("Поріг 3 встановлено для 3 позицій.");
  });

  it("selects English one/other forms", () => {
    expect(en("warehouse.stocktake.subtitle", { count: 1 })).toBe("Count sheet: 1 item");
    expect(en("warehouse.stocktake.subtitle", { count: 2 })).toBe("Count sheet: 2 items");
    expect(en("warehouseAnalytics.kpi.valueMissing", { items: 1, units: 1 })).toBe("No unit cost: 1 item (1 unit) — not included");
    expect(en("warehouseAnalytics.cover.days", { days: "12.5" })).toBe("12.5 days");
  });

  it("accepts already formatted numbers and keeps them as passed", () => {
    expect(uk("warehouse.stocktake.subtitle", { count: "1 234" })).toBe("Лист підрахунку: 1 234 позиції");
    expect(en("warehouse.stocktake.subtitle", { count: "1,001" })).toBe("Count sheet: 1,001 items");
    expect(uk("warehouse.stocktake.subtitle", { count: "1 001" })).toBe("Лист підрахунку: 1 001 позиція");
  });

  it("supports =N, nested placeholders and falls back to other", () => {
    expect(applyPlurals("{n, plural, =0 {none} one {# {what}} other {# {what}s}}", "en", { n: 0 })).toBe("none");
    expect(applyPlurals("{n, plural, =0 {none} one {# {what}} other {# {what}s}}", "en", { n: 1 })).toBe("1 {what}");
    expect(applyPlurals("{n, plural, one {# a} other {# b}}", "uk", { n: "x" })).toBe("x b");
    expect(applyPlurals("{n, plural, one {# a} other {# b}}", "uk", {})).toBe("# b");
    // Некоректний шаблон не ламає текст.
    expect(applyPlurals("{n, plural, one {# a}", "uk", { n: 1 })).toBe("{n, plural, one {# a}");
    expect(applyPlurals("{n, plural, one {# a}}", "uk", { n: 1 })).toBe("{n, plural, one {# a}}");
    expect(translate("en", "warehouse.stocktake.subtitle")).toBe("Count sheet: # items");
  });

  it("every plural message parses, has «other» and Ukrainian ones have one/few/many", () => {
    const bad: string[] = [];
    for (const locale of LOCALES) {
      for (const [key, template] of Object.entries(DICTIONARIES[locale])) {
        if (!/,\s*plural,/.test(template)) continue;
        const names = [...template.matchAll(/\{(\w+),\s*plural,/g)].map((m) => m[1]!);
        const params = Object.fromEntries(names.map((n) => [n, 7]));
        const out = applyPlurals(template, locale, params);
        if (/,\s*plural,/.test(out)) bad.push(`${locale}:${key} does not parse`);
        if (locale === "uk" && !/one \{/.test(template)) bad.push(`${locale}:${key} has no «one»`);
        if (locale === "uk" && /few \{/.test(template) !== /many \{/.test(template)) bad.push(`${locale}:${key} few/many mismatch`);
      }
    }
    expect(bad).toEqual([]);
  });
});

/**
 * Рядки з кількістю, що лишалися без множини (ui-9, N2): «Print: 1 orders», «Packaging materials: 1 alerts»,
 * «Для 1 варіантів…», «1 variants had…».
 */
describe("count messages use plural forms (ui-9 / N2)", () => {
  const uk = makeT("uk");
  const en = makeT("en");

  it("packing print and handover titles", () => {
    expect(en("packing.print.title", { count: 1 })).toBe("Print: 1 order");
    expect(en("packing.print.title", { count: 2 })).toBe("Print: 2 orders");
    expect(en("packing.handover.title", { count: 1 })).toBe("Carrier handover list: 1 parcel");
    expect(en("packing.handover.title", { count: 12 })).toBe("Carrier handover list: 12 parcels");
  });

  it("packaging-material alerts on the stock page", () => {
    expect(en("warehouse.alerts.materials", { count: 1 })).toBe("Packaging materials: 1 alert");
    expect(en("warehouse.alerts.materials", { count: 3 })).toBe("Packaging materials: 3 alerts");
    expect(uk("warehouse.alerts.materials", { count: 1 })).toBe("Пакувальні матеріали: попереджень — 1");
  });

  it("inventory initialisation results (clamped / history)", () => {
    const clamped = (n: number) => uk("warehouse.init.result.clamped", { clamped: n }).split(" сума")[0];
    expect([1, 2, 5, 11, 21, 22].map(clamped)).toEqual([
      "Для 1 варіанта",
      "Для 2 варіантів",
      "Для 5 варіантів",
      "Для 11 варіантів",
      "Для 21 варіанта",
      "Для 22 варіантів",
    ]);
    const history = (n: number) => uk("warehouse.init.result.history", { history: n }).split(" внутрішні")[0];
    expect([1, 3, 5, 11, 21].map(history)).toEqual(["1 варіант мав", "3 варіанти мали", "5 варіантів мали", "11 варіантів мали", "21 варіант мав"]);
    expect(en("warehouse.init.result.clamped", { clamped: 1 })).toMatch(/^For 1 variant the sum/);
    expect(en("warehouse.init.result.clamped", { clamped: 2 })).toMatch(/^For 2 variants the sum/);
    expect(en("warehouse.init.result.history", { history: 1 })).toMatch(/^1 variant had internal/);
    expect(en("warehouse.init.result.history", { history: 4 })).toMatch(/^4 variants had internal/);
  });

  /**
   * Сканування модулів етапу 5: «{n} <іменник у множині>» без {n, plural, …} дає «1 orders» / «1 варіантів».
   * Винятки — лише сталі ліміти («до {limit} замовлень») і суми зі знаком («+{added} / −{removed} units»).
   */
  it("no stage-5 message puts a bare count before a plural noun", () => {
    const MODULES = ["warehouse", "production", "warehouseAnalytics", "dashboard", "staff", "packing"] as const;
    const EN = /\{(\w+)\} (orders|items|variants|alerts|parcels|units|days|lines|products|batches|movements|discrepancies|materials|boxes|kits|receipts|labels|pieces|times|members|permissions)\b/;
    const UK = /\{(\w+)\} (варіант|позиці|товар|замовлен|посил|одиниц|попереджен|днів|дня|день|парті|рух|короб|комплект|надходжен|матеріал|етикет|штук|разів|працівник|дозвол)/;
    const ALLOWED = new Set([
      // Сталі ліміти (завжди більше 1).
      "dashboard.quick.validateAll.limit",
      "packing.bulk.limits",
      "packing.print.truncated",
      "packing.handover.truncated",
      "warehouseAnalytics.createBatchTruncated",
      "warehouseAnalytics.period.invalid",
      // Суми зі знаком / суми параметрів («+0 / −1 units», «({lead} + {cover} days)»).
      "warehouse.stocktake.preview.changed",
      "warehouse.stocktake.done",
      "warehouseAnalytics.method.recommendation",
    ]);
    const bad: string[] = [];
    for (const mod of MODULES) {
      for (const locale of LOCALES) {
        for (const [key, template] of Object.entries(MESSAGE_MODULES[mod]![locale])) {
          if (ALLOWED.has(key)) continue;
          const names = [...template.matchAll(/\{(\w+),\s*plural,/g)].map((x) => x[1]!);
          const flat = applyPlurals(template, locale, Object.fromEntries(names.map((n) => [n, "N"])));
          if ((locale === "en" ? EN : UK).test(flat)) bad.push(`${locale}:${key}: ${template}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
