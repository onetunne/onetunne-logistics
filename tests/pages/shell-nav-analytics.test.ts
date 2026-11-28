/**
 * Головне меню: «Аналітика» (S5-NAV; етап 6 — docs/stage6-design.md §14.3 п. 1, §18.1). Розділ реалізовано з дозволом
 * finance.view і fallbackToRelated: власник переходить на аналітику бізнесу (/analytics); працівник із warehouse.view —
 * на «Склад» → «Аналітика» (як в етапі 5, звичайний пункт); без обох дозволів пункту немає. «Повернення» (етап 6) —
 * реалізований розділ з orders.view.
 */
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { StaticRouterProvider, createStaticHandler, createStaticRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { LayoutBody } from "~/components/layout";
import type { ShellData } from "~/components/shell-types";
import { SECTIONS, navLink, navTarget, sectionByPath, sectionHref, sectionVisible } from "~/domain/navigation";
import { can, makeActor, type Actor } from "~/domain/permissions";
import { DICTIONARIES } from "~/i18n";
import { OWNER, STAFF } from "../helpers";

const NO_WAREHOUSE = makeActor({ id: "no-wh", displayName: "No warehouse", role: "staff", overrides: { revoke: ["warehouse.view"] } });
const uk = (key: string) => DICTIONARIES.uk[key]!;

/**
 * Дані макета — як buildShellData (server/shell.server.ts): розділи за дозволами, «planned» — не реалізовані.
 * withNavLink — як buildShellData після передачі (handoff): пункт обчислено navLink (так його бачить і меню Shopify Admin).
 */
function shellFor(actor: Actor, opts: { withNavLink?: boolean; basePath?: "/demo" | "/app" } = {}): ShellData {
  const basePath = opts.basePath ?? "/demo";
  return {
    mode: basePath === "/app" ? "production" : "demo",
    basePath,
    actor: { id: actor.id, displayName: actor.displayName, role: actor.role, permissions: [...actor.permissions] },
    nav: SECTIONS.filter((s) => sectionVisible(s, (p) => can(actor, p))).map((s) => ({
      key: s.key,
      ...(opts.withNavLink ? navLink(basePath, s, (p) => can(actor, p)) : { href: sectionHref(basePath, s), planned: !s.implemented }),
      stage: s.stage,
      badge: null,
    })),
    automation: { mode: "semi", globalPause: false },
    openProblems: 0,
    demo: null,
  };
}

async function renderNav(actor: Actor, path: string, opts: { withNavLink?: boolean } = {}): Promise<{ main: string; planned: string }> {
  const routes = [
    {
      id: "root",
      path: "/",
      loader: () => ({ locale: "uk" }),
      children: [
        {
          id: "routes/demo-layout",
          path: "demo",
          loader: () => shellFor(actor, opts),
          Component: () => h(LayoutBody, { embedded: false }),
          children: [{ path: "*", Component: () => null }],
        },
      ],
    },
  ];
  const handler = createStaticHandler(routes as never);
  const context = await handler.query(new Request(`http://localhost${path}`));
  if (context instanceof Response) throw new Error(`unexpected response ${context.status}`);
  expect(context.errors).toBeNull();
  const html = renderToString(h(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context }));
  const nav = /<nav class="ot-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? "";
  const [main = "", planned = ""] = nav.split('id="ot-shell-nav-planned"');
  return { main, planned };
}

/** Посилання меню з ключем-написом: [href, aria-current?]. */
function link(part: string, label: string): { href: string; current: boolean } | null {
  for (const m of part.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
    if (!m[2]!.includes(`<span class="ot-nav__label">${label}</span>`)) continue;
    return { href: /href="([^"]+)"/.exec(m[1]!)?.[1] ?? "", current: m[1]!.includes('aria-current="page"') };
  }
  return null;
}

