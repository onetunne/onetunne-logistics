/**
 * A2: точна митна вартість одиниці. Shopify LineItem.discountedUnitPriceAfterAllDiscountsSet (2026-10, MoneyBag!):
 * «The approximate unit price of the line item in shop and presentment currencies. This value includes discounts applied
 * to refunded and removed quantities.» Раніше вартість одиниці розподілялася з Order.subtotalPriceSet на замовлені
 * кількості; документація не каже, чи subtotal зменшується, коли одиниці видалено редагуванням замовлення, — тоді
 * різниця вважалася знижкою й вартість одиниці занижувалася. Тепер — ціна Shopify після всіх знижок (shopMoney), а
 * розподіл — лише для позицій, збережених до етапу 5 (NULL).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { orderChanges, orderLineItems, orders, shipments } from "~/db/schema";
import type { GqlOrder } from "~/integrations/shopify/graphql";
import { addMoney, multiplyMoney } from "~/lib/money";
import { customsUnitValues, transactionUnitValues } from "~/modules/customs/invoice";
import { loadLineItems, loadOrderRow } from "~/modules/orders/repository.server";
import { validateOrderById } from "~/modules/orders/workflow.server";
import { planParcelBox } from "~/modules/packaging/parcel.server";
import { loadSettings } from "~/modules/settings/settings.server";
import { loadOrderInvoice } from "~/modules/shipments/documents.server";
import { buildShipmentRequest, createWaybill } from "~/modules/shipments/waybill.server";
import { discountedUnitPriceOf, mapOrder } from "~/modules/shopify-sync/mappers";
import { upsertOrder } from "~/modules/shopify-sync/sync.server";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";
import { gqlOrder } from "../stage2/fixtures";

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});

const money = (amount: string, currencyCode = "EUR") => ({ shopMoney: { amount, currencyCode } });

/**
 * Відредаговане замовлення: тримач 29.00 × 3 (−10 %: 26.10), з них 2 видалено редагуванням (currentQuantity 1); гріпси
 * 14.90 × 1 (−10 %: 13.41). Якщо Shopify після редагування рахує subtotal без видалених одиниць — 26.10 + 13.41 = 39.51.
 */
function editedOrder(n: number, over: Partial<GqlOrder> = {}): GqlOrder {
  return gqlOrder(n, {
    subtotalPriceSet: money("39.51"),
    totalPriceSet: money("51.51"),
    lineItems: {
      nodes: [
        {
          id: `gid://shopify/LineItem/${n}1`,
          title: "Holder",
          variantTitle: null,
          sku: "H-1",
          quantity: 3,
          currentQuantity: 1,
          originalUnitPriceSet: money("29.00"),
          discountedUnitPriceAfterAllDiscountsSet: money("26.10"),
          image: null,
          variant: null,
        },
        {
          id: `gid://shopify/LineItem/${n}2`,
          title: "Grips",
          variantTitle: null,
          sku: "G-1",
          quantity: 1,
          currentQuantity: 1,
          originalUnitPriceSet: money("14.90"),
          discountedUnitPriceAfterAllDiscountsSet: money("13.41"),
          image: null,
          variant: null,
        },
      ],
    },
    ...over,
  });
}

async function settings() {
  return (await loadSettings(env.handle.db)).values;
}

async function linesOf(orderId: string) {
  return env.handle.db.select().from(orderLineItems).where(eq(orderLineItems.orderId, orderId)).orderBy(orderLineItems.position);
}

describe("unit value source", () => {
  it("subtotal allocation understates an edited order; Shopify's discounted unit price does not", () => {
    const items = [
      { unitPrice: "29.00", quantity: 3, discountedUnitPrice: "26.10" },
      { unitPrice: "14.90", quantity: 1, discountedUnitPrice: "13.41" },
    ];
    const allocated = transactionUnitValues(items, "39.51");
    expect(Number(allocated[0])).toBeLessThan(26.1);
    expect(Number(allocated[1])).toBeLessThan(13.41);
    expect(customsUnitValues(items, "39.51")).toEqual(["26.10", "13.41"]);
  });

  it("any legacy line without the Shopify price → allocation for every line (no mixing)", () => {
    const items = [
      { unitPrice: "29.00", quantity: 3, discountedUnitPrice: "26.10" },
      { unitPrice: "14.90", quantity: 1, discountedUnitPrice: null },
    ];
    expect(customsUnitValues(items, "91.71")).toEqual(transactionUnitValues(items, "91.71"));
    expect(customsUnitValues([{ unitPrice: "10.00", quantity: 1 }], null)).toEqual(["10.00"]);
    // Некоректне значення не використовується.
    expect(customsUnitValues([{ unitPrice: "10.00", quantity: 1, discountedUnitPrice: "-1.00" }], null)).toEqual(["10.00"]);
  });

  it("mapper: shopMoney in the line price currency only; invalid or missing → null (never 0.00)", () => {
    const base = editedOrder(9301).lineItems.nodes[0]!;
    expect(discountedUnitPriceOf(base)).toBe("26.10");
    expect(discountedUnitPriceOf({ ...base, discountedUnitPriceAfterAllDiscountsSet: money("26.1") })).toBe("26.10");
    expect(discountedUnitPriceOf({ ...base, discountedUnitPriceAfterAllDiscountsSet: money("26.10", "USD") })).toBeNull();
    expect(discountedUnitPriceOf({ ...base, discountedUnitPriceAfterAllDiscountsSet: money("n/a") })).toBeNull();
    const { discountedUnitPriceAfterAllDiscountsSet: _drop, ...legacy } = base;
    expect(discountedUnitPriceOf(legacy)).toBeNull();
    expect(mapOrder(editedOrder(9301)).lineItems.map((l) => l.discountedUnitPrice)).toEqual(["26.10", "13.41"]);
  });
});

