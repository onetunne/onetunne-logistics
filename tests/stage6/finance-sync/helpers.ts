/**
 * Етап 6 (WP3): спільне для тестів синхронізації фінансів — база (PGlite / TEST_DATABASE_URL), встановлений вигаданий
 * магазин, збережені замовлення Shopify (через синхронізацію етапу 2), імітація Admin API (tests/stage6/fixtures/
 * shopify-finance). Нічого реального.
 */
import { and, count, eq } from "drizzle-orm";
import type { DatabaseHandle, Db } from "~/db/client.server";
import {
  financeChangeLog,
  financeDiscrepancies,
  orderDisputes,
  orderExternalWaybills,
  orderLineItems,
  orderRefundLines,
  orderRefunds,
  orderSales,
  orderShopifyFinance,
  orderTransactionFees,
  orderTransactions,
  orders,
  shopInstallations,
} from "~/db/schema";
import { DEMO_SETTINGS, seedReferenceData } from "~/db/seed/seed.server";
import type { GqlOrder } from "~/integrations/shopify/graphql";
import { DemoShopifyGateway } from "~/integrations/shopify/types";
import { runFinanceOrderSync } from "~/modules/finance-sync/sync-order.server";
import { mapOrder } from "~/modules/shopify-sync/mappers";
import { upsertOrder } from "~/modules/shopify-sync/sync.server";
import { createDemoCarriers } from "~/server/demo-runtime.server";
import type { ServiceContext } from "~/server/types";
import { gqlOrder } from "../../stage2/fixtures";
import { OWNER, openTestDatabase } from "../../helpers";
import { SHOP, fakeFinanceAdmin, type FakeFinanceAdmin, type FinanceOrderFixture } from "../fixtures/shopify-finance";

export interface FinanceSyncEnv {
  hd: DatabaseHandle;
  db: Db;
  ctx: ServiceContext;
  store: Map<string, FinanceOrderFixture>;
  fake: FakeFinanceAdmin;
  /** Збережене замовлення Shopify (етап 2, режим import — без обробки); повертає id. */
  createOrder: (n: number, over?: Partial<GqlOrder>) => Promise<string>;
  sync: (orderGid: string, extra?: { journey?: boolean; force?: boolean; now?: Date }) => ReturnType<typeof runFinanceOrderSync>;
  close: () => Promise<void>;
}

export async function openFinanceSyncEnv(opts: { scopes?: string } = {}): Promise<FinanceSyncEnv> {
  const hd = await openTestDatabase();
  await seedReferenceData(hd.db, DEMO_SETTINGS);
  await hd.db.insert(shopInstallations).values({ shop: SHOP, scopes: opts.scopes ?? "write_orders,read_products,read_inventory" });
  const ctx: ServiceContext = { mode: "production", db: hd.db, actor: OWNER, carriers: createDemoCarriers(hd.db), shopify: new DemoShopifyGateway(), now: () => new Date() };
  const store = new Map<string, FinanceOrderFixture>();
  const fake = fakeFinanceAdmin(store);
  return {
    hd,
    db: hd.db,
    ctx,
    store,
    fake,
    createOrder: async (n, over = {}) => {
      const r = await upsertOrder(ctx, mapOrder(gqlOrder(n, { test: false, ...over })), "import");
      if (!r.orderId) throw new Error(`order ${n} not stored`);
      return r.orderId;
    },
    sync: (orderGid, extra = {}) =>
      runFinanceOrderSync(
        { db: hd.db, admin: fake.admin, ...(extra.now ? { now: () => extra.now! } : {}) },
        { shop: SHOP, orderGid, ...(extra.journey ? { journey: true } : {}), ...(extra.force ? { force: true } : {}) },
      ),
    close: () => hd.close(),
  };
}

/** Кількості рядків фактів (для перевірки ідемпотентності: повтор не додає рядків). */
export async function factCounts(db: Db, orderId: string) {
  const n = async (q: Promise<Array<{ n: number }>>) => Number((await q)[0]?.n ?? 0);
  return {
    osf: await n(db.select({ n: count() }).from(orderShopifyFinance).where(eq(orderShopifyFinance.orderId, orderId))),
    sales: await n(db.select({ n: count() }).from(orderSales).where(eq(orderSales.orderId, orderId))),
    transactions: await n(db.select({ n: count() }).from(orderTransactions).where(eq(orderTransactions.orderId, orderId))),
    fees: await n(db.select({ n: count() }).from(orderTransactionFees).where(eq(orderTransactionFees.orderId, orderId))),
    refunds: await n(db.select({ n: count() }).from(orderRefunds).where(eq(orderRefunds.orderId, orderId))),
    refundLines: await n(
      db.select({ n: count() }).from(orderRefundLines).innerJoin(orderRefunds, eq(orderRefunds.id, orderRefundLines.refundId)).where(eq(orderRefunds.orderId, orderId)),
    ),
    disputes: await n(db.select({ n: count() }).from(orderDisputes).where(eq(orderDisputes.orderId, orderId))),
    waybills: await n(db.select({ n: count() }).from(orderExternalWaybills).where(eq(orderExternalWaybills.orderId, orderId))),
    discrepancies: await n(db.select({ n: count() }).from(financeDiscrepancies).where(eq(financeDiscrepancies.orderId, orderId))),
    changeLog: await n(db.select({ n: count() }).from(financeChangeLog)),
  };
}

export async function discrepanciesOf(db: Db, orderId: string) {
  return db.select().from(financeDiscrepancies).where(eq(financeDiscrepancies.orderId, orderId)).orderBy(financeDiscrepancies.createdAt);
}

export async function osfOf(db: Db, orderId: string) {
  return (await db.select().from(orderShopifyFinance).where(eq(orderShopifyFinance.orderId, orderId)))[0];
}

export async function lineIdOf(db: Db, orderId: string, gid: string) {
  return (await db.select({ id: orderLineItems.id }).from(orderLineItems).where(and(eq(orderLineItems.orderId, orderId), eq(orderLineItems.shopifyLineItemId, gid))))[0]?.id;
}

export async function orderIdOf(db: Db, gid: string) {
  return (await db.select({ id: orders.id }).from(orders).where(eq(orders.shopifyOrderId, gid)))[0]?.id;
}
