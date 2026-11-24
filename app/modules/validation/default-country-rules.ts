import type { CountryRule } from "./types";

/**
 * Типові правила країн для початкового заповнення таблиці country_rules.
 *
 * Шаблони індексів — регулярні вирази без прапорців, що перевіряють ВЖЕ нормалізований
 * індекс (див. normalizePostalCode). dutyPayer = "unknown" для всіх: хто сплачує мито,
 * ще не підтверджено бізнесом. Перед production правила потрібно перевірити.
 */

export type DutyPayer = "company" | "customer" | "unknown";
export type DefaultCountryRule = CountryRule & { dutyPayer: DutyPayer; notes: string | null };

const VERIFY = "Default rule — verify before production.";

interface RuleSpec {
  nameEn: string;
  nameUk: string;
  pattern: string | null;
  example: string | null;
  postalCodeRequired?: boolean;
  provinceRequired?: boolean;
  shippingEnabled?: boolean;
  notes?: string | null;
}

function rule(countryCode: string, spec: RuleSpec): DefaultCountryRule {
  return {
    countryCode,
    nameEn: spec.nameEn,
    nameUk: spec.nameUk,
    shippingEnabled: spec.shippingEnabled ?? true,
    postalCodeRequired: spec.postalCodeRequired ?? spec.pattern !== null,
    postalCodePattern: spec.pattern,
    postalCodeExample: spec.example,
    provinceRequired: spec.provinceRequired ?? false,
    phoneRequired: true,
    dutyPayer: "unknown",
    notes: spec.notes === undefined ? VERIFY : spec.notes,
  };
}

// Великобританія: зовнішня частина (A9, A99, AA9, AA99, A9A, AA9A) + пробіл + внутрішня (9AA).
const GB_POSTCODE =
  "^(?:GIR 0AA|(?:[A-PR-UWYZ]\\d{1,2}|[A-PR-UWYZ][A-HK-Y]\\d{1,2}|[A-PR-UWYZ]\\d[A-HJKPSTUW]|[A-PR-UWYZ][A-HK-Y]\\d[ABEHMNPRVWXY]) \\d[ABD-HJLNP-UW-Z]{2})$";
// Канада: A9A 9A9 (без літер D, F, I, O, Q, U; W і Z не на першій позиції).
const CA_POSTCODE = "^[ABCEGHJ-NPRSTVXY]\\d[ABCEGHJ-NPRSTV-Z] \\d[ABCEGHJ-NPRSTV-Z]\\d$";
// Ірландія: Eircode — ключ маршруту (A99 або D6W) + пробіл + 4 символи.
const IE_EIRCODE = "^(?:[AC-FHKNPRTV-Y]\\d{2}|D6W) [0-9AC-FHKNPRTV-Y]{4}$";

