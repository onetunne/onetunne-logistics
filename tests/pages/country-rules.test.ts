import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { Outlet, StaticRouterProvider, createStaticHandler, createStaticRouter } from "react-router";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellData } from "~/components/shell-types";
import { makeActor, type Actor } from "~/domain/permissions";
import { DICTIONARIES } from "~/i18n";
import { getCountryRule } from "~/modules/country-rules/country-rules.server";
import type { RequestContext } from "~/server/types";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";

/** Розділ «Правила країн» (/demo/country-rules, /app/country-rules): loader, action і серверний рендер. */
const m = vi.hoisted(() => ({ ctx: null as RequestContext | null }));
vi.mock("~/server/context.server", () => ({
  getRequestContext: async () => {
    if (!m.ctx) throw new Error("test context is not set");
    return m.ctx;
  },
}));

let env: TestEnv;
let page: typeof import("~/pages/country-rules");

beforeAll(async () => {
  env = await createTestEnv();
  page = await import("~/pages/country-rules");
});

afterAll(async () => {
  await env.close();
});

type Mode = "demo" | "production";

function setContext(actor: Actor = OWNER, mode: Mode = "demo") {
  m.ctx = { ...env.ctx(actor), mode, basePath: mode === "demo" ? "/demo" : "/app", locale: "uk" };
}

beforeEach(() => setContext());

const base = () => (m.ctx?.mode === "production" ? "http://localhost/app" : "http://localhost/demo");

async function load(search = "") {
  return page.loader({ request: new Request(`${base()}/country-rules${search}`), params: {}, context: {} } as never);
}

async function act(fields: Record<string, string>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return page.action({ request: new Request(`${base()}/country-rules`, { method: "POST", body }), params: {}, context: {} } as never);
}

async function loaderStatus(search = ""): Promise<number> {
  try {
    await load(search);
    return 200;
  } catch (e) {
    if (e instanceof Response) return e.status;
    throw e;
  }
}

/** Поля форми правила з поточних значень (чекбокси — "on" або відсутні). */
async function formFor(code: string, patch: Record<string, string | boolean> = {}): Promise<Record<string, string>> {
  const r = await getCountryRule(env.handle.db, code);
  if (!r) throw new Error(`rule ${code} not found`);
  const values: Record<string, string | boolean> = {
    shippingEnabled: r.shippingEnabled,
    postalCodeRequired: r.postalCodeRequired,
    provinceRequired: r.provinceRequired,
    phoneRequired: r.phoneRequired,
    postalCodePattern: r.postalCodePattern ?? "",
    postalCodeExample: r.postalCodeExample ?? "",
    dutyPayer: r.dutyPayer,
    notes: r.notes ?? "",
    ...patch,
  };
  const out: Record<string, string> = { countryCode: code, expectedVersion: String(r.version) };
  for (const [k, v] of Object.entries(values)) {
    if (v === true) out[k] = "on";
    else if (typeof v === "string") out[k] = v;
  }
  return out;
}

async function render(path: string): Promise<string> {
  const mode = m.ctx?.mode ?? "demo";
  const actor = m.ctx?.actor ?? OWNER;
  const layoutId = mode === "demo" ? "routes/demo-layout" : "routes/app-layout";
  const shell: ShellData = {
    mode,
    basePath: mode === "demo" ? "/demo" : "/app",
    actor: { id: actor.id, displayName: actor.displayName, role: actor.role, permissions: [...actor.permissions] },
    nav: [],
    automation: { mode: "semi", globalPause: false },
    openProblems: 0,
    demo: null,
  };
  const routes = [
    {
      id: "root",
      path: "/",
      loader: () => ({ locale: "uk" }),
      Component: Outlet,
      children: [
        {
          id: layoutId,
          path: mode === "demo" ? "demo" : "app",
          loader: () => shell,
          Component: Outlet,
          children: [{ id: "page", path: "country-rules", loader: page.loader, action: page.action, Component: page.default }],
        },
      ],
    },
  ];
  const handler = createStaticHandler(routes as never);
  const context = await handler.query(new Request(`http://localhost${path}`));
  if (context instanceof Response) throw new Error(`unexpected response ${context.status}`);
  expect(context.errors).toBeNull();
  const router = createStaticRouter(handler.dataRoutes, context);
  return renderToString(h(StaticRouterProvider, { router, context }));
}

const uk = (key: string) => DICTIONARIES.uk[key]!;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

