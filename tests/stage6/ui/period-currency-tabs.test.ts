/**
 * Етап 6, WP0-UI: вибір періоду (PeriodBar), перемикач валюти (CurrencySwitch), вкладки фінансів (FinanceTabs) —
 * §12.1, §18.1, §18.3. GET-форма з параметрами `period/from/to/granularity/compare` (з префіксом), збереження інших
 * параметрів сторінки, скидання пагінації; довільний період лише з allowCustom; «Ще» — відрізок і порівняння;
 * посилання валюти зберігають параметри; 10 вкладок, поточна — aria-current.
 */
import { createElement as h } from "react";
import { describe, expect, it } from "vitest";
import { CurrencySwitch, currencyHref } from "~/components/finance/currency-switch";
import { FinanceTabs } from "~/components/finance/finance-tabs";
import { PeriodBar, periodParamNames, preservedParams } from "~/components/finance/period-bar";
import { FINANCE_TABS } from "~/domain/finance";
import { DICTIONARIES } from "~/i18n";
import { PERIOD_PRESETS } from "~/lib/periods";
import { CYRILLIC, count, renderUi, textOf } from "./render";

const NOV = { from: "2026-11-01", to: "2026-11-27" };

/** Приховані поля форми: [name, value]. */
function hiddenInputs(html: string): Array<[string, string]> {
  return [...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"\/>/g)].map((m) => [m[1]!, m[2]!.replace(/&amp;/g, "&")]);
}

/** Імена всіх полів форми (select/input), крім прихованих. */
function fieldNames(html: string): string[] {
  return [...html.matchAll(/<(?:select|input)(?![^>]*type="hidden")[^>]*\sname="([^"]+)"/g)].map((m) => m[1]!);
}

describe("PeriodBar", () => {
  it("presets with uk/en labels, the current one selected, compact range and an Apply button", async () => {
    const html = await renderUi(() => h(PeriodBar, { preset: "thisMonth", range: NOV, granularity: "day", compare: "none" }));
    expect(html).toMatch(/<form method="get" action="\/demo\/finance"[^>]*class="ot-period-bar"/);
    const options = [...html.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
    expect(options).toEqual(PERIOD_PRESETS.filter((p) => p !== "custom"));
    expect(html).toMatch(/<option value="thisMonth" selected="">Цей місяць<\/option>/);
    expect(textOf(html)).toContain("01–27.11.2026");
    expect(textOf(html)).toContain("Застосувати");
    expect(fieldNames(html)).toEqual(["period"]);
    const en = await renderUi(() => h(PeriodBar, { preset: "last30", range: NOV, granularity: "day", compare: "none" }), { locale: "en" });
    expect(textOf(en)).not.toMatch(CYRILLIC);
    expect(textOf(en)).toContain("30 days");
    expect(textOf(en)).toContain("01–27/11/2026");
  });

  it("custom period: dates only with allowCustom and preset custom, pre-filled with the current range", async () => {
    const off = await renderUi(() => h(PeriodBar, { preset: "thisMonth", range: NOV, granularity: "day", compare: "none", allowCustom: true }));
    expect(off).toContain('<option value="custom">Довільний</option>');
    expect(fieldNames(off)).toEqual(["period"]);
    const on = await renderUi(() => h(PeriodBar, { preset: "custom", range: NOV, granularity: "day", compare: "none", allowCustom: true }));
    expect(fieldNames(on)).toEqual(["period", "from", "to"]);
    const fromInput = /<input[^>]*name="from"[^>]*>/.exec(on)![0];
    expect(fromInput).toContain('type="date"');
    expect(fromInput).toContain('value="2026-11-01"');
    expect(fromInput).toContain("required");
    expect(on).toContain('value="2026-11-01"');
    expect(on).toContain('value="2026-11-27"');
    expect(textOf(on)).toContain("Від");
    expect(textOf(on)).toContain("До");
  });

  it("keeps other query parameters as hidden fields, drops the controlled ones and pagination", async () => {
    const url = "/demo/finance?tab=profit&currency=EUR&page=3&period=last7&from=2026-01-01&cursor=abc&q=a%26b";
    const html = await renderUi(() => h(PeriodBar, { preset: "last7", range: NOV, granularity: "day", compare: "none" }), { url });
    expect(hiddenInputs(html)).toEqual([
      ["tab", "profit"],
      ["currency", "EUR"],
      ["q", "a&b"],
    ]);
    expect(preservedParams("?granularity=week&compare=previous", ["period"])).toEqual([
      ["granularity", "week"],
      ["compare", "previous"],
    ]);
  });

  it("«More»: granularity and comparison only when asked, comparison range hint, granularities over 366 days disabled", async () => {
    const plain = await renderUi(() => h(PeriodBar, { preset: "thisMonth", range: NOV, granularity: "day", compare: "previous" }));
    expect(plain).not.toContain("Ще");
    expect(fieldNames(plain)).toEqual(["period"]);
    const year = { from: "2024-01-01", to: "2026-11-27" };
    const html = await renderUi(() =>
      h(PeriodBar, { preset: "custom", range: year, granularity: "month", compare: "previous", allowCustom: true, showGranularity: true, showCompare: true }),
    );
    expect(textOf(html)).toContain("Ще");
    expect(html).toContain("ot-disclosure--collapse-mobile");
    expect(fieldNames(html)).toEqual(["period", "from", "to", "granularity", "compare"]);
    expect(html).toMatch(/<option value="day" disabled="">День<\/option>/);
    expect(html).toMatch(/<option value="week" disabled="">Тиждень<\/option>/);
    expect(html).toMatch(/<option value="month" selected="">Місяць<\/option>/);
    expect(textOf(html)).toContain("Порівняння: 03.02.2021 – 31.12.2023");
    expect(html).toMatch(/<option value="previous" selected="">Попередній період<\/option>/);
    for (const mode of ["none", "previous", "lastYear"] as const) expect(DICTIONARIES.en[`finance.compare.${mode}`]).toBeTruthy();
  });

  it("param prefix applies to every field; ids are unique for two bars on one page", async () => {
    expect(periodParamNames("cmp_")).toEqual({ period: "cmp_period", from: "cmp_from", to: "cmp_to", granularity: "cmp_granularity", compare: "cmp_compare" });
    const html = await renderUi(() =>
      h("div", null, [
        h(PeriodBar, { key: "a", preset: "custom", range: NOV, granularity: "week", compare: "none", allowCustom: true, paramPrefix: "a_", showGranularity: true }),
        h(PeriodBar, { key: "b", preset: "custom", range: NOV, granularity: "week", compare: "none", allowCustom: true, paramPrefix: "b_" }),
      ]),
    );
    expect(fieldNames(html)).toEqual(["a_period", "a_from", "a_to", "a_granularity", "b_period", "b_from", "b_to"]);
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("extra controls (e.g. the currency switch) go into «More»", async () => {
    const html = await renderUi(() =>
      h(PeriodBar, { preset: "thisMonth", range: NOV, granularity: "day", compare: "none", extra: h(CurrencySwitch, { current: "UAH", options: ["UAH", "EUR"] }) }),
    );
    expect(textOf(html)).toContain("Ще");
    expect(count(html, "ot-currency-switch__link")).toBe(2);
  });
});

describe("CurrencySwitch", () => {
  it("links keep the other query parameters; the current one has aria-current", async () => {
    const html = await renderUi(() => h(CurrencySwitch, { current: "EUR", options: ["UAH", "EUR", "USD"] }), {
      url: "/demo/finance?period=last30&currency=EUR&tab=profit",
    });
    const links = [...html.matchAll(/<a([^>]*)>([A-Z]{3})<\/a>/g)].map((m) => ({
      code: m[2],
      href: /href="([^"]+)"/.exec(m[1]!)?.[1]?.replace(/&amp;/g, "&"),
      current: m[1]!.includes('aria-current="true"'),
    }));
    expect(links).toEqual([
      { code: "UAH", href: "/demo/finance?period=last30&currency=UAH&tab=profit", current: false },
      { code: "EUR", href: "/demo/finance?period=last30&currency=EUR&tab=profit", current: true },
      { code: "USD", href: "/demo/finance?period=last30&currency=USD&tab=profit", current: false },
    ]);
    expect(html).toContain('aria-label="Валюта показу"');
    expect(textOf(html)).toBe("UAH EUR USD");
  });

  it("custom parameter name, an unknown current code is still shown, optional visible label", async () => {
    expect(currencyHref("/demo/analytics", "?tab=sales", "cur", "PLN")).toBe("/demo/analytics?tab=sales&cur=PLN");
    const html = await renderUi(() => h(CurrencySwitch, { current: "HUF", options: ["UAH"], paramName: "cur", showLabel: true }), { locale: "en" });
    expect(textOf(html)).toBe("Display currency HUF UAH");
    expect(html).toContain("cur=HUF");
  });
});

describe("FinanceTabs", () => {
  it("ten tabs in the §18.1 order with /demo paths; the current tab has aria-current=page; en without Cyrillic", async () => {
    const html = await renderUi(() => h(FinanceTabs, { current: "rates" }));
    const links = [...html.matchAll(/<a([^>]*)><span class="ot-tabs__label">([^<]+)<\/span>/g)].map((m) => ({
      href: /href="([^"]+)"/.exec(m[1]!)?.[1],
      label: m[2],
      current: m[1]!.includes('aria-current="page"'),
    }));
    expect(links.map((l) => l.href)).toEqual(FINANCE_TABS.map((t) => `/demo/${t.path}`));
    expect(links.map((l) => l.label)).toEqual(["Огляд", "Замовлення", "Доставка", "Витрати", "Партнери", "Собівартість", "Курси", "Звіти", "Місяці", "Налаштування"]);
    expect(links.filter((l) => l.current).map((l) => l.href)).toEqual(["/demo/finance/rates"]);
    expect(html).toContain('aria-label="Фінанси"');
    const en = await renderUi(() => h(FinanceTabs, { current: "overview" }), { locale: "en" });
    expect(textOf(en)).not.toMatch(CYRILLIC);
    expect(textOf(en)).toContain("Overview");
  });
});
