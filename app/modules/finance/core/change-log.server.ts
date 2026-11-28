/**
 * Етап 6: історія фінансових змін `finance_change_log` (docs/stage6-design.md §14.4). Пишеться в ТІЙ САМІЙ транзакції,
 * що й зміна. before/after — лише дозволені для типу сутності ключі (zod, strict) зі значеннями: десяткові рядки, коди,
 * ISO-дати, id, кількості, булеві — без персональних даних покупців і без імен партнерів. Причина — маскований вільний
 * текст ≤ 300. НЕ проходить через redact() (він маскує суми й дати). `audit_log` отримує дії `finance.*` лише з id і
 * кількостями (writeAudit викликає сервіс).
 */
import { and, desc, eq, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { DbOrTx } from "~/db/client.server";
import { financeChangeLog } from "~/db/schema";
import { FINANCE_CHANGE_ACTIONS, FINANCE_CHANGE_ENTITY_TYPES, type FinanceChangeAction, type FinanceChangeEntityType } from "~/domain/finance";
import type { Actor } from "~/domain/permissions";
import { maskFreeTextNote } from "~/modules/privacy/notes";
import { financeSchema } from "~/modules/settings/schema";
import { requireFinance } from "./access.server";
import { DEFAULT_STORE_ID } from "./store.server";

const decimal = z.string().regex(/^-?\d{1,14}(\.\d{1,10})?$/);
const currency = z.string().regex(/^[A-Z]{3}$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const code = z.string().regex(/^[A-Za-z0-9_.:\-/]{1,80}$/);
const uuid = z.string().uuid();
const int = z.number().int();
const count = z.number().int().min(0);
const bool = z.boolean();
const nullable = <T extends z.ZodTypeAny>(t: T) => t.nullable();
/** Номер документа перевізника / код знижки / номер рахунку: не персональні дані, ≤ 64. */
const docNumber = z.string().min(1).max(64).regex(/^[^\s@]{1,64}$/);

/** Спільний словник полів (одне ім'я = один тип скрізь). */
const F = {
  id: uuid,
  version: int,
  status: code,
  amount: nullable(decimal),
  currency: nullable(currency),
  date: nullable(isoDate),
  count,
  // витрати
  category: code,
  expenseDate: nullable(isoDate),
  periodFrom: nullable(isoDate),
  periodTo: nullable(isoDate),
  channel: nullable(code),
  gateway: nullable(z.string().max(120)),
  carrierCode: nullable(code),
  partnerId: nullable(uuid),
  orderId: nullable(uuid),
  returnId: nullable(uuid),
  productionBatchId: nullable(uuid),
  coversForecast: bool,
  separateFromForecast: bool,
  supersedesId: nullable(uuid),
  expenseId: uuid,
  expenseVersion: int,
  orders: count,
  total: nullable(decimal),
  weightBasis: code,
  // собівартість
  stockItemId: uuid,
  stockItems: count,
  unitCost: nullable(decimal),
  effectiveFrom: nullable(isoDate),
  source: code,
  confirmed: bool,
  model: nullable(z.string().max(120)),
  color: nullable(z.string().max(120)),
  applyToStock: bool,
  applyToSold: bool,
  completions: count,
  value: nullable(decimal),
  batchId: uuid,
  batchLineId: nullable(uuid),
  extraCost: nullable(decimal),
  deltaStock: nullable(decimal),
  deltaSales: nullable(decimal),
  materialId: uuid,
  valuationId: uuid,
  layerId: nullable(uuid),
  qty: count,
  basis: nullable(code),
  // курси
  quoteCurrency: currency,
  effectiveDate: isoDate,
  rate: decimal,
  units: int,
  ratePerUnit: decimal,
  rateVersion: int,
  affectedEntries: count,
  deltaReporting: nullable(decimal),
  reportingCurrency: currency,
  // обмін
  occurredOn: isoDate,
  soldAmount: decimal,
  soldCurrency: currency,
  boughtAmount: decimal,
  boughtCurrency: currency,
  counterparty: code,
  difference: nullable(decimal),
  differenceCurrency: nullable(currency),
  // комісії
  kind: code,
  percentBp: int,
  fixedAmount: nullable(decimal),
  fixedCurrency: nullable(currency),
  noFees: bool,
  appliesFrom: isoDate,
  appliesTo: nullable(isoDate),
  // партнери (без імен)
  holdDays: int,
  payoutCurrency: nullable(currency),
  nameChanged: bool,
  code: docNumber,
  codeId: nullable(uuid),
  validFrom: nullable(isoDate),
  validTo: nullable(isoDate),
  active: bool,
  rateBp: int,
  paidOn: isoDate,
  coversAmount: nullable(decimal),
  coversCurrency: nullable(currency),
  method: code,
  // імпорт
  headerSignature: z.string().regex(/^[0-9a-f]{64}$/),
  documentKind: code,
  invoiceNumber: docNumber,
  rows: count,
  matched: count,
  discrepancies: count,
  controlTotal: nullable(decimal),
  replacesId: nullable(uuid),
  invoiceLineId: uuid,
  shipmentId: nullable(uuid),
  externalWaybillId: nullable(uuid),
  matchStatus: code,
  matchVersion: int,
  chargeType: code,
  // розбіжності
  type: code,
  severity: code,
  resolutionCode: nullable(code),
  // chargeback
  disputeId: uuid,
  recoveredAmount: nullable(decimal),
  fee: nullable(decimal),
  feeCurrency: nullable(currency),
  outcome: nullable(code),
  decidedOn: nullable(isoDate),
  vatReducible: nullable(bool),
  fullPartnerCancellation: bool,
  // позначки замовлення
  component: code,
  override: code,
  productsAmount: nullable(decimal),
  shippingAmount: nullable(decimal),
  // місяці
  month: isoDate,
  netProfitEligible: bool,
  checklist: z.record(code, z.union([code, bool, count, z.null()])),
  snapshots: count,
  // знімки
  periodFromDate: isoDate,
  periodToDate: isoDate,
  isFinal: bool,
  dataSha256: z.string().regex(/^[0-9a-f]{64}$/),
  // налаштування фінансів (лише змінені ключі верхнього рівня; значення — як у схемі finance, без персональних даних)
  settings: z.partialRecord(z.enum(Object.keys(financeSchema.shape) as [string, ...string[]]), z.json()),
  settingsVersion: int,
} as const;

type FieldName = keyof typeof F;

/** Дозволені ключі before/after на тип сутності. */
export const CHANGE_LOG_FIELDS: Readonly<Record<FinanceChangeEntityType, readonly FieldName[]>> = {
  expense: [
    "id", "version", "status", "category", "amount", "currency", "expenseDate", "periodFrom", "periodTo", "channel", "gateway",
    "carrierCode", "partnerId", "orderId", "returnId", "productionBatchId", "coversForecast", "separateFromForecast", "supersedesId",
  ],
  expense_allocation: ["expenseId", "expenseVersion", "orders", "total", "currency", "weightBasis"],
  stock_item_cost: [
    "stockItemId", "stockItems", "unitCost", "currency", "effectiveFrom", "source", "confirmed", "model", "color", "applyToStock",
    "applyToSold", "completions", "value",
  ],
  batch_cost: ["batchId", "batchLineId", "unitCost", "currency", "extraCost", "deltaStock", "deltaSales", "version"],
  material_cost: ["materialId", "unitCost", "currency"],
  fx_rate: [
    "currency", "quoteCurrency", "effectiveDate", "rate", "units", "ratePerUnit", "source", "rateVersion", "affectedEntries",
    "deltaReporting", "reportingCurrency",
  ],
  fx_conversion: [
    "occurredOn", "soldAmount", "soldCurrency", "boughtAmount", "boughtCurrency", "counterparty", "status", "difference",
    "differenceCurrency", "version",
  ],
  fee_rule: ["gateway", "kind", "percentBp", "fixedAmount", "fixedCurrency", "noFees", "appliesFrom", "appliesTo"],
  partner: ["kind", "status", "holdDays", "payoutCurrency", "version", "nameChanged"],
  partner_code: ["partnerId", "code", "source", "validFrom", "validTo", "active"],
  partner_rate: ["partnerId", "codeId", "rateBp", "effectiveFrom"],
  partner_attribution: ["orderId", "partnerId", "codeId", "source", "rateBp", "holdDays", "status"],
  payout: ["partnerId", "paidOn", "amount", "currency", "coversAmount", "coversCurrency", "method", "status"],
  import_profile: ["carrierCode", "version", "active", "headerSignature", "documentKind"],
  carrier_invoice: [
    "carrierCode", "invoiceNumber", "documentKind", "status", "version", "rows", "matched", "discrepancies", "currency", "controlTotal",
    "replacesId",
  ],
  invoice_line_match: ["invoiceLineId", "orderId", "shipmentId", "externalWaybillId", "matchStatus", "matchVersion", "chargeType"],
  discrepancy: ["type", "status", "severity", "resolutionCode", "orderId"],
  chargeback: [
    "disputeId", "orderId", "amount", "recoveredAmount", "currency", "fee", "feeCurrency", "outcome", "decidedOn", "vatReducible",
    "fullPartnerCancellation", "version",
  ],
  order_component_override: ["orderId", "component", "override", "productsAmount", "shippingAmount", "currency", "active"],
  period: ["month", "status", "netProfitEligible", "checklist", "snapshots", "version"],
  report_snapshot: ["kind", "periodFromDate", "periodToDate", "reportingCurrency", "version", "isFinal", "source", "dataSha256"],
  settings_finance: ["settings", "settingsVersion"],
  valuation_completion: ["valuationId", "layerId", "stockItemId", "qty", "value", "currency", "basis"],
};

const SCHEMAS = Object.fromEntries(
  FINANCE_CHANGE_ENTITY_TYPES.map((t) => [
    t,
    z.object(Object.fromEntries(CHANGE_LOG_FIELDS[t].map((f) => [f, F[f].optional()])) as Record<string, z.ZodTypeAny>).strict(),
  ]),
) as unknown as Record<FinanceChangeEntityType, z.ZodType<Record<string, unknown>>>;

/** Перевірка значень до/після (помилка програміста → RangeError з назвою поля, без значення). */
export function assertChangeValues(entityType: FinanceChangeEntityType, values: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (values === null || values === undefined) return null;
  const parsed = SCHEMAS[entityType].safeParse(values);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => (i.path.length ? i.path.join(".") : (i as { keys?: string[] }).keys?.join(",") ?? i.code)).join(", ");
    throw new RangeError(`finance_change_log ${entityType}: invalid fields ${fields}`);
  }
  return parsed.data;
}

