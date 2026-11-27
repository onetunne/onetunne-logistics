/**
 * Довідник регіонів (штатів, провінцій, територій) для країн, де регіон в адресі обов'язковий
 * (provinceRequired у типових правилах країн: US, CA, AU).
 *
 * Shopify зберігає в адресі provinceCode — саме ці коди тут і перелічено (частина коду ISO 3166-2
 * після «XX-»). Якщо provinceCode немає, синхронізація зберігає назву регіону — для неї
 * валідатор лише ПРОПОНУЄ код (підтверджує менеджер).
 *
 * Джерела (лише дані, у яких немає сумніву):
 * - US: ISO 3166-2:US (50 штатів, DC, AS, GU, MP, PR, VI) + коди USPS, які використовує Shopify
 *   для поштових адрес: FM, MH, PW (вільно асоційовані держави з поштою USPS) та AA, AE, AP
 *   (військова пошта). Код UM (Зовнішні малі острови США) свідомо не включено: у USPS його немає.
 * - CA: ISO 3166-2:CA (10 провінцій, 3 території) = коди Canada Post.
 * - AU: ISO 3166-2:AU (6 штатів, 2 території) = скорочення Australia Post.
 */

export type RegionKind = "state" | "province" | "territory" | "district" | "freely_associated" | "military";

export interface Region {
  /** Код регіону без префікса країни (як provinceCode у Shopify), напр. "NY". */
  code: string;
  /** Офіційна англійська назва. */
  name: string;
  kind: RegionKind;
  /** Інші однозначні назви того самого регіону (для пропозиції коду). */
  aliases?: readonly string[];
}

const r = (code: string, name: string, kind: RegionKind, aliases?: readonly string[]): Region =>
  aliases ? { code, name, kind, aliases } : { code, name, kind };

const US_REGIONS: readonly Region[] = [
  r("AL", "Alabama", "state"),
  r("AK", "Alaska", "state"),
  r("AZ", "Arizona", "state"),
  r("AR", "Arkansas", "state"),
  r("CA", "California", "state"),
  r("CO", "Colorado", "state"),
  r("CT", "Connecticut", "state"),
  r("DE", "Delaware", "state"),
  r("FL", "Florida", "state"),
  r("GA", "Georgia", "state"),
  r("HI", "Hawaii", "state"),
  r("ID", "Idaho", "state"),
  r("IL", "Illinois", "state"),
  r("IN", "Indiana", "state"),
  r("IA", "Iowa", "state"),
  r("KS", "Kansas", "state"),
  r("KY", "Kentucky", "state"),
  r("LA", "Louisiana", "state"),
  r("ME", "Maine", "state"),
  r("MD", "Maryland", "state"),
  r("MA", "Massachusetts", "state"),
  r("MI", "Michigan", "state"),
  r("MN", "Minnesota", "state"),
  r("MS", "Mississippi", "state"),
  r("MO", "Missouri", "state"),
  r("MT", "Montana", "state"),
  r("NE", "Nebraska", "state"),
  r("NV", "Nevada", "state"),
  r("NH", "New Hampshire", "state"),
  r("NJ", "New Jersey", "state"),
  r("NM", "New Mexico", "state"),
  r("NY", "New York", "state"),
  r("NC", "North Carolina", "state"),
  r("ND", "North Dakota", "state"),
  r("OH", "Ohio", "state"),
  r("OK", "Oklahoma", "state"),
  r("OR", "Oregon", "state"),
  r("PA", "Pennsylvania", "state"),
  r("RI", "Rhode Island", "state"),
  r("SC", "South Carolina", "state"),
  r("SD", "South Dakota", "state"),
  r("TN", "Tennessee", "state"),
  r("TX", "Texas", "state"),
  r("UT", "Utah", "state"),
  r("VT", "Vermont", "state"),
  r("VA", "Virginia", "state"),
  r("WA", "Washington", "state"),
  r("WV", "West Virginia", "state"),
  r("WI", "Wisconsin", "state"),
  r("WY", "Wyoming", "state"),
  r("DC", "District of Columbia", "district", ["Washington, D.C."]),
  r("AS", "American Samoa", "territory"),
  r("GU", "Guam", "territory"),
  r("MP", "Northern Mariana Islands", "territory"),
  r("PR", "Puerto Rico", "territory"),
  r("VI", "U.S. Virgin Islands", "territory", ["Virgin Islands, U.S.", "United States Virgin Islands"]),
  r("FM", "Federated States of Micronesia", "freely_associated", ["Micronesia, Federated States of"]),
  r("MH", "Marshall Islands", "freely_associated"),
  r("PW", "Palau", "freely_associated"),
  r("AA", "Armed Forces Americas", "military"),
  r("AE", "Armed Forces Europe", "military"),
  r("AP", "Armed Forces Pacific", "military"),
];

