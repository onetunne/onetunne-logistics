/**
 * Контроль комплектації (чисті функції, без БД): зіставлення сканування з позиціями замовлення, ручні +/−,
 * повнота чекліста. Чекліст — order_packing.checklist: { [lineItemId]: запаковано одиниць }.
 *
 * Сканування (апаратний сканер працює як клавіатура: код + Enter; або ручне введення; або камера):
 * - код нормалізується: без керівних символів (CR/LF/Tab від сканера) і пробілів, без різниці регістру;
 *   для цифрових кодів (EAN-13 / UPC-A / GTIN-14) провідні нулі не важливі (04820… = 4820…);
 * - спершу шукається збіг зі штрихкодом варіанта, потім із SKU (варіанта або позиції);
 * - кілька позицій того самого варіанта → перша, де ще бракує одиниць;
 * - код відповідає різним варіантам (однаковий SKU/штрихкод у позиціях замовлення — тут; у КАТАЛОЗІ, зокрема варіанти
 *   поза замовленням, — recordScan у packing.server.ts) → «неоднозначно» (ручне +, звірити модель і колір);
 * - усі одиниці позиції вже запаковано → «більше, ніж замовлено» (чекліст не змінюється);
 * - код не відповідає жодній позиції → «не з цього замовлення».
 * Кожне вдале сканування — +1 одиниця.
 */

export interface ChecklistLine {
  /** order_line_items.id */
  id: string;
  variantId: string | null;
  sku: string | null;
  barcode: string | null;
  /** Потрібно запакувати (effectiveLineQuantity). */
  required: number;
}

export type Checklist = Readonly<Record<string, number>>;

export type ScanMatch =
  | { kind: "matched"; lineId: string; packed: number; required: number; lineComplete: boolean; by: "barcode" | "sku" }
  | { kind: "over_quantity"; lineId: string; packed: number; required: number }
  | { kind: "ambiguous"; lineIds: string[] }
  | { kind: "not_found" }
  | { kind: "empty" };

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/** Код зі сканера/поля введення: без керівних символів і крайніх пробілів (довжина обмежена). */
export function normalizeScanCode(raw: string, maxLength = 64): string {
  return raw.replace(CONTROL_CHARS, "").trim().slice(0, maxLength);
}

/** Ключ порівняння: без пробілів, верхній регістр; цифровий код — без провідних нулів. */
export function codeKey(value: string | null | undefined): string {
  if (!value) return "";
  const compact = value.replace(CONTROL_CHARS, "").replace(/\s+/g, "").toUpperCase();
  if (/^\d+$/.test(compact)) return compact.replace(/^0+(?=\d)/, "");
  return compact;
}

/** Запаковано одиниць позиції (некоректне значення в чеклісті → 0). */
export function packedQty(checklist: Checklist, lineId: string): number {
  const v = checklist[lineId];
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : 0;
}

/** Зіставлення коду з позиціями (чекліст не змінюється). */
export function matchScan(lines: readonly ChecklistLine[], checklist: Checklist, rawCode: string): ScanMatch {
  const key = codeKey(normalizeScanCode(rawCode));
  if (!key) return { kind: "empty" };
  const packable = lines.filter((l) => l.required > 0);
  let by: "barcode" | "sku" = "barcode";
  let candidates = packable.filter((l) => codeKey(l.barcode) === key);
  if (candidates.length === 0) {
    by = "sku";
    candidates = packable.filter((l) => codeKey(l.sku) === key);
  }
  if (candidates.length === 0) return { kind: "not_found" };
  // Різні варіанти з однаковим кодом — помилка каталогу: пакувальник обирає позицію вручну.
  const variants = new Set(candidates.map((l) => l.variantId ?? `line:${l.id}`));
  if (variants.size > 1) return { kind: "ambiguous", lineIds: candidates.map((l) => l.id) };
  const target = candidates.find((l) => packedQty(checklist, l.id) < l.required);
  if (!target) {
    const last = candidates[candidates.length - 1]!;
    return { kind: "over_quantity", lineId: last.id, packed: packedQty(checklist, last.id), required: last.required };
  }
  const packed = packedQty(checklist, target.id) + 1;
  return { kind: "matched", lineId: target.id, packed, required: target.required, lineComplete: packed >= target.required, by };
}

/** Сканування: зіставлення + новий чекліст (лише для matched; інакше — той самий). */
export function applyScan(
  lines: readonly ChecklistLine[],
  checklist: Checklist,
  rawCode: string,
): { match: ScanMatch; checklist: Record<string, number> } {
  const match = matchScan(lines, checklist, rawCode);
  const next = sanitizeChecklist(lines, checklist);
  if (match.kind === "matched") next[match.lineId] = match.packed;
  return { match, checklist: next };
}

