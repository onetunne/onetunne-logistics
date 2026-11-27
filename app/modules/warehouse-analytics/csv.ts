/**
 * CSV для експорту складських даних (чисті функції).
 *
 * Формат (docs/telegram-warehouse-readiness.md, розділ «Експорт CSV»):
 * - UTF-8 з BOM (Excel правильно відкриває кирилицю), рядки — CRLF (RFC 4180);
 * - профіль за роздільником:
 *   «;» (за замовчуванням) — Excel з українськими/європейськими регіональними налаштуваннями: десяткова КОМА
 *       («12,5», «120,00»), інакше Excel перетворює «12.5» на дату 12 травня, а «120.00» — на текст;
 *   «,» — програми й Google Sheets (машиночитаний): десяткова КРАПКА («12.5»);
 *   групування розрядів немає в жодному профілі; дати — ISO 8601; заголовки — стабільні англійські snake_case
 *   (для програм: майбутній фінансовий модуль, ШІ);
 * - числа: тип number або CsvDecimal (точний десятковий рядок, напр. гроші) — пишуться з десятковим знаком профілю;
 * - текст із «;» або «,» (будь-яким із двох роздільників), лапками, переносом рядка або пробілом на краю — у лапках
 *   (лапки подвоюються): файл однаково ділиться на комірки, хоч би який роздільник обрав Excel;
 * - захист від CSV-ін'єкцій: текст, що починається з = + - @ (також після пробілів/лапок) або табуляції/CR, отримує
 *   префікс «'». Те саме — після КОЖНОЇ можливої межі комірки всередині тексту («,», «;», табуляція, перенос рядка):
 *   Excel ділить файл за системним роздільником списку, а не за тим, з яким файл записано, тож «Black,=FORMULA()»
 *   у файлі з «;» стало б окремою коміркою-формулою. Числа не змінюються.
 */

export const CSV_SEPARATORS = { semicolon: ";", comma: "," } as const;
export type CsvSeparatorKey = keyof typeof CSV_SEPARATORS;
export const DEFAULT_CSV_SEPARATOR: CsvSeparatorKey = "semicolon";
/** Десятковий знак профілю: «;» — Excel (uk/EU), кома; «,» — програми/Sheets, крапка. */
export const CSV_DECIMAL_MARKS: Readonly<Record<CsvSeparatorKey, "," | ".">> = { semicolon: ",", comma: "." };
export const CSV_BOM = "\uFEFF";
export const CSV_CONTENT_TYPE = "text/csv; charset=utf-8";

export function isCsvSeparatorKey(value: unknown): value is CsvSeparatorKey {
  return value === "semicolon" || value === "comma";
}

const DECIMAL_TEXT_RE = /^-?\d+(?:\.\d+)?$/;

/** Точне десяткове число як рядок із крапкою ("120.00", "-0.333"); у файлі — з десятковим знаком профілю. */
export class CsvDecimal {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export type CsvValue = string | number | boolean | null | undefined | CsvDecimal;

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => CsvValue;
}

/** Початок формули на початку тексту (також після пробілів/лапок) або керівний символ. */
const FORMULA_START = /^(?:[\t\r]|[\s"]*[=+\-@])/;
/** Можлива межа комірки всередині тексту, за якою (після пробілів/лапок) — початок формули. */
const INNER_FORMULA_BOUNDARY = /([,;\t\r\n])(?=[\s"]*[=+\-@])/g;

function decimalMarkFor(separator: string): "," | "." {
  return separator === CSV_SEPARATORS.semicolon ? CSV_DECIMAL_MARKS.semicolon : CSV_DECIMAL_MARKS.comma;
}

function numberCell(text: string, separator: string, decimalMark: "," | "."): string {
  const out = decimalMark === "." ? text : text.replace(".", decimalMark);
  return out.includes(separator) ? `"${out}"` : out;
}

/**
 * Одна комірка CSV. Десятковий знак за замовчуванням — профілю роздільника («;» → «,», «,» → «.»).
 */
export function csvCell(value: CsvValue, separator: string, decimalMark: "," | "." = decimalMarkFor(separator)): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    return Number.isFinite(value) ? numberCell(String(value), separator, decimalMark) : "";
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof CsvDecimal) {
    if (DECIMAL_TEXT_RE.test(value.value)) return numberCell(value.value, separator, decimalMark);
    value = value.value; // не число — як звичайний текст (з усіма захистами)
  }
  let text = value.replace(INNER_FORMULA_BOUNDARY, "$1'");
  if (FORMULA_START.test(text)) text = `'${text}`;
  const needsQuotes = text.includes(separator) || /[,;"\r\n]/.test(text) || /^\s|\s$/.test(text);
  return needsQuotes ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Повний CSV: заголовок + рядки. */
export function buildCsv<T>(
  columns: ReadonlyArray<CsvColumn<T>>,
  rows: readonly T[],
  opts: { separator?: CsvSeparatorKey; bom?: boolean } = {},
): string {
  const key = opts.separator ?? DEFAULT_CSV_SEPARATOR;
  const sep = CSV_SEPARATORS[key];
  const mark = CSV_DECIMAL_MARKS[key];
  const lines = [columns.map((c) => csvCell(c.header, sep, mark)).join(sep)];
  for (const row of rows) lines.push(columns.map((c) => csvCell(c.value(row), sep, mark)).join(sep));
  return `${opts.bom === false ? "" : CSV_BOM}${lines.join("\r\n")}\r\n`;
}

/** Десяткове число для CSV (фіксована кількість знаків; знак — профілю файлу) або порожньо. */
export function csvDecimal(value: number | null | undefined, digits: number): CsvDecimal | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return new CsvDecimal(value.toFixed(digits));
}

/** Точна сума/десятковий рядок із даних ("120.00") для CSV або порожньо. */
export function csvAmount(value: string | null | undefined): CsvDecimal | null {
  return value ? new CsvDecimal(value) : null;
}

/** Безпечне ім'я файлу: [a-z0-9._-], без «..» і без крапки/дефіса на початку. */
export function csvFileName(...parts: string[]): string {
  const base = parts
    .join("_")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 120);
  return `${base || "export"}.csv`;
}
