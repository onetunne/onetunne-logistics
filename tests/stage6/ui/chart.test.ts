/**
 * Етап 6, WP0-UI: графік прибутку (§18.3) — чиста геометрія й SSR.
 * Від'ємні — нижче нульової осі; прогнозна частина — штрихуванням над фактом через 2 px ЕКРАНА (і на телефоні, де
 * SVG стиснуто до 140 px); null — розрив (не 0); відомий нуль — позначка на осі; 3–4 поділки з нулем (2–3 інтервали);
 * підписи осі X не налягають і не обрізаються на жодній ширині (рівні за шириною підпису, ≤ 7 на телефоні);
 * `role="img"` + `aria-label`; одна зупинка Tab без маленьких кнопок; «Показати таблицею» — ТІ САМІ числа
 * (таблиця = графік); детермінований SSR.
 */
import { createElement as h } from "react";
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import {
  AXIS_LABEL_GAP,
  AXIS_LABEL_TIERS,
  CHART_H,
  CHART_PAD_Y,
  FORECAST_GAP_PX,
  FORECAST_MIN_UNITS,
  MAX_BAR_WIDTH,
  axisLabelBox,
  chartGeometry,
  estimateLabelWidth,
  nextChartIndex,
  niceTicks,
} from "~/components/finance/chart-geometry";
import type { ChartBucket } from "~/components/finance/contracts";
import { moneyText } from "~/components/finance/format-ui";
import { ProfitChart, chartTableRows } from "~/components/finance/profit-chart";
import { CYRILLIC, count, renderUi, textOf } from "./render";

const BUCKETS: ChartBucket[] = [
  { key: "d1", label: "01.11", actual: "1000.00", forecast: "1500.00" },
  { key: "d2", label: "02.11", actual: "-500.00", forecast: "-500.00" },
  { key: "d3", label: "03.11", actual: null, forecast: "800.00" },
  { key: "d4", label: "04.11", actual: "0.00", forecast: null },
  { key: "d5", label: "05.11", actual: null, forecast: null },
  { key: "d6", label: "06.11", actual: "1200.00", forecast: "900.00" },
];

