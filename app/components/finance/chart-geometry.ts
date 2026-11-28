/**
 * Етап 6, WP0-UI: чиста геометрія графіка прибутку (§18.3) — без React, детерміновано для SSR і браузера.
 * Значення — десяткові рядки сум; масштаб рахується в мінорних одиницях BigInt (без float над грошима), у float —
 * лише координати пікселів. Правила:
 * - стовпці від нульової осі: додатні — вгору, ВІД'ЄМНІ — нижче осі;
 * - факт — суцільний стовпець; прогнозна частина (≈ Прогноз − факт) — окремий заштрихований відрізок, що продовжує
 *   стовпець; між ними — розділювач рівно 2 px ЕКРАНА (`forecastGap`: лінія кольору поверхні з `vector-effect:
 *   non-scaling-stroke`, товщина 4 px, нижня половина під стовпцем факту), бо SVG масштабується
 *   `preserveAspectRatio="none"` (200 px на ПК, 140 px на телефоні) і проміжок в одиницях viewBox був би 1,4 px;
 *   якщо прогноз ближчий до нуля, ніж факт (прогнозна частина зменшує результат), заштрихований відрізок перекриває
 *   верх стовпця факту, а рівень факту позначено лінією 2 px екрана (`forecastCap`);
 * - факт невідомий (null), прогноз є — заштрихований стовпець від нуля; відомий нуль — тонка позначка на осі;
 *   null — нічого (розрив), НІКОЛИ не 0;
 * - порівняння — контур поруч;
 * - 3–4 поділки (2–3 інтервали) «гарного» кроку 1 / 2 / 2,5 / 5 × 10^k (не менше 1 одиниці валюти), нуль — завжди
 *   поділка; лише нулі — −1 / 0 / 1;
 * - підписи осі X проріджуються за ШИРИНОЮ підпису (оцінка `estimateLabelWidth`) і ширини області графіка — рівні
 *   `AXIS_LABEL_TIERS` (контейнерні запити CSS `.ot-chart__xaxis`), а не лише за кількістю: підписи не налягають і не
 *   обрізаються від найменшої ширини рівня; перший / останній притиснуті до країв.
 */
import type { ChartBucket } from "./contracts";
import { parseMinor } from "./format-ui";

export const CHART_W = 1200;
export const CHART_H = 200;
export const CHART_PAD_Y = 10;
/** Проміжок між фактом і прогнозною частиною — px ЕКРАНА (розділювач `.ot-chart__gap`: stroke 2 × FORECAST_GAP_PX). */
export const FORECAST_GAP_PX = 2;
/** Товщина лінії рівня факту (`.ot-chart__cap`), px екрана. */
export const FORECAST_CAP_PX = 2;
/**
 * Найменша висота заштрихованої частини за розділювачем, одиниці viewBox: на телефоні (× 0,7) після 2 px розділювача
 * лишається ≥ 1 px штрихування, на ПК — 3 px.
 */
export const FORECAST_MIN_UNITS = 5;
export const MAX_BAR_WIDTH = 24;

/**
 * Рівні ширини області графіка для підписів осі X (контейнерні запити `@container ot-chart-xaxis (min-width: …)` у
 * styles.css — ті самі межі, перевіряє тест): `minWidth` — межа рівня, `width` — ширина, для якої перевіряється, що
 * підписи не налягають (для найвужчого — найменша реальна ширина графіка на телефоні 320 px), `limit` — найбільша
 * кількість підписів (§18.3: на телефоні ≤ 7). Рівень c0 — також запасний для браузерів без контейнерних запитів.
 */
export const AXIS_LABEL_TIERS = [
  { id: "c0", minWidth: 0, width: 150, limit: 4 },
  { id: "c1", minWidth: 240, width: 240, limit: 5 },
  { id: "c2", minWidth: 360, width: 360, limit: 6 },
  { id: "c3", minWidth: 480, width: 480, limit: 7 },
  { id: "c4", minWidth: 720, width: 720, limit: 10 },
  { id: "c5", minWidth: 960, width: 960, limit: 12 },
] as const;
export type AxisTierId = (typeof AXIS_LABEL_TIERS)[number]["id"];
/** Найменший проміжок між сусідніми підписами осі X, px. */
export const AXIS_LABEL_GAP = 8;