describe("navTarget", () => {
  it("only «Аналітика» falls back to its related part: owner → business analytics, staff with warehouse.view → warehouse analytics", () => {
    const analytics = sectionByPath("analytics")!;
    expect(analytics).toMatchObject({
      implemented: true,
      permission: "finance.view",
      fallbackToRelated: true,
      related: { path: "warehouse/analytics", permission: "warehouse.view" },
    });
    expect(navTarget(analytics, (p) => can(OWNER, p))).toEqual({ path: "analytics", planned: false });
    expect(navTarget(analytics, (p) => can(STAFF, p))).toEqual({ path: "warehouse/analytics", planned: false });
    // Без finance.view і warehouse.view пункту немає взагалі (sectionVisible).
    expect(sectionVisible(analytics, (p) => can(NO_WAREHOUSE, p))).toBe(false);
    expect(sectionVisible(analytics, (p) => can(STAFF, p))).toBe(true);
    for (const s of SECTIONS.filter((x) => x.key !== "analytics")) {
      expect(navTarget(s, () => true), s.key).toEqual({ path: s.path, planned: !s.implemented });
    }
    expect(SECTIONS).toHaveLength(18);
  });

  it("navLink: the same rule with basePath for the shell data (Shopify Admin menu) and the layout", () => {
    const analytics = sectionByPath("analytics")!;
    for (const base of ["/demo", "/app"] as const) {
      expect(navLink(base, analytics, (p) => can(OWNER, p))).toEqual({ href: `${base}/analytics`, planned: false });
      expect(navLink(base, analytics, (p) => can(STAFF, p))).toEqual({ href: `${base}/warehouse/analytics`, planned: false });
      for (const s of SECTIONS.filter((x) => x.key !== "analytics")) {
        expect(navLink(base, s, () => true), s.key).toEqual({ href: sectionHref(base, s), planned: !s.implemented });
      }
    }
    // Вбудоване меню (routes/app-layout.tsx) показує пункти shell.nav без planned.
    const embeddedMenu = (actor: Actor) =>
      shellFor(actor, { withNavLink: true, basePath: "/app" })
        .nav.filter((n) => n.key !== "dashboard" && !n.planned)
        .map((n) => n.href);
    expect(embeddedMenu(OWNER)).toContain("/app/analytics");
    expect(embeddedMenu(OWNER)).toContain("/app/finance");
    expect(embeddedMenu(OWNER)).toContain("/app/returns");
    expect(embeddedMenu(STAFF)).toContain("/app/warehouse/analytics");
    expect(embeddedMenu(STAFF)).not.toContain("/app/analytics");
    expect(embeddedMenu(STAFF)).not.toContain("/app/finance");
    expect(embeddedMenu(STAFF)).toContain("/app/returns");
    expect(embeddedMenu(NO_WAREHOUSE)).not.toContain("/app/warehouse/analytics");
    expect(embeddedMenu(NO_WAREHOUSE)).not.toContain("/app/analytics");
  });
});

describe("main menu «Аналітика» (S5-NAV, stage 6)", () => {
  it("owner: a regular item that opens business analytics; staff with warehouse.view: Warehouse → Analytics", async () => {
    const owner = await renderNav(OWNER, "/demo");
    expect(link(owner.main, uk("nav.analytics"))).toEqual({ href: "/demo/analytics", current: false });
    const staff = await renderNav(STAFF, "/demo");
    expect(link(staff.main, uk("nav.analytics"))).toEqual({ href: "/demo/warehouse/analytics", current: false });
    for (const { main, planned } of [owner, staff]) {
      expect(link(planned, uk("nav.analytics"))).toBeNull();
      // «Повернення» (етап 6) — реалізований розділ (orders.view), серед основних пунктів.
      expect(link(main, uk("nav.returns"))?.href).toBe("/demo/returns");
      expect(link(planned, uk("nav.returns"))).toBeNull();
    }
    expect(link(owner.main, uk("nav.finance"))?.href).toBe("/demo/finance");
    expect(link(staff.main, uk("nav.finance"))).toBeNull();
    expect(link(staff.planned, uk("nav.finance"))).toBeNull();
  });

  it("is the current item on its page; «Склад» stays current on other warehouse pages", async () => {
    const onBusiness = await renderNav(OWNER, "/demo/analytics");
    expect(link(onBusiness.main, uk("nav.analytics"))?.current).toBe(true);
    const onAnalytics = await renderNav(STAFF, "/demo/warehouse/analytics");
    expect(link(onAnalytics.main, uk("nav.analytics"))?.current).toBe(true);
    expect(link(onAnalytics.main, uk("nav.warehouse"))?.current).toBe(false);
    const onStock = await renderNav(STAFF, "/demo/warehouse/movements");
    expect(link(onStock.main, uk("nav.warehouse"))?.current).toBe(true);
    expect(link(onStock.main, uk("nav.analytics"))?.current).toBe(false);
  });

  it("shell data already computed with navLink renders the same menu (nothing is applied twice)", async () => {
    for (const actor of [OWNER, STAFF, NO_WAREHOUSE]) {
      for (const path of ["/demo", "/demo/warehouse/analytics"]) {
        expect(await renderNav(actor, path, { withNavLink: true }), `${actor.id} ${path}`).toEqual(await renderNav(actor, path));
      }
    }
  });

  it("without warehouse.view (and without finance.view): no «Аналітика» item at all", async () => {
    const { main, planned } = await renderNav(NO_WAREHOUSE, "/demo");
    expect(link(main, uk("nav.analytics"))).toBeNull();
    expect(link(planned, uk("nav.analytics"))).toBeNull();
  });
});
