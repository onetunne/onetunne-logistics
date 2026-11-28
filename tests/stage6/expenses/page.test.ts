/**
 * Етап 6, WP6: сторінка «Фінанси → Витрати» (§18.2, §18.8, §14.2). Працівник і підроблений актор — 403 на loader і
 * action; порожня фінансова база — «Немає даних» (ніде не вигаданий 0); банер демо; SSR uk/en без сирих ключів і без
 * кирилиці в англійській версії; дії власника: витрата (G7), виправлення, анулювання, сума періоду (розподіл),
 * правило комісії; посилання WP9 із заповненими полями; помилка закритого місяця з місяцем у форматі мови.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { orderReturns, orders, partners } from "~/db/schema";
import { eq } from "drizzle-orm";
import { makeActor, type Actor } from "~/domain/permissions";
import type { RequestContext } from "~/server/types";
import { createTestEnv, OWNER, STAFF, type TestEnv } from "../../helpers";
import { renderPage } from "../../pages/insights-render";
import { closeMonthRow, insertOrder } from "./helpers";

const m = vi.hoisted(() => ({ ctx: null as RequestContext | null }));
vi.mock("~/server/context.server", () => ({
  getRequestContext: async () => {
    if (!m.ctx) throw new Error("test context is not set");
    return m.ctx;
  },
}));

let env: TestEnv;
let page: typeof import("~/pages/finance-expenses");
const FORGED = makeActor({ id: "forged", displayName: "Forged", role: "staff", overrides: { grant: ["finance.view", "finance.manage"] } });
const NOW = new Date("2026-11-28T10:00:00Z");
const BASE = "http://localhost/demo/finance/expenses";

function setContext(actor: Actor = OWNER, locale: "uk" | "en" = "uk") {
  m.ctx = { ...env.ctx(actor), now: () => NOW, basePath: "/demo", locale };
}
const route = () => ({ path: "finance/expenses", loader: page.loader, action: page.action, Component: page.default });
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;| /g, " ")
    .replace(/\s+/g, " ");
const load = (query = "") => page.loader({ request: new Request(`${BASE}${query}`), params: {}, context: {} } as never);
const act = (fields: Record<string, string>) =>
  page.action({ request: new Request(BASE, { method: "POST", body: new URLSearchParams(fields) }), params: {}, context: {} } as never);

beforeAll(async () => {
  env = await createTestEnv({ seed: false });
  page = await import("~/pages/finance-expenses");
});
afterAll(async () => {
  await env.close();
});

describe("access (§14.2)", () => {
  it("staff and a forged staff actor get 403 on the loader and the action (no redirect)", async () => {
    for (const actor of [STAFF, FORGED]) {
      setContext(actor);
      await expect(load()).rejects.toMatchObject({ status: 403 });
      await expect(act({ intent: "create" })).rejects.toMatchObject({ status: 403 });
    }
  });
});

describe("empty finance database", () => {
  it("renders «No data» states, the demo banner and the production-cost warning; nothing fabricated", async () => {
    setContext();
    const data = await load();
    expect(data.list).toEqual({ items: [], total: 0 });
    expect(data.rules).toEqual([]);
    expect(data.comparison.rows).toEqual([]);
    expect(data.month).toBe("2026-11-01");
    const html = text(await renderPage(route() as never, "/demo/finance/expenses", OWNER));
    for (const s of [
      "Витрати",
      "Демо: усі фінансові дані вигадані.",
      "Немає даних",
      "За 11.2026 витрат і доходів не внесено.",
      "Правил ще немає",
      "Замовлень із відомим шлюзом за останні 3 місяці немає.",
      "Витрати на виробництво вносяться в партіях",
      "Додати витрату",
      "Додати дохід",
    ]) {
      expect(html, s).toContain(s);
    }
    expect(html).not.toMatch(/financeExpenses\.|finance\.(category|notice|tab)\./);
    expect(html).not.toMatch(/\b0,00\b/);
    const en = text(await renderPage(route() as never, "/demo/finance/expenses", OWNER, "en"));
    expect(en).toContain("Expenses and income");
    expect(en).toContain("No data");
    expect(en).toContain("Gateway fee rules");
    expect(en).not.toMatch(/financeExpenses\./);
    expect(en).not.toMatch(/[А-Яа-яІіЇїЄєҐґ]/);
  });
});

describe("owner actions", () => {
  it("adds a period expense (G7), lists it, shows the detail; the same operationId is not saved twice", async () => {
    setContext();
    const operationId = (await load()).operationId;
    const fields = {
      intent: "create",
      operationId,
      category: "advertising",
      amount: "1 000,00",
      currency: "UAH",
      dateMode: "period",
      periodFrom: "2026-11-01",
      periodTo: "2026-11-30",
      channel: "google",
      description: "Кампанія листопада",
    };
    const r = await act(fields);
    expect(r).toMatchObject({ ok: true, message: "financeExpenses.result.created", params: { entries: 30 } });
    expect(await act(fields)).toMatchObject({ ok: true, message: "financeExpenses.result.duplicate" });
    const data = await load();
    expect(data.list.total).toBe(1);
    const item = data.list.items[0]!;
    expect(item).toMatchObject({ category: "advertising", amount: "1000.00", periodFrom: "2026-11-01", periodTo: "2026-11-30", channel: "google" });
    const html = text(await renderPage(route() as never, `/demo/finance/expenses?expense=${item.id}`, OWNER));
    expect(html).toContain("Реклама");
    expect(html).toContain("Google");
    expect(html).toContain("01.11.2026 – 30.11.2026");
    expect(html).toContain("Анулювати");
  });

  it("corrects and voids with a reason; a missing reason is refused", async () => {
    setContext();
    const [item] = (await load()).list.items;
    const edit = await load(`?edit=${item!.id}`);
    expect(edit.edit).toMatchObject({ id: item!.id, amount: "1000.00" });
    const editHtml = text(await renderPage(route() as never, `/demo/finance/expenses?edit=${item!.id}`, OWNER));
    expect(editHtml).toContain("Виправити витрату");
    expect(editHtml).toContain("Зберегти виправлення");
    expect(await act({ intent: "replace", operationId: edit.operationId, expenseId: item!.id, expectedVersion: "1", category: "advertising", amount: "900", currency: "UAH", dateMode: "period", periodFrom: "2026-11-01", periodTo: "2026-11-30", reason: "" })).toMatchObject({
      ok: false,
      error: "financeExpenses.error.reasonRequired",
    });
    const r = await act({ intent: "replace", operationId: edit.operationId, expenseId: item!.id, expectedVersion: "1", category: "advertising", amount: "900", currency: "UAH", dateMode: "period", periodFrom: "2026-11-01", periodTo: "2026-11-30", reason: "Знижка агенції" });
    expect(r).toMatchObject({ ok: true, message: "financeExpenses.result.replaced", params: { reversed: 30, entries: 30 } });
    const [next] = (await load()).list.items;
    expect(next).toMatchObject({ amount: "900.00", supersedesId: item!.id });
    expect(await act({ intent: "void", expenseId: next!.id, expectedVersion: "1", reason: "" })).toMatchObject({ ok: false, error: "financeExpenses.error.reasonRequired" });
    expect(await act({ intent: "void", expenseId: next!.id, expectedVersion: "1", reason: "Помилковий запис" })).toMatchObject({ ok: true, message: "financeExpenses.result.voided", params: { reversed: 30 } });
    expect((await load()).list.total).toBe(0);
    expect((await load("?status=voided")).list.total).toBe(2);
    const voidedHtml = text(await renderPage(route() as never, `/demo/finance/expenses?status=voided&expense=${next!.id}`, OWNER));
    expect(voidedHtml).toContain("Анульовано");
    expect(voidedHtml).toContain("Помилковий запис");
    expect(voidedHtml).not.toContain("Перерахувати розподіл");
  });

  it("a period fee sum replaces forecasts by default and shows its allocation", async () => {
    setContext();
    const db = env.handle.db;
    await insertOrder(db, { placedOn: "2026-11-03", gateway: "paypal", state: "recognized", forecasts: [{ component: "fees", amount: "3.00" }] });
    await insertOrder(db, { placedOn: "2026-11-04", gateway: "paypal", state: "recognized", forecasts: [{ component: "fees", amount: "1.00" }] });
    const r = await act({ intent: "create", operationId: (await load()).operationId, category: "payment_fees", amount: "8", currency: "EUR", dateMode: "single", expenseDate: "2026-11-30", gateway: "paypal", coverage: "covers" });
    expect(r).toMatchObject({ ok: true, extra: ["financeExpenses.result.allocated"], params: { orders: 2, entries: 2 } });
    const data = await load();
    const fee = data.list.items.find((i) => i.category === "payment_fees")!;
    expect(fee.allocation).toMatchObject({ orders: 2, withShare: 2, weightBasis: "forecast" });
    const html = text(await renderPage(route() as never, `/demo/finance/expenses?expense=${fee.id}`, OWNER));
    expect(html).toContain("Розподіл на замовлення");
    expect(html).toContain("Факт (розподілено за прогнозом)");
    expect(html).toContain("Перерахувати розподіл");
    // «Окрема» без причини — відмова.
    expect(await act({ intent: "create", operationId: (await load()).operationId, category: "payment_fees", amount: "8", currency: "EUR", dateMode: "single", expenseDate: "2026-11-30", gateway: "paypal", coverage: "separate" })).toMatchObject({
      ok: false,
      error: "financeExpenses.error.separateReasonRequired",
    });
  });

  it("the WP9 link prefills the return-cost form (order, return case)", async () => {
    setContext();
    const db = env.handle.db;
    const orderId = await insertOrder(db, { placedOn: "2026-11-10" });
    const [o] = await db.select({ number: orders.orderNumber }).from(orders).where(eq(orders.id, orderId));
    const [ret] = await db.insert(orderReturns).values({ orderId, kind: "customer_return", source: "manual", sourceKey: `ret:manual:${orderId}`, createdBy: "test" }).returning();
    const data = await load(`?add=expense&category=return_shipping_cost&order=${encodeURIComponent(o!.number)}&returnId=${ret!.id}`);
    expect(data.add).toBe("expense");
    expect(data.prefill).toMatchObject({ category: "return_shipping_cost", returnId: ret!.id, order: { id: orderId, orderNumber: o!.number, returns: [{ id: ret!.id }] } });
    const html = await renderPage(route() as never, `/demo/finance/expenses?add=expense&category=return_shipping_cost&order=${encodeURIComponent(o!.number)}&returnId=${ret!.id}`, OWNER);
    expect(html).toContain(`value="${o!.number}"`);
    expect(text(html)).toContain("Повернення 1");
    const r = await act({ intent: "create", operationId: data.operationId, category: "return_shipping_cost", amount: "250", currency: "UAH", dateMode: "single", expenseDate: "2026-11-12", order: o!.number, returnId: ret!.id });
    expect(r).toMatchObject({ ok: true, params: { awaiting: 1 }, extra: ["financeExpenses.result.awaiting"] });
  });

  it("the WP7 link prefills the partner of a fixed partner fee; an unknown partner id is ignored", async () => {
    setContext();
    const db = env.handle.db;
    const [p] = await db.insert(partners).values({ displayName: "Blogger Test", createdBy: "test" }).returning();
    const query = `?add=expense&category=partner_fixed_fee&partnerId=${p!.id}`;
    const data = await load(query);
    expect(data).toMatchObject({ add: "expense", prefill: { category: "partner_fixed_fee", partnerId: p!.id } });
    const html = await renderPage(route() as never, `/demo/finance/expenses${query}`, OWNER);
    // Обраний партнер у полі форми (не «—»).
    expect(html).toMatch(new RegExp(`<option value="${p!.id}" selected="">Blogger Test</option>`));
    expect((await load(`?add=expense&category=partner_fixed_fee&partnerId=00000000-0000-4000-8000-000000000000`)).prefill.partnerId).toBeNull();
    expect((await load(`?add=expense&category=partner_fixed_fee&partnerId=not-a-uuid`)).prefill.partnerId).toBeNull();
    const r = await act({ intent: "create", operationId: data.operationId, category: "partner_fixed_fee", amount: "3000", currency: "UAH", dateMode: "single", expenseDate: "2026-11-12", partnerId: p!.id });
    expect(r).toMatchObject({ ok: true });
  });

  it("a Shopify plan bill without a gateway is saved as a period expense with an explanatory note (form default «replaces» is not applied)", async () => {
    setContext();
    const r = await act({ intent: "create", operationId: (await load()).operationId, category: "platform_fees", amount: "39", currency: "UAH", dateMode: "single", expenseDate: "2026-11-30", coverage: "covers" });
    expect(r).toMatchObject({ ok: true, extra: ["financeExpenses.result.noDimension"] });
  });

  it("closed month: the error names the month in the locale's format", async () => {
    await closeMonthRow(env.handle.db, "2026-10-01");
    setContext(OWNER, "uk");
    const r = await act({ intent: "create", operationId: (await load()).operationId, category: "rent", amount: "100", currency: "UAH", dateMode: "single", expenseDate: "2026-10-05" });
    expect(r).toMatchObject({ ok: false, error: "finance.error.monthClosed", params: { month: "10.2026" } });
  });

  it("saves a gateway fee rule and shows it", async () => {
    setContext();
    const r = await act({ intent: "feeRule", gateway: "", gatewayOther: "paypal", kind: "payment", percent: "3,49", fixedAmount: "0,35", fixedCurrency: "EUR", appliesFrom: "2026-11-01" });
    expect(r).toMatchObject({ ok: true, message: "financeExpenses.result.feeRuleSaved" });
    const data = await load();
    expect(data.rules).toHaveLength(1);
    expect(data.rules[0]).toMatchObject({ gateway: "paypal", kind: "payment", percentBp: 349, fixedAmount: "0.35", current: true });
    const html = text(await renderPage(route() as never, "/demo/finance/expenses", OWNER));
    expect(html).toContain("3,49 %");
    expect(html).toContain("Чинне");
  });
});