export interface FinanceChangeInput {
  entityType: FinanceChangeEntityType;
  entityId: string;
  action: FinanceChangeAction;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  /** Вільний текст власника (маскується, ≤ 300). */
  reason?: string | null;
  storeId?: string;
}

/** Записує зміну (у транзакції зміни). Актор — той, хто змінює (власник або SYSTEM_ACTOR). */
export async function writeFinanceChange(db: DbOrTx, actor: Pick<Actor, "id" | "role">, change: FinanceChangeInput): Promise<void> {
  if (!(FINANCE_CHANGE_ENTITY_TYPES as readonly string[]).includes(change.entityType)) throw new RangeError(`entity type ${change.entityType}`);
  if (!(FINANCE_CHANGE_ACTIONS as readonly string[]).includes(change.action)) throw new RangeError(`action ${change.action}`);
  if (!change.entityId || change.entityId.length > 200) throw new RangeError("entityId");
  await db.insert(financeChangeLog).values({
    storeId: change.storeId ?? DEFAULT_STORE_ID,
    entityType: change.entityType,
    entityId: change.entityId,
    action: change.action,
    before: assertChangeValues(change.entityType, change.before),
    after: assertChangeValues(change.entityType, change.after),
    reason: maskFreeTextNote(change.reason, 300),
    actorId: actor.id,
    actorRole: actor.role,
  });
}

export type FinanceChangeRow = typeof financeChangeLog.$inferSelect;

/** Історія змін (сторінка «Історія змін», розгортання «Історія» на сутності) — лише власник (finance.view). */
export async function listFinanceChanges(
  ctx: { db: DbOrTx; actor: Actor },
  filter: { entityType?: FinanceChangeEntityType; entityId?: string; limit?: number; storeId?: string } = {},
): Promise<FinanceChangeRow[]> {
  requireFinance(ctx, "view");
  const conds: SQL[] = [eq(financeChangeLog.storeId, filter.storeId ?? DEFAULT_STORE_ID)];
  if (filter.entityType) conds.push(eq(financeChangeLog.entityType, filter.entityType));
  if (filter.entityId) conds.push(eq(financeChangeLog.entityId, filter.entityId));
  return ctx.db
    .select()
    .from(financeChangeLog)
    .where(and(...conds))
    .orderBy(desc(financeChangeLog.createdAt), desc(financeChangeLog.id))
    .limit(Math.min(Math.max(filter.limit ?? 100, 1), 1000));
}
