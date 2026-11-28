/**
 * Еталонна модель (WP12a): імпорт рахунків, специфікацій і кредит-нот перевізника (§7.2–§7.6) — чиста модель реєстру
 * документів. Файлу й розбору немає: рядки вже розібрано профілем колонок (сума — десятковий рядок, номер — текст
 * клітинки або ціле число XLSX).
 *
 * Правила, які відтворює модель:
 *  - Захист від повторного імпорту (§7.6): (а) той самий SHA-256 серед активних документів перевізника → `same_file`;
 *    (б) той самий (перевізник, рахунок клієнта, нормалізований номер, вид) серед активних → `same_number_kind`; лише
 *    «Замінити» з причиною → стара версія `replaced` + сторно її записів, нова `version + 1` (обидві зберігаються);
 *    (г) ≥ 50 % рядків нового документа мають той самий (номер, послуга, сума, валюта), що й активний документ ІНШОГО
 *    номера → `similar_document`, збереження заблоковано без «Підтвердити як окремий» (з причиною); кожен такий рядок
 *    збереженого документа → `possible_double_billing` (не пропускається автоматично).
 *  - Для одного номера рахунку проводить рівно ОДИН документ (§7.3): рядки специфікації > рядки рахунку > підсумок
 *    рахунку; документ вищого пріоритету в тій самій операції сторнує записи нижчого. Кредит-нота проводить свої рядки
 *    (від'ємні → `credit`, R2 у замовленні) незалежно від пріоритету.
 *  - Рядки: «Разом» / «Всього» (`lineKind = total`) — лише звірка; сума 0 — пропуск (CHECK amount <> 0); порожній номер
 *    із сумою ≠ 0 (зберігання, сервісні збори) і незіставлені → `shipping_unallocated` (`customs_duty` → `duties_paid`
 *    без замовлення, §7.2) датою `charge_date ?? invoice_date` (R4; місяць, закритий на момент імпорту, → пізній
 *    запис); підсумок рахунку без рядків → один `shipping_unallocated` датою рахунку. Зіставлені рядки (а також
 *    `shipment_not_handed_over` / `order_not_recognized` — разом із розбіжністю) → факт рядка замовлення (`orderLines`,
 *    вхід `postOrder`: перше фактичне значення — R1 / R3, кредити й пізніші документи та нові версії — R2, R5 для
 *    скасованого до відвантаження).
 *    Тлумачення моделі: `shipment_cancelled` лишається нерозподіленим до дії «Прийняти як витрату замовлення»
 *    (`matchImportLine`, сторно нерозподіленого + рядок замовлення з `match_version + 1`).
 *  - `control_total` = підсумок активного рахунку цього номера; `invoice_total_mismatch` = control_total − Σ рядків
 *    документа, що проводить (валюта рядків = валюта підсумку — припущення моделі).
 *  - Порівняння сум (amount_vs_forecast, shipping_loss) — у UAH (пороги задано в UAH), кожна сума за курсом своєї дати.
 */
import { cents, str, type Cents } from "./money";
import { convert, type ConvertContext } from "./fx";
import { postingDates, reverseEntry, type RefEntry, type RefMonthClosure } from "./journal";
import type { RefCategory } from "./categories";
import type { ChargeType, RefInvoiceLineFact } from "./order-posting";
import {
  amountVsForecast,
  DEFAULT_VARIANCE,
  duplicatesInFile,
  invoiceTotalMismatch,
  manualCostExists,
  matchWaybill,
  normalizeWaybill,
  shippingLoss,
  similarDocument,
  weightMismatch,
  type ImportLine,
  type MatchCandidate,
  type MatchCode,
  type VarianceSettings,
} from "./shipping";

export type DocumentKind = "invoice" | "specification" | "credit_note";

/** Розібраний рядок файлу (після профілю колонок). */
export interface RefImportRow {
  rowNumber: number;
  sheet?: string;
  /** Номер накладної: текст клітинки або ціле число XLSX; null / порожній — без номера. */
  number: string | number | null;
  service: string;
  /** Сума рядка «0.00» (кредит — від'ємна). */
  amount: string;
  currency: string;
  chargeDate?: string | null;
  /** Тип витрати за правилами профілю; типово `delivery`, від'ємна сума → `credit`. */
  chargeType?: ChargeType;
  /** Платна вага з рахунку. */
  chargedWeightGrams?: number | null;
  lineKind?: "line" | "total";
}

