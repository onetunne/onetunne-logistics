/**
 * Етап 6, WP9: сторінки «Повернення» (…/returns, …/returns/:returnId; §11, §14.2, §20.4).
 * - доступ: без orders.view — 403 на loader і action (без переадресації); суми працівнику — `amounts: null` (не порожнє),
 *   у JSON loader працівника немає фінансових слів (I11); власнику — суми;
 * - порожня база: «Випадків повернень ще немає» / «Немає даних», банер демо; SSR uk/en без сирих ключів і без кирилиці
 *   в англійській версії; текст сторінок працівника без «прибуток / оборот / собівартість / рентабельність»;
 * - дії: ручний випадок → переадресація на випадок; «Відкрити» з підказки; зміна випадку (CAS); працівник без
 *   orders.edit — «Недостатньо прав»; кнопка «Додати витрату на повернення» — посилання на форму WP6 із замовленням і
 *   випадком, лише власнику.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { orderReturns } from "~/db/schema";
import { makeActor, type Actor } from "~/domain/permissions";
import type { RequestContext } from "~/server/types";
import { createTestEnv, OWNER, STAFF, type TestEnv } from "../../helpers";
import { renderPage } from "../../pages/insights-render";
import { addRefund, addShipment, insertOrder, makeVariant, syncCases, type TestOrder } from "./helpers";

const m = vi.hoisted(() => ({ ctx: null as RequestContext | null }));
vi.mock("~/server/context.server", () => ({
  getRequestContext: async () => {
    if (!m.ctx) throw new Error("test context is not set");
    return m.ctx;
  },
}));

let env: TestEnv;
let list: typeof import("~/pages/returns");
let detail: typeof import("~/pages/return-detail");
const NOW = new Date("2026-11-28T10:00:00Z");
const NO_ORDERS = makeActor({
  id: "no-orders",
  displayName: "N",
  role: "staff",
  overrides: { revoke: ["orders.view"] },
});
const VIEW_ONLY = makeActor({
  id: "view-only",
  displayName: "V",
  role: "staff",
  overrides: { revoke: ["orders.edit"] },
});
const FORGED = makeActor({
  id: "forged",
  displayName: "F",
  role: "staff",
  overrides: { grant: ["finance.view", "finance.manage"] },
});
const FINANCE_WORDS = /(profit|прибут|cogs|собіварт|margin|rentab|рентаб|revenue|оборот|turnover)/i;
const STAFF_TEXT_WORDS = /прибут|оборот|собіварт|рентаб|profit|turnover|margin/i;

function setContext(actor: Actor = OWNER, locale: "uk" | "en" = "uk") {
  m.ctx = { ...env.ctx(actor), now: () => NOW, basePath: "/demo", locale };
}
const text = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;| | /g, " ")
    .replace(/\s+/g, " ");
/** SSR сторінки від імені актора (контекст loader і оболонка — той самий актор). */
async function render(route: Parameters<typeof renderPage>[0], url: string, actor: Actor, locale: "uk" | "en" = "uk") {
  setContext(actor, locale);
  return renderPage(route, url, actor, locale);
}
const listRoute = () => ({
  path: "returns",
  loader: list.loader,
  action: list.action,
  Component: list.default,
});
const detailRoute = () => ({
  path: "returns/:returnId",
  loader: detail.loader,
  action: detail.action,
  Component: detail.default,
});
const loadList = (query = "") =>
  list.loader({
    request: new Request(`http://localhost/demo/returns${query}`),
    params: {},
    context: {},
  } as never);
const actList = (fields: Record<string, string | string[]>) => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
  return list.action({
    request: new Request("http://localhost/demo/returns", {
      method: "POST",
      body,
    }),
    params: {},
    context: {},
  } as never);
};
const loadDetail = (id: string, query = "") =>
  detail.loader({
    request: new Request(`http://localhost/demo/returns/${id}${query}`),
    params: { returnId: id },
    context: {},
  } as never);
const actDetail = (id: string, fields: Record<string, string>) =>
  detail.action({
    request: new Request(`http://localhost/demo/returns/${id}`, {
      method: "POST",
      body: new URLSearchParams(fields),
    }),
    params: { returnId: id },
    context: {},
  } as never);