describe("chartGeometry", () => {
  const g = chartGeometry(BUCKETS);
  const bar = (i: number) => g.bars[i]!;

  it("nice ticks: 3–4 ticks (2–3 intervals) of 1/2/2.5/5 × 10^k, zero always a tick", () => {
    expect(g.ticks.map((t) => t.value)).toEqual(["-1000.00", "0.00", "1000.00", "2000.00"]);
    expect(g.ticks.filter((t) => t.zero)).toHaveLength(1);
    expect(g.zeroY).toBe(130);
    expect(g.ticks[g.ticks.length - 1]!.y).toBe(CHART_PAD_Y);
    expect(g.ticks[0]!.y).toBe(CHART_H - CHART_PAD_Y);
    // Рецензія WP0-UI: −2800 … 3010 давало 5 поділок; лише нулі — 2.
    expect(chartGeometry([{ key: "a", label: "a", actual: "-2800.00", forecast: null }, { key: "b", label: "b", actual: "3010.00", forecast: null }]).ticks.map((t) => t.value)).toEqual([
      "-5000.00",
      "0.00",
      "5000.00",
    ]);
    expect(chartGeometry([{ key: "a", label: "a", actual: "0.00", forecast: null }]).ticks.map((t) => t.value)).toEqual(["-1.00", "0.00", "1.00"]);
    expect(chartGeometry([{ key: "a", label: "a", actual: "-100.00", forecast: null }, { key: "b", label: "b", actual: "4100.00", forecast: null }]).ticks.map((t) => t.value)).toEqual([
      "-2500.00",
      "0.00",
      "2500.00",
      "5000.00",
    ]);
    const spans: Array<readonly [bigint, bigint]> = [
      [0n, 123456n],
      [-99n, 1n],
      [-5000000n, 7000000n],
      [0n, 0n],
      [0n, 1n],
      [-1n, 0n],
      [-123456789n, -1n],
      [1n, 99999999999n],
      [-280000n, 301000n],
    ];
    // Детерміновані «випадкові» діапазони (LCG): лише додатні, лише від'ємні й змішані, від копійок до мільярдів.
    let seed = 20261128n;
    const next = () => (seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 63n);
    for (let i = 0; i < 400; i++) {
      const scale = 10n ** (next() % 13n);
      const a = (next() % 1000n) * scale - (i % 3 === 0 ? 0n : (next() % 1000n) * scale);
      const b = (next() % 1000n) * scale * (i % 3 === 2 ? -1n : 1n);
      spans.push(a < b ? [a, b] : [b, a]);
    }
    for (const [lo, hi] of spans) {
      const t = niceTicks(lo, hi);
      const intervals = (t.top - t.bottom) / t.step;
      expect(intervals >= 2n && intervals <= 3n, `${lo}..${hi}: ${t.bottom}/${t.top}/${t.step}`).toBe(true);
      expect((t.top - t.bottom) % t.step).toBe(0n);
      expect(t.bottom <= 0n && t.top >= 0n && t.bottom <= lo && t.top >= hi, `${lo}..${hi}`).toBe(true);
      expect(t.bottom % t.step, `${lo}..${hi}`).toBe(0n); // нуль — поділка
      expect(t.step % 100n).toBe(0n);
      expect(/^(1|2|25|5)0*$/.test((t.step / 100n).toString()), `${t.step}`).toBe(true);
    }
  });

  it("positive actual goes up from the axis, the forecast part continues it; the 2 px gap is a screen-pixel separator", () => {
    const b = bar(0);
    expect(b.actual).toMatchObject({ y: 70, height: 60 });
    expect(b.actual!.y + b.actual!.height).toBe(g.zeroY);
    // Прогнозна частина доходить до краю факту в одиницях viewBox (жодного проміжку, що масштабується) …
    expect(b.forecastPart).toMatchObject({ y: 40, height: 30 });
    expect(b.forecastPart!.y + b.forecastPart!.height).toBe(b.actual!.y);
    expect(b.forecastLayer).toBe("under");
    // … а проміжок дає розділювач на краю факту (лінія 2 × FORECAST_GAP_PX px екрана, нижня половина — під фактом).
    expect(b.forecastGap).toEqual({ x: b.actual!.x, width: b.actual!.width, y: b.actual!.y });
    expect(b.forecastDirection).toBe("up");
    expect(b.forecastCap).toBeNull();
  });

  it("the forecast gap is 2 px on the PC (200 px) and on the phone (140 px): non-scaling separator, visible hatch ≥ 1 px", () => {
    const css = fs.readFileSync("app/ui/styles.css", "utf8");
    const rule = (sel: string) => new RegExp(`${sel.replace(/[.]/g, "\\.")} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
    const gap = rule(".ot-chart__gap");
    expect(gap).toMatch(/stroke: var\(--ot-color-surface\);/);
    expect(gap).toMatch(/vector-effect: non-scaling-stroke;/);
    const strokePx = Number(/stroke-width: (\d+)px;/.exec(gap)?.[1]);
    expect(strokePx).toBe(2 * FORECAST_GAP_PX);
    const cap = rule(".ot-chart__cap");
    expect(cap).toMatch(/vector-effect: non-scaling-stroke;/);
    expect(cap).toMatch(/stroke-width: 2px;/);
    // Модель пікселів: висота SVG H px при viewBox CHART_H → масштаб H / CHART_H; non-scaling stroke — px екрана.
    for (const heightPx of [200, 140]) {
      const scale = heightPx / CHART_H;
      const b = bar(0);
      const actualTopPx = b.actual!.y * scale;
      const separator = { top: b.forecastGap!.y * scale - strokePx / 2, bottom: b.forecastGap!.y * scale + strokePx / 2 };
      // Видимий проміжок = від верху розділювача до верху факту (факт малюється поверх нижньої половини).
      expect(actualTopPx - separator.top, `${heightPx}px`).toBe(FORECAST_GAP_PX);
      expect(separator.bottom).toBeGreaterThan(actualTopPx);
      // Штрихування над розділювачем видно: його верх — рівень прогнозу.
      expect(separator.top - b.forecastPart!.y * scale).toBeGreaterThan(1);
      expect(FORECAST_MIN_UNITS * scale - FORECAST_GAP_PX, `${heightPx}px`).toBeGreaterThanOrEqual(1);
    }
    // Крихітний факт (подовжений до 1 одиниці): розділювач і прогноз — від НАМАЛЬОВАНОГО краю стовпця.
    for (const [actual, forecast] of [
      ["1.00", "500.00"],
      ["-1.00", "-500.00"],
    ] as const) {
      const t = chartGeometry([{ key: "a", label: "a", actual, forecast }, { key: "b", label: "b", actual: "2000.00", forecast: null }]).bars[0]!;
      const edge = actual.startsWith("-") ? Math.round((t.actual!.y + t.actual!.height) * 100) / 100 : t.actual!.y;
      expect(t.actual!.height, actual).toBe(1);
      expect(t.forecastGap!.y, actual).toBe(edge);
      expect(actual.startsWith("-") ? t.forecastPart!.y : t.forecastPart!.y + t.forecastPart!.height, actual).toBe(edge);
    }
    const capped = chartGeometry([{ key: "a", label: "a", actual: "1.00", forecast: "0.50" }, { key: "b", label: "b", actual: "2000.00", forecast: null }]).bars[0]!;
    expect(capped.forecastCap!.y).toBe(capped.actual!.y);
    // Крихітна прогнозна частина не зникає під розділювачем: щонайменше FORECAST_MIN_UNITS.
    const tiny = chartGeometry([{ key: "a", label: "a", actual: "1000.00", forecast: "1000.01" }]).bars[0]!;
    expect(tiny.forecastPart!.height).toBe(FORECAST_MIN_UNITS);
    expect(tiny.forecastPart!.y + tiny.forecastPart!.height).toBe(tiny.actual!.y);
  });

  it("negative actual with a more negative forecast: the forecast part continues downwards with the separator at the fact's lower edge", () => {
    const gg = chartGeometry([{ key: "a", label: "a", actual: "-500.00", forecast: "-800.00" }, { key: "b", label: "b", actual: "1000.00", forecast: null }]);
    const b = gg.bars[0]!;
    expect(b.actual!.y).toBe(gg.zeroY);
    const lower = b.actual!.y + b.actual!.height;
    expect(b.forecastPart!.y).toBe(lower);
    expect(b.forecastPart!.height).toBeGreaterThan(0);
    expect(b.forecastGap).toEqual({ x: b.actual!.x, width: b.actual!.width, y: lower });
    expect(b.forecastLayer).toBe("under");
    expect(b.forecastDirection).toBe("down");
  });

  it("negative actual is drawn below the zero axis; forecast equal to actual adds nothing", () => {
    const b = bar(1);
    expect(b.actual!.y).toBe(g.zeroY);
    expect(b.actual!.height).toBe(30);
    expect(b.forecastPart).toBeNull();
  });

  it("unknown actual with a forecast: a hatched bar from zero, no solid bar", () => {
    const b = bar(2);
    expect(b.actual).toBeNull();
    expect(b.actualZero).toBeNull();
    expect(b.forecastPart).toMatchObject({ y: 82, height: 48 });
    expect(b.forecastPart!.y + b.forecastPart!.height).toBe(g.zeroY);
    expect(b.forecastGap).toBeNull();
  });

  it("a known zero is a thin mark on the axis; null is a gap (nothing drawn, never 0)", () => {
    expect(bar(3).actual).toBeNull();
    expect(bar(3).actualZero).toMatchObject({ height: 1.5 });
    expect(bar(4)).toMatchObject({ actual: null, actualZero: null, forecastPart: null, compare: null });
  });

  it("forecast lower than actual: the hatched part overlaps the top of the fact bar and a cap marks the fact level", () => {
    const b = bar(5);
    expect(b.actual).toMatchObject({ y: 58, height: 72 });
    expect(b.forecastPart).toMatchObject({ y: 58, height: 18 });
    expect(b.forecastLayer).toBe("over");
    expect(b.forecastDirection).toBe("down");
    expect(b.forecastCap).toEqual({ x: b.actual!.x, width: b.actual!.width, y: 58 });
    expect(b.forecastGap).toBeNull();
  });

  it("bars are at most 24 px wide (view units ≤ CSS px: the view box is not narrower than the page)", () => {
    for (const n of [1, 3, 7, 30, 366]) {
      const gg = chartGeometry(Array.from({ length: n }, (_, i) => ({ key: `k${i}`, label: `${i}`, actual: "10.00", forecast: null })));
      for (const b of gg.bars) expect(b.actual!.width).toBeLessThanOrEqual(MAX_BAR_WIDTH);
      const withCompare = chartGeometry(Array.from({ length: n }, (_, i) => ({ key: `k${i}`, label: `${i}`, actual: "10.00", forecast: null, compare: "5.00" })));
      for (const b of withCompare.bars) {
        expect(b.actual!.width).toBeLessThanOrEqual(MAX_BAR_WIDTH);
        expect(b.compare!.x + b.compare!.width).toBeLessThanOrEqual(b.actual!.x);
      }
    }
  });

  it("label width estimate is never below the width measured in Chrome (Inter, 11 px — the widest common UI font)", () => {
    const measured: Array<[string, number]> = [
      ["Тиж. 15 · 2026", 75.86],
      ["Тиж. 1 · 2026", 69.17],
      ["Wk 15 · 2026", 67.67],
      ["01.2026", 41.77],
      ["11.2026", 39.3],
      ["27.11", 22.73],
      ["27.11.2026", 53.08],
      ["2026", 27.19],
      ["лист. 2026", 57.0],
      ["Nov 2026", 51.13],
      ["ШШШШШШШШШШ", 105.33],
      ["WWWWWWWWWW", 110.81],
      ["0123456789", 65.23],
    ];
    for (const [label, px] of measured) expect(estimateLabelWidth(label), label).toBeGreaterThanOrEqual(px);
  });

  it("axis labels never overlap or clip at any width of a tier (weeks, months, days, uk/en); ≤ tier limit, ≤ 7 on phones", () => {
    const pad = (v: number) => String(v).padStart(2, "0");
    const sets: Record<string, string[]> = {
      weeksUk: Array.from({ length: 53 }, (_, i) => `Тиж. ${i + 1} · 2026`),
      weeksEn: Array.from({ length: 53 }, (_, i) => `Wk ${i + 1} · 2026`),
      months: Array.from({ length: 12 }, (_, i) => `${pad(i + 1)}.2026`),
      days: Array.from({ length: 31 }, (_, i) => `${pad(i + 1)}.10`),
      days366: Array.from({ length: 366 }, (_, i) => `${pad((i % 28) + 1)}.${pad((i % 12) + 1)}`),
      years: ["2022", "2023", "2024", "2025", "2026"],
      one: ["Тиж. 47 · 2026"],
      two: ["10.2026", "11.2026"],
      seven: Array.from({ length: 7 }, (_, i) => `${pad(i + 21)}.11`),
    };
    // Найбільша ширина області графіка в рівні — до межі наступного (останній — до 1400 px).
    const upper = (i: number) => (AXIS_LABEL_TIERS[i + 1]?.minWidth ?? 1401) - 1;
    for (const [name, labels] of Object.entries(sets)) {
      const n = labels.length;
      const gg = chartGeometry(labels.map((label, i) => ({ key: `k${i}`, label, actual: `${i}.00`, forecast: null })));
      const labelW = Math.max(...labels.map(estimateLabelWidth));
      AXIS_LABEL_TIERS.forEach((tier, ti) => {
        const shown = gg.bars.filter((b) => b.label[tier.id]).map((b) => b.index);
        expect(shown[0], `${name} ${tier.id}`).toBe(0);
        expect(shown.length, `${name} ${tier.id}`).toBeLessThanOrEqual(tier.limit);
        for (const width of [tier.width, Math.round((tier.width + upper(ti)) / 2), upper(ti)]) {
          const boxes = shown.map((i) => axisLabelBox(i, n, labelW, width));
          boxes.forEach((box, k) => {
            const where = `${name} ${tier.id} @${width}px #${shown[k]}`;
            expect(box.left, where).toBeGreaterThanOrEqual(0);
            expect(box.right, where).toBeLessThanOrEqual(width + 1e-9);
            if (k > 0) expect(box.left - boxes[k - 1]!.right, where).toBeGreaterThanOrEqual(AXIS_LABEL_GAP - 1e-9);
          });
        }
      });
    }
    // Телефон 320–390 px: область графіка < 360 px → рівні c0 / c1, щонайбільше 7 підписів (§18.3).
    for (const tier of AXIS_LABEL_TIERS.filter((t) => t.minWidth < 360)) expect(tier.limit).toBeLessThanOrEqual(7);
    // Тижні на телефоні (рецензія WP0-UI: «Тиж. 1Тиж. 15 · 2026…» налягали): на 150 px — лише перший підпис.
    const weeks = chartGeometry(sets.weeksUk!.map((label, i) => ({ key: `k${i}`, label, actual: "1.00", forecast: null })));
    expect(weeks.bars.filter((b) => b.label.c0).map((b) => b.index)).toEqual([0]);
    expect(weeks.bars.filter((b) => b.label.c3).length).toBeGreaterThan(1);
  });

  it("the CSS container tiers match AXIS_LABEL_TIERS (c0 also the fallback without container queries)", () => {
    const css = fs.readFileSync("app/ui/styles.css", "utf8");
    expect(css).toMatch(/\.ot-chart__xaxis \{[^}]*container: ot-chart-xaxis \/ inline-size;/);
    expect(css).toMatch(/\n\.ot-chart__xlabel\.is-c0 \{\s*display: block;\s*\}/);
    AXIS_LABEL_TIERS.forEach((tier, i) => {
      if (i === 0) return;
      const prev = AXIS_LABEL_TIERS[i - 1]!;
      const block = new RegExp(
        `@container ot-chart-xaxis \\(min-width: ${tier.minWidth}px\\) \\{\\s*\\.ot-chart__xlabel\\.is-${prev.id} \\{\\s*display: none;\\s*\\}\\s*\\.ot-chart__xlabel\\.is-${tier.id} \\{\\s*display: block;\\s*\\}\\s*\\}`,
      );
      expect(css, tier.id).toMatch(block);
    });
    expect(css).not.toMatch(/\.ot-chart__xlabel\.is-(sm|md|lg)/);
  });

  it("no data at all → hasData false; amounts are parsed exactly (BigInt), invalid strings are unknown", () => {
    expect(chartGeometry([{ key: "a", label: "a", actual: null, forecast: null }]).hasData).toBe(false);
    expect(chartGeometry([{ key: "a", label: "a", actual: "1.234", forecast: "x" }]).hasData).toBe(false);
    const huge = chartGeometry([
      { key: "a", label: "a", actual: "999999999999.99", forecast: null },
      { key: "b", label: "b", actual: "999999999999.98", forecast: null },
    ]);
    expect(huge.bars[0]!.actual!.height).toBeGreaterThan(0);
    expect(huge.bars[0]!.actual!.height).toBeGreaterThanOrEqual(huge.bars[1]!.actual!.height);
  });

  it("keyboard: arrows move one column, Home/End jump, Escape hides, others are ignored", () => {
    expect(nextChartIndex("ArrowRight", 0, 6)).toBe(1);
    expect(nextChartIndex("ArrowRight", 5, 6)).toBe(5);
    expect(nextChartIndex("ArrowLeft", 0, 6)).toBe(0);
    expect(nextChartIndex("ArrowLeft", 3, 6)).toBe(2);
    expect(nextChartIndex("ArrowDown", null, 6)).toBe(0);
    expect(nextChartIndex("Home", 4, 6)).toBe(0);
    expect(nextChartIndex("End", 0, 6)).toBe(5);
    expect(nextChartIndex("Escape", 2, 6)).toBeNull();
    expect(nextChartIndex("a", 2, 6)).toBeUndefined();
    expect(nextChartIndex("ArrowRight", 0, 0)).toBeUndefined();
  });
});

