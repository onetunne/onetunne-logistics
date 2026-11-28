/**
 * Етап 6, WP7: сторінки «Фінанси → Партнери» і картка партнера (§18.6, §14.2). Працівник і підроблений актор — 403 на
 * loader і action (без переадресації); порожня фінансова база — «Немає партнерів» / «Немає даних», ніде не вигаданий 0;
 * банер демо; SSR uk/en без сирих ключів і без кирилиці в англійській версії; дії власника: додати партнера з кодом,
 * виплата з підтвердженням аванса, неоднозначна атрибуція → «Обрати партнера».
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { makeActor, type Actor } from "~/domain/permissions";
import type { RequestContext } from "~/server/types";
import { createTestEnv, OWNER, STAFF, type TestEnv } from "../../helpers";
import { renderPage } from "../../pages/insights-render";
import { partnerAttributions } from "~/db/schema";
import { SYSTEM_ACTOR } from "~/domain/permissions";
import { postEntries } from "~/modules/finance/core/entries.server";
import { g1Order, insertOrder, recognize, setFacts, setFinance, sync } from "./helpers";

const m = vi.hoisted(() => ({ ctx: null as RequestContext | null }));
vi.mock("~/server/context.server", () => ({
  getRequestContext: async () => {
    if (!m.ctx) throw new Error("test context is not set");
    return m.ctx;
  },
}));

let env: TestEnv;
let list: typeof import("~/pages/finance-partners");
let detail: typeof import("~/pages/finance-partner");
const FORGED = makeActor({ id: "forged", displayName: "Forged", role: "staff", overrides: { grant: ["finance.view", "finance.manage"] } });
let now = new Date("2026-11-28T10:00:00Z");

function setContext(actor: Actor = OWNER, locale: "uk" | "en" = "uk") {
  m.ctx = { ...env.ctx(actor), now: () => now, basePath: "/demo", locale };
}
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;| | /g, " ")
    .replace(/\s+/g, " ");
const listRoute = () => ({ path: "finance/partners", loader: list.loader, action: list.action, Component: list.default });
const detailRoute = () => ({ path: "finance/partners/:partnerId", loader: detail.loader, action: detail.action, Component: detail.default });
const loadList = (url = "http://localhost/demo/finance/partners") => list.loader({ request: new Request(url), params: {}, context: {} } as never);
const actList = (fields: Record<string, string>) =>
  list.action({ request: new Request("http://localhost/demo/finance/partners", { method: "POST", body: new URLSearchParams(fields) }), params: {}, context: {} } as never);
const loadDetail = (id: string, query = "") =>
  detail.loader({ request: new Request(`http://localhost/demo/finance/partners/${id}${query}`), params: { partnerId: id }, context: {} } as never);
const actDetail = (id: string, fields: Record<string, string>) =>
  detail.action({ request: new Request(`http://localhost/demo/finance/partners/${id}`, { method: "POST", body: new URLSearchParams(fields) }), params: { partnerId: id }, context: {} } as never);

beforeAll(async () => {
  env = await createTestEnv({ seed: false });
  list = await import("~/pages/finance-partners");
  detail = await import("~/pages/finance-partner");
});
afterAll(async () => {
  await env.close();
});

describe("access (§14.2)", () => {
  it("staff and a forged staff actor get 403 on both loaders and actions (no redirect)", async () => {
    for (const actor of [STAFF, FORGED]) {
      setContext(actor);
      await expect(loadList()).rejects.toMatchObject({ status: 403 });
      await expect(actList({ intent: "createPartner" })).rejects.toMatchObject({ status: 403 });
      await expect(loadDetail(randomUUID())).rejects.toMatchObject({ status: 403 });
      await expect(actDetail(randomUUID(), { intent: "createPayout" })).rejects.toMatchObject({ status: 403 });
    }
  });

  it("an unknown partner → 404", async () => {
    setContext(OWNER);
    await expect(loadDetail(randomUUID())).rejects.toMatchObject({ status: 404 });
    await expect(loadDetail("not-a-uuid")).rejects.toMatchObject({ status: 404 });
  });
});

describe("empty finance database", () => {
  it("«No partners», demo banner, nothing fabricated (uk and en)", async () => {
    setContext(OWNER);
    const data = await loadList();
    expect(data.partners).toEqual([]);
    expect(data.ambiguous).toEqual([]);
    expect(data.defaults).toEqual({ rate: "10", holdDays: 30 });
    const uk = text(await renderPage(listRoute() as never, "/demo/finance/partners", OWNER));
    for (const s of ["Партнери", "Демо: усі фінансові дані вигадані.", "Немає партнерів", "Додати партнера", "Код знижки", "Реферальний"]) expect(uk).toContain(s);
    expect(uk).not.toMatch(/partners\.[a-z]/);
    setContext(OWNER, "en");
    const en = text(await renderPage(listRoute() as never, "/demo/finance/partners", OWNER, "en"));
    for (const s of ["Partners", "No partners", "Add a partner", "Discount code"]) expect(en).toContain(s);
    expect(en).not.toMatch(/partners\.[a-z]/);
    expect(en).not.toMatch(/[А-Яа-яІіЇїЄєҐґ]/);
  });
});

describe("owner flow", () => {
  let partnerId = "";
  let orderId = "";

  it("add a partner with a discount code → listed; the new partner card shows «No data» states", async () => {
    setContext(OWNER);
    const r = await actList({ intent: "createPartner", displayName: "Демо-партнер А", kind: "blogger", rate: "10", holdDays: "30", codeSource0: "discount_code", code0: "PART10" });
    expect(r).toMatchObject({ ok: true, message: "partners.result.created" });
    const data = await loadList();
    expect(data.partners).toHaveLength(1);
    partnerId = data.partners[0]!.id;
    expect(data.partners[0]).toMatchObject({ displayName: "Демо-партнер А", kind: "blogger", rateBp: 1000, holdDays: 30, ledger: [], expected: [] });
    expect(data.partners[0]!.codes.map((c) => c.code)).toEqual(["PART10"]);
    const html = text(await renderPage(detailRoute() as never, `/demo/finance/partners/${partnerId}`, OWNER));
    for (const s of ["Демо-партнер А", "Баланс партнера", "Нарахувань і виплат ще немає.", "Ефективність партнера", "Комісії", "Виплати", "Виплат ще немає.", "Фіксовані оплати", "PART10", "Ставки", "недоступно"]) {
      expect(html).toContain(s);
    }
    expect(html).not.toMatch(/partners\.[a-z]/);
    expect(html).not.toContain("0,00 EUR");
  });

  it("validation errors come back as messages (duplicate code, bad rate)", async () => {
    setContext(OWNER);
    expect(await actList({ intent: "createPartner", displayName: "Інший", kind: "blogger", rate: "10", holdDays: "30", codeSource0: "discount_code", code0: "part10" })).toMatchObject({
      ok: false,
      error: "partners.error.codeTaken",
    });
    expect(await actList({ intent: "createPartner", displayName: "Інший", kind: "blogger", rate: "150", holdDays: "30" })).toMatchObject({ ok: false, error: "partners.error.rateInvalid" });
  });

  it("an accrued commission shows on the card; payout beyond «Payable» requires the advance confirmation", async () => {
    orderId = await g1Order(env);
    await recognize(env, orderId, "2026-10-05");
    await sync(env, orderId, { finance: { state: "recognized", recognizedOn: "2026-10-05", recognizedAt: new Date("2026-10-05T10:00:00Z"), newlyRecognized: true } });
    setContext(OWNER);
    const data = await loadDetail(partnerId);
    expect(data.detail.ledger[0]).toMatchObject({ payable: "11.70", currency: "EUR" });
    expect(data.commissionCurrency).toBe("EUR");
    const html = text(await renderPage(detailRoute() as never, `/demo/finance/partners/${partnerId}`, OWNER));
    expect(html).toContain("11,70 EUR");
    expect(html).toContain("До виплати");
    const tooMuch = await actDetail(partnerId, { intent: "createPayout", operationId: data.operationId, amount: "20", currency: "EUR", paidOn: "2026-11-20", method: "bank" });
    expect(tooMuch).toMatchObject({ ok: false, error: "partners.error.payoutExceedsPayable", advanceRequired: true });
    expect(String(tooMuch.ok === false && tooMuch.params?.payable).replace(/\u00a0/g, " ")).toBe("11,70 EUR");
    const ok = await actDetail(partnerId, { intent: "createPayout", operationId: data.operationId, amount: "20", currency: "EUR", paidOn: "2026-11-20", method: "bank", confirmAdvance: "on" });
    expect(ok).toMatchObject({ ok: true, message: "partners.result.payoutAdvance" });
    const again = await actDetail(partnerId, { intent: "createPayout", operationId: data.operationId, amount: "20", currency: "EUR", paidOn: "2026-11-20", method: "bank", confirmAdvance: "on" });
    expect(again).toMatchObject({ ok: true, message: "partners.result.payoutDuplicate" });
    const after = await loadDetail(partnerId);
    expect(after.detail.ledger[0]).toMatchObject({ balance: "-8.30", owes: "8.30", payable: "0.00" });
    const owes = text(await renderPage(detailRoute() as never, `/demo/finance/partners/${partnerId}`, OWNER));
    expect(owes).toContain("Партнер винен 8,30 EUR — буде утримано з наступної виплати");
  });

  it("ambiguous attribution → listed with «Choose a partner»; choosing resolves it and accrues", async () => {
    setContext(OWNER);
    await actList({ intent: "createPartner", displayName: "Блогер-демо Б", kind: "blogger", rate: "8", holdDays: "30", codeSource0: "discount_code", code0: "MAX15" });
    const o = await g1Order(env, "PART10");
    await setFacts(env.handle.db, o, { discountCodes: ["PART10", "MAX15"] });
    await recognize(env, o, "2026-10-06");
    expect(await sync(env, o)).toMatchObject({ attribution: "ambiguous", component: { state: "missing", reason: "ambiguous_partner" }, review: ["partner_attribution_ambiguous"] });
    const data = await loadList();
    expect(data.ambiguous).toHaveLength(1);
    expect(data.ambiguous[0]!.candidates.map((c) => c.displayName).sort()).toEqual(["Блогер-демо Б", "Демо-партнер А"]);
    const html = text(await renderPage(listRoute() as never, "/demo/finance/partners", OWNER));
    expect(html).toContain("Неоднозначні атрибуції");
    const b = data.partners.find((p) => p.displayName === "Блогер-демо Б")!;
    expect(await actList({ intent: "chooseAttribution", orderId: o, partnerId: b.id, reason: "" })).toMatchObject({ ok: false, error: "partners.error.reasonRequired" });
    expect(await actList({ intent: "chooseAttribution", orderId: o, partnerId: b.id, reason: "Блогер підтвердив" })).toMatchObject({ ok: true, message: "partners.result.attributionSet" });
    const after = await loadList();
    expect(after.ambiguous).toEqual([]);
    expect(after.partners.find((p) => p.id === b.id)!.ledger[0]).toMatchObject({ accrued: "9.36" });
  });

  it("review: rates are shown with the locale's decimal separator (uk «12,5 %», en «12.5%»)", async () => {
    setContext(OWNER);
    expect(await actList({ intent: "createPartner", displayName: "Дробова ставка", kind: "affiliate", rate: "12,5", holdDays: "30" })).toMatchObject({ ok: true });
    const data = await loadList();
    const p = data.partners.find((x) => x.displayName === "Дробова ставка")!;
    expect(p.rateBp).toBe(1250);
    const uk = text(await renderPage(listRoute() as never, "/demo/finance/partners", OWNER));
    expect(uk).toContain("12,5 %");
    expect(uk).not.toContain("12.5 %");
    const card = text(await renderPage(detailRoute() as never, `/demo/finance/partners/${p.id}`, OWNER));
    expect(card).toContain("Афіліат · 12,5 %");
    setContext(OWNER, "en");
    expect(text(await renderPage(listRoute() as never, "/demo/finance/partners", OWNER, "en"))).toContain("12.5%");
  });

  it("review: a fixed fee without a rate → «Fixed fees» and «Payback» marked incomplete, payback «—» with the reason (never an overstated ratio)", async () => {
    setContext(OWNER);
    const db = env.handle.db;
    // Остаточне замовлення партнера в UAH і фіксовані оплати: 200,00 UAH і 50,00 PLN (без курсу).
    const o = await insertOrder(db, { placedAt: "2026-10-02T09:00:00Z", currency: "UAH" });
    await setFinance(db, o, { state: "recognized", recognizedOn: "2026-10-05", recognizedAt: "2026-10-05T10:00:00Z", profitState: "final" });
    await db.insert(partnerAttributions).values({ orderId: o, partnerId, source: "owner", status: "attributed", rateBp: 1000, holdDays: 30, decidedBy: "t", decidedAt: new Date() });
    const e = (key: string, category: "sales_product" | "partner_commission" | "partner_fixed_fee", amount: string, currency = "UAH") => ({
      idempotencyKey: `demo:wp7page:${key}`,
      category,
      recognizedOn: "2026-10-05",
      fxOn: "2026-10-05",
      amount,
      currency,
      orderId: category === "partner_fixed_fee" ? null : o,
      partnerId: category === "partner_fixed_fee" ? partnerId : null,
      sourceType: "demo" as const,
      sourceId: key,
    });
    await db.transaction((tx) =>
      postEntries(tx, SYSTEM_ACTOR, [e("s", "sales_product", "6000.00"), e("c", "partner_commission", "-600.00"), e("f", "partner_fixed_fee", "-200.00"), e("fp", "partner_fixed_fee", "-50.00", "PLN")]),
    );
    const data = await loadDetail(partnerId, "?currency=UAH");
    expect(data.performance!.summary).toMatchObject({ fixedFees: "200.00", complete: { fixedFees: false }, paybackMissing: "fixed_fees_unconverted", fact: { payback: null } });
    const html = await renderPage(detailRoute() as never, `/demo/finance/partners/${partnerId}?currency=UAH`, OWNER);
    const markerBefore = (kpi: string) => {
      const at = html.indexOf(`data-kpi="${kpi}"`);
      expect(at).toBeGreaterThan(0);
      return /ot-kpi--([a-z_]+)/.exec(html.slice(html.lastIndexOf("ot-kpi--", at)))![1];
    };
    expect(markerBefore("partner-fixed")).toBe("incomplete");
    expect(markerBefore("partner-chargeback")).toBe("complete");
    const page = text(html);
    const payback = page.slice(page.indexOf("Окупність"), page.indexOf("Окупність") + 400);
    expect(payback).toContain("Неповні дані");
    expect(payback).toContain("—");
    expect(payback).toContain("частина фіксованих оплат без курсу для UAH");
    expect(payback).not.toMatch(/На 1 грн витрат/);
  });

  it("review: a new partner with a UAH payout currency — the payout form covers the commission (shop) currency, not UAH", async () => {
    setContext(OWNER);
    expect(await actList({ intent: "createPartner", displayName: "Виплати в гривні", kind: "blogger", rate: "10", holdDays: "30", payoutCurrency: "UAH" })).toMatchObject({ ok: true });
    const p = (await loadList()).partners.find((x) => x.displayName === "Виплати в гривні")!;
    const data = await loadDetail(p.id);
    expect(data).toMatchObject({ commissionCurrency: "EUR", payoutCurrencyDefault: "UAH" });
    const html = await renderPage(detailRoute() as never, `/demo/finance/partners/${p.id}`, OWNER);
    expect(html).toMatch(/name="coversCurrency" value="EUR"/);
    expect(text(html)).toContain("Закриває баланс комісії, EUR");
  });

  it("English detail page has no Cyrillic except owner-entered names", async () => {
    setContext(OWNER, "en");
    const en = text(await renderPage(detailRoute() as never, `/demo/finance/partners/${partnerId}`, OWNER, "en"));
    for (const s of ["Partner balance", "Partner performance", "Commissions", "Payouts", "Fixed fees", "Codes", "Rates"]) expect(en).toContain(s);
    expect(en).not.toMatch(/partners\.[a-z]/);
    expect(en.replace(/Демо-партнер А/g, "").replace(/Блогер підтвердив/g, "")).not.toMatch(/[А-Яа-яІіЇїЄєҐґ]/);
  });
});
