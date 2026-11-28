/**
 * Етап 6, WP4 — регресії огляду сервісів власника й читання (PGlite / PostgreSQL):
 *  - chargeback закритого місяця (§3.4): зміна, очищення, перенесення збереженого спору й новий спір, записи якого
 *    датовані закритим місяцем, — відмова `finance.error.monthClosed`, нічого не сторновано;
 *  - позначка «Упаковку обліковано загальною сумою» на замовленні — лише коли за місяць визнання є загальна сума
 *    упаковки (§2.6); сума анульована — позначка більше не діє;
 *  - список «Фінанси → Замовлення»: колонка з хоч одним записом без курсу — «—» з позначкою, не часткова сума (F4, §2.6);
 *  - картка: «Доставка (сплатив покупець)» — відомий 0,00, коли виручка фактична, а рядка доставки немає (§2.6).
 * Усі ідентифікатори, коди й суми вигадані.
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { financeEntries, financePeriods } from "~/db/schema";
import { SYSTEM_ACTOR } from "~/domain/permissions";
import { postEntries, reverseEntries } from "~/modules/finance/core/entries.server";
import { financeKeys } from "~/modules/finance/core/keys";
import { saveOrderChargeback, setOrderFinanceFlag } from "~/modules/order-finance/actions.server";
import { loadOrderFinanceCard } from "~/modules/order-finance/card.server";
import { listOrderFinance } from "~/modules/order-finance/list.server";
import { syncOrderFinanceAt } from "~/modules/order-finance/sync.server";
import * as G from "../reference/golden";
import type { RefOrderFacts } from "../reference/model";
import { GoldenOrder, openGoldenEnv, prodCtx, type GoldenEnv } from "./golden-helpers";

let env: GoldenEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const closeMonth = (month: string) => env!.db.insert(financePeriods).values({ month, status: "closed", closedAt: new Date("2026-12-01T10:00:00Z"), closedBy: "test-owner" });

describe("chargeback закритого місяця (§3.4) — відмова, а не тихе сторно «пізнім записом»", () => {
  const cb = (orderId: string, over: Partial<Parameters<typeof saveOrderChargeback>[1]> = {}) => ({
    orderId,
    operationId: randomUUID(),
    amount: "129.00",
    recovered: null,
    currency: "EUR",
    fee: null,
    feeCurrency: null,
    outcome: "lost",
    decidedOn: "2026-11-12",
    vatReducible: false,
    fullPartnerCancellation: false,
    ...over,
  });

  it("G10: спір 12.11 збережено → листопад закрито → зміна / очищення / перенесення на 05.12 / новий спір 20.11 відхилено; записи не змінено", async () => {
    env = await openGoldenEnv(G.G1_RATES);
    const o = await new GoldenOrder(env, { ...G.G1_ORDER_NO_RETURN, partner: undefined }).create();
    await o.advance("2026-10-05T12:00:00Z");
    await o.advance("2026-11-20T00:00:00Z");
    const ctx = prodCtx(env, "2026-12-05T10:00:00Z");
    const saved = await saveOrderChargeback(ctx, cb(o.orderId));
    const lossBefore = (await o.entries()).filter((e) => e.category === "chargeback_loss");
    expect(lossBefore.map((e) => [e.amount, e.recognizedOn])).toEqual([["-129.00", "2026-11-12"]]);
    await closeMonth("2026-11-01");
    const err = { code: "finance.error.monthClosed" };
    await expect(saveOrderChargeback(ctx, cb(o.orderId, { disputeId: saved.disputeId, amount: "100.00" }))).rejects.toMatchObject(err);
    await expect(saveOrderChargeback(ctx, cb(o.orderId, { disputeId: saved.disputeId, outcome: null, decidedOn: null }))).rejects.toMatchObject(err);
    await expect(saveOrderChargeback(ctx, cb(o.orderId, { disputeId: saved.disputeId, decidedOn: "2026-12-05" }))).rejects.toMatchObject(err);
    await expect(saveOrderChargeback(ctx, cb(o.orderId, { decidedOn: "2026-11-20" }))).rejects.toMatchObject(err);
    expect((await o.entries()).filter((e) => e.category === "chargeback_loss")).toEqual(lossBefore);
    const reversals = await env.db.select().from(financeEntries).where(and(eq(financeEntries.orderId, o.orderId), eq(financeEntries.sourceType, "chargeback")));
    expect(reversals.filter((r) => r.reversesEntryId !== null)).toEqual([]);
    // Відкритий місяць — дозволено: новий спір 05.12.
    expect((await saveOrderChargeback(ctx, cb(o.orderId, { decidedOn: "2026-12-05", amount: "10.00" }))).created).toBe(true);
  });

  it("рішення 30.09 (вересень відкритий) раніше за визнання 05.10: записи датовані 05.10 — перевіряється саме ця дата (жовтень закрито → відмова)", async () => {
    env = await openGoldenEnv(G.G1_RATES);
    const o = await new GoldenOrder(env, { ...G.G1_ORDER_NO_RETURN, partner: undefined }).create();
    await o.advance("2026-10-05T12:00:00Z");
    await closeMonth("2026-10-01");
    const ctx = prodCtx(env, "2026-11-10T10:00:00Z");
    // decidedOn 30.09 < визнання 05.10: запис був би 05.10 (жовтень закрито), хоча місяць самого рішення відкритий.
    await expect(saveOrderChargeback(ctx, cb(o.orderId, { decidedOn: "2026-09-30" }))).rejects.toMatchObject({ code: "finance.error.monthClosed", params: { month: "2026-10-01" } });
  });
});

describe("«Упаковку обліковано загальною сумою» на замовленні — лише із загальною сумою місяця (§2.6)", () => {
  it("без packaging_unlinked / упаковки без замовлення → відмова; із сумою → not_applicable; суму сторновано → позначка не діє", async () => {
    env = await openGoldenEnv(G.G1_RATES);
    const ref: RefOrderFacts = { ...G.G8B_ORDER_TABLE, id: "ord-pkg-flag", packagingAccountedInBulk: false };
    const o = await new GoldenOrder(env, ref).create();
    await o.advance("2026-10-05T12:00:00Z");
    await o.advance("2026-10-10T00:00:00Z");
    expect((await o.finance()).componentsParsed.packaging).toMatchObject({ state: "missing", reason: "no_cost" });
    const ctx = prodCtx(env, "2026-10-12T10:00:00Z");
    await expect(setOrderFinanceFlag(ctx, { orderId: o.orderId, flag: "packaging_accounted_in_total", active: true, reason: "Загальна сума" })).rejects.toMatchObject({
      code: "financeOrders.error.packagingTotalMissing",
      params: { month: "2026-10-01" },
    });
    expect((await o.finance()).overrides).not.toHaveProperty("packaging_accounted_in_total");
    const key = financeKeys.invoiceLine(randomUUID(), 1);
    await env.db.transaction((tx) =>
      postEntries(tx, SYSTEM_ACTOR, [{ idempotencyKey: key, category: "packaging_unlinked", recognizedOn: "2026-10-31", fxOn: "2026-10-31", amount: "-80.00", currency: "UAH", sourceType: "invoice_line", sourceId: randomUUID() }]),
    );
    await setOrderFinanceFlag(ctx, { orderId: o.orderId, flag: "packaging_accounted_in_total", active: true, reason: "Загальна сума" });
    expect((await o.finance()).componentsParsed.packaging).toMatchObject({ state: "not_applicable", reason: "packaging_accounted_in_total" });
    // Сума анульована (сторно) → позначка більше не приховує відсутню вартість.
    const [total] = await env.db.select({ id: financeEntries.id }).from(financeEntries).where(and(eq(financeEntries.idempotencyKey, key), isNull(financeEntries.reversesEntryId)));
    await env.db.transaction(async (tx) => {
      await reverseEntries(tx, SYSTEM_ACTOR, [total!.id], { reasonCode: "invoice_replaced" });
      await syncOrderFinanceAt(tx, SYSTEM_ACTOR, o.orderId, { now: new Date("2026-10-13T10:00:00Z") });
    });
    expect((await o.finance()).componentsParsed.packaging).toMatchObject({ state: "missing", reason: "no_cost" });
  });

  it("невизнане замовлення → відмова packagingNotRecognized", async () => {
    env = await openGoldenEnv(G.G1_RATES);
    const o = await new GoldenOrder(env, { ...G.G8B_ORDER_TABLE, id: "ord-pkg-open", packagingAccountedInBulk: false }).create();
    await o.advance("2026-10-05T08:00:00Z");
    expect((await o.finance()).state).toBe("open");
    await expect(setOrderFinanceFlag(prodCtx(env, "2026-10-05T09:00:00Z"), { orderId: o.orderId, flag: "packaging_accounted_in_total", active: true, reason: "x" })).rejects.toMatchObject({
      code: "financeOrders.error.packagingNotRecognized",
    });
  });
});

describe("список: колонка з записом без курсу — «—» з позначкою (F4, §2.6), як картка", () => {
  it("курси лише до 20.10; повернення −45,00 EUR 04.11 без курсу → чиста виручка null + unconvertedColumns, рентабельність «—»; інші колонки — суми", async () => {
    env = await openGoldenEnv(G.G1_RATES.filter((r) => r.date <= "2026-10-20"));
    const o = await new GoldenOrder(env, { ...G.G1_ORDER, partner: undefined }).create();
    for (const t of ["2026-10-05T12:00:00Z", "2026-11-04T10:00:00Z", "2026-11-06T10:00:00Z"]) await o.advance(t);
    const ctx = prodCtx(env, "2026-11-06T10:00:00Z");
    const card = (await loadOrderFinanceCard(ctx, o.orderId, { currency: "UAH" }))!;
    expect(card.rows.netRevenue.converted).toBeNull();
    expect(card.rows.netRevenue.unconverted).toEqual([{ currency: "EUR", amount: "-45.00", entries: 1 }]);
    const row = (await listOrderFinance(ctx, { currency: "UAH" })).rows.find((r) => r.orderId === o.orderId)!;
    expect(row.netRevenue).toBeNull();
    expect(row.unconvertedColumns).toContain("netRevenue");
    expect(row.margin).toBeNull();
    expect(row.unconverted).toBeGreaterThan(0);
    // Колонки без записів без курсу — звичайні суми (собівартість UAH, комісії 05.10).
    expect(row.cogs).toBe(card.rows.cogs.net.converted);
    expect(row.fees).toBe(card.rows.fees.net.converted);
    expect(row.unconvertedColumns).not.toContain("cogs");
    expect(row.unconvertedColumns).not.toContain("fees");
  });

  it("усе з курсом → unconvertedColumns порожній, колонки = картка", async () => {
    env = await openGoldenEnv(G.G1_RATES);
    const o = await new GoldenOrder(env, { ...G.G1_ORDER, partner: undefined }).create();
    for (const t of ["2026-10-05T12:00:00Z", "2026-11-04T10:00:00Z", "2026-11-06T10:00:00Z"]) await o.advance(t);
    const ctx = prodCtx(env, "2026-11-06T10:00:00Z");
    const card = (await loadOrderFinanceCard(ctx, o.orderId, { currency: "UAH" }))!;
    const row = (await listOrderFinance(ctx, { currency: "UAH" })).rows.find((r) => r.orderId === o.orderId)!;
    expect(row.unconvertedColumns).toEqual([]);
    expect(row.netRevenue).toBe(card.rows.netRevenue.converted);
  });
});

describe("картка: відомий нуль «Доставка (сплатив покупець)» (§2.6 «0,00 — лише відомий нуль»)", () => {
  it("угоди прочитано повністю, рядка SHIPPING немає (безкоштовна доставка) → 0,00; виручка «немає даних» → «—»", async () => {
    env = await openGoldenEnv(G.G1_RATES);
    const o = await new GoldenOrder(env, G.G1B_ORDER).create();
    await o.advance("2026-10-05T12:00:00Z");
    const card = (await loadOrderFinanceCard(prodCtx(env, "2026-10-06T10:00:00Z"), o.orderId, { currency: "UAH" }))!;
    expect(card.components.find((c) => c.component === "revenue")?.state).toBe("actual");
    expect(card.rows.shippingPaid).toMatchObject({ converted: "0.00", entries: 0 });
    const noSales = await new GoldenOrder(env, { ...G.G1B_ORDER, id: "ord-nosales", sales: [] }).create();
    const { orderShopifyFinance } = await import("~/db/schema");
    const { emptySnapshot } = await import("~/modules/finance-sync/snapshot");
    await env.db.update(orderShopifyFinance).set({ snapshot: emptySnapshot() as unknown as Record<string, unknown> }).where(eq(orderShopifyFinance.orderId, noSales.orderId));
    await noSales.advance("2026-10-05T12:00:00Z");
    const c2 = (await loadOrderFinanceCard(prodCtx(env, "2026-10-06T10:00:00Z"), noSales.orderId, { currency: "UAH" }))!;
    expect(c2.components.find((c) => c.component === "revenue")?.state).toBe("missing");
    expect(c2.rows.shippingPaid.converted).toBeNull();
  });
});