describe("stored Shopify order: invoice page, waybill request and declared customs value agree", () => {
  it("an edited order declares 26.10 + 13.41 (not the understated allocation)", async () => {
    const r = await upsertOrder(env.ctx(OWNER), mapOrder(editedOrder(9302)), "import");
    expect(r.result).toBe("created");
    const orderId = r.orderId!;
    expect((await linesOf(orderId)).map((l) => l.discountedUnitPrice)).toEqual(["26.10", "13.41"]);

    const invoice = await loadOrderInvoice(env.ctx(STAFF), orderId);
    expect(invoice.lines.map((l) => [l.sku, l.quantity, l.unitValue, l.lineValue])).toEqual([
      ["H-1", 1, "26.10", "26.10"],
      ["G-1", 1, "13.41", "13.41"],
    ]);
    expect(invoice.goodsTotal).toBe("39.51");

    const order = await loadOrderRow(env.handle.db, orderId);
    const items = await loadLineItems(env.handle.db, orderId);
    const req = buildShipmentRequest(order, items, await settings(), "OT-T-UV1", new Date());
    expect(req.customsItems.map((c) => [c.sku, c.quantity, c.unitValue.amount])).toEqual(invoice.lines.map((l) => [l.sku, l.quantity, l.unitValue]));
    // Задекларована митна вартість = Σ вартість одиниці × кількість до відправлення = сума інвойсу.
    const sum = addMoney("0.00", ...req.customsItems.map((c) => multiplyMoney(c.unitValue.amount, c.quantity)));
    expect(req.customs?.totalValue).toEqual({ amount: sum, currency: "EUR" });
    expect(sum).toBe(invoice.goodsTotal);
  });

  it("legacy rows (NULL) keep the previous allocation; a later unchanged re-sync fills the price silently", async () => {
    const gql = editedOrder(9303, { subtotalPriceSet: money("91.71") });
    const r = await upsertOrder(env.ctx(OWNER), mapOrder(gql), "import");
    const orderId = r.orderId!;
    await env.handle.db.update(orderLineItems).set({ discountedUnitPrice: null }).where(eq(orderLineItems.orderId, orderId));
    const legacy = await loadOrderInvoice(env.ctx(STAFF), orderId);
    // 10 % від 101.90 (з видаленими одиницями) = 91.71 → 26.10 / 13.41 — розподіл, як до етапу 5.
    expect(legacy.lines.map((l) => l.unitValue)).toEqual(transactionUnitValues(await linesOf(orderId), "91.71"));

    const changesBefore = (await env.handle.db.select().from(orderChanges).where(eq(orderChanges.orderId, orderId))).length;
    expect((await upsertOrder(env.ctx(OWNER), mapOrder(gql), "import")).result).toBe("unchanged");
    expect((await linesOf(orderId)).map((l) => l.discountedUnitPrice)).toEqual(["26.10", "13.41"]);
    expect((await env.handle.db.select().from(orderChanges).where(eq(orderChanges.orderId, orderId))).length).toBe(changesBefore);
  });

  it("the created waybill (carrier snapshot) and the printed invoice carry the same Shopify unit values", async () => {
    // Демо-замовлення #1001 (тримач 29.00 + гріпси 14.90) — ніби з Shopify: ціни після знижок -10 %, тримачів замовлено 3, 2 видалено.
    const id = await env.orderId("#1001");
    const items = await loadLineItems(env.handle.db, id);
    const holder = items.find((i) => i.variant?.sku === "OT-PH-BLK")!;
    const grips = items.find((i) => i.variant?.sku === "OT-GR-BLK")!;
    await env.handle.db.update(orderLineItems).set({ quantity: 3, currentQuantity: 1, discountedUnitPrice: "26.10" }).where(eq(orderLineItems.id, holder.id));
    await env.handle.db.update(orderLineItems).set({ discountedUnitPrice: "13.41" }).where(eq(orderLineItems.id, grips.id));
    // subtotal, що занизив би розподіл (без видалених одиниць).
    await env.handle.db.update(orders).set({ subtotal: "39.51" }).where(eq(orders.id, id));
    await validateOrderById(env.ctx(OWNER), id);
    const order = await loadOrderRow(env.handle.db, id);
    const planned = buildShipmentRequest(order, await loadLineItems(env.handle.db, id), await settings(), "OT-T-UV2", new Date(), await planParcelBox(env.handle.db, order, await loadLineItems(env.handle.db, id)));
    expect(planned.customsItems.map((c) => [c.sku, c.quantity, c.unitValue.amount])).toEqual([
      ["OT-PH-BLK", 1, "26.10"],
      ["OT-GR-BLK", 1, "13.41"],
    ]);
    expect((await createWaybill(env.ctx(OWNER), id)).kind).toBe("created");
    const [row] = await env.handle.db.select().from(shipments).where(eq(shipments.orderId, id));
    const snap = row!.requestSnapshot as { customsItems: Array<{ sku: string; quantity: number; unitValue: { amount: string } }>; customs: { totalValue: { amount: string } } };
    expect(snap.customsItems.map((c) => [c.sku, c.quantity, c.unitValue.amount])).toEqual([
      ["OT-PH-BLK", 1, "26.10"],
      ["OT-GR-BLK", 1, "13.41"],
    ]);
    expect(snap.customs.totalValue.amount).toBe("39.51");
    const invoice = await loadOrderInvoice(env.ctx(STAFF), id);
    expect(invoice.lines.map((l) => [l.sku, l.quantity, l.unitValue])).toEqual(snap.customsItems.map((c) => [c.sku, c.quantity, c.unitValue.amount]));
    expect(invoice.goodsTotal).toBe(snap.customs.totalValue.amount);
  });
});