// Оцінка ширини символу підпису (11 px, системний шрифт): не менша за виміряну в Chrome для Inter (найширшого з
// поширених), тож підписи на реальних шрифтах (SF, Segoe UI, Roboto) не ширші за оцінку.
const WIDE_CHARS = new Set([..."ЮЩЖШМДФWMmющшwжмф"]);
const NARROW_CHARS = new Set([..."-–—/()1rftijlІЇіїI"]);
const PUNCT_CHARS = new Set([..." .,:;·'’\u00a0\u202f"]);

/** Оцінка ширини підпису осі X у px (11 px; консервативно — не менше справжньої). */
export function estimateLabelWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    if (PUNCT_CHARS.has(ch)) w += 3.5;
    else if (NARROW_CHARS.has(ch)) w += 5.6;
    else if (/\d/.test(ch)) w += 7.2;
    else if (WIDE_CHARS.has(ch)) w += 11.2;
    else if (/\p{Lu}/u.test(ch)) w += 8.5;
    else if (/\p{Ll}/u.test(ch)) w += 6.9;
    else w += 11.2;
  }
  return Math.round(w * 100) / 100;
}

/** Межі підпису осі X у px для області ширини `width`: перший — від лівого краю, останній — до правого. */
export function axisLabelBox(index: number, n: number, labelWidth: number, width: number): { left: number; right: number } {
  if (index === 0) return { left: 0, right: labelWidth };
  if (index === n - 1) return { left: width - labelWidth, right: width };
  const center = ((index + 0.5) * width) / n;
  return { left: center - labelWidth / 2, right: center + labelWidth / 2 };
}

/**
 * Які відрізки підписати на рівні ширини: рівний крок (не більше `limit` підписів, кожні два — щонайменше
 * 1,5 ширини підпису + проміжок, бо крайні притиснуті до країв), далі — відкинути ті, що налягли б на попередній або
 * вийшли б за правий край; останній відрізок (притиснутий до правого краю) додається, якщо вміщується й стоїть
 * далі ніж пів кроку від попереднього підпису (без «злиплих» 05.11 · 06.11). Перший підписано завжди.
 */
export function axisLabelIndexes(n: number, labelWidth: number, width: number, limit: number): number[] {
  if (n <= 0) return [];
  const slot = width / n;
  const step = Math.max(1, Math.ceil(n / limit), Math.ceil((1.5 * labelWidth + AXIS_LABEL_GAP) / slot));
  const kept: number[] = [];
  let lastRight = -Infinity;
  for (let i = 0; i < n; i += step) {
    const box = axisLabelBox(i, n, labelWidth, width);
    if (i > 0 && (box.left < lastRight + AXIS_LABEL_GAP || box.right > width)) continue;
    kept.push(i);
    lastRight = box.right;
  }
  const last = n - 1;
  const prev = kept[kept.length - 1]!;
  if (last > 0 && prev !== last && kept.length < limit && last - prev > step / 2) {
    if (axisLabelBox(last, n, labelWidth, width).left >= lastRight + AXIS_LABEL_GAP) kept.push(last);
  }
  return kept;
}

export interface ChartRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Горизонтальна лінія (товщина — у CSS, px екрана, `vector-effect: non-scaling-stroke`). */
export interface ChartHLine {
  x: number;
  width: number;
  y: number;
}

export interface ChartTick {
  /** Десятковий рядок значення поділки. */
  value: string;
  y: number;
  zero: boolean;
}

export interface ChartBarGeometry {
  key: string;
  index: number;
  actual: ChartRect | null;
  actualZero: ChartRect | null;
  forecastPart: ChartRect | null;
  /**
   * Шар заштрихованої частини: under — продовжує стовпець факту від його краю (малюється ДО розділювача й факту),
   * over — перекриває верх стовпця факту (малюється ПІСЛЯ нього, з лінією рівня факту).
   */
  forecastLayer: "under" | "over" | null;
  /** Розділювач 2 px екрана між фактом і прогнозною частиною (на краю стовпця факту). */
  forecastGap: ChartHLine | null;
  /** Рівень факту, коли прогнозна частина перекриває стовпець факту. */
  forecastCap: ChartHLine | null;
  /** Напрям заштрихованої частини від рівня факту (up — у бік більших значень). */
  forecastDirection: "up" | "down" | null;
  compare: ChartRect | null;
  leftPct: number;
  widthPct: number;
  centerPct: number;
  /** На яких рівнях ширини (AXIS_LABEL_TIERS) показувати підпис осі X. */
  label: Record<AxisTierId, boolean>;
}

