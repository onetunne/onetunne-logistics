import type { CountryRule } from "./types";

/**
 * Нормалізація поштового індексу.
 *
 * Дозволено лише зміну регістру, пробілів і розташування дефіса.
 * Цифри й літери індексу ніколи не додаються, не видаляються і не замінюються.
 */

export interface PostalNormalization {
  value: string;
  changed: boolean;
}

/** Прибирає пробіли й дефіси — «скелет» індексу, який не можна змінювати. */
function skeleton(value: string): string {
  return value.replace(/[\s-]/g, "");
}

/** true, якщо `to` відрізняється від `from` лише регістром, пробілами та дефісами. */
export function isFormatOnlyPostalChange(from: string, to: string): boolean {
  return skeleton(from.toUpperCase()) === skeleton(to.toUpperCase());
}

const insertAt = (s: string, index: number, sep: string) => `${s.slice(0, index)}${sep}${s.slice(index)}`;

type Reformatter = (compact: string) => string | null;

const spaceBeforeLast3: Reformatter = (s) => (/^[A-Z0-9]{5,7}$/.test(s) ? insertAt(s, s.length - 3, " ") : null);
const digits5As3Space2: Reformatter = (s) => (/^\d{5}$/.test(s) ? insertAt(s, 3, " ") : null);

/** Відомі переформатувальники за країною. Вхід — індекс без пробілів і дефісів. */
const REFORMATTERS: Readonly<Record<string, Reformatter>> = {
  GB: spaceBeforeLast3,
  CA: (s) => (/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(s) ? insertAt(s, 3, " ") : null),
  NL: (s) => (/^\d{4}[A-Z]{2}$/.test(s) ? insertAt(s, 4, " ") : null),
  PL: (s) => (/^\d{5}$/.test(s) ? insertAt(s, 2, "-") : null),
  PT: (s) => (/^\d{7}$/.test(s) ? insertAt(s, 4, "-") : null),
  JP: (s) => (/^\d{7}$/.test(s) ? insertAt(s, 3, "-") : null),
  IE: (s) => (/^[A-Z0-9]{7}$/.test(s) ? insertAt(s, 3, " ") : null),
  SE: digits5As3Space2,
  CZ: digits5As3Space2,
  SK: digits5As3Space2,
  BR: (s) => (/^\d{8}$/.test(s) ? insertAt(s, 5, "-") : null),
};

const patternCache = new Map<string, RegExp | null>();
const PATTERN_CACHE_LIMIT = 500;
/** Індекси коротші; довші значення не перевіряються регулярним виразом (захист від надмірного часу перевірки). */
export const MAX_POSTAL_LENGTH = 20;

/**
 * Безпечний підмножина регулярних виразів для індексів (шаблони вносить власник — захист від «зависання»
 * сервера, ReDoS): без необмежених повторів (+, *, {n,}), без зворотних посилань і lookaround.
 * Індекси мають фіксовану довжину, тож {n} / {n,m} і ? достатньо.
 */
export function isSafePostalPattern(pattern: string): boolean {
  if (/\\[1-9]|\\k<|\(\?<?[=!]/.test(pattern)) return false;
  // Необмежені повтори: + або * (не всередині [...]) та {n,}.
  const withoutClasses = pattern.replace(/\[(?:\\.|[^\]\\])*\]/g, "C").replace(/\\./g, "E");
  if (/[+*]/.test(withoutClasses)) return false;
  if (/\{\d+,\}/.test(withoutClasses)) return false;
  return true;
}

/** Компілює шаблон країни для ПОВНОГО збігу. Некоректний або небезпечний шаблон → null (перевірка неможлива). */
export function compilePostalPattern(pattern: string): RegExp | null {
  if (patternCache.has(pattern)) return patternCache.get(pattern) ?? null;
  let re: RegExp | null;
  try {
    re = isSafePostalPattern(pattern) ? new RegExp(`^(?:${pattern})$`) : null;
  } catch {
    re = null;
  }
  if (patternCache.size >= PATTERN_CACHE_LIMIT) patternCache.clear();
  patternCache.set(pattern, re);
  return re;
}

/** Країна без індексів: індекс не обов'язковий і формат не перевіряється. */
export function countryHasNoPostalCodes(rule: CountryRule | undefined): boolean {
  return rule !== undefined && !rule.postalCodeRequired && rule.postalCodePattern === null;
}

export function normalizePostalCode(raw: string, rule: CountryRule | undefined): PostalNormalization {
  // Для країн без індексів значення не чіпаємо.
  if (countryHasNoPostalCodes(rule)) return { value: raw, changed: false };

  const base = raw.replace(/\s+/g, " ").trim().toUpperCase();
  let value = base;

  const pattern = rule?.postalCodePattern ? compilePostalPattern(rule.postalCodePattern) : null;
  const reformat = rule ? REFORMATTERS[rule.countryCode.trim().toUpperCase()] : undefined;
  if (pattern && reformat && base.length <= MAX_POSTAL_LENGTH && !pattern.test(base)) {
    const candidate = reformat(skeleton(base));
    // Застосовуємо лише якщо результат повністю відповідає шаблону і символи індексу ті самі.
    if (candidate !== null && pattern.test(candidate) && isFormatOnlyPostalChange(base, candidate)) {
      value = candidate;
    }
  }

  return { value, changed: value !== raw };
}

/** Чи відповідає індекс шаблону країни. null — перевірити неможливо (немає шаблону). */
export function matchesPostalPattern(value: string, rule: CountryRule | undefined): boolean | null {
  if (!rule?.postalCodePattern) return null;
  const re = compilePostalPattern(rule.postalCodePattern);
  if (!re) return null;
  if (value.length > MAX_POSTAL_LENGTH) return false;
  return re.test(value);
}
