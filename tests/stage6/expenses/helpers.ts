/**
 * Етап 6, WP6: спільне для тестів витрат і місяців (PGlite; TEST_DATABASE_URL — справжній PostgreSQL). Вигадані
 * замовлення без персональних даних; курси — демо-рядки fx_rates (у демо автоматичне джерело — demo).
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "~/db/client.server";
import {
  financeEntries,
  financePeriods,
  fxRates,
  orderFinance,
  orderFinanceForecasts,
  orders,
  orderShopifyFinance,
  shipments,
} from "~/db/schema";
import type { Actor } from "~/domain/permissions";
import { convertMinor, decimalToScaled, fromMinor, RATE_SCALE, toMinor } from "~/lib/decimal";
import { businessDayStart } from "~/modules/warehouse/dates";
import type { ServiceContext } from "~/server/types";
import { createTestEnv, OWNER, type TestEnv } from "../../helpers";

export { OWNER };

export async function openEnv(): Promise<TestEnv> {
  return createTestEnv({ seed: false });
}

/** Контекст із фіксованим «зараз» (Київ) і режимом. */
export function ctxAt(env: TestEnv, now: string, actor: Actor = OWNER, mode: "demo" | "production" = "demo"): ServiceContext {
  return { ...env.ctx(actor), mode, now: () => new Date(now) };
}

let seq = 0;

export interface OrderSpec {
  /** Дата оформлення (Київ), напр. 2026-11-05. */
  placedOn: string;
  currency?: string;
  total?: string;
  gateway?: string;
  carrier?: string;
  /** Стан фінансів замовлення (немає — рядка order_finance немає). */
  state?: "open" | "recognized" | "closed_unrecognized" | "excluded";
  recognizedOn?: string;
  profitState?: "final" | "preliminary" | "incomplete" | "n/a";
  needsReview?: boolean;
  shopifyTest?: boolean;
  forecasts?: Array<{ component: "fees" | "shipping_cost" | "packaging" | "revenue"; amount: string; currency?: string }>;
}

/** Вигадане замовлення (+ фінанси, шлюз, перевізник, прогнози). */
export async function insertOrder(db: Db, spec: OrderSpec): Promise<string> {
  seq += 1;
  const currency = spec.currency ?? "EUR";
  const placedAt = new Date(businessDayStart(spec.placedOn).getTime() + 10 * 3600_000);
  const [o] = await db
    .insert(orders)
    .values({
      source: "demo",
      orderNumber: `#EX${process.pid}${seq}`,
      status: spec.state === "recognized" ? "delivered" : "paid",
      financialStatus: "paid",
      currency,
      subtotal: spec.total ?? "100.00",
      total: spec.total ?? "100.00",
      placedAt,
      shopifyTest: spec.shopifyTest ?? false,
    })
    .returning({ id: orders.id });
  const id = o!.id;
  if (spec.gateway) await db.insert(orderShopifyFinance).values({ orderId: id, paymentGatewayNames: [spec.gateway] });
  if (spec.carrier) {
    await db.insert(shipments).values({
      orderId: id,
      carrierCode: spec.carrier,
      mode: "test",
      status: "created",
      carrierReference: `ref-${randomUUID()}`,
      createdBy: "test",
    });
  }
  if (spec.state || spec.forecasts?.length) {
    const recognized = spec.state === "recognized";
    await db.insert(orderFinance).values({
      orderId: id,
      state: spec.state ?? "open",
      recognizedOn: recognized ? (spec.recognizedOn ?? spec.placedOn) : null,
      recognizedAt: recognized ? new Date(businessDayStart(spec.recognizedOn ?? spec.placedOn).getTime() + 12 * 3600_000) : null,
      recognitionBasis: recognized ? "handover" : null,
      profitState: spec.profitState ?? (recognized ? "preliminary" : "n/a"),
      needsReview: spec.needsReview ?? false,
    });
  }
  for (const f of spec.forecasts ?? []) {
    await db.insert(orderFinanceForecasts).values({ orderId: id, component: f.component, currency: f.currency ?? currency, amount: f.amount, basis: "fee_rule" });
  }
  return id;
}

/** Визнати замовлення (як зробив би WP4): стан recognized з датою. */
export async function recognize(db: Db, orderId: string, on: string, at?: Date): Promise<void> {
  await db
    .insert(orderFinance)
    .values({ orderId, state: "recognized", recognizedOn: on, recognizedAt: at ?? new Date(businessDayStart(on).getTime() + 12 * 3600_000), recognitionBasis: "handover", profitState: "preliminary" })
    .onConflictDoUpdate({
      target: orderFinance.orderId,
      set: { state: "recognized", recognizedOn: on, recognizedAt: at ?? new Date(businessDayStart(on).getTime() + 12 * 3600_000), recognitionBasis: "handover" },
    });
}

/** Демо-курс (гривень за 1 одиницю). */
export async function rate(db: Db, currency: string, date: string, value: string): Promise<void> {
  await db
    .insert(fxRates)
    .values({ source: "demo", currency, quoteCurrency: "UAH", effectiveDate: date, rate: value, units: 1, ratePerUnit: value })
    .onConflictDoNothing();
}

export async function closeMonthRow(db: Db, month: string): Promise<void> {
  await db
    .insert(financePeriods)
    .values({ month, status: "closed", closedAt: new Date(), closedBy: "test" })
    .onConflictDoUpdate({ target: [financePeriods.storeId, financePeriods.month], set: { status: "closed" } });
}

const rev = alias(financeEntries, "t_rev");

/** Записи витрати (усі, у порядку проведення). */
export function entriesOf(db: Db, expenseId: string) {
  return db
    .select()
    .from(financeEntries)
    .where(and(eq(financeEntries.sourceId, expenseId), inArray(financeEntries.sourceType, ["expense", "allocation"])))
    .orderBy(asc(financeEntries.seq));
}

/** Діючі записи (не сторно й не сторновані). */
export function activeEntriesOf(db: Db, expenseId: string) {
  return db
    .select()
    .from(financeEntries)
    .where(
      and(
        eq(financeEntries.sourceId, expenseId),
        inArray(financeEntries.sourceType, ["expense", "allocation"]),
        isNull(financeEntries.reversesEntryId),
        notExists(db.select({ one: sql`1` }).from(rev).where(eq(rev.reversesEntryId, financeEntries.id))),
      ),
    )
    .orderBy(asc(financeEntries.seq));
}

/** Σ записів (соті частки, однієї валюти). */
export function sumMinor(rows: ReadonlyArray<{ amount: string }>): bigint {
  return rows.reduce((a, r) => a + toMinor(r.amount), 0n);
}

/** Σ записів у UAH: кожен запис — за курсом свого fx_on (одне округлення на запис). */
export function sumUah(rows: ReadonlyArray<{ amount: string; currency: string; fxOn: string }>, rates: Readonly<Record<string, Readonly<Record<string, string>>>>): string {
  let total = 0n;
  for (const r of rows) {
    const c = r.currency.trim();
    const p = c === "UAH" ? 10n ** BigInt(RATE_SCALE) : decimalToScaled(rates[c]![r.fxOn]!, RATE_SCALE)!;
    total += convertMinor(toMinor(r.amount), p, 10n ** BigInt(RATE_SCALE), 2);
  }
  return fromMinor(total);
}

export const op = () => randomUUID();