export interface ChartGeometry {
  ticks: ChartTick[];
  zeroY: number;
  bars: ChartBarGeometry[];
  hasCompare: boolean;
  /** Хоч одне відоме значення (факт, прогноз або порівняння). */
  hasData: boolean;
  /** Кількість відрізків з відомим фактом. */
  knownActual: number;
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const round4 = (v: number) => Math.round(v * 10_000) / 10_000;

function minorToDecimal(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  return `${neg ? "-" : ""}${a / 100n}.${(a % 100n).toString().padStart(2, "0")}`;
}

const TICK_MULTIPLIERS = [100n, 200n, 250n, 500n] as const;

/**
 * Поділки осі (§18.3: 3–4): найменший крок 1 / 2 / 2,5 / 5 × 10^k цілих одиниць валюти (≥ 1 одиниці = 100 мінорних) із
 * 2–3 інтервалами між межами, кратними кроку, що охоплюють дані й нуль. Дані в межах одного кроку — другий інтервал у
 * бік даних; лише нулі — −1 / 0 / 1.
 */
export function niceTicks(lo: bigint, hi: bigint): { bottom: bigint; top: bigint; step: bigint } {
  const low = lo > 0n ? 0n : lo;
  const high = hi < 0n ? 0n : hi;
  if (low === 0n && high === 0n) return { bottom: -100n, top: 100n, step: 100n };
  for (let mag = 1n; ; mag *= 10n) {
    for (const m of TICK_MULTIPLIERS) {
      // 2,5 — лише від 25 одиниць: кроки завжди в цілих одиницях валюти (без «2,5 ¥»).
      if (m === 250n && mag === 1n) continue;
      const step = m * mag;
      // low ≤ 0 ≤ high: межі — кратні кроку назовні від даних.
      const bottom = -((-low + step - 1n) / step) * step;
      const top = ((high + step - 1n) / step) * step;
      const intervals = (top - bottom) / step;
      if (intervals > 3n) continue;
      if (intervals >= 2n) return { bottom, top, step };
      return low < 0n ? { bottom: bottom - step, top, step } : { bottom, top: top + step, step };
    }
  }
}

export function chartGeometry(buckets: readonly ChartBucket[]): ChartGeometry {
  const parsed = buckets.map((b) => ({
    key: b.key,
    actual: parseMinor(b.actual),
    forecast: parseMinor(b.forecast),
    compare: b.compare === undefined ? undefined : parseMinor(b.compare),
  }));
  const hasCompare = buckets.some((b) => b.compare !== undefined);
  const known: bigint[] = [];
  for (const p of parsed) {
    if (p.actual !== null) known.push(p.actual);
    if (p.forecast !== null) known.push(p.forecast);
    if (p.compare !== undefined && p.compare !== null) known.push(p.compare);
  }
  let lo = 0n;
  let hi = 0n;
  for (const v of known) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const { bottom, top, step: tickStep } = niceTicks(lo, hi);
  const range = top - bottom;
  const plotH = CHART_H - 2 * CHART_PAD_Y;
  const yOf = (v: bigint): number => {
    const hundredths = ((top - v) * BigInt(plotH * 100) * 2n + range) / (2n * range);
    return round2(CHART_PAD_Y + Number(hundredths) / 100);
  };
  const zeroY = yOf(0n);
  const ticks: ChartTick[] = [];
  for (let v = bottom; v <= top; v += tickStep) ticks.push({ value: minorToDecimal(v), y: yOf(v), zero: v === 0n });

  const n = buckets.length;
  const slot = n > 0 ? CHART_W / n : CHART_W;
  const labelWidth = Math.max(0, ...buckets.map((b) => estimateLabelWidth(b.axisLabel ?? b.label)));
  const labelled = Object.fromEntries(
    AXIS_LABEL_TIERS.map((t) => [t.id, new Set(axisLabelIndexes(n, labelWidth, t.width, t.limit))]),
  ) as Record<AxisTierId, Set<number>>;
  const span = (from: bigint, to: bigint, x: number, width: number, minHeight: number): ChartRect => {
    const a = yOf(from);
    const b = yOf(to);
    let y = Math.min(a, b);
    let height = Math.abs(a - b);
    if (height < minHeight) {
      // Ненульове значення завжди видно (≥ 1 px) — у бік знака від початку відрізка.
      height = minHeight;
      y = to >= from ? a - minHeight : a;
    }
    return { x: round2(x), y: round2(y), width: round2(width), height: round2(height) };
  };

  const bars = parsed.map((p, index): ChartBarGeometry => {
    const center = (index + 0.5) * slot;
    let mainX: number;
    let barW: number;
    let compareX = 0;
    if (hasCompare) {
      const groupW = Math.min(slot * 0.8, 2 * MAX_BAR_WIDTH + 2);
      barW = Math.max(0.5, (groupW - 2) / 2);
      compareX = center - groupW / 2;
      mainX = compareX + barW + 2;
    } else {
      barW = Math.max(0.5, Math.min(slot * 0.7, MAX_BAR_WIDTH));
      mainX = center - barW / 2;
    }
    const a = p.actual;
    const f = p.forecast;
    const actual = a !== null && a !== 0n ? span(0n, a, mainX, barW, 1) : null;
    const actualZero = a === 0n ? { x: round2(mainX), y: round2(zeroY - 0.75), width: round2(barW), height: 1.5 } : null;
    let forecastPart: ChartRect | null = null;
    let forecastLayer: "under" | "over" | null = null;
    let forecastGap: ChartHLine | null = null;
    let forecastCap: ChartHLine | null = null;
    let forecastDirection: "up" | "down" | null = null;
    if (f !== null) {
      const base = a ?? 0n;
      if (f !== base) {
        forecastDirection = f > base ? "up" : "down";
        const outward = (base >= 0n && f > base) || (base <= 0n && f < base);
        // Рівень факту — НАМАЛЬОВАНИЙ край стовпця (крихітний факт подовжено до 1 одиниці), інакше розділювач і
        // лінія рівня опинились би всередині стовпця.
        const yBase = actual ? (base > 0n ? actual.y : round2(actual.y + actual.height)) : yOf(base);
        if (outward) {
          // Продовження стовпця від краю факту; розділювач 2 px екрана — лише коли є стовпець факту (не від нуля).
          const separated = a !== null && a !== 0n;
          const minHeight = separated ? FORECAST_MIN_UNITS : 1;
          forecastLayer = "under";
          const yF = yOf(f);
          if (forecastDirection === "up") {
            const topY = Math.min(yF, yBase - minHeight);
            forecastPart = { x: round2(mainX), y: round2(topY), width: round2(barW), height: round2(yBase - topY) };
          } else {
            const bottomY = Math.max(yF, yBase + minHeight);
            forecastPart = { x: round2(mainX), y: round2(yBase), width: round2(barW), height: round2(bottomY - yBase) };
          }
          if (separated) forecastGap = { x: round2(mainX), width: round2(barW), y: round2(yBase) };
        } else {
          forecastLayer = "over";
          forecastPart = span(base, f, mainX, barW, 1);
          forecastCap = { x: round2(mainX), width: round2(barW), y: round2(yBase) };
        }
      }
    }
    const c = p.compare;
    const compare = c !== undefined && c !== null ? span(0n, c, compareX, barW, c === 0n ? 0 : 1) : null;
    return {
      key: p.key,
      index,
      actual,
      actualZero,
      forecastPart,
      forecastLayer,
      forecastGap,
      forecastCap,
      forecastDirection,
      compare,
      leftPct: round4((index * 100) / Math.max(1, n)),
      widthPct: round4(100 / Math.max(1, n)),
      centerPct: round4(((index + 0.5) * 100) / Math.max(1, n)),
      label: Object.fromEntries(AXIS_LABEL_TIERS.map((t) => [t.id, labelled[t.id].has(index)])) as Record<AxisTierId, boolean>,
    };
  });

  return {
    ticks,
    zeroY,
    bars,
    hasCompare,
    hasData: known.length > 0,
    knownActual: parsed.filter((p) => p.actual !== null).length,
  };
}

/**
 * Клавіатура області графіка (одна зупинка Tab): ←/↑ — попередній стовпець, →/↓ — наступний, Home/End — перший /
 * останній, Escape — сховати підказку (null). Інша клавіша → undefined (не обробляється). Без фокуса — з першого.
 */
export function nextChartIndex(key: string, current: number | null, n: number): number | null | undefined {
  if (n <= 0) return undefined;
  const at = current ?? 0;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return Math.min(n - 1, current === null ? 0 : at + 1);
    case "ArrowLeft":
    case "ArrowUp":
      return Math.max(0, current === null ? 0 : at - 1);
    case "Home":
      return 0;
    case "End":
      return n - 1;
    case "Escape":
      return null;
    default:
      return undefined;
  }
}
