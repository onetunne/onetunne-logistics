/**
 * Розділення рядка адреси на вулицю й номер будинку — ЛИШЕ однозначні випадки.
 * Деякі перевізники (Nova Post: addressParts.street + building) вимагають окремі поля.
 * Нічого не вигадується: якщо номер будинку не виділяється однозначно — null (менеджер уточнює адресу).
 *
 * Однозначні формати:
 * - «вулиця номер» (Європа):     "Hauptstraße 12a" → street "Hauptstraße", building "12a"
 * - «номер вулиця» (США/UK/CA):  "123 Main St"      → street "Main St", building "123"
 * Неоднозначні (→ null): немає цифр; номер і на початку, і в кінці ("12 Rue 5"); лише номер; поштова скринька.
 */

/** Номер будинку: 1–5 цифр, необов'язкова літера, необов'язковий дріб/діапазон (12/3, 12-14, 7B). */
const HOUSE = String.raw`\d{1,5}\s?[A-Za-z]?(?:\s?[/-]\s?\d{1,5}\s?[A-Za-z]?)?`;
const TRAILING = new RegExp(String.raw`^(.*?[^\d\s,][^\d]*?)[\s,]+(?:No\.?\s*|Nr\.?\s*|№\s*)?(${HOUSE})$`, "u");
const LEADING = new RegExp(String.raw`^(${HOUSE})[\s,]+(.*\D.*)$`, "u");
const PO_BOX = /\b(p\.?\s?o\.?\s?box|postfach|apartado|skrytka)\b/i;

export interface StreetParts {
  street: string;
  building: string;
}

export function splitStreetAndBuilding(address1: string | null | undefined): StreetParts | null {
  const value = (address1 ?? "").trim().replace(/\s+/g, " ");
  if (!value || !/\d/.test(value) || PO_BOX.test(value)) return null;
  const trailing = TRAILING.exec(value);
  const leading = LEADING.exec(value);
  const t = trailing ? { street: trailing[1]!.trim().replace(/[,\s]+$/, ""), building: trailing[2]!.replace(/\s+/g, "") } : null;
  const l = leading ? { street: leading[2]!.trim(), building: leading[1]!.replace(/\s+/g, "") } : null;
  // Номер і на початку, і в кінці → неоднозначно.
  if (t && l) return null;
  const parts = t ?? l;
  if (!parts) return null;
  // Вулиця має містити літери й не містити інших чисел-кандидатів у кінці/на початку.
  if (!/\p{L}/u.test(parts.street)) return null;
  if (parts.street.length === 0 || parts.building.length === 0) return null;
  return parts;
}
