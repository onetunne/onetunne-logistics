/**
 * Золоті випадки етапу 6 (WP12a → WP12b): доставка — статистика за накладними (G15) і імпорт рахунків (G9): правила
 * рядків, а також документи для реєстру імпорту (model/invoice-import.ts) — рахунок № 7001 (а)–(л), повтор байтів,
 * нова версія, кредит-нота (з), підсумок № 1234 → специфікація (и), схожий документ № 1235 (і). Номери, рахунки
 * клієнта й SHA-256 — вигадані.
 */
import type { StatWaybill, ImportLine, MatchCandidate } from "../model/shipping";
import type { ImportOrderInfo, RefCarrierDocument } from "../model/invoice-import";
import type { RefOrderFacts } from "../model/order-posting";
import { G1_ORDER_NO_RETURN } from "./orders";

const D = "2026-11-10";

/** G15 — W1 (DE, 1 200 г), W2 (DE, 1 800 г), W3 (PL, зовнішній номер), W4 (DE) без рахунку; валюта UAH. */
export const G15_WAYBILLS: readonly StatWaybill[] = [
  {
    id: "W1",
    orderId: "o-w1",
    source: "app",
    country: "DE",
    chargeableWeightGrams: 1200,
    recognizedOn: D,
    forecast: { basis: "carrier_reported", amount: "520.00", currency: "UAH", fxOn: D },
    lines: [
      { chargeType: "delivery", amount: "500.00", currency: "UAH", fxOn: D },
      { chargeType: "additional_service", amount: "40.00", currency: "UAH", fxOn: D },
    ],
  },
  {
    id: "W2",
    orderId: "o-w2",
    source: "app",
    country: "DE",
    chargeableWeightGrams: 1800,
    recognizedOn: D,
    forecast: { basis: "country_average", amount: "560.00", currency: "UAH", fxOn: D },
    lines: [
      { chargeType: "delivery", amount: "620.00", currency: "UAH", fxOn: D },
      { chargeType: "credit", amount: "-20.00", currency: "UAH", fxOn: D },
    ],
  },
  {
    id: "W3",
    orderId: "o-w3",
    source: "external",
    country: "PL",
    chargeableWeightGrams: null,
    recognizedOn: D,
    forecast: { basis: "owner_table", amount: "400.00", currency: "UAH", fxOn: D },
    lines: [
      { chargeType: "delivery", amount: "450.00", currency: "UAH", fxOn: D },
      { chargeType: "return_delivery", amount: "300.00", currency: "UAH", fxOn: D },
    ],
  },
  { id: "W4", orderId: "o-w4", source: "app", country: "DE", chargeableWeightGrams: 900, recognizedOn: D, forecast: { basis: "carrier_reported", amount: "480.00", currency: "UAH", fxOn: D }, lines: [] },
];
export const G15_EXPECTED = {
  waybills: 4,
  withActual: 3,
  averageCost: "530.00",
  DE: { averageCost: "570.00", withActual: 2, waybills: 3, perKg: "380.00" },
  PL: { averageCost: "450.00" },
  forecast: "1480.00",
  actual: "1590.00",
  delta: "110.00",
  meanAbsDeltaPct: "7.8",
  overThreshold: 0,
  byBasis: { carrier_reported: "20.00", country_average: "40.00", owner_table: "50.00" },
  returns: "300.00",
} as const;

const NP = "nova_post";
const ACC = "acc-g9";
const FC = (amount: string) => ({ amount, currency: "UAH", fxOn: "2026-10-05" });

/** G9 — накладні застосунку й зовнішні номери для зіставлення (заморожені прогнози, платна вага відправлень). */
export const G9_CANDIDATES: readonly MatchCandidate[] = [
  { number: "20450000000011", carrier: NP, orderId: "o-a", waybillId: "wb-a", handedOver: true, orderRecognized: true, forecast: FC("520.00"), weightGrams: 1200 },
  { number: "20450000000012", carrier: NP, orderId: "o-b", waybillId: "wb-b", handedOver: true, orderRecognized: true, forecast: FC("500.00"), weightGrams: 1500 },
  { number: "20450000000013", carrier: NP, orderId: "o-d", waybillId: "wb-d", cancelled: true },
  { number: "20450000000014", carrier: NP, orderId: "o-e", waybillId: "wb-e", handedOver: true, orderRecognized: true, forecast: FC("400.00"), weightGrams: 2000 },
  // (и) специфікація № 1234
  { number: "20450000000021", carrier: NP, orderId: "o-f", waybillId: "wb-f", handedOver: true, orderRecognized: true, forecast: FC("700.00") },
  { number: "20450000000022", carrier: NP, orderId: "o-g", waybillId: "wb-g", handedOver: true, orderRecognized: true, forecast: FC("640.00") },
  { number: "20450000000023", carrier: NP, orderId: "o-h", waybillId: "wb-h", handedOver: true, orderRecognized: true, forecast: FC("650.00") },
];

