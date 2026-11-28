/**
 * Етап 6: чиста конвертація фінансових сум (docs/stage6-design.md §5.5). Точна раціональна конвертація через UAH:
 * A_Y = A × p_X(d) / p_Y(d), p — гривень за 1 одиницю на дату курсу запису (`fx_on`). Одне округлення (половина від
 * нуля) на КОЖЕН запис одразу до мінорних одиниць цільової валюти (0 або 2 знаки), потім сума. Кросс-курс НІКОЛИ не
 * округлюється заздалегідь і не зберігається. SQL-двійник — sql.ts (sqlConvertMinor), тест I6: SQL = TS.
 *
 * Курси (P = p × 10^10, ціле) дає rateFor (rate-for.server.ts) — єдине джерело курсів для фінансів.
 */
import { assertSupportedCurrency, convertMinor, fromMinor, RATE_SCALE_FACTOR, toMinor, toMinorForCurrency } from "~/lib/decimal";

export { convertMinor };

/** Курс гривні до самої себе (P для UAH). */
export const UAH_SCALED_RATE = RATE_SCALE_FACTOR;
export const BASE_CURRENCY = "UAH";

/**
 * Конвертує одну суму (десятковий рядок у валюті `from`) у валюту `to` за курсами PX (from) і PY (to), P = p × 10^10.
 * Та сама валюта — без змін (курси не потрібні). Результат — десятковий рядок з 2 знаками (для валют з 0 знаками —
 * «.00»).
 */
export function convertAmount(amount: string, from: string, to: string, PX: bigint, PY: bigint): string {
  const a = toMinorForCurrency(amount, from);
  const dY = assertSupportedCurrency(to);
  if (from === to) return fromMinor(a);
  return fromMinor(convertMinor(a, PX, PY, dY));
}

/** Курс валюти на дату курсу запису: P (× 10^10) або null — «немає курсу». */
export type ScaledRateLookup = (currency: string, fxOn: string) => bigint | null;

export interface ConvertibleEntry {
  amount: string;
  currency: string;
  /** Дата курсу запису (YYYY-MM-DD). */
  fxOn: string;
}

export interface UnconvertedTotal {
  currency: string;
  /** Σ у початковій валюті (десятковий рядок). */
  amount: string;
  entries: number;
}

export interface ConvertedSum {
  /**
   * Σ сконвертованих записів у цільовій валюті (лише записи з курсом). null — НІЧОГО не сконвертовано, хоча записи є
   * (усі без курсу): невідома сума, «—», а не «0,00» (F4; як SUM над NULL у SQL-двійнику). "0.00" — лише відомий нуль
   * (немає записів або сконвертовані записи дають 0).
   */
  total: string | null;
  /** Скільки записів сконвертовано. */
  converted: number;
  /** Записи без курсу: не входять у total, перелічуються окремо («Без курсу: 120,00 PLN (2 записи)», §2.6). */
  unconverted: UnconvertedTotal[];
}

/**
 * Σ записів у валюті `target`: кожен запис конвертується окремо за курсом свого `fxOn` (одне округлення на запис),
 * потім сума. Відсутній курс — запис не входить у суму й не стає нулем; усі записи без курсу → total = null.
 */
export function sumConverted(entries: readonly ConvertibleEntry[], target: string, rateOf: ScaledRateLookup): ConvertedSum {
  const dY = assertSupportedCurrency(target);
  let total = 0n;
  let converted = 0;
  const missing = new Map<string, { minor: bigint; entries: number }>();
  for (const e of entries) {
    const a = toMinorForCurrency(e.amount, e.currency);
    if (e.currency === target) {
      total += a;
      converted++;
      continue;
    }
    const px = e.currency === BASE_CURRENCY ? UAH_SCALED_RATE : rateOf(e.currency, e.fxOn);
    const py = target === BASE_CURRENCY ? UAH_SCALED_RATE : rateOf(target, e.fxOn);
    if (px === null || py === null) {
      const m = missing.get(e.currency) ?? { minor: 0n, entries: 0 };
      m.minor += a;
      m.entries++;
      missing.set(e.currency, m);
      continue;
    }
    total += convertMinor(a, px, py, dY);
    converted++;
  }
  return {
    total: converted === 0 && missing.size > 0 ? null : fromMinor(total),
    converted,
    unconverted: [...missing.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, m]) => ({ currency, amount: fromMinor(m.minor), entries: m.entries })),
  };
}

/**
 * Неявне співвідношення валюти покупця до валюти магазину (§2.4): «Покупець платив 86,40 GBP → 100,00 EUR; неявне
 * співвідношення 0,8640 — розраховано застосунком, не курс Shopify». 4 знаки, половина від нуля; база ≤ 0 → null.
 */
export function impliedRatio(presentmentAmount: string, shopAmount: string): string | null {
  const p = toMinor(presentmentAmount);
  const s = toMinor(shopAmount);
  if (s <= 0n || p < 0n) return null;
  const scaled = (2n * p * 10_000n + s) / (2n * s);
  const int = scaled / 10_000n;
  const frac = (scaled % 10_000n).toString().padStart(4, "0");
  return `${int}.${frac}`;
}
