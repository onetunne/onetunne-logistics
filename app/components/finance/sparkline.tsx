/**
 * Етап 6, WP0-UI: міні-графік (inline SVG, без бібліотек): лінія за точками; null — РОЗРИВ (немає даних), ніколи не 0.
 * `role="img"` + `aria-label` = текстова альтернатива (`label`); окрема точка між розривами — кружечок.
 * Геометрія — чиста функція `sparklineGeometry` (BigInt над мінорними одиницями; детерміновано для SSR).
 */
import type { SparklinePoint, SparklineProps } from "./contracts";
import { parseMinor } from "./format-ui";

export const SPARK_WIDTH = 100;
export const SPARK_HEIGHT = 24;
const PAD = 2;

export interface SparklineGeometry {
  /** Відрізки лінії (кожен — щонайменше 2 точки) у координатах viewBox. */
  segments: Array<Array<{ x: number; y: number }>>;
  /** Окремі точки (сусіди — розриви). */
  dots: Array<{ x: number; y: number }>;
  /** Нульова лінія, якщо значення мають різні знаки. */
  zeroY: number | null;
  known: number;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

export function sparklineGeometry(points: readonly SparklinePoint[]): SparklineGeometry {
  const values = points.map((p) => parseMinor(p.value));
  const known = values.filter((v): v is bigint => v !== null);
  if (known.length === 0) return { segments: [], dots: [], zeroY: null, known: 0 };
  let lo = known[0]!;
  let hi = known[0]!;
  for (const v of known) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo;
  const plotH = SPARK_HEIGHT - 2 * PAD;
  const yOf = (v: bigint): number => {
    if (span === 0n) return SPARK_HEIGHT / 2;
    const hundredths = ((hi - v) * BigInt(plotH * 100) * 2n + span) / (2n * span);
    return round2(PAD + Number(hundredths) / 100);
  };
  const n = points.length;
  const xOf = (i: number) => (n === 1 ? SPARK_WIDTH / 2 : round2(PAD + (i * (SPARK_WIDTH - 2 * PAD)) / (n - 1)));
  const segments: SparklineGeometry["segments"] = [];
  const dots: SparklineGeometry["dots"] = [];
  let current: Array<{ x: number; y: number }> = [];
  const flush = () => {
    if (current.length >= 2) segments.push(current);
    else if (current.length === 1) dots.push(current[0]!);
    current = [];
  };
  values.forEach((v, i) => {
    if (v === null) flush();
    else current.push({ x: xOf(i), y: yOf(v) });
  });
  flush();
  const zeroY = lo < 0n && hi > 0n ? yOf(0n) : null;
  return { segments, dots, zeroY, known: known.length };
}

export function Sparkline({ points, label }: SparklineProps) {
  const g = sparklineGeometry(points);
  return (
    <svg
      className="ot-sparkline"
      viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
      focusable="false"
      data-known={g.known}
    >
      {g.zeroY !== null ? <line className="ot-sparkline__zero" x1={0} x2={SPARK_WIDTH} y1={g.zeroY} y2={g.zeroY} /> : null}
      {g.segments.map((seg, i) => (
        <polyline key={i} className="ot-sparkline__line" points={seg.map((p) => `${p.x},${p.y}`).join(" ")} />
      ))}
      {g.dots.map((p, i) => (
        <circle key={`d${i}`} className="ot-sparkline__dot" cx={p.x} cy={p.y} r={1.5} />
      ))}
    </svg>
  );
}
