/**
 * Етап 6, WP7: спільне для тестів партнерів — вигадані замовлення (без персональних даних), факти Shopify (продажі,
 * коди знижок, спори), стан фінансів замовлення (визнання — так, як його записав би WP4) і виклик внутрішньої
 * синхронізації винагороди в транзакції.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { financeEntries, orderDisputes, orderFinance, orderSales, orderShopifyFinance, orders, partnerCommissionEvents } from "~/db/schema";
import type { Db } from "~/db/client.server";
import type { AgreementKind, DisputeOutcome, OrderFinanceState } from "~/domain/finance";
import { SYSTEM_ACTOR } from "~/domain/permissions";
import { syncPartnerCommission, type PartnerSyncOptions, type PartnerSyncResult } from "~/modules/partners/sync.server";
import { createPartner } from "~/modules/partners/partners.server";
import type { ServiceContext } from "~/server/types";
import { OWNER, type TestEnv } from "../../helpers";

let counter = 0;

/** Контекст власника з фіксованим «зараз». */
export function ownerCtx(env: TestEnv, now: Date | string, actor = OWNER): ServiceContext {
  const d = typeof now === "string" ? new Date(now) : now;
  return { ...env.ctx(actor), now: () => d };
}

export async function insertOrder(db: Db, input: { placedAt: string; currency?: string; test?: boolean; number?: string } ): Promise<string> {
  counter++;
  const [row] = await db
    .insert(orders)
    .values({
      source: "demo",
      orderNumber: input.number ?? `#P${Date.now() % 1_000_000}-${counter}`,
      status: "delivered",
      currency: input.currency ?? "EUR",
      subtotal: "0.00",
      total: "0.00",
      placedAt: new Date(input.placedAt),
      shopifyTest: input.test ?? false,
    })
    .returning({ id: orders.id });
  return row!.id;
}

export async function setFinance(db: Db, orderId: string, input: { state: OrderFinanceState; recognizedOn?: string | null; recognizedAt?: string | null; profitState?: "final" | "preliminary" | "incomplete" | "n/a" }) {
  const values = {
    state: input.state,
    recognizedOn: input.recognizedOn ?? null,
    recognizedAt: input.recognizedAt ? new Date(input.recognizedAt) : null,
    profitState: input.profitState ?? "n/a",
    shopCurrency: "EUR",
  };
  await db.insert(orderFinance).values({ orderId, ...values }).onConflictDoUpdate({ target: orderFinance.orderId, set: values });
}

export async function setFacts(
  db: Db,
  orderId: string,
  input: { discountCodes?: string[]; referralCode?: string | null; journeyReady?: boolean | null; flags?: string[]; displayFinancialStatus?: string | null },
) {
  const values = {
    discountCodes: input.discountCodes ?? [],
    referralCode: input.referralCode ?? null,
    journeyReady: input.journeyReady ?? true,
    flags: input.flags ?? [],
    displayFinancialStatus: input.displayFinancialStatus ?? "PAID",
    shopCurrency: "EUR",
  };
  await db.insert(orderShopifyFinance).values({ orderId, ...values }).onConflictDoUpdate({ target: orderShopifyFinance.orderId, set: values });
}

export async function addSale(
  db: Db,
  orderId: string,
  input: { kind?: AgreementKind; lineType: string; total: string; tax?: string; currency?: string; happenedAt: string },
): Promise<void> {
  const currency = input.currency ?? "EUR";
  await db.insert(orderSales).values({
    orderId,
    shopifySaleId: `gid://shopify/Sale/${randomUUID()}`,
    agreementId: `gid://shopify/OrderAgreement/${randomUUID()}`,
    agreementKind: input.kind ?? "order",
    happenedAt: new Date(input.happenedAt),
    actionType: input.kind === "return" || input.kind === "refund" ? "RETURN" : "ORDER",
    lineType: input.lineType,
    totalAmount: input.total,
    totalTax: input.tax ?? "0.00",
    currency,
    pTotalAmount: input.total,
    pTotalTax: input.tax ?? "0.00",
    pCurrency: currency,
    source: "demo",
  });
}

export async function addDispute(
  db: Db,
  orderId: string,
  input: { outcome: DisputeOutcome | null; amount: string | null; recovered?: string | null; currency?: string | null; decidedOn?: string | null; full?: boolean },
): Promise<string> {
  const [row] = await db
    .insert(orderDisputes)
    .values({
      orderId,
      disputeGid: `manual:${randomUUID()}`,
      outcome: input.outcome,
      amount: input.amount,
      recoveredAmount: input.recovered ?? null,
      currency: input.currency === undefined ? "EUR" : input.currency,
      decidedOn: input.decidedOn ?? null,
      fullPartnerCancellation: input.full ?? false,
      source: "manual",
    })
    .returning({ id: orderDisputes.id });
  return row!.id;
}

/** Внутрішня синхронізація (як її викликав би syncOrderFinance WP4) у власній транзакції. */
export function sync(env: TestEnv, orderId: string, opts: PartnerSyncOptions = {}, actor: { id: string } = SYSTEM_ACTOR): Promise<PartnerSyncResult> {
  return env.handle.db.transaction((tx) => syncPartnerCommission(tx, actor, orderId, opts));
}

export const eventsOf = (db: Db, orderId: string) =>
  db.select().from(partnerCommissionEvents).where(eq(partnerCommissionEvents.orderId, orderId)).orderBy(partnerCommissionEvents.n);

export const entriesOf = (db: Db, orderId: string) =>
  db.select().from(financeEntries).where(eq(financeEntries.orderId, orderId)).orderBy(financeEntries.seq);

/** Партнер із кодом (через сервіс власника). */
export async function makePartner(
  env: TestEnv,
  input: { name?: string; rateBp?: number; holdDays?: number; codes?: Array<{ source: "discount_code" | "referral"; code: string; validFrom?: string | null; validTo?: string | null }>; now?: string },
): Promise<string> {
  counter++;
  const r = await createPartner(ownerCtx(env, input.now ?? "2026-09-01T10:00:00Z"), {
    displayName: input.name ?? `Демо-партнер ${counter}`,
    kind: "blogger",
    rateBp: input.rateBp ?? 1000,
    holdDays: input.holdDays ?? 30,
    codes: input.codes ?? [],
  });
  return r.id;
}

/** Замовлення G1 (§20.1): A 2 × 50 − 10 % (90,00), B 30 − 10 % (27,00), доставка 12,00; оплачено й передано 05.10. */
export async function g1Order(env: TestEnv, code = "PART10"): Promise<string> {
  const db = env.handle.db;
  const id = await insertOrder(db, { placedAt: "2026-10-05T07:00:00Z" });
  await setFacts(db, id, { discountCodes: [code.toLowerCase()] });
  await addSale(db, id, { lineType: "PRODUCT", total: "90.00", happenedAt: "2026-10-05T07:00:00Z" });
  await addSale(db, id, { lineType: "PRODUCT", total: "27.00", happenedAt: "2026-10-05T07:00:00Z" });
  await addSale(db, id, { lineType: "SHIPPING", total: "12.00", happenedAt: "2026-10-05T07:00:00Z" });
  return id;
}

export async function recognize(env: TestEnv, orderId: string, on: string, profitState: "final" | "preliminary" | "incomplete" = "preliminary") {
  await setFinance(env.handle.db, orderId, { state: "recognized", recognizedOn: on, recognizedAt: `${on}T10:00:00Z`, profitState });
}
