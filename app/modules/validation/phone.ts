import { isSupportedCountry, parsePhoneNumberFromString, type CountryCode, type PhoneNumber } from "libphonenumber-js/max";
import type { AutoFixRuleId, CountryRules, ValidationIssue } from "./types";

/**
 * Нормалізація телефону до E.164.
 *
 * Дозволено лише однозначні перетворення: прибрати форматування, замінити "00" на "+",
 * додати "+", перевести місцевий номер у міжнародний за країною доставки.
 * Цифри НІКОЛИ не вигадуються і не змінюються (див. isDigitPreserving).
 */

export type PhoneNormalization =
  | { status: "valid"; e164: string; ruleId: AutoFixRuleId | null }
  | { status: "ambiguous"; candidates: string[] }
  | { status: "invalid"; reason: "characters" | "unparseable" };

/** Символи форматування, які можна безпечно прибрати: пробіли (у т.ч. NBSP), - . ( ) / */
const FORMATTING_CHARS = /[\s  \-.()/]/g;
const COMPACT_PHONE = /^\+?\d*$/;

function parseSafe(text: string, defaultCountry?: CountryCode): PhoneNumber | undefined {
  try {
    return parsePhoneNumberFromString(text, { defaultCountry, extract: false });
  } catch {
    return undefined;
  }
}

/**
 * Інваріант безпеки: національний значущий номер результату має бути суцільним суфіксом
 * цифр, які ввів клієнт (дозволено лише відкинути префікс/транк і додати код країни).
 * Для міжнародного вводу код країни також має бути префіксом введених цифр.
 */
export function isDigitPreserving(
  inputDigits: string,
  parsed: { number: string; countryCallingCode: string; nationalNumber: string },
  international: boolean,
): boolean {
  const { countryCallingCode: cc, nationalNumber: nsn, number } = parsed;
  if (!/^\d+$/.test(inputDigits) || !/^\d+$/.test(nsn) || !/^\d+$/.test(cc)) return false;
  if (number !== `+${cc}${nsn}`) return false;
  if (!inputDigits.endsWith(nsn)) return false;
  if (international) return inputDigits.startsWith(cc) && inputDigits.length >= cc.length + nsn.length;
  return true;
}

function parseValid(digits: string, mode: "international" | { country: CountryCode }): string | null {
  const parsed = mode === "international" ? parseSafe(`+${digits}`) : parseSafe(digits, mode.country);
  if (!parsed || !parsed.isValid()) return null;
  // Порушення інваріанта → кандидат вважається недійсним (ніколи не "вгадуємо").
  if (!isDigitPreserving(digits, parsed, mode === "international")) return null;
  return parsed.number;
}

function supportedCountry(code: string | null): CountryCode | null {
  if (!code) return null;
  const upper = code.trim().toUpperCase();
  return isSupportedCountry(upper) ? upper : null;
}

export function normalizePhone(raw: string, shippingCountry: string | null): PhoneNormalization {
  const compact = raw.replace(FORMATTING_CHARS, "");
  if (!COMPACT_PHONE.test(compact)) return { status: "invalid", reason: "characters" };
  if (!/\d/.test(compact)) return { status: "invalid", reason: "unparseable" };

  if (compact.startsWith("+")) {
    const e164 = parseValid(compact.slice(1), "international");
    if (!e164) return { status: "invalid", reason: "unparseable" };
    return { status: "valid", e164, ruleId: e164 === raw ? null : "phone.normalize_format" };
  }

  if (compact.startsWith("00")) {
    const e164 = parseValid(compact.slice(2), "international");
    if (!e164) return { status: "invalid", reason: "unparseable" };
    return { status: "valid", e164, ruleId: "phone.international_prefix_00" };
  }

  // Без "+": можливі тлумачення — місцевий номер країни доставки та номер з кодом країни без "+".
  const candidates: Array<{ e164: string; ruleId: AutoFixRuleId }> = [];
  const country = supportedCountry(shippingCountry);
  if (country) {
    const national = parseValid(compact, { country });
    if (national) {
      candidates.push({
        e164: national,
        ruleId: national === `+${compact}` ? "phone.add_plus" : "phone.national_to_international",
      });
    }
  }
  const withPlus = parseValid(compact, "international");
  if (withPlus && !candidates.some((c) => c.e164 === withPlus)) {
    candidates.push({ e164: withPlus, ruleId: "phone.add_plus" });
  }

  const [first] = candidates;
  if (!first) return { status: "invalid", reason: "unparseable" };
  if (candidates.length === 1) return { status: "valid", e164: first.e164, ruleId: first.ruleId };
  return { status: "ambiguous", candidates: candidates.map((c) => c.e164) };
}

/**
 * Перевірка телефону одержувача (поле shipping.phone) на ВЖЕ виправленій копії замовлення.
 * contactPhone тут не перевіряється — він лише джерело для копіювання.
 */
export function validateShippingPhone(
  phone: string | null,
  countryCode: string | null,
  rules: CountryRules,
): ValidationIssue[] {
  const field = "shipping.phone";
  const value = phone?.trim() ?? "";
  if (value === "") {
    const rule = countryCode ? rules.get(countryCode.trim().toUpperCase()) : undefined;
    const severity = !rule || rule.phoneRequired ? "error" : "warning";
    return [{ code: "PHONE_MISSING", severity, field, params: {}, suggestion: null }];
  }
  const result = normalizePhone(value, countryCode);
  if (result.status === "invalid") {
    return [{ code: "PHONE_INVALID", severity: "error", field, params: { reason: result.reason }, suggestion: null }];
  }
  if (result.status === "ambiguous") {
    return [
      {
        code: "PHONE_AMBIGUOUS",
        severity: "error",
        field,
        params: {},
        suggestion: { field, candidates: result.candidates },
      },
    ];
  }
  return [];
}
