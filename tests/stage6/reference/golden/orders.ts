/**
 * Золоті випадки етапу 6 (WP12a → WP12b): сирі факти замовлень (G1, G1b, G2, G8, G8b, G10, G10b, G10c, G11, G12).
 * Усі ідентифікатори, коди й суми вигадані; персональних даних немає. Моменти — ISO UTC; дати Києва — у коментарях.
 */
import type { RefOrderFacts } from "../model/order-posting";

const T_PAID_0510 = "2026-10-05T07:00:00Z"; // 05.10 10:00 Київ
const T_HANDOVER_0510 = "2026-10-05T12:00:00Z"; // 05.10 15:00 Київ

/**
 * G1 — магазин EUR, звітність UAH: A 2 × 50,00, B 1 × 30,00, код PART10 −10 %, доставка 12,00, без податку;
 * повернення 04.11 (A −1 од., −45,00), надходження придатне 06.11 (+400,00 грн), рахунок 540,00 імпортовано 10.11.
 */
export const G1_ORDER: RefOrderFacts = {
  id: "ord-g1",
  currency: "EUR",
  country: "DE",
  placedAt: T_PAID_0510,
  handedOverAt: T_HANDOVER_0510,
  displayFinancialStatus: "PARTIALLY_REFUNDED",
  lines: [
    { id: "li-g1-a", productId: "prod-a", quantity: 2 },
    { id: "li-g1-b", productId: "prod-b", quantity: 1 },
  ],
  sales: [
    { id: "s-g1-a", agreement: "order", lineType: "PRODUCT", lineId: "li-g1-a", productId: "prod-a", quantity: 2, totalAmount: "90.00", taxAmount: "0.00", discountAmount: "10.00", happenedAt: T_PAID_0510 },
    { id: "s-g1-b", agreement: "order", lineType: "PRODUCT", lineId: "li-g1-b", productId: "prod-b", quantity: 1, totalAmount: "27.00", taxAmount: "0.00", discountAmount: "3.00", happenedAt: T_PAID_0510 },
    { id: "s-g1-ship", agreement: "order", lineType: "SHIPPING", totalAmount: "12.00", taxAmount: "0.00", happenedAt: T_PAID_0510 },
    { id: "s-g1-ret", agreement: "return", lineType: "PRODUCT", lineId: "li-g1-a", productId: "prod-a", quantity: -1, totalAmount: "-45.00", taxAmount: "0.00", happenedAt: "2026-11-04T10:00:00Z" },
  ],
  transactions: [
    { id: "t-g1-sale", kind: "SALE", status: "SUCCESS", amount: "129.00", processedAt: T_PAID_0510, gateway: "shopify_payments", fees: [{ id: "fee-g1", amount: "4.04", currency: "EUR" }] },
    { id: "t-g1-refund", kind: "REFUND", status: "SUCCESS", amount: "45.00", processedAt: "2026-11-04T10:00:00Z", gateway: "shopify_payments" },
  ],
  valuations: [
    { id: "v-g1-a", kind: "consume", lineId: "li-g1-a", productId: "prod-a", quantity: 2, value: "800.00", currency: "UAH", occurredAt: T_HANDOVER_0510 },
    { id: "v-g1-b", kind: "consume", lineId: "li-g1-b", productId: "prod-b", quantity: 1, value: "250.00", currency: "UAH", occurredAt: T_HANDOVER_0510 },
    { id: "v-g1-pack", kind: "material", quantity: 1, value: "21.00", currency: "UAH", occurredAt: "2026-10-05T09:00:00Z" },
    { id: "v-g1-ret", kind: "return", lineId: "li-g1-a", productId: "prod-a", quantity: 1, value: "400.00", currency: "UAH", occurredAt: "2026-11-06T10:00:00Z" },
  ],
  waybills: [{ id: "wb-g1", source: "app", number: "20450000000011", country: "DE", chargeableWeightGrams: 1200, frozenForecast: { basis: "carrier_reported", amount: "520.00", currency: "UAH" } }],
  invoiceLines: [{ id: "il-g1", waybillId: "wb-g1", documentId: "inv-1001", chargeType: "delivery", amount: "540.00", currency: "UAH", serviceDate: "2026-10-05", importedAt: "2026-11-10T09:00:00Z" }],
  partner: { partnerId: "partner-a", rateBp: 1000, holdDays: 30 },
};

/** Між 06.11 і 10.11 (до імпорту рахунку) і після імпорту. */
export const G1_AS_OF_BEFORE_IMPORT = "2026-11-08T12:00:00Z";
export const G1_AS_OF_AFTER_IMPORT = "2026-11-30T12:00:00Z";