/** Значення комірок DataTable за рядками: [мітка, …значення]. */
function tableRows(html: string): string[][] {
  const tbody = /<tbody>([\s\S]*?)<\/tbody>/.exec(html)?.[1] ?? "";
  return [...tbody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((tr) => {
    const label = /<th[^>]*>([\s\S]*?)<\/th>/.exec(tr[1]!)?.[1] ?? "";
    const values = [...tr[1]!.matchAll(/<span class="ot-dt__value">([\s\S]*?)<\/span>/g)].map((m) => textOf(m[1]!));
    return [textOf(label), ...values];
  });
}

describe("ProfitChart SSR", () => {
  it("role=img with a summary, legend with icons, hatch pattern, one Tab stop and no small buttons", async () => {
    const html = await renderUi(() => h(ProfitChart, { buckets: BUCKETS, currency: "UAH", tableCaption: "Прибуток за днями" }));
    expect(html).toMatch(/<svg class="ot-chart__svg"[^>]*role="img"[^>]*aria-label="Прибуток за днями: 6 відрізків, 01\.11 – 06\.11; факт відомий для 4\./);
    expect(textOf(html.replace(/aria-label="([^"]*)"/g, (_m, a: string) => `>${a}<`))).toContain(
      "Найбільший факт — 1 200,00 грн (06.11), найменший — -500,00 грн (02.11).",
    );
    expect(html).toMatch(/<pattern id="ot-hatch-[A-Za-z0-9_-]+"/);
    const hatchId = /<pattern id="(ot-hatch-[A-Za-z0-9_-]+)"/.exec(html)![1]!;
    expect(count(html, `fill="url(#${hatchId})"`)).toBe(1 /* легенда */ + 3 /* d1, d3, d6 */);
    expect(textOf(/<ul class="ot-chart__legend">[\s\S]*?<\/ul>/.exec(html)![0])).toBe("Факт ≈ Прогноз");
    expect(count(html, 'tabindex="0"')).toBe(1);
    expect(html).toMatch(/class="ot-chart__plot"[^>]*role="group"[^>]*aria-label="Прибуток за днями"/);
    expect(html).not.toContain("<button");
    // Вісь: поділки formatCompactMoney.
    expect(textOf(/<div class="ot-chart__yaxis"[\s\S]*?<\/div>/.exec(html)![0])).toContain("2 тис. грн");
    expect(count(html, 'class="ot-chart__actual"')).toBe(3);
    expect(count(html, "ot-chart__actual--zero")).toBe(1);
    expect(count(html, '<line class="ot-chart__cap"')).toBe(1);
    expect(count(html, '<line class="ot-chart__gap"')).toBe(1);
    // Порядок шарів: продовження прогнозу → розділювач → факт; перекриття: факт → прогноз → рівень факту.
    const group = (key: string) => new RegExp(`<g class="ot-chart__bucket[^"]*" data-key="${key}"[^>]*>([\\s\\S]*?)</g>`).exec(html)![1]!;
    const layers = (key: string) => [...group(key).matchAll(/<(?:rect|line) class="(ot-chart__[a-z_-]+)/g)].map((m) => m[1]);
    expect(layers("d1")).toEqual(["ot-chart__forecast", "ot-chart__gap", "ot-chart__actual"]);
    expect(layers("d6")).toEqual(["ot-chart__actual", "ot-chart__forecast", "ot-chart__cap"]);
    expect(layers("d3")).toEqual(["ot-chart__forecast"]);
    // Підписи осі X: перший і останній притиснуті до країв (не обрізаються), рівні видимості за шириною області.
    const labels = [...html.matchAll(/<span class="ot-chart__xlabel([^"]*)"[^>]*>([^<]+)<\/span>/g)].map((m) => [m[2], m[1]!.trim()]);
    expect(labels).toEqual([
      ["01.11", "is-c0 is-c1 is-c2 is-c3 is-c4 is-c5 is-first"],
      ["02.11", "is-c2 is-c3 is-c4 is-c5"],
      ["03.11", "is-c1 is-c2 is-c3 is-c4 is-c5"],
      ["04.11", "is-c0 is-c2 is-c3 is-c4 is-c5"],
      ["05.11", "is-c1 is-c2 is-c3 is-c4 is-c5"],
      ["06.11", "is-c0 is-c2 is-c3 is-c4 is-c5 is-last"],
    ]);
  });

  it("«Show as a table» has exactly the chart's numbers (table = chart), «—» for unknown, «≈» for forecast", async () => {
    const html = await renderUi(() => h(ProfitChart, { buckets: BUCKETS, currency: "UAH", tableCaption: "Прибуток за днями" }));
    expect(html).toContain("Показати таблицею");
    const rows = tableRows(html);
    expect(rows).toEqual([
      ["01.11", "1 000,00 грн", "≈ 1 500,00 грн"],
      ["02.11", "-500,00 грн", "≈ -500,00 грн"],
      ["03.11", "—", "≈ 800,00 грн"],
      ["04.11", "0,00 грн", "—"],
      ["05.11", "—", "—"],
      ["06.11", "1 200,00 грн", "≈ 900,00 грн"],
    ]);
    // Ті самі значення лежать у data-атрибутах стовпців графіка.
    const groups = [...html.matchAll(/<g class="ot-chart__bucket[^"]*" data-key="([^"]+)" data-actual="([^"]*)" data-forecast="([^"]*)"/g)];
    expect(groups).toHaveLength(BUCKETS.length);
    groups.forEach((m, i) => {
      expect(m[1]).toBe(BUCKETS[i]!.key);
      expect(textOf(moneyText(m[2] || null, "UAH", "uk"))).toBe(rows[i]![1]);
      const f = textOf(moneyText(m[3] || null, "UAH", "uk"));
      expect(f === "—" ? f : `≈ ${f}`).toBe(rows[i]![2]);
    });
    expect(chartTableRows(BUCKETS, "UAH", "uk").map((r) => [r.label, textOf(r.actual), textOf(r.forecast)])).toEqual(rows);
  });

  it("comparison series: outline bars, legend entry with the caller's label, table column", async () => {
    const buckets = BUCKETS.slice(0, 2).map((b, i) => ({ ...b, compare: i === 0 ? "700.00" : null }));
    const html = await renderUi(() =>
      h(ProfitChart, { buckets, currency: "EUR", tableCaption: "Profit by day", compareLabel: "Previous period" }),
      { locale: "en" },
    );
    expect(count(html, 'class="ot-chart__compare"')).toBe(1);
    expect(textOf(/<ul class="ot-chart__legend">[\s\S]*?<\/ul>/.exec(html)![0])).toBe("Actual ≈ Forecast Previous period");
    expect(tableRows(html)).toEqual([
      ["01.11", "€1,000.00", "≈ €1,500.00", "€700.00"],
      ["02.11", "-€500.00", "≈ -€500.00", "—"],
    ]);
    expect(textOf(html).replace(/01\.11|02\.11/g, "")).not.toMatch(CYRILLIC);
  });

  it("empty periods: «No data» text instead of an empty chart (no table for zero buckets)", async () => {
    const none = await renderUi(() => h(ProfitChart, { buckets: [], currency: "UAH", tableCaption: "Прибуток" }));
    expect(textOf(none)).toContain("Немає даних за цей період");
    expect(none).not.toContain("ot-chart__svg");
    expect(none).not.toContain("Показати таблицею");
    const unknown = await renderUi(() =>
      h(ProfitChart, { buckets: [{ key: "a", label: "01.11", actual: null, forecast: null }], currency: "UAH", tableCaption: "Прибуток" }),
    );
    expect(textOf(unknown)).toContain("Немає даних за цей період");
    expect(tableRows(unknown)).toEqual([["01.11", "—", "—"]]);
    expect(unknown).not.toMatch(/0,00/);
  });

  it("SSR is deterministic and English has no Cyrillic in the component's own texts", async () => {
    const make = () => h(ProfitChart, { buckets: BUCKETS, currency: "USD", tableCaption: "Profit" });
    const a = await renderUi(make, { locale: "en" });
    const b = await renderUi(make, { locale: "en" });
    expect(a).toBe(b);
    expect(textOf(a)).not.toMatch(CYRILLIC);
    expect(a).toContain("Show as a table");
    expect(a).toContain("US$1,000.00");
  });
});