/** G9 — дані замовлень для розбіжностей: сплачена покупцем доставка (й), ручне мито (л). */
export const G9_ORDER_INFO: Readonly<Record<string, ImportOrderInfo>> = {
  "o-a": { shippingPaid: { amount: "12.00", currency: "EUR", fxOn: "2026-10-05" } },
  "o-b": { shippingPaid: { amount: "10.00", currency: "EUR", fxOn: "2026-10-05" } },
  "o-e": { manualDuties: true },
};

/** G9 — замовлення накладної …11 (основа — G1 без повернення; рядки рахунків — з реєстру імпорту). */
export const G9_ORDER_A: RefOrderFacts = {
  ...G1_ORDER_NO_RETURN,
  id: "o-a",
  waybills: [{ id: "wb-a", source: "app", number: "20450000000011", country: "DE", chargeableWeightGrams: 1200, frozenForecast: { basis: "carrier_reported", amount: "520.00", currency: "UAH" } }],
  invoiceLines: [],
};

/** G9 — рахунок № 7001 з рядками (а)–(л) і «Разом» (ж); «Сума за рахунком» 2 510,00 = Σ рядків. */
export const G9_DOC_FILE: RefCarrierDocument = {
  id: "doc-7001-v1",
  carrier: NP,
  accountRef: ACC,
  invoiceNumber: "7001",
  kind: "invoice",
  sha256: "sha-g9-7001-a",
  invoiceDate: "2026-11-10",
  total: { amount: "2510.00", currency: "UAH" },
  importedAt: "2026-11-12T09:00:00Z",
  rows: [
    { rowNumber: 2, number: "20450000000011", service: "Доставка", amount: "540.00", currency: "UAH" }, // (а)
    { rowNumber: 3, number: "20450000000012", service: "Доставка", amount: "700.00", currency: "UAH" }, // (б), (й)
    { rowNumber: 4, number: "20450000000099", service: "Доставка", amount: "300.00", currency: "UAH" }, // (в)
    { rowNumber: 5, number: "20450000000013", service: "Доставка", amount: "350.00", currency: "UAH" }, // (д)
    { rowNumber: 6, number: " 2045 0000 0000 14 ", service: "Доставка", amount: "410.00", currency: "UAH", chargedWeightGrams: 2500 }, // (е), (ї)
    { rowNumber: 7, number: "2.0451E+13", service: "Доставка", amount: "50.00", currency: "UAH" }, // (є)
    { rowNumber: 8, number: null, service: "Зберігання", amount: "40.00", currency: "UAH", chargeType: "storage" }, // (к)
    { rowNumber: 9, number: "20450000000014", service: "Митні платежі", amount: "120.00", currency: "UAH", chargeType: "customs_duty" }, // (л)
    { rowNumber: 10, number: null, service: "Разом", amount: "2510.00", currency: "UAH", lineKind: "total" }, // (ж)
  ],
};
/** Ті самі байти ще раз (інший id спроби). */
export const G9_DOC_FILE_AGAIN: RefCarrierDocument = { ...G9_DOC_FILE, id: "doc-7001-again", importedAt: "2026-11-13T09:00:00Z" };
/** Той самий номер і вид, інші байти: (а) виправлено на 530,00, «Сума за рахунком» 2 500,00. */
export const G9_DOC_FILE_V2: RefCarrierDocument = {
  ...G9_DOC_FILE,
  id: "doc-7001-v2",
  sha256: "sha-g9-7001-b",
  total: { amount: "2500.00", currency: "UAH" },
  importedAt: "2026-11-25T09:00:00Z",
  rows: G9_DOC_FILE.rows.map((r) => (r.rowNumber === 2 ? { ...r, amount: "530.00" } : r.lineKind === "total" ? { ...r, amount: "2500.00" } : r)),
};
/** (з) кредит-нота до рахунку № 7001: −20,00 за накладною …11, дата послуги 20.11. */
export const G9_DOC_CREDIT: RefCarrierDocument = {
  id: "doc-7001-cn",
  carrier: NP,
  accountRef: ACC,
  invoiceNumber: "7001",
  kind: "credit_note",
  sha256: "sha-g9-7001-cn",
  invoiceDate: "2026-11-20",
  total: null,
  importedAt: "2026-11-21T09:00:00Z",
  rows: [{ rowNumber: 2, number: "20450000000011", service: "Коригування", amount: "-20.00", currency: "UAH", chargeDate: "2026-11-20" }],
};
/** (г) файл із дублем (а) — перевірка на порожньому реєстрі (крок 3). */
export const G9_DOC_DUPLICATE: RefCarrierDocument = {
  ...G9_DOC_FILE,
  id: "doc-7002",
  invoiceNumber: "7002",
  sha256: "sha-g9-7002",
  total: null,
  rows: [G9_DOC_FILE.rows[0]!, { ...G9_DOC_FILE.rows[0]!, rowNumber: 3 }],
};
/** (и) рахунок № 1234 лише з підсумком 2 000,00. */
export const G9_DOC_1234_TOTAL: RefCarrierDocument = {
  id: "doc-1234-inv",
  carrier: NP,
  accountRef: ACC,
  invoiceNumber: "1234",
  kind: "invoice",
  sha256: "sha-g9-1234-inv",
  invoiceDate: "2026-11-05",
  total: { amount: "2000.00", currency: "UAH" },
  importedAt: "2026-11-06T09:00:00Z",
  rows: [],
};
/** (и) потім специфікація № « 12 34 » (нормалізується до 1234) з рядками на 1 990,00. */
export const G9_DOC_1234_SPEC: RefCarrierDocument = {
  id: "doc-1234-spec",
  carrier: NP,
  accountRef: ACC,
  invoiceNumber: " 12 34 ",
  kind: "specification",
  sha256: "sha-g9-1234-spec",
  invoiceDate: "2026-11-05",
  total: null,
  importedAt: "2026-11-08T09:00:00Z",
  rows: [
    { rowNumber: 2, number: "20450000000021", service: "Доставка", amount: "700.00", currency: "UAH" },
    { rowNumber: 3, number: "20450000000022", service: "Доставка", amount: "640.00", currency: "UAH" },
    { rowNumber: 4, number: "20450000000023", service: "Доставка", amount: "650.00", currency: "UAH" },
  ],
};
/** (і) той самий набір рядків під іншим номером. */
export const G9_DOC_1235: RefCarrierDocument = { ...G9_DOC_1234_SPEC, id: "doc-1235", invoiceNumber: "1235", sha256: "sha-g9-1235", importedAt: "2026-11-09T09:00:00Z" };