export interface RefCarrierDocument {
  id: string;
  carrier: string;
  accountRef: string;
  invoiceNumber: string;
  kind: DocumentKind;
  sha256: string;
  invoiceDate: string;
  /** «Сума за рахунком» — підсумок рахунку (control_total); рахунок без рядків проводить саме його. */
  total?: { amount: string; currency: string } | null;
  rows: readonly RefImportRow[];
  importedAt: string;
}

export interface RefStoredDocument extends RefCarrierDocument {
  numberNorm: string;
  version: number;
  status: "active" | "replaced";
  replacedAt: string | null;
  replaceReason: string | null;
  supersedesId: string | null;
  separateReason: string | null;
  /** Чи проводить документ витрати зараз (§7.3 «posting»). */
  posting: boolean;
}

export type ImportLineCode = MatchCode | "no_number";

export interface RefImportLine {
  /** `<documentId>:<sheet>:<row>` — унікальний (invoice_id, sheet, row_number) (§7.6 в). */
  id: string;
  documentId: string;
  sheet: string;
  rowNumber: number;
  numberNorm: string | null;
  rawNumber: string | null;
  service: string;
  amount: string;
  currency: string;
  chargeType: ChargeType;
  chargedWeightGrams: number | null;
  /** charge_date ?? invoice_date. */
  serviceDate: string;
  code: ImportLineCode;
  /** Замовлення, на яке проводиться рядок; null — нерозподілене. */
  orderId: string | null;
  /** Знайдене замовлення (зокрема для shipment_cancelled) — для розбіжності. */
  foundOrderId: string | null;
  waybillId: string | null;
  matchVersion: number;
}

export type ImportDiscrepancyType =
  | Exclude<MatchCode, "matched">
  | "test_waybill_in_production"
  | "duplicate_in_file"
  | "possible_double_billing"
  | "amount_vs_forecast"
  | "weight_mismatch"
  | "shipping_loss"
  | "manual_cost_exists"
  | "credit_without_charge"
  | "invoice_total_mismatch";

export interface RefImportDiscrepancy {
  type: ImportDiscrepancyType;
  documentId: string;
  lineId: string | null;
  orderId: string | null;
  waybillId: string | null;
  /** Δ у UAH (amount_vs_forecast, shipping_loss) або control_total − Σ рядків (invoice_total_mismatch). */
  amount: string | null;
}

/** Факт рядка рахунку для замовлення (вхід `postOrder.invoiceLines`, зокрема сторновані — з `reversedAt`). */
export interface OrderInvoiceLine extends RefInvoiceLineFact {
  orderId: string;
}

export interface RefImportLedger {
  documents: RefStoredDocument[];
  lines: RefImportLine[];
  /** Записи періоду імпорту: `shipping_unallocated` / `duties_paid` без замовлення і їхні сторно. */
  entries: RefEntry[];
  orderLines: OrderInvoiceLine[];
  discrepancies: RefImportDiscrepancy[];
}

export function emptyImportLedger(): RefImportLedger {
  return { documents: [], lines: [], entries: [], orderLines: [], discrepancies: [] };
}

export interface ImportOrderInfo {
  /** Σ sales_shipping замовлення (сплачено покупцем), з датою курсу. */
  shippingPaid?: { amount: string; currency: string; fxOn: string } | null;
  /** Ручна вартість доставки / ручне мито на картці (manual_cost_exists). */
  manualShipping?: boolean;
  manualDuties?: boolean;
}

export interface ImportContext {
  candidates: readonly MatchCandidate[];
  orders?: Readonly<Record<string, ImportOrderInfo>>;
  closures?: readonly RefMonthClosure[];
  fx?: ConvertContext;
  variance?: VarianceSettings;
  /** Робочий режим: номер TEST… → test_waybill_in_production. */
  production?: boolean;
}

export interface ImportOptions {
  /** «Замінити новою версією» (причина обов'язкова). */
  replace?: { reason: string } | null;
  /** «Підтвердити як окремий документ» при similar_document (причина обов'язкова). */
  confirmSeparate?: { reason: string } | null;
}

export type ImportRefusal = "invoice_number_required" | "same_file" | "same_number_kind" | "reason_required" | "similar_document";