/** G1 без повернення (основа G10 / G10c). */
export const G1_ORDER_NO_RETURN: RefOrderFacts = {
  ...G1_ORDER,
  id: "ord-g1-noret",
  displayFinancialStatus: "PAID",
  sales: G1_ORDER.sales.filter((s) => s.agreement === "order"),
  transactions: G1_ORDER.transactions.filter((t) => t.kind === "SALE"),
  valuations: G1_ORDER.valuations.filter((v) => v.kind !== "return"),
};

/** G1b — передоплата 01.10 (48,0000), передано 05.10 (48,5000), продаж 100,00 EUR. */
export const G1B_ORDER: RefOrderFacts = {
  id: "ord-g1b",
  currency: "EUR",
  country: "DE",
  placedAt: "2026-10-01T08:00:00Z",
  handedOverAt: T_HANDOVER_0510,
  lines: [{ id: "li-g1b", productId: "prod-a", quantity: 1 }],
  sales: [{ id: "s-g1b", agreement: "order", lineType: "PRODUCT", lineId: "li-g1b", productId: "prod-a", quantity: 1, totalAmount: "100.00", taxAmount: "0.00", happenedAt: "2026-10-01T08:00:00Z" }],
  transactions: [{ id: "t-g1b", kind: "SALE", status: "SUCCESS", amount: "100.00", processedAt: "2026-10-01T08:00:00Z", gateway: "shopify_payments", fees: [] }],
  valuations: [
    { id: "v-g1b", kind: "consume", lineId: "li-g1b", productId: "prod-a", quantity: 1, value: "400.00", currency: "UAH", occurredAt: T_HANDOVER_0510 },
    { id: "v-g1b-pack", kind: "material", quantity: 1, value: "10.00", currency: "UAH", occurredAt: T_HANDOVER_0510 },
  ],
  waybills: [],
  invoiceLines: [],
};

/** G2 — DE 19 %: товар 59,50 (податок 9,50), доставка 10,00 (податок 1,60); партнер 10 %. */
export const G2_ORDER: RefOrderFacts = {
  id: "ord-g2",
  currency: "EUR",
  country: "DE",
  placedAt: T_PAID_0510,
  handedOverAt: T_HANDOVER_0510,
  lines: [{ id: "li-g2", productId: "prod-a", quantity: 1 }],
  sales: [
    { id: "s-g2-p", agreement: "order", lineType: "PRODUCT", lineId: "li-g2", productId: "prod-a", quantity: 1, totalAmount: "59.50", taxAmount: "9.50", happenedAt: T_PAID_0510 },
    { id: "s-g2-s", agreement: "order", lineType: "SHIPPING", totalAmount: "10.00", taxAmount: "1.60", happenedAt: T_PAID_0510 },
  ],
  transactions: [{ id: "t-g2", kind: "SALE", status: "SUCCESS", amount: "69.50", processedAt: T_PAID_0510, gateway: "shopify_payments", fees: [{ id: "fee-g2", amount: "2.10", currency: "EUR" }] }],
  valuations: [
    { id: "v-g2", kind: "consume", lineId: "li-g2", productId: "prod-a", quantity: 1, value: "400.00", currency: "UAH", occurredAt: T_HANDOVER_0510 },
    { id: "v-g2-pack", kind: "material", quantity: 1, value: "15.00", currency: "UAH", occurredAt: T_HANDOVER_0510 },
  ],
  waybills: [{ id: "wb-g2", source: "app", number: "20450000000021", country: "DE", frozenForecast: { basis: "carrier_reported", amount: "500.00", currency: "UAH" } }],
  invoiceLines: [],
  partner: { partnerId: "partner-a", rateBp: 1000, holdDays: 30 },
};

/** G2 — підсумки Shopify для звірки RC1–RC4 (RC4: лише податок товарів 9,50). */
export const G2_TOTALS = { currentTotalPrice: "69.50", netPayment: "69.50", totalRefunded: "0.00", currentTotalTax: "9.50" } as const;