export type AdjustResult =
  | { kind: "ok"; checklist: Record<string, number>; packed: number; required: number }
  | { kind: "over_quantity"; packed: number; required: number }
  | { kind: "below_zero" }
  | { kind: "unknown_line" };

/**
 * Ручна зміна на ±1 (сканер не читає код тощо): +1 — не більше потрібного; −1 — не менше 0. −1 завжди дозволено для
 * зайвих одиниць (більше потрібного — напр. кількість зменшили в Shopify після сканування): так пакувальник сам
 * виправляє чекліст до потрібного, без рішення власника.
 */
export function adjustChecklist(lines: readonly ChecklistLine[], checklist: Checklist, lineId: string, delta: 1 | -1): AdjustResult {
  const line = lines.find((l) => l.id === lineId && l.required > 0);
  if (!line) {
    // Позицію могли видалити/обнулити в Shopify, а в чеклісті лишилися одиниці: дозволяємо лише зняти їх.
    const stale = packedQty(checklist, lineId);
    if (delta === -1 && stale > 0) {
      const next = sanitizeChecklist(lines, checklist, { keepStale: true });
      next[lineId] = stale - 1;
      if (next[lineId] === 0) delete next[lineId];
      return { kind: "ok", checklist: next, packed: stale - 1, required: 0 };
    }
    return { kind: "unknown_line" };
  }
  const current = packedQty(checklist, line.id);
  const packed = current + delta;
  if (packed < 0) return { kind: "below_zero" };
  if (delta === 1 && packed > line.required) return { kind: "over_quantity", packed: current, required: line.required };
  const next = sanitizeChecklist(lines, checklist, { keepStale: true });
  if (packed === 0) delete next[line.id];
  else next[line.id] = packed;
  return { kind: "ok", checklist: next, packed, required: line.required };
}

/**
 * Чекліст лише з коректних значень > 0. keepStale — зберегти одиниці позицій, яких більше немає в замовленні
 * (щоб пакувальник бачив, що їх треба вийняти; на повноту впливають як «зайві»).
 */
export function sanitizeChecklist(
  lines: readonly ChecklistLine[],
  checklist: Checklist,
  opts: { keepStale?: boolean } = { keepStale: true },
): Record<string, number> {
  const known = new Set(lines.map((l) => l.id));
  const out: Record<string, number> = {};
  for (const id of Object.keys(checklist)) {
    const q = packedQty(checklist, id);
    if (q <= 0) continue;
    if (!known.has(id) && !opts.keepStale) continue;
    out[id] = q;
  }
  return out;
}

export interface ChecklistProgress {
  /** Потрібно одиниць усього. */
  requiredUnits: number;
  /** Запаковано (не більше потрібного по кожній позиції). */
  packedUnits: number;
  /** Зайві одиниці: понад потрібне або позиції, яких уже немає в замовленні. */
  overUnits: number;
  totalLines: number;
  completeLines: number;
  missing: Array<{ lineId: string; missing: number }>;
  over: Array<{ lineId: string; over: number }>;
  /** Усі позиції запаковано повністю й зайвого немає. */
  complete: boolean;
}

export function checklistProgress(lines: readonly ChecklistLine[], checklist: Checklist): ChecklistProgress {
  const packable = lines.filter((l) => l.required > 0);
  let requiredUnits = 0;
  let packedUnits = 0;
  let overUnits = 0;
  let completeLines = 0;
  const missing: ChecklistProgress["missing"] = [];
  const over: ChecklistProgress["over"] = [];
  const known = new Set<string>();
  for (const line of packable) {
    known.add(line.id);
    const q = packedQty(checklist, line.id);
    requiredUnits += line.required;
    packedUnits += Math.min(q, line.required);
    if (q === line.required) completeLines += 1;
    if (q < line.required) missing.push({ lineId: line.id, missing: line.required - q });
    if (q > line.required) {
      over.push({ lineId: line.id, over: q - line.required });
      overUnits += q - line.required;
    }
  }
  for (const id of Object.keys(checklist)) {
    if (known.has(id)) continue;
    const q = packedQty(checklist, id);
    if (q > 0) {
      over.push({ lineId: id, over: q });
      overUnits += q;
    }
  }
  return {
    requiredUnits,
    packedUnits,
    overUnits,
    totalLines: packable.length,
    completeLines,
    missing,
    over,
    complete: missing.length === 0 && over.length === 0,
  };
}