/** Крок 3 «Перевірка» (§7.3): лічильники, підсумки, рядки без номера, заміна проведеного документа. */
export interface ImportSummary {
  lines: number;
  matched: number;
  unmatched: number;
  ambiguous: number;
  errors: number;
  duplicates: number;
  discrepancies: number;
  /** «Без номера: 1, 40,00». */
  noNumber: { count: number; amount: string };
  /** Рядки «Разом» / «Всього» — лише звірка. */
  totalRows: number;
  totalsByCurrency: Record<string, string>;
  posting: boolean;
  /** Підсумок рахунку проти Σ рядків документа, що проводить. */
  controlTotal: { amount: string; lines: string; mismatch: string | null } | null;
  /** «Специфікація замінить проведений підсумок рахунку № 1234: −2 000,00 грн, +1 990,00 грн за 152 рядками». */
  replaces: { documentId: string; reversedCost: string; newCost: string; lines: number } | null;
}

export type ImportResult =
  | { ok: true; ledger: RefImportLedger; document: RefStoredDocument; summary: ImportSummary; discrepancies: RefImportDiscrepancy[] }
  | { ok: false; error: ImportRefusal; existingDocumentId: string | null; summary: ImportSummary };

/** Номер рахунку: обрізати, верхній регістр, без внутрішніх пробілів (§7.6 б). */
export function normalizeInvoiceNumber(raw: string): string {
  return raw.normalize("NFKC").replace(/\s+/g, "").toUpperCase();
}

/** Рядки, що проводяться на замовлення (решта кодів — нерозподілені). */
const ORDER_CODES: ReadonlySet<ImportLineCode> = new Set(["matched", "shipment_not_handed_over", "order_not_recognized"]);
/** Вартість відправлення для «прогноз vs факт» (§7.7). */
const FORECAST_COST_TYPES: ReadonlySet<ChargeType> = new Set(["delivery", "additional_service", "insurance", "other", "credit"]);
/** Фактична доставка замовлення (shipping_cost, §7.2) для shipping_loss. */
const SHIPPING_COST_TYPES: ReadonlySet<ChargeType> = new Set(["delivery", "additional_service", "storage", "insurance", "other", "credit"]);

const toImportLine = (l: RefImportLine): ImportLine => ({ number: l.numberNorm ?? l.rawNumber ?? "", service: l.service, amount: str(cents(l.amount)), currency: l.currency });
const tupleKey = (l: RefImportLine) => {
  const t = toImportLine(l);
  return `${t.number}\u0000${t.service.toLowerCase()}\u0000${t.amount}\u0000${t.currency}`;
};

function classifyRows(doc: RefCarrierDocument, ctx: ImportContext): { lines: RefImportLine[]; totalRows: number; testNumbers: Set<string> } {
  const lines: RefImportLine[] = [];
  const testNumbers = new Set<string>();
  let totalRows = 0;
  for (const row of doc.rows) {
    if (row.lineKind === "total") {
      totalRows += 1;
      continue;
    }
    const amount = cents(row.amount);
    if (amount === 0n) continue;
    const sheet = row.sheet ?? "1";
    const id = `${doc.id}:${sheet}:${row.rowNumber}`;
    const rawNumber = row.number === null ? null : String(row.number);
    const blank = row.number === null || (typeof row.number === "string" && row.number.normalize("NFKC").replace(/\s+/g, "") === "");
    let code: ImportLineCode = "no_number";
    let numberNorm: string | null = null;
    let foundOrderId: string | null = null;
    let waybillId: string | null = null;
    if (!blank) {
      const m = matchWaybill(row.number!, doc.carrier, ctx.candidates);
      code = m.code;
      numberNorm = m.norm;
      foundOrderId = m.orderId;
      waybillId = m.candidate ? (m.candidate.waybillId ?? m.norm) : null;
      const n = normalizeWaybill(row.number!);
      if (n.ok && n.cls === "test") testNumbers.add(id);
    }
    lines.push({
      id,
      documentId: doc.id,
      sheet,
      rowNumber: row.rowNumber,
      numberNorm,
      rawNumber,
      service: row.service,
      amount: str(amount),
      currency: row.currency,
      chargeType: row.chargeType ?? (amount < 0n ? "credit" : "delivery"),
      chargedWeightGrams: row.chargedWeightGrams ?? null,
      serviceDate: row.chargeDate ?? doc.invoiceDate,
      code,
      orderId: ORDER_CODES.has(code) ? foundOrderId : null,
      foundOrderId,
      waybillId,
      matchVersion: 1,
    });
  }
  return { lines, totalRows, testNumbers };
}