beforeAll(async () => {
  env = await createTestEnv({ seed: false });
  list = await import("~/pages/returns");
  detail = await import("~/pages/return-detail");
});
afterAll(async () => {
  await env.close();
});

describe("access (§14.2)", () => {
  it("no orders.view → 403 on both loaders and actions (no redirect)", async () => {
    setContext(NO_ORDERS);
    await expect(loadList()).rejects.toMatchObject({ status: 403 });
    await expect(loadList("?tab=stats")).rejects.toMatchObject({ status: 403 });
    await expect(actList({ intent: "createCase" })).rejects.toMatchObject({
      status: 403,
    });
    await expect(loadDetail(randomUUID())).rejects.toMatchObject({
      status: 403,
    });
    await expect(actDetail(randomUUID(), { intent: "update" })).rejects.toMatchObject({ status: 403 });
  });

  it("unknown or malformed case → 404", async () => {
    setContext(STAFF);
    await expect(loadDetail(randomUUID())).rejects.toMatchObject({
      status: 404,
    });
    await expect(loadDetail("nope")).rejects.toMatchObject({ status: 404 });
  });
});

describe("empty database", () => {
  it("cases tab: «No return cases yet», demo banner; staff and forged actors get amounts: null", async () => {
    for (const actor of [STAFF, FORGED, OWNER]) {
      setContext(actor);
      const data = (await loadList()) as Awaited<ReturnType<typeof list.loader>>;
      expect(data.amounts).toBeNull();
      expect(data.list).toMatchObject({ total: 0, rows: [] });
      expect(data.hints).toEqual([]);
    }
    const uk = text(await render(listRoute(), "/demo/returns", STAFF, "uk"));
    expect(uk).toContain("Випадків повернень ще немає");
    expect(uk).toContain("Демо: усі випадки");
    expect(uk).not.toMatch(/returns\.[a-z]/);
    const en = text(await render(listRoute(), "/demo/returns", STAFF, "en"));
    expect(en).toContain("No return cases yet");
    expect(en).not.toMatch(/[А-Яа-яІіЇїЄєҐґ]/);
  });

  it("statistics tab: «No data», rate «—» (never 0 %); owner sees money with «—»; staff gets amounts: null", async () => {
    setContext(STAFF);
    const s = (await loadList("?tab=stats")) as Awaited<ReturnType<typeof list.loader>>;
    expect(s.amounts).toBeNull();
    expect(s.stats).toMatchObject({ cases: 0, rate: { percent: null } });
    expect(JSON.stringify(s)).not.toMatch(FINANCE_WORDS);
    setContext(FORGED);
    expect(((await loadList("?tab=stats")) as Awaited<ReturnType<typeof list.loader>>).amounts).toBeNull();
    setContext(OWNER);
    const o = (await loadList("?period=last30")) as Awaited<ReturnType<typeof list.loader>>;
    expect(o.tab).toBe("stats");
    expect(o.amounts).toMatchObject({
      currency: "UAH",
      refunds: { total: null, entries: 0 },
    });
    const ownerHtml = text(await render(listRoute(), "/demo/returns?tab=stats", OWNER, "uk"));
    expect(ownerHtml).toContain("Немає даних за період");
    expect(ownerHtml).toContain("Суми повернень за період (лише власник)");
    expect(ownerHtml).not.toMatch(/0,0\s?%/);
    const staffHtml = text(await render(listRoute(), "/demo/returns?tab=stats", STAFF, "uk"));
    expect(staffHtml).not.toContain("лише власник");
    expect(staffHtml).not.toMatch(STAFF_TEXT_WORDS);
    expect(text(await render(listRoute(), "/demo/returns?tab=stats", STAFF, "en"))).not.toMatch(STAFF_TEXT_WORDS);
    expect(text(await render(listRoute(), "/demo/returns?tab=stats", OWNER, "en"))).not.toMatch(/[А-Яа-яІіЇїЄєҐґ]/);
  });
});