export const DEFAULT_COUNTRY_RULES: DefaultCountryRule[] = [
  rule("DE", { nameEn: "Germany", nameUk: "Німеччина", pattern: "^\\d{5}$", example: "10115" }),
  rule("PL", { nameEn: "Poland", nameUk: "Польща", pattern: "^\\d{2}-\\d{3}$", example: "00-950" }),
  rule("FR", { nameEn: "France", nameUk: "Франція", pattern: "^\\d{5}$", example: "75008" }),
  rule("IT", { nameEn: "Italy", nameUk: "Італія", pattern: "^\\d{5}$", example: "00184" }),
  rule("ES", { nameEn: "Spain", nameUk: "Іспанія", pattern: "^(?:0[1-9]|[1-4]\\d|5[0-2])\\d{3}$", example: "28013" }),
  rule("NL", { nameEn: "Netherlands", nameUk: "Нідерланди", pattern: "^[1-9]\\d{3} [A-Z]{2}$", example: "1011 AB" }),
  rule("BE", { nameEn: "Belgium", nameUk: "Бельгія", pattern: "^[1-9]\\d{3}$", example: "1000" }),
  rule("AT", { nameEn: "Austria", nameUk: "Австрія", pattern: "^[1-9]\\d{3}$", example: "1010" }),
  rule("CZ", { nameEn: "Czechia", nameUk: "Чехія", pattern: "^\\d{3} \\d{2}$", example: "110 00" }),
  rule("SK", { nameEn: "Slovakia", nameUk: "Словаччина", pattern: "^\\d{3} \\d{2}$", example: "811 01" }),
  rule("SE", { nameEn: "Sweden", nameUk: "Швеція", pattern: "^[1-9]\\d{2} \\d{2}$", example: "114 55" }),
  rule("DK", { nameEn: "Denmark", nameUk: "Данія", pattern: "^\\d{4}$", example: "1050" }),
  rule("FI", { nameEn: "Finland", nameUk: "Фінляндія", pattern: "^\\d{5}$", example: "00100" }),
  rule("PT", { nameEn: "Portugal", nameUk: "Португалія", pattern: "^\\d{4}-\\d{3}$", example: "1000-001" }),
  rule("IE", {
    nameEn: "Ireland",
    nameUk: "Ірландія",
    pattern: IE_EIRCODE,
    example: "D02 X285",
    postalCodeRequired: false,
    notes: `${VERIFY} Eircode is optional; when given it must be a valid Eircode.`,
  }),
  rule("LT", {
    nameEn: "Lithuania",
    nameUk: "Литва",
    pattern: "^(?:LT-)?\\d{5}$",
    example: "LT-01100",
    notes: `${VERIFY} Official format is LT-12345; the 5-digit form is also accepted.`,
  }),
  rule("LV", {
    nameEn: "Latvia",
    nameUk: "Латвія",
    pattern: "^(?:LV-)?\\d{4}$",
    example: "LV-1050",
    notes: `${VERIFY} Official format is LV-1234; the 4-digit form is also accepted.`,
  }),
  rule("EE", { nameEn: "Estonia", nameUk: "Естонія", pattern: "^\\d{5}$", example: "10111" }),
  rule("RO", { nameEn: "Romania", nameUk: "Румунія", pattern: "^\\d{6}$", example: "010011" }),
  rule("HU", { nameEn: "Hungary", nameUk: "Угорщина", pattern: "^[1-9]\\d{3}$", example: "1051" }),
  rule("GR", { nameEn: "Greece", nameUk: "Греція", pattern: "^\\d{3} ?\\d{2}$", example: "105 57" }),
  rule("BG", { nameEn: "Bulgaria", nameUk: "Болгарія", pattern: "^\\d{4}$", example: "1000" }),
  rule("HR", { nameEn: "Croatia", nameUk: "Хорватія", pattern: "^\\d{5}$", example: "10000" }),
  rule("SI", { nameEn: "Slovenia", nameUk: "Словенія", pattern: "^\\d{4}$", example: "1000" }),
  rule("LU", { nameEn: "Luxembourg", nameUk: "Люксембург", pattern: "^\\d{4}$", example: "1009" }),
  rule("GB", { nameEn: "United Kingdom", nameUk: "Велика Британія", pattern: GB_POSTCODE, example: "SW1A 1AA" }),
  rule("CH", { nameEn: "Switzerland", nameUk: "Швейцарія", pattern: "^[1-9]\\d{3}$", example: "8001" }),
  rule("NO", { nameEn: "Norway", nameUk: "Норвегія", pattern: "^\\d{4}$", example: "0150" }),
  rule("US", {
    nameEn: "United States",
    nameUk: "Сполучені Штати Америки",
    pattern: "^\\d{5}(?:-\\d{4})?$",
    example: "10001",
    provinceRequired: true,
    notes: `${VERIFY} ZIP or ZIP+4; state is required.`,
  }),
  rule("CA", {
    nameEn: "Canada",
    nameUk: "Канада",
    pattern: CA_POSTCODE,
    example: "K1A 0B1",
    provinceRequired: true,
    notes: `${VERIFY} Province is required.`,
  }),
  rule("AU", {
    nameEn: "Australia",
    nameUk: "Австралія",
    pattern: "^\\d{4}$",
    example: "2000",
    provinceRequired: true,
    notes: `${VERIFY} State is required.`,
  }),
  rule("JP", { nameEn: "Japan", nameUk: "Японія", pattern: "^\\d{3}-\\d{4}$", example: "100-0001" }),
  rule("IL", { nameEn: "Israel", nameUk: "Ізраїль", pattern: "^\\d{7}$", example: "6100000" }),
  rule("AE", {
    nameEn: "United Arab Emirates",
    nameUk: "Об'єднані Арабські Емірати",
    pattern: null,
    example: null,
    notes: `${VERIFY} No postal codes in use.`,
  }),
  rule("HK", {
    nameEn: "Hong Kong",
    nameUk: "Гонконг",
    pattern: null,
    example: null,
    notes: `${VERIFY} No postal codes in use.`,
  }),
  rule("UA", {
    nameEn: "Ukraine",
    nameUk: "Україна",
    pattern: "^\\d{5}$",
    example: "01001",
    shippingEnabled: false,
    notes: "Origin country: domestic shipping is out of scope.",
  }),
  rule("RU", {
    nameEn: "Russia",
    nameUk: "Росія",
    pattern: "^\\d{6}$",
    example: "101000",
    shippingEnabled: false,
    notes: "Shipping prohibited.",
  }),
  rule("BY", {
    nameEn: "Belarus",
    nameUk: "Білорусь",
    pattern: "^\\d{6}$",
    example: "220030",
    shippingEnabled: false,
    notes: "Shipping prohibited.",
  }),
];
