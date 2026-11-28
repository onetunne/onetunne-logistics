/**
 * Етап 6, WP9: спільне для DB-тестів повернень — вигадані замовлення й товари (без персональних даних), факти Shopify
 * (повернення коштів з рядками — як їх записує WP3), відправлення з кодами перевізника, надходження повернення через
 * справжню операцію складу етапу 5 і виклик внутрішньої синхронізації в транзакції (як його робить WP4).
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "~/db/client.server";
import {
  orderLineItems,
  orderRefundLines,
  orderRefunds,
  orderReturnLines,
  orderReturns,
  orders,
  shipments,
  shipmentTrackingEvents,
} from "~/db/schema";
import { SYSTEM_ACTOR } from "~/domain/permissions";
import type { PostingActor } from "~/modules/finance/core/contracts";
import { syncReturnCasesForOrder } from "~/modules/returns/sync.server";
import { receiveStock } from "~/modules/warehouse/operations.server";
import type { ServiceContext } from "~/server/types";
import { OWNER, type TestEnv } from "../../helpers";
import { insertProduct, stockItemFor } from "../../stage5/helpers";

let counter = 0;

export function ctxAt(env: TestEnv, now: Date | string, actor = OWNER): ServiceContext {
  const d = typeof now === "string" ? new Date(now) : now;
  return { ...env.ctx(actor), now: () => d };
}

export interface TestOrder {
  orderId: string;
  orderNumber: string;
  lines: Array<{ id: string; variantId: string; shopifyLineItemId: string }>;
}

/** Вигаданий товар з варіантом (модель і колір) і відкритою позицією обліку. */
export async function makeVariant(
  db: Db,
  opts: { model?: string; color?: string } = {},
): Promise<{ variantId: string; stockItemId: string; productId: string }> {
  counter++;
  const p = await insertProduct(db, `Тестовий товар ${counter}`, [{ sku: `RT-${counter}`, model: opts.model, color: opts.color }]);
  const variantId = p.variantIds[0]!;
  return {
    variantId,
    productId: p.productId,
    stockItemId: await stockItemFor(db, variantId),
  };
}

export async function insertOrder(
  db: Db,
  input: {
    variants: Array<{ variantId: string; quantity?: number }>;
    status?: "paid" | "handed_to_carrier" | "delivered";
    country?: string;
    placedAt?: string;
    number?: string;
  },
): Promise<TestOrder> {
  counter++;
  const orderNumber = input.number ?? `#R${String(Date.now()).slice(-6)}-${counter}`;
  const [o] = await db
    .insert(orders)
    .values({
      source: "demo",
      orderNumber,
      status: input.status ?? "delivered",
      currency: "EUR",
      subtotal: "0.00",
      total: "0.00",
      shipCountryCode: input.country ?? "DE",
      placedAt: new Date(input.placedAt ?? "2026-10-01T09:00:00Z"),
    })
    .returning({ id: orders.id });
  const lines: TestOrder["lines"] = [];
  let pos = 0;
  for (const v of input.variants) {
    const shopifyLineItemId = `gid://shopify/LineItem/${counter}${pos}`;
    const [li] = await db
      .insert(orderLineItems)
      .values({
        orderId: o!.id,
        variantId: v.variantId,
        shopifyLineItemId,
        title: "Тестова позиція",
        quantity: v.quantity ?? 2,
        unitPrice: "50.00",
        currency: "EUR",
        position: pos++,
      })
      .returning({ id: orderLineItems.id });
    lines.push({ id: li!.id, variantId: v.variantId, shopifyLineItemId });
  }
  return { orderId: o!.id, orderNumber, lines };
}