describe("country rules loader", () => {
  it("lists all default rules; owner can manage, staff cannot", async () => {
    const data = await load();
    expect(data.total).toBeGreaterThan(30);
    expect(data.rules).toHaveLength(data.total);
    expect(data.canManage).toBe(true);
    expect(data.verifyCount).toBe(data.rules.filter((r) => r.needsVerification).length);
    expect(data.verifyCount).toBeGreaterThan(0);
    expect(data.rules.find((r) => r.countryCode === "DE")).toMatchObject({ hasDefault: true, changed: false, needsVerification: true });
    setContext(STAFF);
    expect((await load()).canManage).toBe(false);
  });

  it("searches by code or name and filters by shipping / changed", async () => {
    expect((await load("?q=de")).rules.map((r) => r.countryCode)[0]).toBe("DE");
    expect((await load("?q=" + encodeURIComponent("німеч"))).rules.map((r) => r.countryCode)).toEqual(["DE"]);
    expect((await load("?q=poland")).rules.map((r) => r.countryCode)).toEqual(["PL"]);
    const disabled = (await load("?shipping=disabled")).rules;
    expect(disabled.length).toBeGreaterThan(0);
    expect(disabled.every((r) => !r.shippingEnabled)).toBe(true);
    expect(disabled.map((r) => r.countryCode)).toContain("RU");
    expect((await load("?shipping=enabled")).rules.every((r) => r.shippingEnabled)).toBe(true);
    expect((await load("?changed=1")).rules).toEqual([]);
    expect((await load("?shipping=bogus")).filters.shipping).toBe("all");
  });

  it("selects a country with its (empty) history; unknown country is reported", async () => {
    const data = await load("?country=de");
    expect(data.selected?.countryCode).toBe("DE");
    expect(data.history).toEqual([]);
    expect((await load("?country=QQ")).missingCountry).toBe("QQ");
    expect((await load("?country=../x")).selected).toBeNull();
  });

  it("requires orders.view", async () => {
    setContext(makeActor({ id: "no-view", displayName: "No view", role: "staff", overrides: { revoke: ["orders.view"] } }));
    expect(await loaderStatus()).toBe(403);
  });
});

describe("country rules action", () => {
  it("staff cannot update, reset or add", async () => {
    setContext(STAFF);
    expect(await act({ intent: "update", ...(await formFor("PL", { dutyPayer: "customer" })) })).toMatchObject({ ok: false, error: "error.forbidden" });
    expect(await act({ intent: "reset", ...(await formFor("PL")) })).toMatchObject({ ok: false, error: "error.forbidden" });
    expect(await act({ intent: "add", ...(await formFor("PL")), countryCode: "IS" })).toMatchObject({ ok: false, error: "error.forbidden" });
    expect((await getCountryRule(env.handle.db, "PL"))?.dutyPayer).toBe("unknown");
  });

  it("owner saves a change; history and 'changed' filter follow; stale form → conflict", async () => {
    const form = await formFor("PL", { dutyPayer: "customer", phoneRequired: false });
    const res = await act({ intent: "update", ...form });
    expect(res).toMatchObject({ ok: true, message: "countryRules.result.updated", intent: "update", countryCode: "PL" });
    expect("params" in res && typeof res.params?.count).toBe("number");

    const data = await load("?country=PL");
    expect(data.selected).toMatchObject({ dutyPayer: "customer", phoneRequired: false, changed: true });
    expect(data.history.map((h) => [h.version, h.source, h.by])).toEqual([
      [2, "update", "owner"],
      [1, "initial", "system"],
    ]);
    expect(data.history[0]?.changes.map((c) => c.field).sort()).toEqual(["dutyPayer", "phoneRequired"]);
    expect((await load("?changed=1")).rules.map((r) => r.countryCode)).toEqual(["PL"]);

    // Та сама (застаріла) версія форми.
    expect(await act({ intent: "update", ...form, dutyPayer: "company" })).toMatchObject({ ok: false, error: "error.conflict", intent: "update" });
  });

  it("returns field errors for an invalid pattern and an example mismatch", async () => {
    const bad = await act({ intent: "update", ...(await formFor("AT", { postalCodePattern: "([0-9]" })) });
    expect(bad).toMatchObject({ ok: false, error: "error.validation", fieldErrors: { postalCodePattern: "countryRules.error.patternInvalid" } });
    const mismatch = await act({ intent: "update", ...(await formFor("AT", { postalCodeExample: "ABC" })) });
    expect(mismatch).toMatchObject({ ok: false, fieldErrors: { postalCodeExample: "countryRules.error.exampleMismatch" } });
    expect(await act({ intent: "update", ...(await formFor("AT")), expectedVersion: "x" })).toMatchObject({ ok: false, error: "error.generic" });
    expect(await act({ intent: "bogus" })).toMatchObject({ ok: false, error: "error.generic" });
  });

  it("resets to default and adds a country", async () => {
    const reset = await act({ intent: "reset", ...(await formFor("PL")) });
    expect(reset).toMatchObject({ ok: true, message: "countryRules.result.reset" });
    expect((await load("?country=PL")).selected).toMatchObject({ changed: false, dutyPayer: "unknown" });

    const added = await act({
      intent: "add",
      ...(await formFor("DK")),
      countryCode: "is",
      nameUk: "",
      nameEn: "",
    });
    expect(added).toMatchObject({ ok: true, message: "countryRules.result.added", countryCode: "IS" });
    expect((await load("?country=IS")).selected).toMatchObject({ hasDefault: false, changed: true, nameEn: "Iceland" });
    expect(await act({ intent: "add", ...(await formFor("DK")), countryCode: "IS" })).toMatchObject({
      ok: false,
      fieldErrors: { countryCode: "countryRules.error.codeExists" },
    });
    expect(await act({ intent: "reset", ...(await formFor("IS")) })).toMatchObject({ ok: false, error: "countryRules.error.noDefault" });
  });

  it("testPostal: owner tests an unsaved pattern; staff always uses the saved one", async () => {
    expect(await act({ intent: "testPostal", countryCode: "NL", sample: "1012ab" })).toMatchObject({
      intent: "testPostal",
      patternValid: true,
      normalized: "1012 AB",
      match: true,
    });
    expect(await act({ intent: "testPostal", countryCode: "NL", sample: "1012ab", pattern: "^\\d{5}$" })).toMatchObject({ match: false });
    expect(await act({ intent: "testPostal", countryCode: "NL", sample: "1", pattern: "(" })).toMatchObject({ patternValid: false });
    setContext(STAFF);
    expect(await act({ intent: "testPostal", countryCode: "NL", sample: "1012ab", pattern: "^\\d{5}$" })).toMatchObject({ match: true });
    expect(await act({ intent: "testPostal", countryCode: "QQ", sample: "1" })).toMatchObject({ ok: false, error: "error.notFound" });
  });

  it("does not revalidate loaders after a postal test", () => {
    const fd = new FormData();
    fd.set("intent", "testPostal");
    expect(page.shouldRevalidate({ formData: fd, defaultShouldRevalidate: true } as never)).toBe(false);
    fd.set("intent", "update");
    expect(page.shouldRevalidate({ formData: fd, defaultShouldRevalidate: true } as never)).toBe(true);
  });
});