function cloneLedger(l: RefImportLedger): RefImportLedger {
  return {
    documents: l.documents.map((d) => ({ ...d })),
    lines: l.lines.map((x) => ({ ...x })),
    entries: [...l.entries],
    orderLines: l.orderLines.map((x) => ({ ...x })),
    discrepancies: [...l.discrepancies],
  };
}

function periodEntry(key: string, category: RefCategory, amount: Cents, currency: string, date: string, postedAt: string, closures: readonly RefMonthClosure[], details: RefEntry["details"]): RefEntry {
  const d = postingDates({ recognizedOn: date, fxOn: date }, postedAt, closures);
  return { key, orderId: null, category, amount: str(amount), currency, recognizedOn: d.recognizedOn, fxOn: d.fxOn, originalOn: d.originalOn, isLate: d.isLate, isLateCompletion: false, reversesKey: null, details };
}

const linesOf = (l: RefImportLedger, documentId: string) => l.lines.filter((x) => x.documentId === documentId);

function postLine(l: RefImportLedger, d: RefStoredDocument, line: RefImportLine, at: string, closures: readonly RefMonthClosure[]): void {
  if (line.orderId) {
    l.orderLines.push({
      id: line.id,
      orderId: line.orderId,
      waybillId: line.waybillId,
      documentId: d.id,
      chargeType: line.chargeType,
      amount: line.amount,
      currency: line.currency,
      serviceDate: line.serviceDate,
      importedAt: at,
      matchVersion: line.matchVersion,
      reversedAt: null,
    });
    return;
  }
  const category: RefCategory = line.chargeType === "customs_duty" ? "duties_paid" : "shipping_unallocated";
  l.entries.push(periodEntry(`inv:${line.id}:m${line.matchVersion}`, category, -cents(line.amount), line.currency, line.serviceDate, at, closures, { documentId: d.id, lineId: line.id, chargeType: line.chargeType }));
}

function postDocument(l: RefImportLedger, d: RefStoredDocument, at: string, closures: readonly RefMonthClosure[]): void {
  const lines = linesOf(l, d.id);
  if (lines.length === 0) {
    if (d.kind === "invoice" && d.total && cents(d.total.amount) !== 0n) {
      l.entries.push(periodEntry(`invtotal:${d.id}`, "shipping_unallocated", -cents(d.total.amount), d.total.currency, d.invoiceDate, at, closures, { documentId: d.id, lineId: null, chargeType: "total" }));
      d.posting = true;
    }
    return;
  }
  for (const line of lines) postLine(l, d, line, at, closures);
  d.posting = true;
}

function unpostDocument(l: RefImportLedger, d: RefStoredDocument, at: string, closures: readonly RefMonthClosure[]): void {
  const reversed = new Set(l.entries.filter((e) => e.reversesKey !== null).map((e) => e.reversesKey!));
  for (const e of [...l.entries]) {
    if (e.details?.documentId === d.id && e.reversesKey === null && !reversed.has(e.key)) l.entries.push(reverseEntry(e, at, closures));
  }
  for (const ol of l.orderLines) if (ol.documentId === d.id && !ol.reversedAt) ol.reversedAt = at;
  d.posting = false;
}

/** Вартість, яку проводить документ (додатна величина витрати): Σ рядків, інакше підсумок рахунку. */
function costOf(l: RefImportLedger, d: RefStoredDocument): Cents {
  const lines = linesOf(l, d.id);
  if (lines.length > 0) return lines.reduce((a, x) => a + cents(x.amount), 0n);
  return d.kind === "invoice" && d.total ? cents(d.total.amount) : 0n;
}

const sameGroup = (a: { carrier: string; accountRef: string; numberNorm: string }, b: { carrier: string; accountRef: string; numberNorm: string }) =>
  a.carrier === b.carrier && a.accountRef === b.accountRef && a.numberNorm === b.numberNorm;

