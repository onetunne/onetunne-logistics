/**
 * Етап 6, WP0-UI: графік прибутку (§18.3) — inline SVG без бібліотек і CDN.
 * - Стовпці ≤ 24 px від нульової осі; від'ємні — нижче осі. Факт — суцільний (`--ot-chart-ink`); прогнозна частина
 *   (≈ Прогноз − факт) — через 2 px екрана (розділювач `.ot-chart__gap`, non-scaling stroke — однаково на ПК і
 *   телефоні) з діагональним штрихуванням (`<pattern>`, `--ot-chart-hatch`); порівняння — контур.
 *   Геометрія — чиста `chartGeometry` (chart-geometry.ts, BigInt над сумами).
 * - Одна вісь, 3–4 поділки `formatCompactMoney`; легенда над графіком (значки, не лише колір); підписи осі X —
 *   за рівнями ширини області графіка (`AXIS_LABEL_TIERS`, контейнерні запити CSS): без налягань від найменшої
 *   ширини рівня, ≤ 4–5 на телефоні, ≤ 12 на ПК.
 * - Доступність: SVG `role="img"` + `aria-label` (стислий опис); область графіка — ОДНА зупинка Tab (`role="group"`),
 *   стрілки вліво/вправо, Home/End переводять фокус між стовпцями (підсвітка стовпця + підказка + оголошення
 *   `aria-live`); наведення й дотик показують ту саму підказку після гідратації. Окремих маленьких кнопок немає.
 * - «Показати таблицею» — `DataTable` з ТИМИ САМИМИ числами (тест «таблиця = графік»); відсутнє — «—», прогноз — «≈».
 * - `prefers-reduced-motion`: без переходів (styles.css, розділ finance).
 */
import { useId, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useLocale } from "~/i18n";
import { formatCompactMoney } from "~/lib/format";
import { financeLabelKeys } from "~/modules/finance/core/labels";
import { DataTable, Disclosure, VisuallyHidden, cx, type DataTableColumn } from "~/ui";
import { AXIS_LABEL_TIERS, CHART_H, CHART_W, chartGeometry, nextChartIndex, type ChartHLine, type ChartRect } from "./chart-geometry";
import type { ChartBucket, ProfitChartProps } from "./contracts";
import { DASH, moneyText, parseMinor } from "./format-ui";
import { useFinanceUiT } from "./i18n";

export interface ProfitChartExtraProps {
  /** Підпис ряду порівняння в легенді й таблиці (типово «Порівняння»), напр. «Попередній період». */
  compareLabel?: string;
}

export interface ChartTableRow {
  key: string;
  label: string;
  actual: string;
  forecast: string;
  compare?: string;
}

/** Рядки «Показати таблицею» — ті самі числа, що й у графіку (відсутнє — «—», прогноз — «≈ …»). */
export function chartTableRows(buckets: readonly ChartBucket[], currency: string, locale: "uk" | "en"): ChartTableRow[] {
  const hasCompare = buckets.some((b) => b.compare !== undefined);
  return buckets.map((b) => {
    const forecast = moneyText(b.forecast, currency, locale);
    const row: ChartTableRow = {
      key: b.key,
      label: b.label,
      actual: moneyText(b.actual, currency, locale),
      forecast: forecast === DASH ? DASH : `≈ ${forecast}`,
    };
    if (hasCompare) row.compare = moneyText(b.compare ?? null, currency, locale);
    return row;
  });
}

function Rect({ r, className, fill }: { r: ChartRect | null; className: string; fill?: string }) {
  if (!r) return null;
  return <rect className={className} x={r.x} y={r.y} width={r.width} height={r.height} fill={fill} />;
}

/** Горизонтальна лінія; товщина — у CSS у px екрана (`vector-effect: non-scaling-stroke`). */
function HLine({ l, className }: { l: ChartHLine | null; className: string }) {
  if (!l) return null;
  return <line className={className} x1={l.x} x2={Math.round((l.x + l.width) * 100) / 100} y1={l.y} y2={l.y} />;
}