/** G8 — визнане; варіант не відкритий, без ручної собівартості й партії; шлюз «PayPal» без правила. */
export const G8_ORDER: RefOrderFacts = {
  id: "ord-g8",
  currency: "EUR",
  country: "PL",
  placedAt: T_PAID_0510,
  handedOverAt: T_HANDOVER_0510,
  lines: [{ id: "li-g8", productId: "prod-c", quantity: 1 }],
  sales: [{ id: "s-g8", agreement: "order", lineType: "PRODUCT", lineId: "li-g8", productId: "prod-c", quantity: 1, totalAmount: "80.00", taxAmount: "0.00", happenedAt: T_PAID_0510 }],
  transactions: [{ id: "t-g8", kind: "SALE", status: "SUCCESS", amount: "80.00", processedAt: T_PAID_0510, gateway: "PayPal", fees: [] }],
  valuations: [{ id: "v-g8-pack", kind: "material", quantity: 1, value: "12.00", currency: "UAH", occurredAt: T_HANDOVER_0510 }],
  waybills: [{ id: "wb-g8", source: "app", number: "20450000000081", country: "PL", frozenForecast: { basis: "carrier_reported", amount: "450.00", currency: "UAH" } }],
  invoiceLines: [{ id: "il-g8", waybillId: "wb-g8", documentId: "inv-1002", chargeType: "delivery", amount: "450.00", currency: "UAH", serviceDate: "2026-10-05", importedAt: "2026-10-06T09:00:00Z" }],
  feeRule: null,
};

/** G8b — відправлено поза застосунком без трек-номера (варіанти: таблиця власника / нічого / «Без витрат на доставку»). */
export const G8B_ORDER_TABLE: RefOrderFacts = {
  id: "ord-g8b",
  currency: "EUR",
  country: "DE",
  placedAt: T_PAID_0510,
  consumeAt: null,
  fulfilledImported: false,
  handedOverAt: T_HANDOVER_0510,
  lines: [{ id: "li-g8b", productId: "prod-n", quantity: 1 }],
  sales: [{ id: "s-g8b", agreement: "order", lineType: "PRODUCT", lineId: "li-g8b", productId: "prod-n", quantity: 1, totalAmount: "100.00", taxAmount: "0.00", happenedAt: T_PAID_0510 }],
  transactions: [{ id: "t-g8b", kind: "SALE", status: "SUCCESS", amount: "100.00", processedAt: T_PAID_0510, gateway: "manual_bank", fees: [] }],
  valuations: [{ id: "v-g8b-std", kind: "stdcogs", lineId: "li-g8b", productId: "prod-n", quantity: 1, value: "210.00", currency: "UAH", occurredAt: T_HANDOVER_0510 }],
  waybills: [],
  invoiceLines: [],
  noWaybillForecast: { basis: "owner_table", amount: "300.00", currency: "UAH" },
  feeRule: { kind: "no_fees" },
  packagingAccountedInBulk: true,
};
export const G8B_ORDER_NOTHING: RefOrderFacts = { ...G8B_ORDER_TABLE, noWaybillForecast: { basis: "none", amount: null, currency: "UAH" } };
export const G8B_ORDER_OWNER_MARK: RefOrderFacts = { ...G8B_ORDER_NOTHING, shippingOwnerMark: "no_shipping_cost" };

/**
 * G5 «позиція без списання» (§6.8): варіант не відкритий, відвантажено 2 од., ручна собівартість 210,00 від дати раніше
 * відвантаження → stdcogs 2 × 210,00 (очікування — G5_NO_WRITEOFF у costing.ts).
 */
export const G5_NO_WRITEOFF_ORDER: RefOrderFacts = {
  ...G8B_ORDER_OWNER_MARK,
  id: "ord-g5-std",
  lines: [{ id: "li-g5-std", productId: "prod-n", quantity: 2 }],
  valuations: [{ id: "v-g5-std", kind: "stdcogs", lineId: "li-g5-std", productId: "prod-n", quantity: 2, value: "420.00", currency: "UAH", occurredAt: T_HANDOVER_0510 }],
};
/** Те саме + друга позиція зі складу (змішана основа → owner_standard, тлумачення моделі). */
export const G5_MIXED_BASIS_ORDER: RefOrderFacts = {
  ...G5_NO_WRITEOFF_ORDER,
  id: "ord-g5-mixed",
  lines: [...G5_NO_WRITEOFF_ORDER.lines, { id: "li-g5-stock", productId: "prod-a", quantity: 1 }],
  valuations: [...G5_NO_WRITEOFF_ORDER.valuations, { id: "v-g5-stock", kind: "consume", lineId: "li-g5-stock", productId: "prod-a", quantity: 1, value: "400.00", currency: "UAH", occurredAt: T_HANDOVER_0510 }],
};