/** Документ, що проводить витрати номера (§7.3): специфікація з рядками > рахунок із рядками > підсумок рахунку. */
function postingDocFor(l: RefImportLedger, group: { carrier: string; accountRef: string; numberNorm: string }): RefStoredDocument | null {
  const docs = l.documents.filter((d) => d.status === "active" && d.kind !== "credit_note" && sameGroup(d, group));
  const hasLines = (d: RefStoredDocument) => linesOf(l, d.id).length > 0;
  return (
    docs.find((d) => d.kind === "specification" && hasLines(d)) ??
    docs.find((d) => d.kind === "invoice" && hasLines(d)) ??
    docs.find((d) => d.kind === "invoice" && d.total !== null && d.total !== undefined && cents(d.total.amount) !== 0n) ??
    null
  );
}

/** Активні (не сторновані) факти рядків замовлень. */
export function activeOrderLines(l: RefImportLedger, orderId?: string): OrderInvoiceLine[] {
  return l.orderLines.filter((x) => !x.reversedAt && (orderId === undefined || x.orderId === orderId));
}

/** Усі факти рядків замовлення (зокрема сторновані) — `invoiceLines` для postOrder. */
export function orderInvoiceLines(l: RefImportLedger, orderId: string): OrderInvoiceLine[] {
  return l.orderLines.filter((x) => x.orderId === orderId);
}

function summaryOf(lines: readonly RefImportLine[], totalRows: number, duplicates: number, discrepancies: number): ImportSummary {
  const byCur = new Map<string, Cents>();
  for (const l of lines) byCur.set(l.currency, (byCur.get(l.currency) ?? 0n) + cents(l.amount));
  const noNumber = lines.filter((l) => l.code === "no_number");
  return {
    lines: lines.length,
    matched: lines.filter((l) => l.code === "matched").length,
    unmatched: lines.filter((l) => l.code === "unmatched_waybill").length,
    ambiguous: lines.filter((l) => l.code === "ambiguous_match").length,
    errors: lines.filter((l) => l.code === "invalid_number").length,
    duplicates,
    discrepancies,
    noNumber: { count: noNumber.length, amount: str(noNumber.reduce((a, l) => a + cents(l.amount), 0n)) },
    totalRows,
    totalsByCurrency: Object.fromEntries([...byCur.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([c, v]) => [c, str(v)])),
    posting: false,
    controlTotal: null,
    replaces: null,
  };
}

/**
 * Збереження документа (крок 4) — одна «транзакція»: перевірки дублікатів → документ і рядки → заміна записів
 * документа нижчого пріоритету / попередньої версії → проведення документа, що проводить → розбіжності.
 * Результат чистий: новий реєстр, наявний не змінюється.
 */
