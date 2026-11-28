/**
 * Етап 6 (інтеграційний раунд ядра): контракти спільних фінансових компонентів (app/components/finance/contracts.ts)
 * збігаються з компонентами WP0-UI — додаткові пропси (explanation, deltaPreference, deltaLabel, showGranularity,
 * showCompare, granularities, extra, compareLabel, showLabel) тепер є необов'язковими полями контракту, а
 * ChartBucket.axisLabel — короткий підпис осі X (повний `label` лишається в таблиці, підказці й описі).
 */
import { createElement as h } from "react";
import { describe, expect, it } from "vitest";
import type { ChartBucket, CurrencySwitchProps, KpiTileProps, PeriodBarProps, ProfitChartProps } from "~/components/finance/contracts";
import { chartGeometry, estimateLabelWidth } from "~/components/finance/chart-geometry";
import { ProfitChart } from "~/components/finance/profit-chart";
import type { CurrencySwitchExtraProps } from "~/components/finance/currency-switch";
import type { KpiTileExtraProps } from "~/components/finance/kpi-tile";
import type { PeriodBarExtraProps } from "~/components/finance/period-bar";
import type { ProfitChartExtraProps } from "~/components/finance/profit-chart";
import { renderUi } from "../ui/render";

/** Тип-рівна перевірка: A і B взаємно присвоювані. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe("finance component contracts", () => {
  it("the WP0-UI extra props are optional contract fields (type-level)", () => {
    const checks: [
      Same<KpiTileExtraProps, Pick<KpiTileProps, "explanation" | "deltaPreference" | "deltaLabel">>,
      Same<PeriodBarExtraProps, Pick<PeriodBarProps, "showGranularity" | "showCompare" | "granularities" | "extra">>,
      Same<ProfitChartExtraProps, Pick<ProfitChartProps, "compareLabel">>,
      Same<CurrencySwitchExtraProps, Pick<CurrencySwitchProps, "showLabel">>,
    ] = [true, true, true, true];
    expect(checks).toEqual([true, true, true, true]);
    const bucket: ChartBucket = { key: "w47", label: "Тиж. 47 · 2026", axisLabel: "Т47", actual: null, forecast: null };
    expect(bucket.axisLabel).toBe("Т47");
  });

  it("ChartBucket.axisLabel is the x-axis text; the full label stays in the table and the summary", async () => {
    const buckets: ChartBucket[] = Array.from({ length: 4 }, (_, i) => ({
      key: `w${45 + i}`,
      label: `Тиждень ${45 + i} · 2026`,
      axisLabel: `Т${45 + i}`,
      actual: `${(i + 1) * 100}.00`,
      forecast: null,
    }));
    const html = await renderUi(() => h(ProfitChart, { buckets, currency: "UAH", tableCaption: "Прибуток" }));
    const axis = /<div class="ot-chart__xaxis"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
    expect(axis).toContain("Т45");
    expect(axis).not.toContain("Тиждень");
    // Таблиця «Показати таблицею» й опис role="img" — повні підписи.
    expect(html).toContain("Тиждень 45 · 2026");
    expect(html).toContain("Тиждень 48 · 2026");
    // Проріджування осі рахує ширину короткого підпису (більше підписів уміщується).
    const g = chartGeometry(buckets);
    const gFull = chartGeometry(buckets.map(({ axisLabel: _a, ...b }) => b));
    const shown = (x: typeof g) => x.bars.filter((b) => b.label.c0).length;
    expect(estimateLabelWidth("Т45")).toBeLessThan(estimateLabelWidth("Тиждень 45 · 2026"));
    expect(shown(g)).toBeGreaterThanOrEqual(shown(gFull));
  });

  it("without axisLabel the axis shows the label (unchanged behaviour)", async () => {
    const buckets: ChartBucket[] = [
      { key: "d1", label: "01.11", actual: "1.00", forecast: null },
      { key: "d2", label: "02.11", actual: "2.00", forecast: null },
    ];
    const html = await renderUi(() => h(ProfitChart, { buckets, currency: "UAH", tableCaption: "Прибуток" }));
    const axis = /<div class="ot-chart__xaxis"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
    expect(axis).toContain("01.11");
    expect(axis).toContain("02.11");
  });
});
