/**
 * Етап 6, WP1: чисті правила ручного курсу (docs/stage6-design.md §5.3, §18.2 «1 EUR = … грн»). Курс вводиться за
 * `units` одиниць валюти (як публікує НБУ: 1, 10, 100, 1000, 10000) з точністю до 6 знаків; курс за одиницю
 * (rate_per_unit, numeric(20,10)) рахується точно — без float.
 */
import { FX_QUOTE_CURRENCY, FX_RATE_UNITS } from "~/domain/finance";
import { CURRENCY_CODE_RE, isSupportedCurrency, parseDecimalStrict, ratePerUnitScaled, scaledRateToDecimal } from "~/lib/decimal";

/** Знаків після коми в курсі (fx_rates.rate numeric(18,6)). */
export const MANUAL_RATE_MAX_SCALE = 6;
const MANUAL_RATE_MAX_INT_DIGITS = 12;
/** Курс за одиницю numeric(20,10): не більше 10 цілих розрядів. */
const PER_UNIT_MAX = 10n ** 20n;

export type RateInputError =
  | "financeFx.error.rateEmpty"
  | "financeFx.error.rateInvalid"
  | "financeFx.error.rateAmbiguous"
  | "financeFx.error.rateTooPrecise"
  | "financeFx.error.unitsInvalid";

export type RateInputResult = { ok: true; rate: string; units: number; ratePerUnit: string } | { ok: false; error: RateInputError };

/**
 * Курс із форми власника: «49,4942», «49.4942», «1 234,5» (пробіли — розділювачі тисяч). І кома, і крапка — помилка
 * «неоднозначно»; > 6 знаків після коми — помилка; ≤ 0 — помилка. Результат — канонічний десятковий рядок.
 */
export function parseRateInput(input: string | null | undefined, unitsInput: number | string | null | undefined = 1): RateInputResult {
  const raw = (input ?? "").replace(/[\s  ]/g, "");
  if (raw === "") return { ok: false, error: "financeFx.error.rateEmpty" };
  if (raw.includes(",") && raw.includes(".")) return { ok: false, error: "financeFx.error.rateAmbiguous" };
  if ((raw.match(/[,.]/g) ?? []).length > 1) return { ok: false, error: "financeFx.error.rateAmbiguous" };
  const normalized = raw.replace(",", ".");
  const m = /^(\d+)(?:\.(\d+))?$/.exec(normalized);
  if (!m) return { ok: false, error: "financeFx.error.rateInvalid" };
  if ((m[2] ?? "").length > MANUAL_RATE_MAX_SCALE) return { ok: false, error: "financeFx.error.rateTooPrecise" };
  const int = m[1]!.replace(/^0+(?=\d)/, "");
  if (int.length > MANUAL_RATE_MAX_INT_DIGITS) return { ok: false, error: "financeFx.error.rateInvalid" };
  const units = typeof unitsInput === "number" ? unitsInput : Number((unitsInput ?? "1").toString().trim() || "1");
  if (!(FX_RATE_UNITS as readonly number[]).includes(units)) return { ok: false, error: "financeFx.error.unitsInvalid" };
  const r = parseDecimalStrict(`${int}${m[2] ? `.${m[2]}` : ""}`, MANUAL_RATE_MAX_SCALE);
  if (!r || r.num <= 0n) return { ok: false, error: "financeFx.error.rateInvalid" };
  const scaled = ratePerUnitScaled(`${int}${m[2] ? `.${m[2]}` : ""}`, units);
  if (scaled >= PER_UNIT_MAX) return { ok: false, error: "financeFx.error.rateInvalid" };
  const rate = scaledRateToDecimal(ratePerUnitScaled(`${int}${m[2] ? `.${m[2]}` : ""}`, 1));
  return { ok: true, rate, units, ratePerUnit: scaledRateToDecimal(scaled) };
}

export type CurrencyInputError = "financeFx.error.currencyInvalid" | "financeFx.error.currencyBase" | "finance.error.unsupportedCurrency";

/** Код валюти курсу: ISO 4217, 0 або 2 знаки (§5.1), не гривня (курс гривні — рівно 1). */
export function parseRateCurrency(input: string | null | undefined): { ok: true; currency: string } | { ok: false; error: CurrencyInputError } {
  const c = (input ?? "").trim().toUpperCase();
  if (!CURRENCY_CODE_RE.test(c)) return { ok: false, error: "financeFx.error.currencyInvalid" };
  if (c === FX_QUOTE_CURRENCY) return { ok: false, error: "financeFx.error.currencyBase" };
  if (!isSupportedCurrency(c)) return { ok: false, error: "finance.error.unsupportedCurrency" };
  return { ok: true, currency: c };
}
