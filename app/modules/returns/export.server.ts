/**
 * Етап 6, WP9 → WP10: рядки набору експорту `returns` (docs/stage6-design.md §13.2 — «без вільного тексту»): лише
 * id, номер замовлення, коди (вид, статус, причина, джерело), дати Києва, країна й одиниці. Примітка випадку
 * (`reason_note`) і будь-які персональні дані не експортуються. Набір фінансовий (`finance.view` + роль owner), бо
 * WP10 додає до нього суми журналу; самі рядки грошей не містять. Тестові замовлення Shopify — лише з
 * `finance.includeTestOrders` (§2.5, як у статистиці й P&L); одиниці — точні, неточні (MIXED) — окремим стовпцем.
 */
import { asc, eq } from "drizzle-orm";
import { orderReturns, orders } from "~/db/schema";
import type { DateRange } from "~/lib/periods";
import { requireFinance } from "~/modules/finance/core/access.server";
import { businessDate } from "~/modules/warehouse/dates";
import type { ServiceContext } from "~/server/types";
import { caseInsights } from "./insights.server";
import { includeTestOrdersSetting, returnsRangeWhere } from "./stats.server";
import type { ReturnKind, ReturnReason, ReturnStatus } from "./rules";

export const RETURNS_EXPORT_LIMIT = 50_000;

export interface ReturnExportRow {
  caseId: string;
  orderId: string;
  orderNumber: string;
  kind: ReturnKind;
  status: ReturnStatus;
  reasonCode: ReturnReason;
  source: string;
  firstSignalOn: string;
  receivedOn: string | null;
  closedOn: string | null;
  countryCode: string | null;
  /** Точно відомі одиниці. */
  units: number;
  restockedUnits: number;
  damagedUnits: number;
  /** Можливо ще одиниць (рядки повернення коштів MIXED — кількість неточна). */
  uncertainUnits: number;
  /** §6.7 «Очікує надходження на склад». */
  awaitingReceipt: boolean;
  testOrder: boolean;
}

/** Випадки з першим сигналом у періоді (Київ), за датою; `truncated` — більше за ліміт. */
export async function returnExportRows(
  ctx: Pick<ServiceContext, "db" | "actor">,
  range: DateRange,
  limit = RETURNS_EXPORT_LIMIT,
): Promise<{ rows: ReturnExportRow[]; truncated: boolean }> {
  requireFinance(ctx, "view");
  const cap = Math.min(Math.max(limit, 1), RETURNS_EXPORT_LIMIT);
  const includeTest = await includeTestOrdersSetting(ctx.db);
  const rows = await ctx.db
    .select({
      id: orderReturns.id,
      orderId: orderReturns.orderId,
      orderNumber: orders.orderNumber,
      kind: orderReturns.kind,
      status: orderReturns.status,
      reasonCode: orderReturns.reasonCode,
      source: orderReturns.source,
      firstSignalAt: orderReturns.firstSignalAt,
      receivedAt: orderReturns.receivedAt,
      closedAt: orderReturns.closedAt,
      countryCode: orders.shipCountryCode,
      testOrder: orders.shopifyTest,
    })
    .from(orderReturns)
    .innerJoin(orders, eq(orders.id, orderReturns.orderId))
    .where(returnsRangeWhere(range, includeTest))
    .orderBy(asc(orderReturns.firstSignalAt), asc(orderReturns.id))
    .limit(cap + 1);
  const page = rows.slice(0, cap);
  const insights = await caseInsights(ctx.db, page);
  return {
    truncated: rows.length > cap,
    rows: page.map((r) => {
      const i = insights.get(r.id);
      return {
        caseId: r.id,
        orderId: r.orderId,
        orderNumber: r.orderNumber,
        kind: r.kind,
        status: r.status,
        reasonCode: r.reasonCode,
        source: r.source,
        firstSignalOn: businessDate(r.firstSignalAt),
        receivedOn: r.receivedAt ? businessDate(r.receivedAt) : null,
        closedOn: r.closedAt ? businessDate(r.closedAt) : null,
        countryCode: r.countryCode,
        units: i?.units.units ?? 0,
        restockedUnits: i?.units.restocked ?? 0,
        damagedUnits: i?.units.damaged ?? 0,
        uncertainUnits: i?.units.uncertainUnits ?? 0,
        awaitingReceipt: i?.awaitingReceipt ?? false,
        testOrder: r.testOrder,
      };
    }),
  };
}