/** G9 — рядки файлу (а)–(є) і (г) дубль (а). */
export const G9_FILE_LINES: readonly ImportLine[] = [
  { number: "20450000000011", service: "Доставка", amount: "540.00", currency: "UAH" },
  { number: "20450000000012", service: "Доставка", amount: "700.00", currency: "UAH" },
  { number: "20450000000099", service: "Доставка", amount: "300.00", currency: "UAH" },
  { number: "20450000000011", service: "Доставка", amount: "540.00", currency: "UAH" },
  { number: "20450000000013", service: "Доставка", amount: "350.00", currency: "UAH" },
  { number: " 2045 0000 0000 14 ", service: "Доставка", amount: "410.00", currency: "UAH" },
];
export const G9_EXPECTED = {
  a: { code: "matched", amountVsForecast: false },
  b: { code: "matched", amountVsForecast: true },
  c: { code: "unmatched_waybill", unallocatedEntry: "-300.00" },
  d: { duplicateIndices: [3] },
  e: { code: "shipment_cancelled" },
  f: { code: "matched", norm: "20450000000014" },
  g: { raw: "2.0451E+13", code: "invalid_number" },
  /** (и) рахунок № 1234 лише з підсумком 2 000,00 → потім специфікація з рядками на 1 990,00. */
  i: { totalOnlyEntry: "-2000.00", specLines: ["700.00", "640.00", "650.00"], controlTotal: "2000.00", mismatch: "10.00" },
  /** (ї) платна вага 2 500 г при 2 000 г. */
  weight: { charged: 2500, shipment: 2000, mismatch: true },
  /** (й) факт 700,00 грн, сплачено покупцем 10,00 EUR = 485,00 грн за 48,50. */
  loss: { actual: "700.00", paidEur: "10.00", paidUah: "485.00", loss: "215.00", flagged: true },
  /** (к) рядок зберігання 40,00 без номера. */
  storage: { unallocatedEntry: "-40.00" },
  /** Збереження G9_DOC_FILE на порожньому реєстрі: крок 3 і проведення. */
  file: {
    summary: {
      lines: 8,
      matched: 4,
      unmatched: 1,
      ambiguous: 0,
      errors: 1,
      duplicates: 0,
      discrepancies: 7,
      noNumber: { count: 1, amount: "40.00" },
      totalRows: 1,
      totalsByCurrency: { UAH: "2510.00" },
      posting: true,
      controlTotal: { amount: "2510.00", lines: "2510.00", mismatch: null },
      replaces: null,
    },
    discrepancyTypes: ["amount_vs_forecast", "invalid_number", "manual_cost_exists", "shipment_cancelled", "shipping_loss", "unmatched_waybill", "weight_mismatch"],
    amountVsForecast: { waybillId: "wb-b", amount: "200.00" },
    shippingLoss: { orderId: "o-b", amount: "215.00" },
    /** Нерозподілені записи (R4, дата рахунку 10.11): (в) …99, (д) скасоване, (є) пошкоджене число, (к) зберігання. */
    unallocated: [
      { row: 4, category: "shipping_unallocated", amount: "-300.00", recognizedOn: "2026-11-10", fxOn: "2026-11-10" },
      { row: 5, category: "shipping_unallocated", amount: "-350.00", recognizedOn: "2026-11-10", fxOn: "2026-11-10" },
      { row: 7, category: "shipping_unallocated", amount: "-50.00", recognizedOn: "2026-11-10", fxOn: "2026-11-10" },
      { row: 8, category: "shipping_unallocated", amount: "-40.00", recognizedOn: "2026-11-10", fxOn: "2026-11-10" },
    ],
    orderLines: [
      { orderId: "o-a", waybillId: "wb-a", chargeType: "delivery", amount: "540.00" },
      { orderId: "o-b", waybillId: "wb-b", chargeType: "delivery", amount: "700.00" },
      { orderId: "o-e", waybillId: "wb-e", chargeType: "delivery", amount: "410.00" },
      { orderId: "o-e", waybillId: "wb-e", chargeType: "customs_duty", amount: "120.00" },
    ],
  },
  /** (г) крок 3 для файлу з дублем. */
  duplicateFile: { duplicates: 1, lines: 2 },
  /** Повторне завантаження тих самих байтів → відмова. */
  sameBytes: { error: "same_file", existingDocumentId: "doc-7001-v1" },
  /** Той самий номер і вид, інші байти → відмова без «Замінити». */
  sameNumberOtherBytes: { error: "same_number_kind", existingDocumentId: "doc-7001-v1" },
  /** Заміна (з причиною) → у журналі лише записи нової версії (старі сторновано). */
  replacement: {
    version: 2,
    oldStatus: "replaced",
    reversedUnallocated: ["300.00", "350.00", "50.00", "40.00"],
    activeEntryDocuments: ["doc-7001-v2"],
    /** Активні записи доставки замовлення o-a (30.11): нова версія (R2) і кредит-нота (R2). */
    orderA: [
      { category: "shipping_cost", amount: "-530.00", recognizedOn: "2026-11-10", fxOn: "2026-11-10" },
      { category: "shipping_cost", amount: "20.00", recognizedOn: "2026-11-20", fxOn: "2026-11-20" },
    ],
    /** Перша версія (R3) і її сторно — датою й курсом оригіналу. */
    orderAReversed: { amount: "-540.00", reversal: "540.00", recognizedOn: "2026-10-05", fxOn: "2026-11-10", isLateCompletion: true },
  },
  /** (и) через реєстр: підсумок проведено, потім специфікація сторнує його й проводить рядки. */
  totalThenSpec: {
    totalEntry: { category: "shipping_unallocated", amount: "-2000.00", recognizedOn: "2026-11-05", fxOn: "2026-11-05" },
    reversal: { amount: "2000.00", recognizedOn: "2026-11-05", fxOn: "2026-11-05" },
    replaces: { documentId: "doc-1234-inv", reversedCost: "2000.00", newCost: "1990.00", lines: 3 },
    controlTotal: { amount: "2000.00", lines: "1990.00", mismatch: "10.00" },
    numberNorm: "1234",
  },
  /** (і) той самий набір рядків під іншим номером → збереження заблоковано; «окремий» з причиною → possible_double_billing. */
  similar: { error: "similar_document", existingDocumentId: "doc-1234-spec", doubleBilling: 3 },
} as const;
