/**
 * Етап 6, WP0-UI: сума (MoneyValue) і бейдж стану (StateBadge) — §2.6, F4, F5, §18.9.
 * Відсутнє = «—» (НІКОЛИ «0,00»), відомий нуль — «0,00 грн»; прогноз — «≈» і «Прогноз»; початкові суми підрядком;
 * підказка курсу; стан — значок + текст (не лише колір) для кожного стану трьох родин; SSR детермінований; en — без
 * кирилиці.
 */
import { createElement as h } from "react";
import { describe, expect, it } from "vitest";
import { COMPONENT_STATES, FINANCE_BASES, MISSING_REASONS, ORDER_FINANCE_STATES, PROFIT_STATES } from "~/domain/finance";
import { MoneyValue } from "~/components/finance/money-value";
import { StateBadge, stateLabelKey } from "~/components/finance/state-badge";
import { STATE_PRESENTATION } from "~/components/finance/icons";
import { DICTIONARIES } from "~/i18n";
import { CYRILLIC, count, renderUi, textOf, visibleText } from "./render";

describe("MoneyValue", () => {
  it("null and unparsable values render «—» with a screen-reader «No data», never 0", async () => {
    for (const value of [null, { amount: "", currency: "UAH" }, { amount: "abc", currency: "UAH" }, { amount: "1.234", currency: "UAH" }]) {
      const html = await renderUi(() => h(MoneyValue, { value }));
      expect(visibleText(html)).toBe("—");
      expect(textOf(html)).toContain("Немає даних");
      expect(html).not.toMatch(/0,00/);
      expect(html).toContain("ot-money--missing");
    }
  });

  it("a known zero is shown as 0,00 грн (not «—»)", async () => {
    const html = await renderUi(() => h(MoneyValue, { value: { amount: "0.00", currency: "UAH" }, state: "zero_confirmed" }));
    expect(visibleText(html)).toBe("0,00 грн 0 (підтверджено)");
  });

  it("forecast flag and forecast state both add «≈» and the «Forecast» label (F5)", async () => {
    const a = visibleText(await renderUi(() => h(MoneyValue, { value: { amount: "520.00", currency: "UAH" }, forecast: true })));
    expect(a).toBe("≈ 520,00 грн Прогноз");
    const b = visibleText(await renderUi(() => h(MoneyValue, { value: { amount: "520.00", currency: "UAH" }, state: "forecast" })));
    expect(b).toBe("≈ 520,00 грн Прогноз");
    // Без числа «≈» не ставиться, підпис стану лишається.
    const c = visibleText(await renderUi(() => h(MoneyValue, { value: null, forecast: true })));
    expect(c).toBe("— Прогноз");
  });

  it("shows original amounts as a sub-line and skips a duplicate single original in the same currency", async () => {
    const html = await renderUi(() =>
      h(MoneyValue, {
        value: { amount: "6256.50", currency: "UAH" },
        original: [
          { amount: "129.00", currency: "EUR" },
          { amount: "-45.00", currency: "EUR" },
        ],
        state: "actual",
      }),
    );
    expect(visibleText(html)).toBe("6 256,50 грн Факт 129,00 EUR · -45,00 EUR");
    expect(textOf(html)).toContain("У валюті запису:");
    const same = visibleText(
      await renderUi(() => h(MoneyValue, { value: { amount: "21.00", currency: "UAH" }, original: [{ amount: "21.00", currency: "UAH" }] })),
    );
    expect(same).toBe("21,00 грн");
  });

  it("rate hint: NBU / manual / demo with date, fallback is marked, base (UAH) has no hint", async () => {
    const nbu = visibleText(
      await renderUi(() => h(MoneyValue, { value: { amount: "100.00", currency: "UAH" }, rate: { rateDate: "2026-11-20", source: "nbu", fallback: false } })),
    );
    expect(nbu).toBe("100,00 грн Курс НБУ на 20.11.2026");
    const fallback = visibleText(
      await renderUi(() => h(MoneyValue, { value: { amount: "100.00", currency: "UAH" }, rate: { rateDate: "2026-11-20", source: "manual", fallback: true } })),
    );
    expect(fallback).toContain("Курс вручну за 20.11.2026 (запасний");
    const base = visibleText(
      await renderUi(() => h(MoneyValue, { value: { amount: "100.00", currency: "UAH" }, rate: { rateDate: "2026-11-20", source: "base", fallback: false } })),
    );
    expect(base).toBe("100,00 грн");
    const en = visibleText(
      await renderUi(() => h(MoneyValue, { value: { amount: "100.00", currency: "EUR" }, rate: { rateDate: "2026-11-20", source: "demo", fallback: false } }), {
        locale: "en",
      }),
    );
    expect(en).toBe("€100.00 Demo rate for 20/11/2026");
  });

  it("strong emphasis, negative amounts and deterministic SSR", async () => {
    const make = () => h(MoneyValue, { value: { amount: "-1576.40", currency: "UAH" }, emphasis: "strong" });
    const one = await renderUi(make);
    const two = await renderUi(make);
    expect(one).toBe(two);
    expect(one).toContain("ot-money--strong");
    expect(visibleText(one)).toBe("-1 576,40 грн");
  });

  it("English output has no Cyrillic", async () => {
    const html = await renderUi(
      () => h(MoneyValue, { value: null, state: "missing", original: [{ amount: "12.00", currency: "PLN" }], rate: { rateDate: "2026-11-01", source: "nbu", fallback: true } }),
      { locale: "en" },
    );
    expect(textOf(html)).not.toMatch(CYRILLIC);
  });
});