/** Повернення коштів Shopify з рядками (як WP3: order_refunds + order_refund_lines). */
export async function addRefund(
  db: Db,
  order: TestOrder,
  input: {
    at: string;
    total?: string;
    lines: Array<{
      line: number;
      quantity: number;
      restockType: string | null;
      /** Як WP3: RETURN → true за замовчуванням; MIXED — null (WP3 скидає «поповнено» при об'єднанні різних видів). */
      restocked?: boolean | null;
      /** Як WP3 з міграції 0013: розподіл MIXED (вид → кількість); типово null. */
      restockQuantities?: Record<string, number> | null;
    }>;
  },
): Promise<string> {
  const [r] = await db
    .insert(orderRefunds)
    .values({
      orderId: order.orderId,
      shopifyRefundId: `gid://shopify/Refund/${randomUUID()}`,
      processedAt: new Date(input.at),
      createdAtShopify: new Date(input.at),
      total: input.total ?? "45.00",
      currency: "EUR",
    })
    .returning({ id: orderRefunds.id });
  for (const l of input.lines) {
    const line = order.lines[l.line]!;
    await db.insert(orderRefundLines).values({
      refundId: r!.id,
      shopifyLineItemId: line.shopifyLineItemId,
      orderLineItemId: line.id,
      quantity: l.quantity,
      restockType: l.restockType,
      restocked: l.restocked !== undefined ? l.restocked : l.restockType === "MIXED" ? null : l.restockType === "RETURN",
      restockQuantities: l.restockQuantities ?? null,
      subtotal: "45.00",
      currency: "EUR",
    });
  }
  return r!.id;
}

/** Відправлення (тестовий перевізник за замовчуванням) з фактами передачі / вручення і кодом статусу перевізника. */
export async function addShipment(
  db: Db,
  order: TestOrder,
  input: {
    carrierCode?: string;
    handedOverAt?: string | null;
    deliveredAt?: string | null;
    statusCode?: string | null;
    statusAt?: string | null;
    events?: Array<{ code: string; at: string; status?: string }>;
  } = {},
): Promise<string> {
  counter++;
  const [s] = await db
    .insert(shipments)
    .values({
      orderId: order.orderId,
      carrierCode: input.carrierCode ?? "test",
      mode: "test",
      status: "created",
      carrierReference: `ref-${randomUUID()}`,
      waybillNumber: `TEST${String(counter).padStart(10, "0")}`,
      handedOverAt: input.handedOverAt ? new Date(input.handedOverAt) : null,
      deliveredAt: input.deliveredAt ? new Date(input.deliveredAt) : null,
      carrierStatusCode: input.statusCode ?? null,
      carrierStatusAt: input.statusAt ? new Date(input.statusAt) : null,
      createdBy: "test",
    })
    .returning({ id: shipments.id });
  for (const e of input.events ?? []) {
    await db.insert(shipmentTrackingEvents).values({
      shipmentId: s!.id,
      status: e.status ?? "exception",
      code: e.code,
      occurredAt: new Date(e.at),
    });
  }
  return s!.id;
}

/** Надходження повернення покупця через справжню операцію складу (warehouse.receive, працівник). */
export async function receiveReturn(
  env: TestEnv,
  ctx: ServiceContext,
  input: {
    orderId: string;
    stockItemId: string;
    good: number;
    damaged?: number;
  },
): Promise<{ movementId: string }> {
  const r = await receiveStock(ctx, {
    operationId: randomUUID(),
    stockItemId: input.stockItemId,
    quantity: input.good,
    defectiveQuantity: input.damaged ?? 0,
    reason: "customer_return",
    orderId: input.orderId,
  });
  void env;
  return { movementId: r.movementId };
}

/** Внутрішня синхронізація (як її викликає syncOrderFinance WP4) у власній транзакції. */
export function syncCases(env: TestEnv, orderId: string, actor: PostingActor = SYSTEM_ACTOR): Promise<void> {
  return env.handle.db.transaction((tx) => syncReturnCasesForOrder(tx, actor, orderId));
}

export async function casesOf(db: Db, orderId: string) {
  const cases = await db.select().from(orderReturns).where(eq(orderReturns.orderId, orderId));
  const lines = cases.length ? await db.select().from(orderReturnLines) : [];
  return cases
    .sort((a, b) => a.firstSignalAt.getTime() - b.firstSignalAt.getTime() || a.id.localeCompare(b.id))
    .map((c) => ({
      ...c,
      lines: lines.filter((l) => l.returnId === c.id).sort((a, b) => a.condition.localeCompare(b.condition) || a.quantity - b.quantity),
    }));
}