const CA_REGIONS: readonly Region[] = [
  r("AB", "Alberta", "province"),
  r("BC", "British Columbia", "province"),
  r("MB", "Manitoba", "province"),
  r("NB", "New Brunswick", "province"),
  r("NL", "Newfoundland and Labrador", "province"),
  r("NS", "Nova Scotia", "province"),
  r("ON", "Ontario", "province"),
  r("PE", "Prince Edward Island", "province"),
  r("QC", "Quebec", "province"),
  r("SK", "Saskatchewan", "province"),
  r("NT", "Northwest Territories", "territory"),
  r("NU", "Nunavut", "territory"),
  r("YT", "Yukon", "territory"),
];

const AU_REGIONS: readonly Region[] = [
  r("NSW", "New South Wales", "state"),
  r("QLD", "Queensland", "state"),
  r("SA", "South Australia", "state"),
  r("TAS", "Tasmania", "state"),
  r("VIC", "Victoria", "state"),
  r("WA", "Western Australia", "state"),
  r("ACT", "Australian Capital Territory", "territory"),
  r("NT", "Northern Territory", "territory"),
];

export const REGIONS: Readonly<Record<string, readonly Region[]>> = {
  US: US_REGIONS,
  CA: CA_REGIONS,
  AU: AU_REGIONS,
};

/** Регіони країни або null, якщо довідника для країни немає (перевірка коду неможлива). */
export function regionsOf(country: string | null): readonly Region[] | null {
  if (!country) return null;
  return REGIONS[country.trim().toUpperCase()] ?? null;
}

/** Точний відомий код регіону (з урахуванням регістру) або null. */
export function findRegionByCode(country: string | null, code: string | null): Region | null {
  const regions = regionsOf(country);
  if (!regions || code === null) return null;
  return regions.find((reg) => reg.code === code) ?? null;
}

/**
 * Ключ для порівняння назв: без діакритики й регістру, без крапок і апострофів,
 * інші розділові знаки → пробіл. "Québec" → "quebec", "U.S. Virgin Islands" → "us virgin islands".
 */
export function regionNameKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[.'’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Можливі коди для значення, яке не є відомим кодом: точний збіг з назвою або іншою назвою
 * регіону, або повний код ISO 3166-2 ("US-NY"). Нічого не «вгадує» за частковим збігом.
 */
export function regionCandidates(country: string | null, value: string): string[] {
  const regions = regionsOf(country);
  if (!regions || !country) return [];
  const key = regionNameKey(value);
  if (key === "") return [];
  const out: string[] = [];
  const add = (code: string) => {
    if (!out.includes(code)) out.push(code);
  };
  for (const reg of regions) {
    if ([reg.name, ...(reg.aliases ?? [])].some((n) => regionNameKey(n) === key)) add(reg.code);
  }
  const iso = /^([A-Za-z]{2})[-\s]([A-Za-z]{2,3})$/.exec(value.trim());
  if (iso && iso[1]?.toUpperCase() === country.trim().toUpperCase()) {
    const reg = findRegionByCode(country, (iso[2] ?? "").toUpperCase());
    if (reg) add(reg.code);
  }
  return out;
}