describe("StateBadge", () => {
  const ALL = [...COMPONENT_STATES, ...PROFIT_STATES, ...ORDER_FINANCE_STATES] as const;

  it("every state of the three families has an icon, a tone and uk/en labels", async () => {
    for (const state of ALL) {
      expect(STATE_PRESENTATION[state], state).toBeDefined();
      const key = stateLabelKey(state);
      expect(DICTIONARIES.uk[key], key).toBeTruthy();
      expect(DICTIONARIES.en[key], key).toBeTruthy();
      for (const locale of ["uk", "en"] as const) {
        const html = await renderUi(() => h(StateBadge, { state }), { locale });
        expect(html, state).toMatch(/<svg[^>]*data-icon="[a-z]+"/);
        expect(html).toContain(`data-state="${state}"`);
        expect(textOf(html)).toBe(DICTIONARIES[locale][key]);
        if (locale === "en") expect(textOf(html)).not.toMatch(CYRILLIC);
      }
    }
  });

  it("component states win over same-named codes; profit «n/a» uses the na key", () => {
    expect(stateLabelKey("actual")).toBe("finance.state.actual");
    expect(stateLabelKey("open")).toBe("finance.orderState.open");
    expect(stateLabelKey("final")).toBe("finance.profitState.final");
    expect(stateLabelKey("n/a")).toBe("finance.profitState.na");
  });

  it("not colour alone: missing and actual differ by icon and text, not only by tone", async () => {
    const missing = await renderUi(() => h(StateBadge, { state: "missing", reason: "no_invoice" }));
    const actual = await renderUi(() => h(StateBadge, { state: "actual", basis: "invoice" }));
    expect(missing).toContain('data-icon="warning"');
    expect(actual).toContain('data-icon="check"');
    expect(visibleText(missing)).toBe("Немає даних Немає рахунку перевізника");
    expect(visibleText(actual)).toBe("Факт Рахунок перевізника");
    expect(missing).toContain("ot-badge--warning");
    expect(actual).toContain("ot-badge--success");
  });

  it("reason and basis are shown next to the badge and in its title", async () => {
    const html = await renderUi(() => h(StateBadge, { state: "forecast", basis: "country_average", size: "md" }));
    expect(html).toContain('title="Прогноз · Середня фактична до країни"');
    expect(html).toContain("ot-badge--md");
    expect(count(html, "ot-state__detail")).toBe(1);
    for (const reason of MISSING_REASONS) {
      const text = visibleText(await renderUi(() => h(StateBadge, { state: "missing", reason }), { locale: "en" }));
      expect(text).not.toMatch(CYRILLIC);
      expect(text.startsWith("No data ")).toBe(true);
    }
    for (const basis of FINANCE_BASES) expect(DICTIONARIES.en[`finance.basis.${basis}`], basis).toBeTruthy();
  });
});