/** G10 — програно 129,00 EUR (без податку), повернено 0, комісія 15,00 EUR 12.11. */
export const G10_ORDER: RefOrderFacts = {
  ...G1_ORDER_NO_RETURN,
  id: "ord-g10",
  disputes: [{ id: "dsp-g10", outcome: "lost", decidedOn: "2026-11-12", disputed: "129.00", reversed: "0.00", fee: { amount: "15.00", currency: "EUR", date: "2026-11-12" }, enteredAt: "2026-11-12T12:00:00Z" }],
};
/** G10 + повернення коштів → chargeback_refund_overlap. */
export const G10_ORDER_WITH_REFUND: RefOrderFacts = { ...G1_ORDER, id: "ord-g10r", disputes: G10_ORDER.disputes };

/** G10b — замовлення G2: спір 69,50, повернено 20,00 (типово; «ПДВ зменшується»; «Скасувати винагороду повністю»). */
const G10B_DISPUTE = { id: "dsp-g10b", outcome: "lost" as const, decidedOn: "2026-11-12", disputed: "69.50", reversed: "20.00", enteredAt: "2026-11-12T12:00:00Z" };
export const G10B_ORDER: RefOrderFacts = { ...G2_ORDER, id: "ord-g10b", disputes: [G10B_DISPUTE] };
export const G10B_ORDER_VAT: RefOrderFacts = { ...G2_ORDER, id: "ord-g10b-vat", disputes: [{ ...G10B_DISPUTE, vatReduces: true }] };
export const G10B_ORDER_CANCEL: RefOrderFacts = { ...G2_ORDER, id: "ord-g10b-cancel", disputes: [{ ...G10B_DISPUTE, cancelCommission: true }] };

/** G10c — замовлення G1, посилку втрачено: ADJUSTMENT угоди REFUND −129,00 (15.11). */
export const G10C_ORDER: RefOrderFacts = {
  ...G1_ORDER_NO_RETURN,
  id: "ord-g10c",
  sales: [...G1_ORDER_NO_RETURN.sales, { id: "s-g10c-adj", agreement: "refund", lineType: "ADJUSTMENT", totalAmount: "-129.00", taxAmount: "0.00", happenedAt: "2026-11-15T10:00:00Z" }],
};

/** G11 — жовтень закрито 05.11; повернення Shopify з happenedAt 31.10, синхронізоване 06.11. */
export const G11_ORDER: RefOrderFacts = {
  ...G1_ORDER_NO_RETURN,
  id: "ord-g11",
  invoiceLines: [{ ...G1_ORDER.invoiceLines[0]!, importedAt: "2026-10-20T09:00:00Z" }],
  sales: [
    ...G1_ORDER_NO_RETURN.sales,
    { id: "s-g11-ret", agreement: "return", lineType: "PRODUCT", lineId: "li-g1-a", productId: "prod-a", quantity: -1, totalAmount: "-45.00", taxAmount: "0.00", happenedAt: "2026-10-31T10:00:00Z", knownAt: "2026-11-06T10:00:00Z" },
  ],
};
export const G11_CLOSURES = [{ month: "2026-10", closedAt: "2026-11-05T10:00:00Z", allConfirmedWithTaxes: true }] as const;

/** G12 — оформлено 30.10.2026 23:30 UTC (= 31.10 01:30 Київ), передано 02.11, повернення 05.11. */
export const G12_ORDER: RefOrderFacts = {
  id: "ord-g12",
  currency: "UAH",
  country: "UA",
  placedAt: "2026-10-30T23:30:00Z",
  handedOverAt: "2026-11-02T10:00:00Z",
  lines: [{ id: "li-g12", productId: "prod-a", quantity: 1 }],
  sales: [
    { id: "s-g12", agreement: "order", lineType: "PRODUCT", lineId: "li-g12", productId: "prod-a", quantity: 1, totalAmount: "1500.00", taxAmount: "0.00", happenedAt: "2026-10-30T23:30:00Z" },
    { id: "s-g12-ret", agreement: "refund", lineType: "PRODUCT", lineId: "li-g12", productId: "prod-a", quantity: -1, totalAmount: "-1500.00", taxAmount: "0.00", happenedAt: "2026-11-05T09:00:00Z" },
  ],
  transactions: [{ id: "t-g12", kind: "SALE", status: "SUCCESS", amount: "1500.00", processedAt: "2026-10-30T23:30:00Z", gateway: "liqpay", fees: [{ id: "fee-g12", amount: "30.00", currency: "UAH" }] }],
  valuations: [{ id: "v-g12", kind: "consume", lineId: "li-g12", productId: "prod-a", quantity: 1, value: "400.00", currency: "UAH", occurredAt: "2026-11-02T10:00:00Z" }],
  waybills: [],
  invoiceLines: [],
  shippingOwnerMark: "recipient_pays",
  packagingAccountedInBulk: true,
};
