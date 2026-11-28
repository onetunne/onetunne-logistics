/**
 * Етап 6, WP7 (огляд): валюта покриття виплати — завжди валюта КОМІСІЇ (валюта подій партнера; до першого нарахування —
 * валюта магазину), не валюта виплати чи звітності (§9.3 «Валюта — валюта магазину», §9.5 covers_amount — «скільки
 * балансу комісії закрито»). Аванс до першого нарахування й наступне нарахування — ОДИН баланс у валюті магазину.
 * Без жодного замовлення валюта комісії невідома — виплату не прив'язати (відмова, не вигадана валюта).
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fxRates, stores } from "~/db/schema";
import { createPartner, getPartnerDetail } from "~/modules/partners/partners.server";
import { createPayout } from "~/modules/partners/payouts.server";
import { shopCurrencyOf } from "~/modules/partners/currency.server";
import { createTestEnv, type TestEnv } from "../../helpers";
import { g1Order, ownerCtx, recognize, sync } from "./helpers";

let env: TestEnv;
const NOW = "2026-11-28T10:00:00Z";
const recognized = (on: string) => ({ finance: { state: "recognized" as const, recognizedOn: on, recognizedAt: new Date(`${on}T10:00:00Z`), newlyRecognized: true } });

beforeAll(async () => {
  env = await createTestEnv({ seed: false });
  // Демо-курс EUR на дату виплати (контекст тестів — демо): 48,8000 UAH.
  await env.handle.db.insert(fxRates).values({ source: "demo", currency: "EUR", effectiveDate: "2026-09-20", rate: "48.8", units: 1, ratePerUnit: "48.8000000000" });
});
afterAll(async () => {
  await env.close();
});

describe("payout covers the commission currency", () => {
  let partnerId = "";

  it("no orders at all → the commission currency is unknown: the payout is refused, nothing is invented", async () => {
    const r = await createPartner(ownerCtx(env, "2026-09-01T10:00:00Z"), { displayName: "Блогер-аванс", kind: "blogger", rateBp: 1000, holdDays: 30, payoutCurrency: "UAH", codes: [{ source: "discount_code", code: "ADV10" }] });
    partnerId = r.id;
    expect(await shopCurrencyOf(env.handle.db)).toBeNull();
    const detail = (await getPartnerDetail(ownerCtx(env, NOW), partnerId))!;
    expect(detail).toMatchObject({ commissionCurrency: null, commissionCurrencies: [] });
    await expect(
      createPayout(ownerCtx(env, NOW), { operationId: randomUUID(), partnerId, paidOn: "2026-09-20", amount: "500", currency: "UAH", method: "bank", confirmAdvance: true }),
    ).rejects.toMatchObject({ code: "partners.error.commissionCurrencyUnknown", status: 409 });
  });

  it("an advance before any commission is booked in the shop currency (EUR, not the UAH payout currency) and nets with the later accrual", async () => {
    await env.handle.db.update(stores).set({ shopCurrency: "EUR" }).where(eq(stores.isDefault, true));
    expect(await shopCurrencyOf(env.handle.db)).toBe("EUR");
    expect((await getPartnerDetail(ownerCtx(env, NOW), partnerId))!).toMatchObject({ commissionCurrency: "EUR", commissionCurrencies: ["EUR"] });
    // Валюта покриття не з валют комісії — відмова.
    await expect(
      createPayout(ownerCtx(env, NOW), { operationId: randomUUID(), partnerId, paidOn: "2026-09-20", amount: "500", currency: "UAH", coversCurrency: "UAH", method: "bank", confirmAdvance: true }),
    ).rejects.toMatchObject({ code: "partners.error.coversCurrencyInvalid", params: { currency: "UAH" } });
    // Форма за замовчуванням (UAH, без coversCurrency, з підтвердженням аванса): покриття — EUR за курсом на дату виплати.
    const p = await createPayout(ownerCtx(env, NOW), { operationId: randomUUID(), partnerId, paidOn: "2026-09-20", amount: "500,00", currency: "UAH", method: "bank", confirmAdvance: true });
    expect(p).toMatchObject({ advance: true, amount: { amount: "500.00", currency: "UAH" }, covers: { amount: "10.25", currency: "EUR" } });
    expect((await getPartnerDetail(ownerCtx(env, NOW), partnerId))!.ledger).toEqual([expect.objectContaining({ currency: "EUR", paid: "10.25", balance: "-10.25", owes: "10.25" })]);
    // Нарахування G1 (11,70 EUR) зменшує той самий баланс — жодного окремого балансу UAH.
    const o = await g1Order(env, "ADV10");
    await recognize(env, o, "2026-10-05");
    await sync(env, o, recognized("2026-10-05"));
    const ledger = (await getPartnerDetail(ownerCtx(env, NOW), partnerId))!.ledger;
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ currency: "EUR", net: "11.70", paid: "10.25", balance: "1.45", owes: "0.00", payable: "1.45" });
  });

  it("the shop currency falls back to the newest order when the store row has none", async () => {
    await env.handle.db.update(stores).set({ shopCurrency: null }).where(eq(stores.isDefault, true));
    expect(await shopCurrencyOf(env.handle.db)).toBe("EUR");
  });
});
