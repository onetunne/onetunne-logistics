/**
 * Етап 6, WP0-UI: розбивка витрат (BreakdownBars) і міні-графік (Sparkline) — §18.3.
 * Частка чистої виручки — точно (BigInt, 1 знак, половина від нуля); відсутнє — «—» без смуги (не 0); прогноз —
 * штрихування й «≈»; від'ємне — контур; міні-графік: null — розрив лінії, не нуль.
 */
import { createElement as h } from "react";
import { describe, expect, it } from "vitest";
import { BreakdownBars } from "~/components/finance/breakdown-bars";
import { barPercent, formatDateRange, formatMonth, parseMinor, sharePercent, signOf, signedMoneyText, signedPercentText } from "~/components/finance/format-ui";
import { Sparkline, sparklineGeometry } from "~/components/finance/sparkline";
import { CYRILLIC, count, renderUi, textOf } from "./render";

describe("format helpers", () => {
  it("parseMinor never turns unknown into zero", () => {
    expect(parseMinor("12.30")).toBe(1230n);
    expect(parseMinor("-0.05")).toBe(-5n);
    expect(parseMinor("0.00")).toBe(0n);
    for (const bad of [null, undefined, "", " ", "1.234", "1e3", "abc", "1,5"]) expect(parseMinor(bad as never)).toBeNull();
  });

  it("sharePercent is exact (BigInt) with one decimal, half away from zero; total ≤ 0 → null", () => {
    expect(sharePercent("62000.00", "177000.00")).toBe("35.0");
    expect(sharePercent("1.00", "3.00")).toBe("33.3");
    expect(sharePercent("2.00", "3.00")).toBe("66.7");
    expect(sharePercent("0.05", "100.00")).toBe("0.1"); // 0,05 % → 0,1 (половина від нуля)
    expect(sharePercent("-0.05", "100.00")).toBe("-0.1");
    expect(sharePercent("0.04", "100.00")).toBe("0.0");
    expect(sharePercent("10.00", "0.00")).toBeNull();
    expect(sharePercent("10.00", "-5.00")).toBeNull();
    expect(sharePercent(null, "100.00")).toBeNull();
    expect(sharePercent("10.00", null)).toBeNull();
  });

  it("bar widths are proportional to the largest |value|, a non-zero value is always visible", () => {
    expect(barPercent(50n, 100n)).toBe(50);
    expect(barPercent(-100n, 100n)).toBe(100);
    expect(barPercent(1n, 100000n)).toBe(1);
    expect(barPercent(0n, 100n)).toBe(0);
    expect(barPercent(null, 100n)).toBe(0);
    expect(barPercent(5n, 0n)).toBe(0);
  });

  it("signs, signed texts, date ranges and months", () => {
    expect(signOf("12.0")).toBe(1);
    expect(signOf("-0.0")).toBe(0);
    expect(signOf("+3")).toBe(1);
    expect(signOf("x")).toBeNull();
    expect(signedPercentText("12.0", "uk")).toBe("+12,0 %");
    expect(signedPercentText("-3.0", "en")).toBe("-3.0%");
    expect(signedPercentText(null, "en")).toBe("—");
    expect(signedMoneyText("19500.00", "UAH", "uk")).toBe("+19 500,00 грн");
    expect(signedMoneyText("0.00", "EUR", "en")).toBe("€0.00");
    expect(signedMoneyText(null, "EUR", "en")).toBe("—");
    expect(formatDateRange({ from: "2026-11-01", to: "2026-11-27" }, "uk")).toBe("01–27.11.2026");
    expect(formatDateRange({ from: "2026-10-02", to: "2026-11-27" }, "uk")).toBe("02.10–27.11.2026");
    expect(formatDateRange({ from: "2025-12-30", to: "2026-01-02" }, "en")).toBe("30/12/2025 – 02/01/2026");
    expect(formatDateRange({ from: "2026-11-28", to: "2026-11-28" }, "en")).toBe("28/11/2026");
    expect(formatMonth("2026-10-01", "uk")).toBe("10.2026");
    expect(formatMonth("2026-10-01", "en")).toBe("10/2026");
  });
});

