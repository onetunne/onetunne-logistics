/**
 * Етап 6, WP1: сторінка «Фінанси → Курси» (§18.2, §14.2). Працівник і підроблений актор — 403 на loader і action;
 * порожня фінансова база — «Немає даних» / порожні стани (ніде не вигаданий 0); банери демо; SSR uk/en без сирих ключів і
 * без кирилиці в англійській версії; дії власника: ручний курс (історія, Δ), обмін (G4), вимикач НБУ й кнопки
 * (неактивні/відмова без вимикача), помилки з датами у форматі мови; подвійне надсилання форм ручного курсу — «без змін»;
 * у картках без відступів (таблиці) форма й порожні стани мають власні відступи (не вкладений `ot-card__body`).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { makeActor, type Actor } from "~/domain/permissions";
import { storeOfficialRates } from "~/modules/fx/rates-store.server";
import type { RequestContext } from "~/server/types";
import { createTestEnv, OWNER, STAFF, type TestEnv } from "../../helpers";
import { renderPage } from "../../pages/insights-render";
import { ALL_20261120, closeMonth, EUR_RANGE, fixtureRows, prodCtx } from "./helpers";

const m = vi.hoisted(() => ({ ctx: null as RequestContext | null }));
vi.mock("~/server/context.server", () => ({
  getRequestContext: async () => {
    if (!m.ctx) throw new Error("test context is not set");
    return m.ctx;
  },
}));

let env: TestEnv;
let page: typeof import("~/pages/finance-rates");
const FORGED = makeActor({ id: "forged", displayName: "Forged", role: "staff", overrides: { grant: ["finance.view", "finance.manage"] } });
const NOW = new Date("2026-11-28T10:00:00Z");

function setContext(actor: Actor = OWNER, opts: { locale?: "uk" | "en"; mode?: "demo" | "production" } = {}) {
  const mode = opts.mode ?? "demo";
  const base = mode === "production" ? prodCtx(env, actor, NOW) : { ...env.ctx(actor), now: () => NOW };
  m.ctx = { ...base, basePath: mode === "demo" ? "/demo" : "/app", locale: opts.locale ?? "uk" };
}
const route = () => ({ path: "finance/rates", loader: page.loader, action: page.action, Component: page.default });
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;|\u00a0/g, " ")
    .replace(/\s+/g, " ");
const load = (url = "http://localhost/demo/finance/rates") => page.loader({ request: new Request(url), params: {}, context: {} } as never);
const act = (fields: Record<string, string>) =>
  page.action({ request: new Request("http://localhost/demo/finance/rates", { method: "POST", body: new URLSearchParams(fields) }), params: {}, context: {} } as never);

/**
 * Для кожної картки без відступів (`ot-card--flush`) — скільки елементів `ot-card__body` у ній. Має бути рівно один
 * (власний): правило `.ot-card--flush .ot-card__body { padding: 0 }` обнуляє відступи й вкладеного.
 */
function flushCardBodies(html: string): number[] {
  const out: number[] = [];
  for (const m of html.matchAll(/<section\b[^>]*class="[^"]*\bot-card--flush\b[^"]*"[^>]*>/g)) {
    const start = m.index! + m[0].length;
    const tag = /<\/?section\b[^>]*>/g;
    tag.lastIndex = start;
    let depth = 1;
    let end = html.length;
    for (let t = tag.exec(html); t; t = tag.exec(html)) {
      depth += t[0].startsWith("</") ? -1 : 1;
      if (depth === 0) {
        end = t.index;
        break;
      }
    }
    out.push((html.slice(start, end).match(/class="[^"]*\bot-card__body\b/g) ?? []).length);
  }
  return out;
}

beforeAll(async () => {
  env = await createTestEnv({ seed: false });
  page = await import("~/pages/finance-rates");
});
afterAll(async () => {
  await env.close();
});

describe("access (§14.2)", () => {
  it("staff and a forged staff actor get 403 on the loader and the action (no redirect)", async () => {
    for (const actor of [STAFF, FORGED]) {
      setContext(actor);
      await expect(load()).rejects.toMatchObject({ status: 403 });
      await expect(act({ intent: "saveRate" })).rejects.toMatchObject({ status: 403 });
    }
  });
});

