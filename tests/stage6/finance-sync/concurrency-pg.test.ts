/**
 * Етап 6 (WP3, §20.3): два паралельні finance.sync_order одного замовлення → той самий набір рядків, що й одна
 * синхронізація (блокування рядка замовлення → FINANCE_ORDER_LOCK; ON CONFLICT DO NOTHING; розбіжності — по одній);
 * ПЕРШІ синхронізації різних замовлень на свіжій базі (stores.shop_domain ще порожній) паралельно — без взаємного
 * блокування (shop_domain записується поза транзакцією фактів). Лише справжній PostgreSQL (TEST_DATABASE_URL): PGlite
 * виконує транзакції послідовно.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { stores } from "~/db/schema";
import { agreement, bag, financeNode, g2Fixture, sale, transaction } from "../fixtures/shopify-finance";
import { discrepanciesOf, factCounts, openFinanceSyncEnv, type FinanceSyncEnv } from "./helpers";

vi.mock("~/modules/order-finance/sync.server", () => ({ syncOrderFinance: async () => undefined }));

describe.skipIf(!process.env.TEST_DATABASE_URL)("parallel finance.sync_order of one order (PostgreSQL)", () => {
  let env: FinanceSyncEnv;
  beforeAll(async () => {
    env = await openFinanceSyncEnv();
  });
  afterAll(async () => {
    await env.close();
  });

  it("G2: two parallel syncs give exactly the rows of one sync; repeated rounds stay stable", async () => {
    const a = await env.createOrder(9601);
    const b = await env.createOrder(9602);
    env.store.set("gid://shopify/Order/9601", g2Fixture("gid://shopify/Order/9601", "gid://shopify/LineItem/96011"));
    env.store.set("gid://shopify/Order/9602", g2Fixture("gid://shopify/Order/9602", "gid://shopify/LineItem/96021"));
    await env.sync("gid://shopify/Order/9601");
    const single = await factCounts(env.db, a);
    for (let round = 0; round < 3; round++) {
      const results = await Promise.allSettled([env.sync("gid://shopify/Order/9602"), env.sync("gid://shopify/Order/9602", { force: true })]);
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    }
    const parallel = await factCounts(env.db, b);
    const { changeLog: _a, ...s } = single;
    const { changeLog: _b, ...p } = parallel;
    expect(p).toEqual(s);
  });

  it("a mismatch seen by two parallel syncs opens ONE discrepancy", async () => {
    const id = await env.createOrder(9603);
    env.store.set("gid://shopify/Order/9603", {
      finance: financeNode("gid://shopify/Order/9603", { transactions: [transaction({ amount: "20.00" })], totals: { currentTotalPriceSet: bag("20.00"), netPaymentSet: bag("15.00") } }),
      agreements: [agreement("OrderAgreement", "2026-10-05T09:00:00Z", [sale({ total: "20.00", lineItem: "gid://shopify/LineItem/96031" })])],
      refunds: [],
    });
    await Promise.all([env.sync("gid://shopify/Order/9603"), env.sync("gid://shopify/Order/9603"), env.sync("gid://shopify/Order/9603")]);
    const ds = await discrepanciesOf(env.db, id);
    expect(ds.map((d) => [d.type, d.status, (d.details as { check: string }).check])).toEqual([["reconciliation_mismatch", "open", "RC2"]]);
    expect((await factCounts(env.db, id)).sales).toBe(1);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("first finance syncs of different orders in parallel on a fresh database (PostgreSQL)", () => {
  let env: FinanceSyncEnv;
  beforeAll(async () => {
    env = await openFinanceSyncEnv();
  });
  afterAll(async () => {
    await env.close();
  });

  it("6 orders, first syncs at once while stores.shop_domain is empty → all synced, no 40P01; shop remembered once", async () => {
    const [before] = await env.db.select().from(stores).where(eq(stores.id, "default"));
    expect(before).toMatchObject({ shopDomain: null, shopCurrency: null });
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const n = 9610 + i;
      ids.push(await env.createOrder(n));
      env.store.set(`gid://shopify/Order/${n}`, g2Fixture(`gid://shopify/Order/${n}`, `gid://shopify/LineItem/${n}1`));
    }
    const results = await Promise.allSettled(ids.map((_, i) => env.sync(`gid://shopify/Order/${9610 + i}`)));
    const failures = results.flatMap((r) => (r.status === "rejected" ? [String((r.reason as { code?: string })?.code ?? r.reason)] : []));
    expect(failures).toEqual([]);
    expect(results.map((r) => (r.status === "fulfilled" ? r.value.status : "x"))).toEqual(Array(6).fill("synced"));
    const [after] = await env.db.select().from(stores).where(eq(stores.id, "default"));
    expect(after).toMatchObject({ shopDomain: "ot-finance.myshopify.com", shopCurrency: "EUR" });
    for (const id of ids) expect((await factCounts(env.db, id)).sales).toBe(2);
  });
});

