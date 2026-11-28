/**
 * Етап 6, WP6: сторінка «Фінанси → Місяці» (§3.4, §18.2, §14.2). Працівник і підроблений актор — 403 на loader і
 * action; порожня база — місяці «Немає даних», чек-лист ■ ▲ ☐, кнопка «Закрити місяць»; SSR uk/en без сирих ключів і
 * кирилиці в англійській версії; підтвердження ☐; закриття поточного місяця — відмова; закриття, поки buildReportData
 * (WP8) — заглушка, — зрозуміла відмова «ще в розробці» без змін; закритий місяць (знімки підставлено) — «Відкрити
 * повторно» (з причиною).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { makeActor, type Actor } from "~/domain/permissions";
import { emptyReportData, fakeBuildReportData } from "~/modules/finance/core/fakes";
import { closeMonth } from "~/modules/finance/periods/periods.server";
import type { RequestContext } from "~/server/types";
import { createTestEnv, OWNER, STAFF, type TestEnv } from "../../helpers";
import { renderPage } from "../../pages/insights-render";
import { op, rate } from "../expenses/helpers";
import { createExpense, voidExpense } from "~/modules/expenses/expenses.server";

const m = vi.hoisted(() => ({ ctx: null as RequestContext | null }));
vi.mock("~/server/context.server", () => ({
  getRequestContext: async () => {
    if (!m.ctx) throw new Error("test context is not set");
    return m.ctx;
  },
}));

let env: TestEnv;
let page: typeof import("~/pages/finance-periods");
const FORGED = makeActor({ id: "forged", displayName: "Forged", role: "staff", overrides: { grant: ["finance.view", "finance.manage"] } });
const NOW = new Date("2026-11-28T10:00:00Z");
const BASE = "http://localhost/demo/finance/periods";

function setContext(actor: Actor = OWNER, locale: "uk" | "en" = "uk") {
  m.ctx = { ...env.ctx(actor), now: () => NOW, basePath: "/demo", locale };
}
const route = () => ({ path: "finance/periods", loader: page.loader, action: page.action, Component: page.default });
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
  page = await import("~/pages/finance-periods");
});
afterAll(async () => {
  await env.close();
});

describe("access (§14.2)", () => {
  it("staff and a forged staff actor get 403 on the loader and the action", async () => {
    for (const actor of [STAFF, FORGED]) {
      setContext(actor);
      await expect(load()).rejects.toMatchObject({ status: 403 });
      await expect(act({ intent: "close", month: "2026-10-01" })).rejects.toMatchObject({ status: 403 });
    }
  });
});

describe("empty finance database", () => {
  it("lists 12 months with «No data», the previous month's checklist and the close button", async () => {
    setContext();
    const data = await load();
    expect(data.month).toBe("2026-10-01");
    expect(data.months).toHaveLength(12);
    expect(data.months[0]).toMatchObject({ month: "2026-11-01", status: "open", fullyPast: false, entries: 0 });
    expect(data.overview.checklist).toMatchObject({ canClose: true, blockingFailures: 0, pendingConfirmations: 7, allConfirmed: false });
    const html = text(await renderPage(route() as never, "/demo/finance/periods", OWNER));
    for (const s of [
      "Місяці",
      "Демо: усі фінансові дані вигадані.",
      "Місяць 10.2026",
      "Немає даних",
      "■ Блокує закриття",
      "▲ Попередження",
      "☐ Підтвердження власника",
      "Усі замовлення місяця — остаточні",
      "Податки компанії (внесено або податків немає)",
      "Закрити місяць",
      "Знімків ще немає",
      "Щоб показати чистий прибуток, закрийте місяць і підтвердьте всі витрати й податки.",
    ]) {
      expect(html, s).toContain(s);
    }
    expect(html).not.toMatch(/financeExpenses\.|finance\.(checklist|periodStatus|notice|tab)\./);
    const en = text(await renderPage(route() as never, "/demo/finance/periods", OWNER, "en"));
    expect(en).toContain("Months");
    expect(en).toContain("Close month");
    expect(en).toContain("No data");
    expect(en).not.toMatch(/financeExpenses\./);
    expect(en).not.toMatch(/[А-Яа-яІіЇїЄєҐґ]/);
  });
});

describe("owner actions", () => {
  it("confirmations: «entered» without entries is refused; «none this month» is saved", async () => {
    setContext();
    expect(await act({ intent: "confirm", month: "2026-10-01", expectedVersion: "0", "confirm.advertising": "entered" })).toMatchObject({
      ok: false,
      error: "financeExpenses.error.confirmEnteredWithoutEntries",
    });
    const r = await act({ intent: "confirm", month: "2026-10-01", expectedVersion: "0", "confirm.advertising": "none_this_month", "confirm.taxes_company": "none_this_month" });
    expect(r).toMatchObject({ ok: true, message: "financeExpenses.result.confirmed", params: { items: 2 } });
    const data = await load("?month=2026-10");
    expect(data.overview.confirmations).toEqual({ advertising: "none_this_month", taxes_company: "none_this_month" });
    expect(data.overview.version).toBe(1);
  });

  it("the current month cannot be closed; with the WP8 stub the close is refused as «in development» and nothing changes", async () => {
    setContext();
    expect(await act({ intent: "close", month: "2026-11-01" })).toMatchObject({ ok: false, error: "financeExpenses.error.monthNotPast", params: { month: "11.2026" } });
    expect(await act({ intent: "close", month: "2026-10-01", expectedVersion: "1" })).toMatchObject({ ok: false, error: "finance.error.notImplemented" });
    const data = await load("?month=2026-10-01");
    expect(data.overview).toMatchObject({ status: "open", version: 1, snapshots: [] });
  });

  it("a confirmation that no longer matches the month's records is shown as «out of date» (uk / en) with a warning before closing", async () => {
    setContext();
    const tax = await createExpense(m.ctx!, { operationId: op(), category: "taxes_company", amount: "500", currency: "UAH", dateMode: "single", expenseDate: "2026-08-14" });
    expect(await act({ intent: "confirm", month: "2026-08-01", "confirm.taxes_company": "entered" })).toMatchObject({ ok: true });
    await voidExpense(m.ctx!, { expenseId: tax.id, reason: "Помилка" });
    const data = await load("?month=2026-08-01");
    expect(data.overview.checklist).toMatchObject({ staleConfirmations: 1, allConfirmed: false });
    const uk = text(await renderPage(route() as never, "/demo/finance/periods?month=2026-08-01", OWNER));
    expect(uk).toContain("Застаріло — підтвердьте знову");
    expect(uk).toContain("діючих записів і витрат цієї категорії за місяць уже немає");
    expect(uk).toContain("Підтверджень, що більше не відповідають записам місяця: 1");
    setContext(OWNER, "en");
    const en = text(await renderPage(route() as never, "/demo/finance/periods?month=2026-08-01", OWNER, "en"));
    expect(en).toContain("Out of date — confirm again");
    expect(en).toContain("Confirmations that no longer match the month's records: 1");
  });

  it("a closed month shows a final snapshot in every display currency and «Reopen»; reopening needs a reason", async () => {
    setContext();
    await createExpense(m.ctx!, { operationId: op(), category: "rent", amount: "100", currency: "UAH", dateMode: "single", expenseDate: "2026-09-10" });
    const before = await load("?month=2026-09-01");
    const rates = before.overview.checklist.items.find((i) => i.item === "rates_for_display_currencies")!;
    expect(rates).toMatchObject({ status: "blocked", count: 4, details: { EUR: 1, USD: 1, GBP: 1, PLN: 1, UAH: 0 } });
    for (const [c, v] of [["EUR", "45.0"], ["USD", "41.0"], ["GBP", "52.0"], ["PLN", "10.5"]] as const) await rate(env.handle.db, c, "2026-09-10", v);
    // Справжня збірка даних звіту — WP8; тут підставлено порожні дані (сервіс закриття зберігає їх знімками).
    const closed = await closeMonth(m.ctx!, { month: "2026-09-01" }, { buildReportData: fakeBuildReportData((i) => emptyReportData(i)) });
    expect(closed.snapshots.map((s) => s.currency)).toEqual(["UAH", "EUR", "USD", "GBP", "PLN"]);
    const html = text(await renderPage(route() as never, "/demo/finance/periods?month=2026-09-01", OWNER));
    expect(html).toContain("Відкрити повторно");
    expect(html).toContain("Остаточний");
    expect(html).toContain("Закрито");
    expect(html).not.toContain("Живий перерахунок, не знімок");
    expect((await load("?month=2026-09-01")).overview).toMatchObject({ status: "closed", liveCurrencies: [] });
    expect(await act({ intent: "reopen", month: "2026-09-01", reason: "" })).toMatchObject({ ok: false, error: "financeExpenses.error.reasonRequired" });
    expect(await act({ intent: "reopen", month: "2026-09-01", reason: "Знайдено рахунок" })).toMatchObject({ ok: true, message: "financeExpenses.result.reopened", params: { month: "09.2026" } });
    const after = text(await renderPage(route() as never, "/demo/finance/periods?month=2026-09-01", OWNER));
    expect(after).toContain("Відкрито повторно");
    expect(after).toContain("Знайдено рахунок");
  });
});
