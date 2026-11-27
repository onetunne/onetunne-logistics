import type { DutyPayer } from "~/modules/validation";

/**
 * Константи правил країн без залежностей (безпечно імпортувати в клієнтський код сторінки).
 * Повідомлення помилок — ключі i18n (app/i18n/messages/country-rules.ts).
 */

export const DUTY_PAYERS = ["company", "customer", "unknown"] as const satisfies readonly DutyPayer[];

export const MAX_NOTES_LENGTH = 500;
export const MAX_PATTERN_LENGTH = 200;
export const MAX_EXAMPLE_LENGTH = 20;
export const MAX_NAME_LENGTH = 80;
/** Позначка в примітках типових правил: правило потребує перевірки перед роботою. */
export const VERIFY_MARKER = "verify before production";
/** Повне речення позначки (як у типових правилах, app/modules/validation/default-country-rules.ts). */
export const VERIFY_NOTE = "Default rule — verify before production.";

/** Поля правила, які редагує власник (назви країни — лише під час додавання/скидання). */
export const EDITABLE_RULE_FIELDS = [
  "shippingEnabled",
  "postalCodeRequired",
  "postalCodePattern",
  "postalCodeExample",
  "provinceRequired",
  "phoneRequired",
  "dutyPayer",
  "notes",
] as const;
export type EditableRuleField = (typeof EDITABLE_RULE_FIELDS)[number];

export const ERR = {
  invalid: "countryRules.error.invalid",
  tooLong: "countryRules.error.tooLong",
  patternInvalid: "countryRules.error.patternInvalid",
  exampleMismatch: "countryRules.error.exampleMismatch",
  codeInvalid: "countryRules.error.codeInvalid",
  codeExists: "countryRules.error.codeExists",
  nameRequired: "countryRules.error.nameRequired",
} as const;