export function saveImport(ledger: RefImportLedger, doc: RefCarrierDocument, ctx: ImportContext, opts: ImportOptions = {}): ImportResult {
  const closures = ctx.closures ?? [];
  const numberNorm = normalizeInvoiceNumber(doc.invoiceNumber);
  const { lines, totalRows, testNumbers } = classifyRows(doc, ctx);
  const dups = duplicatesInFile(lines.map(toImportLine));
  const refuse = (error: ImportRefusal, existingDocumentId: string | null): ImportResult => ({ ok: false, error, existingDocumentId, summary: summaryOf(lines, totalRows, dups.length, 0) });
  if (numberNorm === "") return refuse("invoice_number_required", null);
  const active = ledger.documents.filter((d) => d.status === "active" && d.carrier === doc.carrier);
  const sameFile = active.find((d) => d.sha256 === doc.sha256);
  if (sameFile) return refuse("same_file", sameFile.id);
  const group = { carrier: doc.carrier, accountRef: doc.accountRef, numberNorm };
  const sameNumber = active.find((d) => sameGroup(d, group) && d.kind === doc.kind);
  if (sameNumber && !opts.replace) return refuse("same_number_kind", sameNumber.id);
  if ((opts.replace && opts.replace.reason.trim() === "") || (opts.confirmSeparate && opts.confirmSeparate.reason.trim() === "")) return refuse("reason_required", sameNumber?.id ?? null);
  const otherNumberDocs = active.filter((d) => !sameGroup(d, group));
  const newTuples = lines.map(toImportLine);
  const similar = otherNumberDocs.find((d) => similarDocument(newTuples, linesOf(ledger, d.id).map(toImportLine)));
  if (similar && !opts.confirmSeparate) return refuse("similar_document", similar.id);

  const next = cloneLedger(ledger);
  const before = doc.kind === "credit_note" ? null : postingDocFor(next, group);
  const beforeCost = before ? costOf(next, before) : 0n;
  const stored: RefStoredDocument = {
    ...doc,
    numberNorm,
    version: sameNumber ? sameNumber.version + 1 : 1,
    status: "active",
    replacedAt: null,
    replaceReason: null,
    supersedesId: sameNumber?.id ?? null,
    separateReason: similar ? opts.confirmSeparate!.reason : null,
    posting: false,
  };
  if (sameNumber) {
    const old = next.documents.find((d) => d.id === sameNumber.id)!;
    old.status = "replaced";
    old.replacedAt = doc.importedAt;
    old.replaceReason = opts.replace!.reason;
  }
  next.documents.push(stored);
  next.lines.push(...lines);
  let replaces: ImportSummary["replaces"] = null;
  if (doc.kind === "credit_note") {
    if (sameNumber) unpostDocument(next, next.documents.find((d) => d.id === sameNumber.id)!, doc.importedAt, closures);
    postDocument(next, stored, doc.importedAt, closures);
  } else {
    const after = postingDocFor(next, group);
    if (before && before.id !== after?.id) unpostDocument(next, next.documents.find((d) => d.id === before.id)!, doc.importedAt, closures);
    if (after && after.id !== before?.id) {
      const target = next.documents.find((d) => d.id === after.id)!;
      postDocument(next, target, doc.importedAt, closures);
      if (before && target.id === stored.id) replaces = { documentId: before.id, reversedCost: str(beforeCost), newCost: str(costOf(next, stored)), lines: lines.length };
    }
  }

  // --- Розбіжності (§7.5) ---
  const disc: RefImportDiscrepancy[] = [];
  const add = (type: ImportDiscrepancyType, line: RefImportLine | null, extra: Partial<RefImportDiscrepancy> = {}) =>
    disc.push({ type, documentId: stored.id, lineId: line?.id ?? null, orderId: line?.orderId ?? line?.foundOrderId ?? null, waybillId: line?.waybillId ?? null, amount: null, ...extra });
  for (const l of lines) {
    if (l.code !== "matched" && l.code !== "no_number") add(l.code, l);
    if (ctx.production && testNumbers.has(l.id)) add("test_waybill_in_production", l);
  }
  for (const i of dups) add("duplicate_in_file", lines[i]!);
  const fx = ctx.fx ?? { rates: [] };
  const v = ctx.variance ?? DEFAULT_VARIANCE;
  const uah = (x: { amount: string; currency: string; fxOn: string }) => convert(cents(x.amount), x.currency, "UAH", x.fxOn, fx);
  const sumUah = (xs: readonly OrderInvoiceLine[]): Cents | null => {
    let t = 0n;
    for (const x of xs) {
      const c = uah({ amount: x.amount, currency: x.currency, fxOn: x.serviceDate });
      if (c === null) return null;
      t += c;
    }
    return t;
  };
  if (stored.posting) {
    const otherTuples = new Set(next.lines.filter((x) => otherNumberDocs.some((d) => d.id === x.documentId)).map(tupleKey));
    const orderLinesNow = activeOrderLines(next);
    for (const l of lines) {
      if (otherTuples.has(tupleKey(l))) add("possible_double_billing", l);
      if (!l.orderId) continue;
      const cand = ctx.candidates.find((c) => (c.waybillId ?? normalizeWaybillNorm(c.number)) === l.waybillId);
      if (l.chargedWeightGrams !== null && cand?.weightGrams && weightMismatch(l.chargedWeightGrams, cand.weightGrams, v)) add("weight_mismatch", l);
      const info = ctx.orders?.[l.orderId];
      if (info && manualCostExists({ shipping: info.manualShipping, duties: info.manualDuties }, l.chargeType)) add("manual_cost_exists", l);
      if (cents(l.amount) < 0n && !orderLinesNow.some((x) => x.waybillId === l.waybillId && x.id !== l.id && cents(x.amount) > 0n)) add("credit_without_charge", l);
    }
    for (const waybillId of new Set(lines.filter((l) => l.orderId && l.waybillId).map((l) => l.waybillId!))) {
      const cand = ctx.candidates.find((c) => (c.waybillId ?? normalizeWaybillNorm(c.number)) === waybillId);
      if (!cand?.forecast) continue;
      const actual = sumUah(orderLinesNow.filter((x) => x.waybillId === waybillId && FORECAST_COST_TYPES.has(x.chargeType)));
      const forecast = uah(cand.forecast);
      if (actual === null || forecast === null) continue;
      if (amountVsForecast(actual, forecast, v)) add("amount_vs_forecast", null, { orderId: cand.orderId, waybillId, amount: str(actual - forecast) });
    }
    for (const orderId of new Set(lines.filter((l) => l.orderId).map((l) => l.orderId!))) {
      const paidFact = ctx.orders?.[orderId]?.shippingPaid;
      if (!paidFact) continue;
      const actual = sumUah(orderLinesNow.filter((x) => x.orderId === orderId && SHIPPING_COST_TYPES.has(x.chargeType)));
      const paid = uah(paidFact);
      if (actual === null || paid === null) continue;
      const r = shippingLoss(actual, paid, v);
      if (r.flagged) add("shipping_loss", null, { orderId, amount: str(r.loss) });
    }
  }
  let controlTotal: ImportSummary["controlTotal"] = null;
  if (doc.kind !== "credit_note") {
    const groupDocs = next.documents.filter((d) => d.status === "active" && d.kind !== "credit_note" && sameGroup(d, group));
    const invoice = groupDocs.find((d) => d.kind === "invoice" && d.total);
    const poster = groupDocs.find((d) => d.posting);
    const posterLines = poster ? linesOf(next, poster.id) : [];
    if (invoice?.total && poster && posterLines.length > 0) {
      const mismatch = invoiceTotalMismatch(posterLines.map((l) => l.amount), invoice.total.amount);
      controlTotal = { amount: str(cents(invoice.total.amount)), lines: str(posterLines.reduce((a, l) => a + cents(l.amount), 0n)), mismatch };
      if (mismatch !== null) disc.push({ type: "invoice_total_mismatch", documentId: poster.id, lineId: null, orderId: null, waybillId: null, amount: mismatch });
    }
  }
  next.discrepancies.push(...disc);
  const summary: ImportSummary = { ...summaryOf(lines, totalRows, dups.length, disc.length), posting: stored.posting, controlTotal, replaces };
  return { ok: true, ledger: next, document: next.documents.find((d) => d.id === stored.id)!, summary, discrepancies: disc };
}

