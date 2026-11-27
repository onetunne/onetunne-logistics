import { matchesPostalPattern, normalizePostalCode } from "./postal";
import type { CountryRule } from "./types";

/**
 * Пошук поштового індексу в полі «Місто» ("10115 Berlin", "Berlin, 10115", "1011 AB Amsterdam").
 *
 * Індекс визнається лише якщо початкові або кінцеві 1–2 «слова» після нормалізації ПОВНІСТЮ
 * відповідають формату країни доставки, а решта містить літери. Нічого не вигадується:
 * кандидати — це лише частини того, що ввів клієнт.
 */

export interface CityPostalExtraction {
  /** Місто без індексу (як введено, без зайвих розділювачів). */
  city: string;
  /** Індекс у стандартному форматі країни. */
  postalCode: string;
}

/** Розділювачі між індексом і назвою міста, які можна відкинути. */
const EDGE_SEPARATORS = /^[\s,;\-–—]+|[\s,;\-–—]+$/g;

export function extractPostalFromCity(city: string | null, rule: CountryRule | undefined): CityPostalExtraction[] {
  if (city === null || !rule?.postalCodePattern) return [];
  const tokens = city.replace(/,/g, " , ").split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return [];

  const out: CityPostalExtraction[] = [];
  const consider = (codeTokens: string[], rest: string[]) => {
    const raw = codeTokens.join(" ");
    if (!/\d/.test(raw)) return;
    const { value } = normalizePostalCode(raw, rule);
    if (matchesPostalPattern(value, rule) !== true) return;
    const name = rest.join(" ").replace(/\s+,/g, ",").replace(EDGE_SEPARATORS, "").trim();
    if (!/\p{L}/u.test(name)) return;
    if (!out.some((e) => e.city === name && e.postalCode === value)) out.push({ city: name, postalCode: value });
  };

  for (const size of [2, 1]) {
    if (tokens.length <= size) continue;
    consider(tokens.slice(0, size), tokens.slice(size));
    consider(tokens.slice(tokens.length - size), tokens.slice(0, tokens.length - size));
  }
  // Кілька різних тлумачень (напр. "10115 Berlin 10117") — усі повертаються, рішення за менеджером.
  return out;
}