describe("with cases", () => {
  let order: TestOrder;
  let caseId = "";
  let hintShipment = "";
  let hintOrder: TestOrder;

  beforeAll(async () => {
    const db = env.handle.db;
    const v = await makeVariant(db, { model: "Тримач", color: "Чорний" });
    order = await insertOrder(db, {
      variants: [{ variantId: v.variantId, quantity: 2 }],
    });
    await addShipment(db, order, {
      handedOverAt: "2026-10-05T08:00:00Z",
      deliveredAt: "2026-10-12T08:00:00Z",
    });
    await addRefund(db, order, {
      at: "2026-11-04T09:00:00Z",
      lines: [{ line: 0, quantity: 1, restockType: "RETURN" }],
    });
    await syncCases(env, order.orderId);
    [caseId] = (await db.select({ id: orderReturns.id }).from(orderReturns).where(eq(orderReturns.orderId, order.orderId))).map((r) => r.id) as [
      string,
    ];
    hintOrder = await insertOrder(db, {
      variants: [{ variantId: v.variantId }],
    });
    hintShipment = await addShipment(db, hintOrder, {
      carrierCode: "test",
      statusCode: "TEST-RETURN",
      statusAt: "2026-11-20T08:00:00Z",
    });
  });

  it("staff detail: history and items without money (amounts: null, no finance words in JSON or text); owner: amounts and expense links", async () => {
    setContext(STAFF);
    const s = (await loadDetail(caseId)) as Awaited<ReturnType<typeof detail.loader>>;
    expect(s.amounts).toBeNull();
    expect(s.canAddExpense).toBe(false);
    expect(s.detail.timeline.length).toBeGreaterThan(3);
    expect(JSON.stringify(s)).not.toMatch(FINANCE_WORDS);
    for (const locale of ["uk", "en"] as const) {
      const html = text(await render(detailRoute(), `/demo/returns/${caseId}`, STAFF, locale));
      expect(html).not.toMatch(STAFF_TEXT_WORDS);
      expect(html).not.toMatch(/returns\.[a-z]/);
      expect(html).not.toContain("finance/expenses");
      if (locale === "en") expect(html.replace(/Тестов\S* \S*|Тримач|Чорний/g, "")).not.toMatch(/[А-Яа-яІіЇїЄєҐґ]/);
      // §6.7: повернення коштів RETURN без надходження на склад — «Очікує надходження на склад» (бачить і працівник).
      expect(html).toContain(locale === "uk" ? "Очікує надходження на склад" : "Awaiting stock receipt");
    }
    expect(s.detail).toMatchObject({ awaitingReceipt: true, quantityUncertain: false });
    setContext(OWNER);
    const o = (await loadDetail(caseId)) as Awaited<ReturnType<typeof detail.loader>>;
    expect(o.amounts).toMatchObject({
      currency: "UAH",
      refunds: [{ amount: "45.00", currency: "EUR" }],
    });
    expect(o.canAddExpense).toBe(true);
    const raw = await render(detailRoute(), `/demo/returns/${caseId}`, OWNER, "uk");
    const qs = new URLSearchParams({
      add: "expense",
      category: "return_shipping_cost",
      order: order.orderNumber,
      returnId: caseId,
    }).toString();
    expect(raw).toContain(`/demo/finance/expenses?${qs.replace(/&/g, "&amp;")}#expense-form`);
    expect(raw).toContain("category=return_handling");
    expect(text(raw)).toContain("Суми (лише власник)");
    // Суми — віднесені до випадку; решта записів замовлення — окремим блоком.
    expect(o.amounts).toMatchObject({ orderCases: 1, orderLevel: { entries: 0 } });
    expect(text(raw)).toContain("За замовленням, не прив'язано до випадку");
    expect(text(raw)).toContain("Немає записів замовлення поза випадками.");
  });

  it("the list shows the case and the carrier hint; «Open» creates an in-transit case and redirects to it", async () => {
    setContext(STAFF);
    const data = (await loadList()) as Awaited<ReturnType<typeof list.loader>>;
    expect(data.list!.rows.map((r) => r.id)).toContain(caseId);
    expect(data.hints!.map((h) => h.shipmentId)).toEqual([hintShipment]);
    const html = text(await render(listRoute(), "/demo/returns", STAFF, "uk"));
    expect(html).toContain("Очікує надходження на склад");
    expect(data.list!.rows.find((r) => r.id === caseId)).toMatchObject({ awaitingReceipt: true, testOrder: false, uncertainUnits: 0 });
    expect(html).toContain("Можливе повернення (дані перевізника)");
    expect(html).toContain("Повернення (замовив відправник)");
    const res = (await actList({
      intent: "openHint",
      shipmentId: hintShipment,
    })) as Response;
    expect(res.status).toBe(302);
    const loc = res.headers.get("Location")!;
    expect(loc).toMatch(/^\/demo\/returns\/[0-9a-f-]{36}\?notice=opened$/);
    const id = loc.split("/").pop()!.split("?")[0]!;
    const [c] = await env.handle.db.select().from(orderReturns).where(eq(orderReturns.id, id));
    expect(c).toMatchObject({
      orderId: hintOrder.orderId,
      status: "in_transit",
      kind: "carrier_return",
      source: "carrier_hint",
    });
    expect(((await loadList()) as Awaited<ReturnType<typeof list.loader>>).hints).toEqual([]);
  });

  it("manual case through the form → redirect; a view-only staff member is refused; filters keep working", async () => {
    const db = env.handle.db;
    const v = await makeVariant(db);
    const o = await insertOrder(db, {
      variants: [{ variantId: v.variantId, quantity: 2 }],
    });
    setContext(STAFF);
    const form = (await loadList(`?order=${encodeURIComponent(o.orderNumber)}`)) as Awaited<ReturnType<typeof list.loader>>;
    expect(form.form?.order?.items).toHaveLength(1);
    expect(form.operationId).toMatch(/^[0-9a-f-]{36}$/);
    const html = text(await render(listRoute(), `/demo/returns?order=${encodeURIComponent(o.orderNumber)}`, STAFF, "uk"));
    expect(html).toContain(`Замовлення ${o.orderNumber}`);
    const lineId = form.form!.order!.items[0]!.id;
    const fields = {
      intent: "createCase",
      operationId: form.operationId!,
      orderRef: form.form!.order!.id,
      kind: "lost",
      reasonCode: "address_problem",
      status: "open",
      note: "",
      itemId: [lineId],
      [`qty_${lineId}`]: "2",
      [`condition_${lineId}`]: "unknown",
    };
    const bad = (await actList({ ...fields, [`qty_${lineId}`]: "abc" })) as {
      ok: boolean;
      error: string;
    };
    expect(bad).toMatchObject({
      ok: false,
      error: "returns.error.quantityInvalid",
    });
    const res = (await actList(fields)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toMatch(/\?notice=created$/);
    const again = (await actList(fields)) as Response;
    expect(again.headers.get("Location")).toMatch(/\?notice=replay$/);
    setContext(VIEW_ONLY);
    expect(await actList({ ...fields, operationId: randomUUID() })).toMatchObject({ ok: false, error: "error.forbidden" });
    const viewForm = (await loadList(`?order=${encodeURIComponent(o.orderNumber)}`)) as Awaited<ReturnType<typeof list.loader>>;
    expect(viewForm.form).toBeNull();
    setContext(STAFF);
    const filtered = (await loadList("?kind=lost&status=open")) as Awaited<ReturnType<typeof list.loader>>;
    expect(filtered.list!.rows.map((r) => r.orderId)).toEqual([o.orderId]);
    expect(text(await render(listRoute(), "/demo/returns?kind=refused", STAFF, "uk"))).toContain("Немає випадків за цими фільтрами");
  });

  it("editing on the detail page: saved, stale version → conflict, view-only → forbidden", async () => {
    setContext(STAFF);
    const d = (await loadDetail(caseId)) as Awaited<ReturnType<typeof detail.loader>>;
    const v = String(d.detail.case.version);
    expect(
      await actDetail(caseId, {
        intent: "update",
        version: v,
        kind: "customer_return",
        reasonCode: "wrong_item",
        status: "in_transit",
        note: "",
      }),
    ).toEqual({
      ok: true,
      message: "returns.result.updated",
    });
    expect(
      await actDetail(caseId, {
        intent: "update",
        version: v,
        status: "closed",
      }),
    ).toMatchObject({ ok: false, error: "error.conflict" });
    setContext(VIEW_ONLY);
    expect(
      await actDetail(caseId, {
        intent: "update",
        version: String(Number(v) + 1),
        status: "closed",
      }),
    ).toMatchObject({ ok: false, error: "error.forbidden" });
    setContext(STAFF);
    const html = text(await render(detailRoute(), `/demo/returns/${caseId}?notice=existing`, STAFF, "uk"));
    expect(html).toContain("Для замовлення вже є незакритий випадок");
    expect(html).toContain("Не той товар");
    expect(html).toContain("Повна історія замовлення");
  });
});