describe("country rules page render", () => {
  it("owner: verify banner, edit form, postal tester, history and add form", async () => {
    const html = await render("/demo/country-rules?country=NL");
    expect(html).toContain(esc(uk("countryRules.verify.title")));
    expect(html).toContain(esc(uk("countryRules.verify.rule")));
    expect(html).toContain('name="postalCodePattern"');
    expect(html).toContain('value="update"');
    expect(html).toContain(esc(uk("countryRules.test.title")));
    expect(html).toContain(esc(uk("countryRules.history.empty")));
    expect(html).toContain(esc(uk("countryRules.add.title")));
    expect(html).toContain(esc(uk("countryRules.reset.isDefault")));
  });

  it("owner marks a rule verified from the page: badge and banner disappear, history shows it", async () => {
    setContext(OWNER);
    let html = await render("/demo/country-rules?country=LT");
    expect(html).toContain('value="verify"');
    // Службову англійську позначку не показуємо (дані гідратації в <script> — не видимий текст).
    expect(html.replace(/<script[\s\S]*?<\/script>/g, "")).not.toContain("verify before production");
    // Збереження форми (примітки без позначки + keepVerifyMarker) позначку не знімає.
    const form = await formFor("LT", { notes: "Official format is LT-12345." });
    expect(await act({ intent: "update", ...form, keepVerifyMarker: "1" })).toMatchObject({ ok: true });
    const saved = await getCountryRule(env.handle.db, "LT");
    expect(saved?.notes).toBe("Default rule — verify before production. Official format is LT-12345.");
    const { expectedVersion } = await formFor("LT", {});
    expect(await act({ intent: "verify", countryCode: "LT", expectedVersion: expectedVersion ?? "" })).toMatchObject({
      ok: true,
      message: "countryRules.result.verified",
    });
    html = await render("/demo/country-rules?country=LT");
    expect(html).not.toContain(esc(uk("countryRules.verify.rule")));
    expect(html).not.toContain('value="verify"');
    expect(html).toContain(esc(uk("countryRules.history.source.verify")));
    // Працівник не може позначати.
    setContext(STAFF);
    expect(await act({ intent: "verify", countryCode: "LV", expectedVersion: "1" })).toMatchObject({ ok: false, error: "error.forbidden" });
    setContext(OWNER);
  });

  it("owner sees reset for a changed rule and the change in history (production)", async () => {
    setContext(OWNER, "production");
    expect(await act({ intent: "update", ...(await formFor("BE", { notes: "Checked" })) })).toMatchObject({ ok: true });
    const html = await render("/app/country-rules?country=BE");
    expect(html).toContain(esc(uk("countryRules.reset.button")));
    expect(html).toContain(esc(uk("countryRules.history.source.update")));
    expect(html).not.toContain(esc(uk("countryRules.verify.rule")));
  });

  it("staff: read-only (no edit/add/reset forms), tester still available", async () => {
    setContext(STAFF);
    const html = await render("/demo/country-rules?country=BE");
    expect(html).toContain(esc(uk("countryRules.info.readOnly")));
    expect(html).not.toContain('value="update"');
    expect(html).not.toContain('value="add"');
    expect(html).not.toContain('value="reset"');
    expect(html).not.toContain(esc(uk("countryRules.add.title")));
    expect(html).toContain('value="testPostal"');
    expect(html).toContain(esc(uk("countryRules.field.postalCodePattern")));
  });
});