export function ProfitChart({ buckets, currency, tableCaption, compareLabel }: ProfitChartProps & ProfitChartExtraProps) {
  const ft = useFinanceUiT();
  const locale = useLocale();
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, "");
  const hatchId = `ot-hatch-${uid}`;
  const hintId = `ot-chart-hint-${uid}`;
  const g = chartGeometry(buckets);
  const rows = chartTableRows(buckets, currency, locale);
  const [active, setActive] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const n = buckets.length;
  const cmpLabel = compareLabel ?? ft("financeUi.chart.compare");
  const actualLabel = ft(financeLabelKeys.state("actual"));
  const forecastLabel = `≈ ${ft(financeLabelKeys.state("forecast"))}`;

  const describe = (i: number): string => {
    const row = rows[i];
    if (!row) return "";
    const parts = [`${actualLabel}: ${row.actual}`, `${forecastLabel}: ${row.forecast}`];
    if (row.compare !== undefined) parts.push(`${cmpLabel}: ${row.compare}`);
    return `${row.label}: ${parts.join("; ")}`;
  };

  // Стислий опис для role="img": кількість відрізків, межі, відомий факт, найбільший/найменший факт.
  let summary = ft("financeUi.chart.empty");
  if (n > 0) {
    summary = ft("financeUi.chart.summary", {
      title: tableCaption,
      n,
      first: buckets[0]!.label,
      last: buckets[n - 1]!.label,
      known: g.knownActual,
    });
    let maxI = -1;
    let minI = -1;
    buckets.forEach((b, i) => {
      const v = parseMinor(b.actual);
      if (v === null) return;
      if (maxI < 0 || v > parseMinor(buckets[maxI]!.actual)!) maxI = i;
      if (minI < 0 || v < parseMinor(buckets[minI]!.actual)!) minI = i;
    });
    if (maxI >= 0 && minI >= 0) {
      summary += ` ${ft("financeUi.chart.extremes", {
        max: rows[maxI]!.actual,
        maxLabel: buckets[maxI]!.label,
        min: rows[minI]!.actual,
        minLabel: buckets[minI]!.label,
      })}`;
    }
  }

  const indexAt = (e: PointerEvent<HTMLDivElement>): number | null => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || n === 0) return null;
    const i = Math.floor(((e.clientX - rect.left) / rect.width) * n);
    return Math.max(0, Math.min(n - 1, i));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = nextChartIndex(e.key, active, n);
    if (next === undefined) return;
    e.preventDefault();
    setActive(next);
  };

  const columns: Array<DataTableColumn<ChartTableRow>> = [
    { key: "label", header: ft("financeUi.chart.bucket"), render: (r) => r.label, primary: true },
    { key: "actual", header: actualLabel, render: (r) => r.actual, align: "end" },
    { key: "forecast", header: forecastLabel, render: (r) => r.forecast, align: "end" },
  ];
  if (g.hasCompare) columns.push({ key: "compare", header: cmpLabel, render: (r) => r.compare ?? DASH, align: "end" });

  const activeBar = active !== null ? g.bars[active] : undefined;
  const tooltipAlign = activeBar ? (activeBar.centerPct < 15 ? "start" : activeBar.centerPct > 85 ? "end" : "center") : "center";

  return (
    <figure className="ot-chart" data-buckets={n}>
      <ul className="ot-chart__legend">
        <li>
          <span className="ot-chart__swatch ot-chart__swatch--actual" aria-hidden="true" />
          {actualLabel}
        </li>
        <li>
          <svg className="ot-chart__swatch-svg" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
            {/* Візерунок штрихування — тут, щоб легенда й стовпці мали його й тоді, коли даних немає. */}
            <defs>
              <pattern id={hatchId} className="ot-chart__hatch" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
                <rect className="ot-chart__hatch-bg" x="0" y="0" width="6" height="6" />
                <line className="ot-chart__hatch-line" x1="0" y1="0" x2="0" y2="6" />
              </pattern>
            </defs>
            <rect className="ot-chart__forecast" x="0.5" y="0.5" width="11" height="11" fill={`url(#${hatchId})`} />
          </svg>
          {forecastLabel}
        </li>
        {g.hasCompare ? (
          <li>
            <span className="ot-chart__swatch ot-chart__swatch--compare" aria-hidden="true" />
            {cmpLabel}
          </li>
        ) : null}
      </ul>
      {g.hasData ? (
        <div className="ot-chart__frame">
          <div className="ot-chart__yaxis" aria-hidden="true">
            <span className="ot-chart__ysizer">
              {g.ticks.map((t) => (
                <span key={t.value}>{formatCompactMoney(t.value, currency, locale)}</span>
              ))}
            </span>
            {g.ticks.map((t) => (
              <span key={t.value} className={cx("ot-chart__tick", t.zero && "is-zero")} style={{ top: `${Math.round((t.y * 1_000_000) / CHART_H) / 10_000}%` }}>
                {formatCompactMoney(t.value, currency, locale)}
              </span>
            ))}
          </div>
          <div
            className={cx("ot-chart__plot", focused && "is-focused")}
            role="group"
            aria-label={tableCaption}
            aria-describedby={hintId}
            tabIndex={0}
            onKeyDown={onKeyDown}
            onFocus={() => {
              setFocused(true);
              setActive((a) => a ?? 0);
            }}
            onBlur={() => {
              setFocused(false);
              setActive(null);
            }}
            onPointerMove={(e) => {
              if (e.pointerType === "mouse") setActive(indexAt(e));
            }}
            onPointerLeave={(e) => {
              if (e.pointerType === "mouse" && !focused) setActive(null);
            }}
            onPointerDown={(e) => {
              if (e.pointerType !== "mouse") setActive(indexAt(e));
            }}
          >
            <svg
              className="ot-chart__svg"
              viewBox={`0 0 ${CHART_W} ${CHART_H}`}
              preserveAspectRatio="none"
              role="img"
              aria-label={summary}
              focusable="false"
            >
              {g.ticks.map((t) => (
                <line key={t.value} className={t.zero ? "ot-chart__axis" : "ot-chart__grid"} x1={0} x2={CHART_W} y1={t.y} y2={t.y} />
              ))}
              {activeBar ? (
                <rect
                  className="ot-chart__focus"
                  x={(activeBar.leftPct * CHART_W) / 100}
                  y={0}
                  width={(activeBar.widthPct * CHART_W) / 100}
                  height={CHART_H}
                />
              ) : null}
              {g.bars.map((b, i) => {
                const bucket = buckets[i]!;
                return (
                  <g
                    key={b.key}
                    className={cx("ot-chart__bucket", i === active && "is-active")}
                    data-key={b.key}
                    data-actual={bucket.actual ?? ""}
                    data-forecast={bucket.forecast ?? ""}
                    data-compare={bucket.compare ?? ""}
                    data-forecast-direction={b.forecastDirection ?? ""}
                  >
                    <Rect r={b.compare} className="ot-chart__compare" />
                    {/* Порядок шарів: продовження прогнозу → розділювач 2 px → факт (накриває нижню половину
                        розділювача) або факт → перекриття прогнозом → лінія рівня факту. */}
                    {b.forecastLayer === "under" ? <Rect r={b.forecastPart} className="ot-chart__forecast" fill={`url(#${hatchId})`} /> : null}
                    <HLine l={b.forecastGap} className="ot-chart__gap" />
                    <Rect r={b.actual} className="ot-chart__actual" />
                    <Rect r={b.actualZero} className="ot-chart__actual ot-chart__actual--zero" />
                    {b.forecastLayer === "over" ? <Rect r={b.forecastPart} className="ot-chart__forecast" fill={`url(#${hatchId})`} /> : null}
                    <HLine l={b.forecastCap} className="ot-chart__cap" />
                  </g>
                );
              })}
            </svg>
            {activeBar && active !== null ? (
              <div className={`ot-chart__tooltip ot-chart__tooltip--${tooltipAlign}`} style={{ left: `${activeBar.centerPct}%` }} aria-hidden="true">
                <strong>{rows[active]!.label}</strong>
                <span>{`${actualLabel}: ${rows[active]!.actual}`}</span>
                <span>{`${forecastLabel}: ${rows[active]!.forecast}`}</span>
                {rows[active]!.compare !== undefined ? <span>{`${cmpLabel}: ${rows[active]!.compare}`}</span> : null}
              </div>
            ) : null}
            <span className="ot-visually-hidden" aria-live="polite">
              {focused && active !== null ? describe(active) : ""}
            </span>
          </div>
          <div className="ot-chart__xaxis" aria-hidden="true">
            {g.bars.map((b, i) =>
              AXIS_LABEL_TIERS.some((t) => b.label[t.id]) ? (
                <span
                  key={b.key}
                  className={cx(
                    "ot-chart__xlabel",
                    ...AXIS_LABEL_TIERS.map((t) => b.label[t.id] && `is-${t.id}`),
                    i === 0 && "is-first",
                    i > 0 && i === n - 1 && "is-last",
                  )}
                  style={{ left: `${b.centerPct}%` }}
                >
                  {buckets[i]!.label}
                </span>
              ) : null,
            )}
          </div>
        </div>
      ) : (
        <p className="ot-chart__empty">{ft("financeUi.chart.empty")}</p>
      )}
      <VisuallyHidden id={hintId}>{ft("financeUi.chart.keyboard")}</VisuallyHidden>
      {n > 0 ? (
        <Disclosure className="ot-chart__table" summary={ft("financeUi.chart.showTable")}>
          <DataTable caption={tableCaption} columns={columns} rows={rows} rowKey={(r) => r.key} />
        </Disclosure>
      ) : null}
    </figure>
  );
}
