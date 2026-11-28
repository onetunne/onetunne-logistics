/**
 * Етап 6, WP1: курсова різниця обміну валюти (docs/stage6-design.md §5.7, §10.4) — чиста функція.
 * Продано a у валюті A, отримано b у валюті B, дата D: очікувано = convert(a, A→B, D) (одне округлення, половина від
 * нуля, до мінорних одиниць B), `fx_difference` = b − очікувано у валюті B. Приклад G4: 1 000,00 EUR → 48 650,00 UAH
 * 27.11.2026, НБУ 49,4942 → очікувано 49 494,20 → −844,20 UAH.
 */
import { fromMinor, toMinorForCurrency } from "~/lib/decimal";
import { convertAmount } from "./convert";

export interface ConversionDifferenceInput {
  soldAmount: string;
  soldCurrency: string;
  boughtAmount: string;
  boughtCurrency: string;
  /** P (курс × 10^10, гривень за 1 одиницю) валюти продажу й купівлі на дату обміну. */
  soldRate: bigint;
  boughtRate: bigint;
}

export interface ConversionDifference {
  /** Очікувана сума у валюті купівлі за курсами дати обміну. */
  expected: string;
  /** Отримано − очікувано (у валюті купівлі); "0.00" — різниці немає. */
  difference: string;
}

export function conversionDifference(input: ConversionDifferenceInput): ConversionDifference {
  if (input.soldCurrency === input.boughtCurrency) throw new RangeError("currencies must differ");
  const expected = convertAmount(input.soldAmount, input.soldCurrency, input.boughtCurrency, input.soldRate, input.boughtRate);
  const diff = toMinorForCurrency(input.boughtAmount, input.boughtCurrency) - toMinorForCurrency(expected, input.boughtCurrency);
  return { expected, difference: fromMinor(diff) };
}