describe("BreakdownBars", () => {
  const rows = [
    { key: "cogs", label: "Собівартість", value: "62000.00", state: "actual" as const },
    { key: "shipping", label: "Доставка", value: "3200.00", state: "forecast" as const },
    { key: "fees", label: "Комісії", value: null, state: "missing" as const },
    { key: "fx", label: "Курсові різниці", value: "-310.00" },
  ];

  it("rows: amount, exact share of net revenue, bars; forecast hatched with «≈», missing «—» without a bar", async () => {
    const html = await renderUi(() => h(BreakdownBars, { rows, currency: "UAH", total: "177000.00" }));
    const text = textOf(html);
    expect(text).toContain("% чистої виручки");
    expect(text).toContain("Собівартість 62 000,00 грн 35,0 %");
    expect(text).toContain("Доставка ≈ 3 200,00 грн 1,8 %");
    expect(text).toContain("Комісії — — Немає даних");
    expect(text).toContain("Курсові різниці -310,00 грн -0,2 %");
    expect(text).toContain("Частки — від чистої виручки 177 000,00 грн.");
    expect(html).toContain('style="width:100%"');
    expect(html).toMatch(/is-forecast[^>]*data-key="shipping"/);
    expect(html).toMatch(/is-negative[^>]*data-key="fx"/);
    expect(html).toMatch(/is-missing[^>]*data-key="fees"/);
    // Рядок без значення не має смуги; значки стану — лише для не-фактичних.
    const fees = /data-key="fees"[\s\S]*?<\/li>/.exec(html)![0];
    expect(fees).not.toContain("ot-breakdown__bar");
    expect(count(html, "ot-state ")).toBe(2);
    expect(html).not.toMatch(/>0,00/);
  });

  it("total undefined → no share column; total unknown or ≤ 0 → shares «—» with an explanation", async () => {
    const none = await renderUi(() => h(BreakdownBars, { rows: rows.slice(0, 1), currency: "UAH" }));
    expect(none).not.toContain("ot-breakdown__share");
    expect(textOf(none)).not.toContain("%");
    const unknown = await renderUi(() => h(BreakdownBars, { rows: rows.slice(0, 1), currency: "UAH", total: null }));
    expect(textOf(unknown)).toContain("Собівартість 62 000,00 грн —");
    expect(textOf(unknown)).toContain("Частки не пораховано");
    const zero = await renderUi(() => h(BreakdownBars, { rows: rows.slice(0, 1), currency: "UAH", total: "0.00" }));
    expect(textOf(zero)).toContain("Частки не пораховано");
  });

  it("English has no Cyrillic in the component's own texts", async () => {
    const html = await renderUi(
      () => h(BreakdownBars, { rows: [{ key: "a", label: "Shipping", value: "15.00", state: "partial" }], currency: "EUR", total: "100.00" }),
      { locale: "en" },
    );
    expect(textOf(html)).not.toMatch(CYRILLIC);
    expect(textOf(html)).toContain("% of net revenue");
    expect(textOf(html)).toContain("Shipping €15.00 15.0%");
  });
});

describe("Sparkline", () => {
  it("null breaks the line (gap), a lone point becomes a dot, a zero line appears when signs differ", () => {
    const g = sparklineGeometry([
      { key: "1", value: "10.00" },
      { key: "2", value: "20.00" },
      { key: "3", value: null },
      { key: "4", value: "-5.00" },
      { key: "5", value: null },
      { key: "6", value: "15.00" },
      { key: "7", value: "0.00" },
    ]);
    expect(g.segments).toHaveLength(2);
    expect(g.segments[0]).toHaveLength(2);
    expect(g.segments[1]).toHaveLength(2);
    expect(g.dots).toHaveLength(1);
    expect(g.known).toBe(5);
    expect(g.zeroY).not.toBeNull();
    // 0,00 — справжня точка (відомий нуль) на нульовій лінії.
    expect(g.segments[1]![1]!.y).toBe(g.zeroY);
    expect(sparklineGeometry([{ key: "a", value: null }])).toEqual({ segments: [], dots: [], zeroY: null, known: 0 });
  });

  it("SSR: role=img with the caller's label, polylines only for known runs", async () => {
    const html = await renderUi(() =>
      h(Sparkline, {
        label: "Оборот за 30 днів",
        points: [
          { key: "1", value: "1.00" },
          { key: "2", value: "2.00" },
          { key: "3", value: null },
          { key: "4", value: "3.00" },
        ],
      }),
    );
    expect(html).toMatch(/<svg class="ot-sparkline"[^>]*role="img"[^>]*aria-label="Оборот за 30 днів"/);
    expect(count(html, "<polyline")).toBe(1);
    expect(count(html, "<circle")).toBe(1);
  });
});
