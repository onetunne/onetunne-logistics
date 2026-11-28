/**
 * Етап 6, WP4 — регресія міжпакетного виправлення (CROSS-PACKAGE FIX у app/modules/expenses/posting.server.ts):
 * ручна вартість доставки замовлення, додана на сторінці «Витрати» (WP6 createExpense), — факт складника доставки.
 * Без оновлення фінансів замовлення в тій самій транзакції order_finance лишався «≈ Прогноз» доставки, і картка /
 * список рахували ОДНОЧАСНО факт витрати й заморожений прогноз (подвійний облік, порушення «факт замінює прогноз»).
 * Те саме — анулювання витрати (прогноз повертається).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createExpense, voidExpense } from "~/modules/expenses/expenses.server";
import { loadOrderFinanceCard } from "~/modules/order-finance/card.server";
import * as G from "../reference/golden";
import { GoldenOrder, openGoldenEnv, prodCtx, type GoldenEnv } from "./golden-helpers";

const AT = G.G1_AS_OF_BEFORE_IMPORT;
let env: GoldenEnv;
let o: GoldenOrder;

beforeAll(async () => {
  env = await openGoldenEnv(G.G1_RATES);
  o = await new GoldenOrder(env, G.G1_ORDER_NO_RETURN).create();
  await o.advance("2026-10-05T12:00:00Z");
  await o.advance(AT);
});

afterAll(async () => {
  await env?.close();
});

describe("WP6 витрата замовлення → фінанси замовлення оновлено в тій самій транзакції", () => {
  let expenseId = "";

  it("до витрати: доставка — «≈ Прогноз» −520,00, прибуток — прогноз", async () => {
    const f = await o.finance();
    expect(f.componentsParsed.shipping_cost?.state).toBe("forecast");
    const card = (await loadOrderFinanceCard(prodCtx(env, AT), o.orderId, { currency: "UAH" }))!;
    expect(card.profit.kind).toBe("forecast");
  });

  it("createExpense(shipping_cost, замовлення) → доставка actual (basis manual), прогноз не рахується, прибуток «Факт» без подвійного обліку", async () => {
    const r = await createExpense(prodCtx(env, AT), {
      operationId: randomUUID(),
      category: "shipping_cost",
      amount: "540.00",
      currency: "UAH",
      dateMode: "single",
      expenseDate: "2026-11-08",
      order: o.orderId,
    });
    expenseId = r.id;
    const f = await o.finance();
    expect(f.componentsParsed.shipping_cost?.state).toBe("actual");
    expect(f.profitState).toBe("final");
    expect(await o.forecasts()).toEqual([]);
    const card = (await loadOrderFinanceCard(prodCtx(env, AT), o.orderId, { currency: "UAH" }))!;
    expect(card.profit.kind).toBe("fact");
    expect(card.rows.shippingActual.original).toEqual([{ amount: "-540.00", currency: "UAH" }]);
    const ship = card.components.find((c) => c.component === "shipping_cost")!;
    expect(ship.forecast).toBeNull();
  });

  it("voidExpense → доставка знову «≈ Прогноз» (заморожений прогноз −520,00), прибуток — прогноз", async () => {
    await voidExpense(prodCtx(env, AT), { expenseId, reason: "Помилка введення" });
    const f = await o.finance();
    expect(f.componentsParsed.shipping_cost?.state).toBe("forecast");
    expect((await o.forecasts()).filter((x) => x.component === "shipping_cost").map((x) => x.amount)).toEqual(["-520.00"]);
    const card = (await loadOrderFinanceCard(prodCtx(env, AT), o.orderId, { currency: "UAH" }))!;
    expect(card.profit.kind).toBe("forecast");
  });
});
