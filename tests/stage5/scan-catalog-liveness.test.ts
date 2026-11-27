import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { productVariants, products } from "~/db/schema";
import type { AdminGraphql } from "~/integrations/shopify/admin-client.server";
import type { GqlProduct } from "~/integrations/shopify/graphql";
import { validateOrderById } from "~/modules/orders/workflow.server";
import { adjustPackedLine, recordScan, startPacking } from "~/modules/packing/packing.server";
import { loadPackingScreen } from "~/modules/packing/view.server";
import { createWaybill } from "~/modules/shipments/waybill.server";
import { mapProduct } from "~/modules/shopify-sync/mappers";
import { markProductDeleted, syncProduct, upsertProduct } from "~/modules/shopify-sync/sync.server";
import { gqlProduct } from "../stage2/fixtures";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";

/**
 * Регресія NEW-2 (повторна рецензія G1b, packing-9): штрихкод, спільний лише з варіантом ВИДАЛЕНОГО в Shopify товару
 * (products.status = DELETED) або з варіантом, якого вже немає в повному переліку варіантів товару (видалений
 * варіант), не робить сканування живого товару «неоднозначним». Спільний з живим варіантом (чернетка, активний) —
 * неоднозначний, як і раніше.
 */
let env: TestEnv;
let orderId = "";
let line: { id: string; barcode: string };

beforeAll(async () => {
  env = await createTestEnv();
  orderId = await env.orderId("#1001");
  await validateOrderById(env.ctx(OWNER), orderId);
  expect((await createWaybill(env.ctx(OWNER), orderId)).kind).toBe("created");
  await startPacking(env.ctx(STAFF), orderId);
  const first = (await loadPackingScreen(env.ctx(STAFF), orderId)).lines.find((l) => l.barcode);
  line = { id: first!.id, barcode: first!.barcode! };
});
afterAll(async () => {
  await env.close();
});

/** Сканує штрихкод позиції; якщо зараховано — повертає чекліст до 0 (наступна перевірка з того самого стану). */
async function scanKind(): Promise<string> {
  const r = await recordScan(env.ctx(STAFF), orderId, line.barcode);
  if (r.kind === "matched") await adjustPackedLine(env.ctx(STAFF), orderId, line.id, -1, "correction");
  return r.kind;
}

async function insertCatalogProduct(status: string | null, barcode: string, title = `Дубль ${status ?? "—"}`) {
  const [p] = await env.handle.db.insert(products).values({ title, handle: `dup-${status ?? "none"}-${barcode}`, status }).returning({ id: products.id });
  await env.handle.db.insert(productVariants).values({ productId: p!.id, title: "Копія", sku: `DUP-${status ?? "N"}`, barcode, price: "1.00", currency: "EUR" });
  return p!.id;
}

const fakeAdmin = (product: GqlProduct) => (async () => ({ product })) as unknown as AdminGraphql;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("scan ambiguity ignores catalog rows that no longer exist in Shopify", () => {
  it("baseline: the order line's barcode scans as matched", async () => {
    expect(await scanKind()).toBe("matched");
  });

  it("a duplicate barcode only on a DELETED product → matched; on a live draft product → ambiguous", async () => {
    await insertCatalogProduct("DELETED", line.barcode);
    expect(await scanKind()).toBe("matched");
    const draft = await insertCatalogProduct("DRAFT", line.barcode);
    const r = await recordScan(env.ctx(STAFF), orderId, line.barcode);
    expect(r).toMatchObject({ kind: "ambiguous", scope: "catalog", count: 2 });
    // Товар видалено в Shopify (markProductDeleted ставить status = DELETED) — спільний штрихкод зникає з перевірки.
    await env.handle.db.update(products).set({ status: "DELETED" }).where(eq(products.id, draft));
    expect(await scanKind()).toBe("matched");
  });

  it("a variant removed from the product in Shopify (absent from the full variant list) → matched; partial list → still ambiguous", async () => {
    const dup = gqlProduct(9101, {
      variants: {
        nodes: [
          { ...gqlProduct(9101).variants.nodes[0]!, id: "gid://shopify/ProductVariant/910101", sku: "DUP-A", barcode: line.barcode },
          { ...gqlProduct(9101).variants.nodes[0]!, id: "gid://shopify/ProductVariant/910102", sku: "DUP-B", barcode: "999000111" },
        ],
      },
    });
    await upsertProduct(env.handle.db, mapProduct(dup), "EUR", new Date(), { variantsComplete: true });
    expect(await scanKind()).toBe("ambiguous");

    // Shopify видалив варіант A (повний перелік — лише B): його рядок лишається, але штрихкод не «спільний».
    await wait(5);
    const withoutA: GqlProduct = { ...dup, updatedAt: "2026-11-21T10:00:00Z", variants: { pageInfo: { hasNextPage: false }, nodes: [dup.variants.nodes[1]!] } };
    expect(await syncProduct(env.handle.db, fakeAdmin(withoutA), withoutA.id, "EUR")).toBe("saved");
    expect(await scanKind()).toBe("matched");

    // Неповний перелік (є наступна сторінка варіантів) нічого не каже про відсутні — A вважається наявним.
    await wait(5);
    const partial: GqlProduct = { ...dup, updatedAt: "2026-11-22T10:00:00Z", variants: { pageInfo: { hasNextPage: true }, nodes: [dup.variants.nodes[1]!] } };
    expect(await syncProduct(env.handle.db, fakeAdmin(partial), partial.id, "EUR")).toBe("saved");
    expect(await scanKind()).toBe("ambiguous");

    // Товар видалено в Shopify (products/delete → markProductDeleted) — жоден його варіант не «спільний».
    await markProductDeleted(env.handle.db, dup.id);
    expect(await scanKind()).toBe("matched");
  });

  it("wrong item prefers a live catalog variant over a deleted one with the same code", async () => {
    // Видалений сортується першим за назвою — перевага все одно живому.
    await insertCatalogProduct("DELETED", "777000333", "A removed copy");
    await insertCatalogProduct("ACTIVE", "777000333", "B live product");
    const r = await recordScan(env.ctx(STAFF), orderId, "777000333");
    expect(r).toMatchObject({ kind: "wrong_item", productTitle: "B live product" });
  });
});