describe("empty finance database (demo)", () => {
  it("every section renders «No data» / empty states, demo banners, the NBU source; nothing fabricated", async () => {
    setContext(OWNER);
    const data = await load();
    expect(data.matrix.currencies).toEqual(["EUR", "USD", "GBP", "PLN"]);
    expect(data.matrix.rows).toHaveLength(14);
    expect(data.matrix.rows.every((r) => Object.values(r.cells).every((c) => c.effective === null))).toBe(true);
    expect(data.versions).toEqual([]);
    expect(data.conversions).toEqual([]);
    expect(data.conflicts).toEqual([]);
    expect(data.nbu).toMatchObject({ available: false, enabled: false, lastFetchedAt: null, pendingJobs: 0 });
    const html = text(await renderPage(route() as never, "/demo/finance/rates", OWNER));
    for (const s of [
      "Курси",
      "Демо: усі фінансові дані вигадані.",
      "Демо-курси вигадані. Це не курси НБУ.",
      "Немає даних",
      "Курсів за цей період немає.",
      "Ручних курсів ще немає.",
      "Обмінів ще немає.",
      "У демо запитів до НБУ немає: усі курси вигадані.",
      "Курси для тарифів Checkout (не фінансові)",
      "Джерело: Національний банк України (bank.gov.ua)",
      "Зараз на цю дату курсу немає.",
    ]) {
      expect(html, s).toContain(s);
    }
    expect(html).not.toMatch(/financeFx\.|finance\.(rate|notice|tab)\./);
    expect(html).not.toMatch(/\b0,00\b/);
    const en = text(await renderPage(route() as never, "/demo/finance/rates", OWNER, "en"));
    expect(en).toContain("Rates by date");
    expect(en).toContain("No data");
    expect(en).toContain("Source: National Bank of Ukraine (bank.gov.ua)");
    expect(en).not.toMatch(/financeFx\./);
    expect(en).not.toMatch(/[А-Яа-яІіЇїЄєҐґ]/);
  });

  it("the flush «Rates by date» card pads its filter and empty states itself (no nested card body)", async () => {
    setContext(OWNER);
    const html = await renderPage(route() as never, "/demo/finance/rates", OWNER);
    const cards = flushCardBodies(html);
    expect(cards.length).toBeGreaterThanOrEqual(1);
    expect(cards.every((n) => n === 1), JSON.stringify(cards)).toBe(true);
    expect(html).toContain("ot-rates-inset");
  });

  it("in the demo the NBU buttons refuse", async () => {
    setContext(OWNER);
    expect(await act({ intent: "nbuFetch" })).toMatchObject({ ok: false, error: "financeFx.error.demoNoNbu" });
    expect(await act({ intent: "nbuToggle", enabled: "true" })).toMatchObject({ ok: false, error: "financeFx.error.demoNoNbu" });
  });
});

