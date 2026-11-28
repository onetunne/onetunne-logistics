/**
 * Етап 6, WP0-UI: плитка показника (KpiTile) і рядок покриття (CoverageNote) — §2.6, §18.3, золотий G1.
 * Факт null → «—» (ніколи 0), «≈ Прогноз» — окремим числом; маркер повноти зі значком; зміна — стрілка + слова;
 * «Чого бракує» з посиланнями; покриття «за N з M» з правильними відмінками (uk) і множиною (en).
 */
import { createElement as h } from "react";
import { describe, expect, it } from "vitest";
import { CoverageNote, coveragePercent } from "~/components/finance/coverage-note";
import { KpiTile, deltaDirection } from "~/components/finance/kpi-tile";
import { CYRILLIC, attr, count, renderUi, textOf, visibleText } from "./render";

const UAH = (amount: string) => ({ amount, currency: "UAH" });

describe("KpiTile", () => {
  it("G1 October before the invoice: actual «—» for 0 of 1 orders, «≈ Forecast» 3 902,11 грн (never 0)", async () => {
    const html = await renderUi(() =>
      h(KpiTile, {
        id: "profit",
        title: "Прибуток після врахованих витрат",
        value: null,
        forecast: UAH("3902.11"),
        marker: "with_forecast",
        coverage: { n: 0, m: 1 },
      }),
    );
    const text = visibleText(html);
    expect(text).toContain("Прибуток після врахованих витрат");
    expect(text).toContain("З прогнозом");
    expect(text).toMatch(/Факт — ≈ Прогноз 3 902,11 грн/);
    expect(text).toContain("за 0 з 1 замовлення");
    expect(text).not.toMatch(/0,00/);
    // Значення факту має стабільний id (E2E читає плитки), прогноз — окремий елемент.
    expect(html).toContain('id="kpi-profit"');
    expect(html).toContain('id="kpi-profit-forecast"');
    expect(html).toContain('data-kpi="profit"');
    expect(html).toContain('data-marker="with_forecast"');
  });

  it("without a forecast prop there is no forecast row and no «Actual» label", async () => {
    const text = visibleText(await renderUi(() => h(KpiTile, { id: "turnover", title: "Оборот", value: UAH("182340.00"), marker: "complete" })));
    expect(text).toBe("Оборот Повні дані 182 340,00 грн");
  });

  it("forecast: null renders a «—» forecast row (unknown, not 0)", async () => {
    const text = visibleText(await renderUi(() => h(KpiTile, { id: "p", title: "P", value: UAH("10.00"), forecast: null, marker: "incomplete" })));
    expect(text).toBe("P Неповні дані Факт 10,00 грн ≈ Прогноз —");
  });

  it("delta: arrow + words; up/down/flat/unknown; percent or amount may be unknown", async () => {
    expect(deltaDirection({ amount: UAH("19500.00"), percent: "12.0" })).toBe("up");
    expect(deltaDirection({ amount: UAH("-100.00"), percent: null })).toBe("down");
    expect(deltaDirection({ amount: UAH("0.00"), percent: "0.0" })).toBe("flat");
    expect(deltaDirection({ amount: null, percent: null })).toBe("unknown");
    const up = await renderUi(() =>
      h(KpiTile, { id: "t", title: "Оборот", value: UAH("1.00"), marker: "complete", delta: { amount: UAH("19500.00"), percent: "12.0" } }),
    );
    expect(textOf(up)).toContain("▲ Зростання: +12,0 % · +19 500,00 грн до періоду порівняння");
    expect(up).toContain('data-direction="up"');
    const down = await renderUi(() =>
      h(KpiTile, {
        id: "r",
        title: "Повернення",
        value: UAH("1.00"),
        marker: "complete",
        delta: { amount: UAH("-120.00"), percent: null },
        deltaPreference: "lower",
        deltaLabel: "до попередніх 30 днів",
      }),
    );
    expect(textOf(down)).toContain("▼ Зниження: — · -120,00 грн до попередніх 30 днів · менше — добре");
    const unknown = await renderUi(() => h(KpiTile, { id: "u", title: "U", value: null, marker: "incomplete", delta: { amount: null, percent: null } }));
    expect(visibleText(unknown)).toContain("Зміна невідома");
    expect(unknown).not.toMatch(/0,00/);
  });

  it("«What is missing» lists only non-zero items, with links; title links to href; note and sparkline", async () => {
    const html = await renderUi(() =>
      h(KpiTile, {
        id: "gp",
        title: "Валовий прибуток",
        value: UAH("96400.00"),
        marker: "incomplete",
        coverage: { n: 118, m: 120 },
        href: "/demo/finance/pnl",
        note: "маржа 54,1 %",
        missing: [
          { labelKey: "finance.component.cogs", count: 2, href: "/demo/finance/costs" },
          { labelKey: "finance.component.fees", count: 0 },
          { labelKey: "finance.component.shipping_cost", count: 9 },
        ],
        sparkline: [
          { key: "1", value: "10.00" },
          { key: "2", value: null },
          { key: "3", value: "12.00" },
        ],
      }),
    );
    const text = visibleText(html);
    expect(text).toContain("за 118 з 120 замовлень");
    expect(text).toContain("маржа 54,1 %");
    expect(text).toContain("Чого бракує");
    expect(text).toContain("Собівартість: 2");
    expect(text).toContain("Доставка: 9");
    expect(text).not.toContain("Комісії: 0");
    expect(html).toContain('href="/demo/finance/costs"');
    expect(html).toMatch(/<h2 class="ot-card__title"><a href="\/demo\/finance\/pnl"[^>]*>Валовий прибуток<\/a>/);
    expect(html).toContain('aria-label="Динаміка: Валовий прибуток"');
    expect(count(html, 'role="img"')).toBe(1);
  });

  it("explanation disclosure «How it is calculated»", async () => {
    const html = await renderUi(() =>
      h(KpiTile, { id: "x", title: "X", value: UAH("1.00"), marker: "complete", explanation: "Σ записів остаточних замовлень + записи періоду" }),
    );
    expect(textOf(html)).toContain("Як порахувано Σ записів остаточних замовлень + записи періоду");
  });

  it("English tile has no Cyrillic in its own texts", async () => {
    const html = await renderUi(
      () =>
        h(KpiTile, {
          id: "p",
          title: "Profit after recorded costs",
          value: null,
          forecast: { amount: "54800.00", currency: "EUR" },
          marker: "incomplete",
          coverage: { n: 96, m: 120 },
          delta: { amount: null, percent: "-3.0" },
          missing: [{ labelKey: "finance.component.packaging", count: 1 }],
          explanation: "Sum of entries",
        }),
      { locale: "en" },
    );
    const text = textOf(html);
    expect(text).not.toMatch(CYRILLIC);
    expect(text).toContain("for 96 of 120 orders");
    expect(text).toContain("≈ Forecast");
    expect(text).toContain("Down: -3.0% · — vs the comparison period");
    expect(text).toContain("Packaging: 1");
  });
});

