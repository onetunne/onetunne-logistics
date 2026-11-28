/**
 * Етап 6, WP1: генератор вигаданих демо-курсів (docs/stage6-design.md §5.8) для WP11 (seedDemoFinance). Чиста функція,
 * детермінована: курс залежить ЛИШЕ від валюти й дати (не від «сьогодні»), тож повторне заповнення в інший день дає ті
 * самі значення для тих самих дат (ідемпотентність, ON CONFLICT DO NOTHING).
 *
 * EUR 48,50 · USD 44,50 · GBP 56,50 · PLN 11,20 гривень за 1 одиницю; плавне коливання ±1,2 % (наближення синуса
 * Бгаскари на цілих числах — без float, однаково на будь-якому рушії); 4 знаки після коми; субота й неділя повторюють
 * п'ятницю (як публікує НБУ). Період — [сьогодні − 420, сьогодні + 7]. Курси вигадані — не курси НБУ (банер сторінки).
 */
import { addDays, eachDay, isoWeekday, parseIsoDate } from "~/lib/periods";

export interface DemoRateSpec {
  currency: string;
  /** Основа × 10^4 (48,5000 → 485000). */
  base4: number;
  /** Період коливання, днів. */
  periodDays: number;
  /** Зсув фази, днів. */
  phaseDays: number;
}

export const DEMO_RATE_SPECS: readonly DemoRateSpec[] = [
  { currency: "EUR", base4: 485_000, periodDays: 97, phaseDays: 0 },
  { currency: "USD", base4: 445_000, periodDays: 83, phaseDays: 21 },
  { currency: "GBP", base4: 565_000, periodDays: 113, phaseDays: 47 },
  { currency: "PLN", base4: 112_000, periodDays: 71, phaseDays: 9 },
];

export const DEMO_RATE_DAYS_BACK = 420;
export const DEMO_RATE_DAYS_AHEAD = 7;
/** Амплітуда коливання, мільйонні частки (1,2 %). */
export const DEMO_RATE_AMPLITUDE_PPM = 12_000;

/** sin(θ°) × 1000 (θ — ціле, будь-яке): наближення Бгаскари I, похибка < 0,2 %. Цілі числа. */
export function sinMilli(theta: number): number {
  const t = ((theta % 360) + 360) % 360;
  const x = t % 180;
  const p = x * (180 - x);
  const s = Math.floor((4 * p * 1000 + Math.floor((40_500 - p) / 2)) / (40_500 - p));
  return t < 180 ? s : -s;
}

function dayIndex(iso: string): number {
  return Math.round(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);
}

/** Демо-курс (рядок з 4 знаками) валюти на дату; вихідні — курс п'ятниці. */
export function demoRateOn(spec: DemoRateSpec, date: string): string {
  if (!parseIsoDate(date)) throw new RangeError(`invalid date ${date}`);
  const wd = isoWeekday(date);
  const effective = wd === 6 ? addDays(date, -1) : wd === 7 ? addDays(date, -2) : date;
  const idx = dayIndex(effective) + spec.phaseDays;
  const pos = ((idx % spec.periodDays) + spec.periodDays) % spec.periodDays;
  const theta = Math.floor((pos * 360) / spec.periodDays);
  const ppm = (DEMO_RATE_AMPLITUDE_PPM * sinMilli(theta)) / 1000;
  // base4 × (1 + ppm / 10^6), половина від нуля (додатні значення).
  const num = BigInt(spec.base4) * BigInt(1_000_000 + Math.round(ppm));
  const value = (2n * num + 1_000_000n) / 2_000_000n;
  const s = value.toString().padStart(5, "0");
  return `${s.slice(0, -4)}.${s.slice(-4)}`;
}

export interface DemoRateRow {
  currency: string;
  effectiveDate: string;
  rate: string;
}

/** Усі демо-курси для «сьогодні» (Київ): [today − 420, today + 7] × EUR, USD, GBP, PLN. */
export function generateDemoRates(today: string, specs: readonly DemoRateSpec[] = DEMO_RATE_SPECS): DemoRateRow[] {
  const days = eachDay({ from: addDays(today, -DEMO_RATE_DAYS_BACK), to: addDays(today, DEMO_RATE_DAYS_AHEAD) });
  const out: DemoRateRow[] = [];
  for (const spec of specs) for (const d of days) out.push({ currency: spec.currency, effectiveDate: d, rate: demoRateOn(spec, d) });
  return out;
}

/**
 * Дві ручні версії EUR (історія версій на сторінці курсів): дата — 14 днів тому; v1 = демо-курс + 0,1000, v2
 * (поточна, виправлення) = демо-курс + 0,0500. Причини — вигадані (позначені «демо»).
 */
export const DEMO_MANUAL_RATE_DAYS_BACK = 14;
export const DEMO_MANUAL_RATE_REASONS = ["(демо) курс банку за випискою", "(демо) виправлено за випискою банку"] as const;

export function demoManualEurVersions(today: string): Array<{ currency: string; effectiveDate: string; rate: string; version: number; reason: string }> {
  const date = addDays(today, -DEMO_MANUAL_RATE_DAYS_BACK);
  const base = demoRateOn(DEMO_RATE_SPECS[0]!, date);
  const plus = (v: string, add4: number) => {
    const n = BigInt(v.replace(".", "")) + BigInt(add4);
    const s = n.toString().padStart(5, "0");
    return `${s.slice(0, -4)}.${s.slice(-4)}`;
  };
  return [
    { currency: "EUR", effectiveDate: date, rate: plus(base, 1000), version: 1, reason: DEMO_MANUAL_RATE_REASONS[0] },
    { currency: "EUR", effectiveDate: date, rate: plus(base, 500), version: 2, reason: DEMO_MANUAL_RATE_REASONS[1] },
  ];
}