describe("with NBU rates (production context)", () => {
  beforeAll(async () => {
    await storeOfficialRates(env.handle.db, fixtureRows(ALL_20261120, { from: "2026-11-20", to: "2026-11-20" }), { fetchedAt: NOW, mode: "production" });
    await storeOfficialRates(env.handle.db, fixtureRows(EUR_RANGE, { from: "2026-11-18", to: "2026-11-30" }), { fetchedAt: NOW, mode: "production" });
  });

  it("the table shows NBU rates, Friday's rate on weekends, a fallback «rate of» and «No rate»", async () => {
    setContext(OWNER, { mode: "production" });
    const data = await load("http://localhost/app/finance/rates?from=2026-11-19&to=2026-11-28");
    const row = (d: string) => data.matrix.rows.find((r) => r.date === d)!;
    expect(row("2026-11-21").cells.EUR!.effective).toMatchObject({ source: "nbu", ratePerUnit: "49.5335", fallback: false });
    expect(row("2026-11-21").weekend).toBe(true);
    expect(row("2026-11-23").cells.USD!.effective).toMatchObject({ source: "nbu", fallback: true, rateDate: "2026-11-20" });
    expect(row("2026-11-28").cells.USD!.effective).toBeNull();
    expect(row("2026-11-19").cells.USD!.effective).toBeNull();
    const html = text(await renderPage(route() as never, "/demo/finance/rates?from=2026-11-19&to=2026-11-28", OWNER));
    expect(html).toContain("49,5335");
    expect(html).toContain("Курс НБУ");
    expect(html).toContain("вихідний: курс п'ятниці");
    expect(html).toContain("курс за 20.11.2026");
    expect(html).toContain("Без курсу");
    // Масштаб НБУ показано (HUF за 100).
    const huf = text(await renderPage(route() as never, "/demo/finance/rates?from=2026-11-20&to=2026-11-20&currency=HUF", OWNER));
    expect(huf).toContain("0,134308");
    expect(huf).toContain("13,4308 за 100");
  });

  it("owner saves a manual rate (result with entries and Δ), the version appears; closed month → message with a readable month", async () => {
    setContext(OWNER, { mode: "production" });
    expect(await act({ intent: "saveRate", currency: "EUR", effectiveDate: "2026-11-20", rate: "49,6", units: "1", expectedVersion: "0" })).toMatchObject({
      ok: false,
      error: "financeFx.error.reasonRequired",
    });
    const r = await act({ intent: "saveRate", currency: "EUR", effectiveDate: "2026-11-20", rate: "49,6", units: "1", reason: "Курс банку", expectedVersion: "0" });
    expect(r).toMatchObject({ ok: true, message: "financeFx.result.rateSaved", params: { currency: "EUR", date: "20.11.2026", version: 1, entries: 0, delta: "0,00\u00a0грн" } });
    expect(r.nextOperationId).toMatch(/^[0-9a-f-]{36}$/);
    const data = await load("http://localhost/app/finance/rates?rateCurrency=EUR&rateDate=2026-11-20");
    expect(data.versions).toHaveLength(1);
    expect(data.versions[0]).toMatchObject({ currency: "EUR", version: 1, isCurrent: true, affectedEntries: 0, deltaReporting: "0.00", reason: "Курс банку" });
    expect(data.edit.cell).toMatchObject({ manual: { version: 1 }, effective: { source: "manual", ratePerUnit: "49.6" } });
    const html = text(await renderPage(route() as never, "/demo/finance/rates?rateCurrency=EUR&rateDate=2026-11-20", OWNER));
    expect(html).toContain("Поточний ручний курс: 49,6, версія 1.");
    expect(html).toContain("Анулювати ручний курс");
    await closeMonth(env.handle.db, "2026-10-01");
    // Місяць — сирий календарний місяць; назву місяця мовою інтерфейсу дає централізовано localizeParams (ActionBanner).
    const closed = (await act({ intent: "saveRate", currency: "EUR", effectiveDate: "2026-10-15", rate: "48", units: "1", reason: "x" })) as { params?: Record<string, string | number> };
    expect(closed).toMatchObject({ ok: false, error: "finance.error.monthClosed", params: { month: "2026-10-01" } });
    const { localizeParams } = await import("~/i18n/localize");
    const { makeT } = await import("~/i18n");
    expect(makeT("uk")("finance.error.monthClosed", localizeParams(closed.params, makeT("uk"), "uk"))).toContain("Місяць жовтень 2026 закрито");
    setContext(OWNER, { mode: "production", locale: "en" });
    const closedEn = (await act({ intent: "saveRate", currency: "EUR", effectiveDate: "2026-10-15", rate: "48", units: "1", reason: "x" })) as { params?: Record<string, string | number> };
    expect(makeT("en")("finance.error.monthClosed", localizeParams(closedEn.params, makeT("en"), "en"))).toContain("Month October 2026 is closed");
  });

  it("owner records a currency exchange (G4 numbers) and sees it in the list; no rate → readable date", async () => {
    setContext(OWNER, { mode: "production" });
    const op = randomUUID();
    const fields = { intent: "conversion", operationId: op, occurredOn: "2026-11-27", soldAmount: "1 000,00", soldCurrency: "EUR", boughtAmount: "48 650,00", boughtCurrency: "UAH", counterparty: "bank" };
    expect(await act(fields)).toMatchObject({ ok: true, message: "financeFx.result.conversionSaved", params: { expected: "49\u00a0494,20\u00a0грн", difference: "-844,20\u00a0грн" } });
    expect(await act(fields)).toMatchObject({ ok: true, tone: "info", message: "financeFx.result.conversionDuplicate" });
    expect(await act({ ...fields, operationId: randomUUID(), occurredOn: "2026-11-22", soldCurrency: "USD" })).toMatchObject({
      ok: false,
      error: "finance.error.noRate",
      params: { currency: "USD", date: "22.11.2026" },
    });
    const data = await load();
    expect(data.conversions).toHaveLength(1);
    expect(data.conversions[0]).toMatchObject({ difference: "-844.20", expected: "49494.20", status: "active" });
    const html = text(await renderPage(route() as never, "/demo/finance/rates", OWNER));
    expect(html).toContain("-844,20 грн");
    expect(html).toContain("Чинний");
    const id = data.conversions[0]!.id;
    expect(await act({ intent: "voidConversion", id, reason: "" })).toMatchObject({ ok: false, error: "financeFx.error.reasonRequired" });
    expect(await act({ intent: "voidConversion", id, reason: "Помилка", expectedVersion: String(data.conversions[0]!.version) })).toMatchObject({ ok: true, message: "financeFx.result.conversionVoided" });
  });

  it("NBU switch: buttons refuse while off; the owner turns it on and queues an update; English page has no Cyrillic in its own texts", async () => {
    setContext(OWNER, { mode: "production" });
    let html = text(await renderPage(route() as never, "/demo/finance/rates", OWNER));
    expect(html).toContain("Запити до НБУ вимкнено.");
    expect(html).toContain("Неактивно: спершу дозвольте запити до НБУ.");
    expect(await act({ intent: "nbuFetch" })).toMatchObject({ ok: false, error: "finance.error.nbuDisabled" });
    expect(await act({ intent: "nbuBackfill", currency: "EUR", from: "2026-01-01", to: "2026-02-01" })).toMatchObject({ ok: false, error: "finance.error.nbuDisabled" });
    expect(await act({ intent: "nbuToggle", enabled: "true", reason: "Дозволено" })).toMatchObject({ ok: true, message: "financeFx.result.nbuOn" });
    expect(await act({ intent: "nbuFetch" })).toMatchObject({ ok: true, message: "financeFx.result.fetchQueued" });
    expect(await act({ intent: "nbuBackfill", currency: "EUR", from: "2025-06-01", to: "2026-02-01" })).toMatchObject({ ok: true, params: { windows: 1, queued: 1 } });
    html = text(await renderPage(route() as never, "/demo/finance/rates", OWNER));
    expect(html).toContain("Запити до НБУ дозволено.");
    expect(html).toContain("Завдань НБУ в черзі: 2.");
    setContext(OWNER, { mode: "production", locale: "en" });
    const en = text(await renderPage(route() as never, "/demo/finance/rates", OWNER, "en"));
    expect(en).toContain("NBU requests are allowed.");
    expect(en).not.toMatch(/financeFx\./);
    // Кирилиця в англійській версії — лише з даних власника (причини ручних курсів), не з текстів сторінки.
    const own = en.replaceAll("Курс банку", "").replaceAll("Помилка", "");
    expect(own).not.toMatch(/[А-Яа-яІіЇїЄєҐґ]/);
    expect(await act({ intent: "nbuToggle", enabled: "false" })).toMatchObject({ ok: true, message: "financeFx.result.nbuOff" });
  });

  it("an NBU conflict is listed and the owner can keep the stored rate", async () => {
    await storeOfficialRates(env.handle.db, [{ currency: "USD", effectiveDate: "2026-11-20", rate: "45.1", units: 1, setOn: null }], { fetchedAt: NOW, mode: "production" });
    setContext(OWNER, { mode: "production" });
    const data = await load();
    expect(data.conflicts).toHaveLength(1);
    const html = text(await renderPage(route() as never, "/demo/finance/rates", OWNER));
    expect(html).toContain("Розбіжності курсів НБУ");
    expect(html).toContain("USD на 20.11.2026: збережено 45,0532 / 1, отримано 45,1 / 1");
    expect(await act({ intent: "keepConflict", id: data.conflicts[0]!.id, expectedVersion: String(data.conflicts[0]!.version), note: "Перевірено" })).toMatchObject({
      ok: true,
      message: "financeFx.result.conflictKept",
    });
    expect((await load()).conflicts).toHaveLength(0);
    expect(await act({ intent: "keepConflict", id: "nope" })).toMatchObject({ ok: false, error: "financeFx.error.notFound" });
  });

  it("double submit: the same manual-rate form twice → «unchanged»; the same void form twice → «already voided»; layout with data", async () => {
    setContext(OWNER, { mode: "production" });
    const save = { intent: "saveRate", currency: "EUR", effectiveDate: "2026-11-25", rate: "49,7", units: "1", reason: "Курс банку", expectedVersion: "0" };
    expect(await act(save)).toMatchObject({ ok: true, message: "financeFx.result.rateSaved", params: { version: 1 } });
    expect(await act(save)).toMatchObject({ ok: true, tone: "info", message: "financeFx.result.rateUnchanged", params: { currency: "EUR", date: "25.11.2026" } });
    const voidForm = { intent: "voidRate", currency: "EUR", effectiveDate: "2026-11-25", reason: "Помилка", expectedVersion: "1" };
    expect(await act(voidForm)).toMatchObject({ ok: true, message: "financeFx.result.rateVoided" });
    expect(await act(voidForm)).toMatchObject({ ok: true, tone: "info", message: "financeFx.result.rateAlreadyVoided", params: { currency: "EUR", date: "25.11.2026" } });
    const html = await renderPage(route() as never, "/demo/finance/rates?from=2026-11-19&to=2026-11-28", OWNER);
    const cards = flushCardBodies(html);
    expect(cards.length).toBeGreaterThanOrEqual(2);
    expect(cards.every((n) => n === 1), JSON.stringify(cards)).toBe(true);
    setContext(OWNER, { mode: "production", locale: "en" });
    const en = text(await renderPage(route() as never, "/demo/finance/rates", OWNER, "en"));
    expect(en).not.toMatch(/financeFx\./);
  });
});
