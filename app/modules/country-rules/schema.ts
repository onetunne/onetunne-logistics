import { z } from "zod";
import { DEFAULT_COUNTRY_RULES, type DefaultCountryRule, type DutyPayer } from "~/modules/validation";
import {
  DUTY_PAYERS,
  EDITABLE_RULE_FIELDS,
  ERR,
  MAX_EXAMPLE_LENGTH,
  MAX_NAME_LENGTH,
  MAX_NOTES_LENGTH,
  MAX_PATTERN_LENGTH,
  VERIFY_MARKER,
  VERIFY_NOTE,
  type EditableRuleField,
} from "./constants";
import { compilePostalPattern } from "~/modules/validation/postal";

/**
 * Правила країн, які редагує власник (етап 4): схеми перевірки (zod) і чисті допоміжні функції.
 * Повідомлення помилок — ключі i18n (app/i18n/messages/country-rules.ts).
 */

export * from "./constants";

export interface CountryRuleValue {
  shippingEnabled: boolean;
  postalCodeRequired: boolean;
  postalCodePattern: string | null;
  postalCodeExample: string | null;
  provinceRequired: boolean;
  phoneRequired: boolean;
  dutyPayer: DutyPayer;
  notes: string | null;
}

/** Повний знімок правила (зберігається в country_rules_history.value). */
export interface CountryRuleSnapshot extends CountryRuleValue {
  nameEn: string;
  nameUk: string;
}


/** Рядок: обрізаються пробіли, порожнє/відсутнє значення → null. */
const optionalText = (max: number) =>
  z
    .preprocess((v) => (v === null || v === undefined ? "" : v), z.string({ error: ERR.invalid }))
    .transform((v) => v.trim())
    .pipe(z.string().max(max, { error: ERR.tooLong }))
    .transform((v) => (v === "" ? null : v));

const flag = z.boolean({ error: ERR.invalid });

export const countryRuleValueSchema = z
  .object({
    shippingEnabled: flag,
    postalCodeRequired: flag,
    postalCodePattern: optionalText(MAX_PATTERN_LENGTH),
    postalCodeExample: optionalText(MAX_EXAMPLE_LENGTH),
    provinceRequired: flag,
    phoneRequired: flag,
    dutyPayer: z.enum(DUTY_PAYERS, { error: ERR.invalid }),
    notes: optionalText(MAX_NOTES_LENGTH),
  })
  .superRefine((v, ctx) => {
    if (v.postalCodePattern === null) return;
    const re = compilePostalPattern(v.postalCodePattern);
    if (!re) {
      ctx.addIssue({ code: "custom", path: ["postalCodePattern"], message: ERR.patternInvalid });
      return;
    }
    if (v.postalCodeExample !== null && !re.test(v.postalCodeExample)) {
      ctx.addIssue({ code: "custom", path: ["postalCodeExample"], message: ERR.exampleMismatch });
    }
  });

export const countryCodeSchema = z
  .preprocess((v) => (typeof v === "string" ? v.trim().toUpperCase() : v), z.string({ error: ERR.codeInvalid }))
  .pipe(z.string().regex(/^[A-Z]{2}$/, { error: ERR.codeInvalid }));

const nameSchema = optionalText(MAX_NAME_LENGTH);

export const newCountryRuleSchema = z.object({
  countryCode: countryCodeSchema,
  nameEn: nameSchema,
  nameUk: nameSchema,
});

export function fieldErrorsOf(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join(".") || "_";
    out[path] ??= issue.message.startsWith("countryRules.error.") ? issue.message : ERR.invalid;
  }
  return out;
}

export function pickRuleValue(source: CountryRuleValue): CountryRuleValue {
  return {
    shippingEnabled: source.shippingEnabled,
    postalCodeRequired: source.postalCodeRequired,
    postalCodePattern: source.postalCodePattern,
    postalCodeExample: source.postalCodeExample,
    provinceRequired: source.provinceRequired,
    phoneRequired: source.phoneRequired,
    dutyPayer: source.dutyPayer,
    notes: source.notes,
  };
}

export function pickSnapshot(source: CountryRuleSnapshot): CountryRuleSnapshot {
  return { nameEn: source.nameEn, nameUk: source.nameUk, ...pickRuleValue(source) };
}

/** Поля, значення яких відрізняються. */
export function changedFields(a: CountryRuleValue, b: CountryRuleValue): EditableRuleField[] {
  return EDITABLE_RULE_FIELDS.filter((f) => a[f] !== b[f]);
}

export function defaultRuleFor(countryCode: string): DefaultCountryRule | undefined {
  const code = countryCode.trim().toUpperCase();
  return DEFAULT_COUNTRY_RULES.find((r) => r.countryCode === code);
}

/** Чи відрізняється правило від типового. Країна без типового правила (додана власником) — завжди «змінено». */
export function isChangedFromDefault(rule: CountryRuleSnapshot & { countryCode: string }): boolean {
  const def = defaultRuleFor(rule.countryCode);
  if (!def) return true;
  // Позначка перевірки — не зміна значень: перевірене типове правило лишається «типовим».
  const a = { ...pickRuleValue(rule), notes: withoutVerifyMarker(rule.notes) };
  const b = { ...pickRuleValue(def), notes: withoutVerifyMarker(def.notes) };
  return changedFields(a, b).length > 0 || rule.nameEn !== def.nameEn || rule.nameUk !== def.nameUk;
}

export function needsVerification(notes: string | null): boolean {
  return notes !== null && notes.toLowerCase().includes(VERIFY_MARKER);
}

/** Речення з позначкою (напр. «Default rule — verify before production.»), без урахування регістру. */
const VERIFY_SENTENCE_RE = new RegExp(`[^.!?\\n]*${VERIFY_MARKER.replace(/ /g, "\\s+")}[^.!?\\n]*[.!?]?`, "gi");

/**
 * Примітки без позначки «потребує перевірки» (решта тексту зберігається). Порожній результат → null.
 * Збережена позначка лишається англійською для сумісності; в інтерфейсі її замінює значок «Потребує перевірки».
 */
export function withoutVerifyMarker(notes: string | null): string | null {
  if (notes === null) return null;
  const cleaned = notes.replace(VERIFY_SENTENCE_RE, " ").replace(/[ \t]{2,}/g, " ").replace(/ *\n */g, "\n").trim();
  return cleaned === "" ? null : cleaned;
}

/** Повертає позначку на початок приміток (форма показує примітки без неї, але збереження не має її знімати). */
export function withVerifyMarker(notes: string | null): string {
  const rest = withoutVerifyMarker(notes);
  return rest ? `${VERIFY_NOTE} ${rest}` : VERIFY_NOTE;
}
