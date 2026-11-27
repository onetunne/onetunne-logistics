/**
 * Узгодженість поштового індексу з регіоном (штат/провінція). Лише ПОПЕРЕДЖЕННЯ:
 * невідомо, що саме помилкове — індекс чи регіон, тому нічого не змінюється й не пропонується.
 *
 * Канада (Canada Post): перша літера індексу (Forward Sortation Area) визначає провінцію.
 * X — спільна для Північно-Західних територій і Нунавуту.
 *
 * США (USPS): перша цифра ZIP — національна зона (National Area). Відомі винятки, коли
 * штат має ZIP з іншою першою цифрою (включено як дозволені):
 * - NY: 005xx (Holtsville, IRS) і 06390 (Fishers Island) → зона 0;
 * - TX: 885xx (El Paso) → зона 8;
 * - DC: 569xx (федеральні установи) → зона 5.
 * Військові: AA = 340xx (зона 3), AE = 090–098 (зона 0), AP = 962–966 (зона 9).
 */

/** Канада: перша літера індексу → можливі провінції/території. */
const CA_FIRST_LETTER: Readonly<Record<string, readonly string[]>> = {
  A: ["NL"],
  B: ["NS"],
  C: ["PE"],
  E: ["NB"],
  G: ["QC"],
  H: ["QC"],
  J: ["QC"],
  K: ["ON"],
  L: ["ON"],
  M: ["ON"],
  N: ["ON"],
  P: ["ON"],
  R: ["MB"],
  S: ["SK"],
  T: ["AB"],
  V: ["BC"],
  X: ["NT", "NU"],
  Y: ["YT"],
};

/** США: перша цифра ZIP → штати/території/військові коди зони. */
const US_FIRST_DIGIT: Readonly<Record<string, readonly string[]>> = {
  "0": ["CT", "MA", "ME", "NH", "NJ", "PR", "RI", "VT", "VI", "AE"],
  "1": ["DE", "NY", "PA"],
  "2": ["DC", "MD", "NC", "SC", "VA", "WV"],
  "3": ["AL", "FL", "GA", "MS", "TN", "AA"],
  "4": ["IN", "KY", "MI", "OH"],
  "5": ["IA", "MN", "MT", "ND", "SD", "WI"],
  "6": ["IL", "KS", "MO", "NE"],
  "7": ["AR", "LA", "OK", "TX"],
  "8": ["AZ", "CO", "ID", "NM", "NV", "UT", "WY"],
  "9": ["AK", "CA", "HI", "OR", "WA", "AP", "AS", "GU", "MP", "FM", "MH", "PW"],
};

/** США: точкові винятки (префікс ZIP → штат), коли штат лежить поза своєю основною зоною. */
const US_EXCEPTIONS: ReadonlyArray<{ prefix: string; region: string }> = [
  { prefix: "005", region: "NY" },
  { prefix: "06390", region: "NY" },
  { prefix: "885", region: "TX" },
  { prefix: "569", region: "DC" },
];

export interface PostalRegionCheck {
  /** Символ індексу, за яким перевірено (перша літера/цифра). */
  prefix: string;
  /** Регіони, яким відповідає цей символ. */
  expected: readonly string[];
}

/**
 * Перевіряє, чи відповідає індекс регіону. Повертає null, якщо все узгоджено або перевірити
 * неможливо (країна без таблиці, невідомий регіон, порожні значення); інакше — що очікувалось.
 * Індекс має бути ВЖЕ нормалізованим і відповідати формату країни (перевіряє викликач).
 */
export function checkPostalRegion(country: string | null, postalCode: string, region: string): PostalRegionCheck | null {
  const prefix = postalCode.charAt(0).toUpperCase();
  if (prefix === "") return null;
  if (country === "CA") {
    const expected = CA_FIRST_LETTER[prefix];
    if (!expected) return null;
    return expected.includes(region) ? null : { prefix, expected };
  }
  if (country === "US") {
    const expected = US_FIRST_DIGIT[prefix];
    if (!expected) return null;
    if (expected.includes(region)) return null;
    if (US_EXCEPTIONS.some((e) => e.region === region && postalCode.startsWith(e.prefix))) return null;
    // Регіон, якого немає в жодній зоні (напр. невідомий код), не перевіряємо.
    if (!Object.values(US_FIRST_DIGIT).some((list) => list.includes(region))) return null;
    return { prefix, expected };
  }
  return null;
}