describe("CoverageNote", () => {
  it("Ukrainian genitive after «з M» and English plural", async () => {
    const cases: Array<[number, number, string, string]> = [
      [0, 1, "за 0 з 1 замовлення", "for 0 of 1 order"],
      [1, 2, "за 1 з 2 замовлень", "for 1 of 2 orders"],
      [18, 22, "за 18 з 22 замовлень", "for 18 of 22 orders"],
      [20, 21, "за 20 з 21 замовлення", "for 20 of 21 orders"],
      [5, 11, "за 5 з 11 замовлень", "for 5 of 11 orders"],
      [1200, 1500, "за 1 200 з 1 500 замовлень", "for 1,200 of 1,500 orders"],
    ];
    for (const [n, m, uk, en] of cases) {
      expect(visibleText(await renderUi(() => h(CoverageNote, { n, m })))).toBe(uk);
      expect(visibleText(await renderUi(() => h(CoverageNote, { n, m }), { locale: "en" }))).toBe(en);
    }
    expect(visibleText(await renderUi(() => h(CoverageNote, { n: 3, m: 4, kind: "waybills" })))).toBe("на основі 3 з 4 накладних");
    expect(visibleText(await renderUi(() => h(CoverageNote, { n: 1, m: 1, kind: "waybills" })))).toBe("на основі 1 з 1 накладної");
    expect(visibleText(await renderUi(() => h(CoverageNote, { n: 1, m: 1, kind: "waybills" }), { locale: "en" }))).toBe("based on 1 of 1 waybill");
  });

  it("completeness meter is decorative and proportional (0 for an empty base)", async () => {
    expect(coveragePercent(18, 22)).toBe(82);
    expect(coveragePercent(0, 0)).toBe(0);
    expect(coveragePercent(5, 0)).toBe(0);
    expect(coveragePercent(30, 20)).toBe(100);
    const html = await renderUi(() => h(CoverageNote, { n: 1, m: 4 }));
    expect(attr(html, /<span class="ot-coverage__meter"[^>]*>/, "aria-hidden")).toBe("true");
    expect(html).toContain('style="width:25%"');
    expect(html).toContain('data-coverage="1/4"');
  });
});