function normalizeWaybillNorm(raw: string): string | null {
  const n = normalizeWaybill(raw);
  return n.ok ? n.norm : null;
}

/** Крок 3 «Перевірка» — без записів: той самий розрахунок, реєстр не змінюється. */
export function previewImport(ledger: RefImportLedger, doc: RefCarrierDocument, ctx: ImportContext, opts: ImportOptions = {}): { refusal: { error: ImportRefusal; existingDocumentId: string | null } | null; summary: ImportSummary } {
  const r = saveImport(ledger, doc, ctx, opts);
  return r.ok ? { refusal: null, summary: r.summary } : { refusal: { error: r.error, existingDocumentId: r.existingDocumentId }, summary: r.summary };
}

/**
 * Пізніше ручне зіставлення / «Прийняти як витрату замовлення» (§7.3): сторно нерозподіленого запису рядка + рядок
 * замовлення з `match_version + 1` (ключ `inv:<lineId>:m<n+1>`), відомий з моменту `at`.
 */
export function matchImportLine(ledger: RefImportLedger, lineId: string, target: { orderId: string; waybillId: string }, at: string, closures: readonly RefMonthClosure[] = []): RefImportLedger {
  const next = cloneLedger(ledger);
  const line = next.lines.find((l) => l.id === lineId);
  if (!line) throw new RangeError(`reference: unknown import line ${lineId}`);
  const doc = next.documents.find((d) => d.id === line.documentId)!;
  if (line.orderId || !doc.posting) throw new RangeError("reference: only an unallocated line of a posting document can be matched");
  const key = `inv:${line.id}:m${line.matchVersion}`;
  const original = next.entries.find((e) => e.key === key && e.reversesKey === null);
  if (!original || next.entries.some((e) => e.reversesKey === key)) throw new RangeError("reference: unallocated entry is not active");
  next.entries.push(reverseEntry(original, at, closures));
  line.orderId = target.orderId;
  line.foundOrderId = target.orderId;
  line.waybillId = target.waybillId;
  line.matchVersion += 1;
  line.code = "matched";
  postLine(next, doc, line, at, closures);
  return next;
}
