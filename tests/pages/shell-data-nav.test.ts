/**
 * Дані оболонки (server/shell.server.ts buildShellData) — пункт меню «Аналітика» (S5-NAV, паритет із вбудованим
 * меню Shopify Admin). routes/app-layout.tsx будує NavMenu з shell.nav (пункти без planned), тож «Аналітика» з'являється
 * там лише якщо дані оболонки вже ведуть на аналітику складу (navLink), а не лише макет (layout.tsx) перераховує її.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SECTIONS, navLink } from "~/domain/navigation";
import { can, makeActor, type Actor } from "~/domain/permissions";
import { buildShellData } from "~/server/shell.server";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";

const NO_WAREHOUSE = makeActor({ id: "no-wh", displayName: "No warehouse", role: "staff", overrides: { revoke: ["warehouse.view"] } });

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv({ seed: false });
});
afterAll(async () => {
  await env.close();
});

async function shellNav(actor: Actor, basePath: "/demo" | "/app") {
  const data = await buildShellData({ ...env.ctx(actor), mode: basePath === "/app" ? "production" : "demo", basePath, locale: "uk" });
  return data.nav;
}

describe("buildShellData: menu entries use navLink (one rule with layout.tsx)", () => {
  for (const basePath of ["/demo", "/app"] as const) {
    it(`${basePath}: «Аналітика» leads to warehouse analytics for warehouse.view, as a regular (not planned) item`, async () => {
      for (const actor of [OWNER, STAFF]) {
        const nav = await shellNav(actor, basePath);
        const analytics = nav.find((n) => n.key === "analytics");
        expect(analytics, actor.role).toMatchObject({ href: `${basePath}/warehouse/analytics`, planned: false });
        // Вбудоване меню (app-layout.tsx): пункти shell.nav без planned.
        expect(nav.filter((n) => !n.planned).map((n) => n.href), actor.role).toContain(`${basePath}/warehouse/analytics`);
      }
    });

    it(`${basePath}: without warehouse.view «Аналітика» stays a planned item (hidden from the embedded menu)`, async () => {
      const nav = await shellNav(NO_WAREHOUSE, basePath);
      expect(nav.find((n) => n.key === "analytics")).toMatchObject({ href: `${basePath}/analytics`, planned: true });
      expect(nav.filter((n) => !n.planned).map((n) => n.href)).not.toContain(`${basePath}/warehouse/analytics`);
    });

    it(`${basePath}: every other entry is unchanged (href = section path, planned = not implemented)`, async () => {
      const nav = await shellNav(OWNER, basePath);
      for (const s of SECTIONS.filter((x) => x.key !== "analytics" && (!x.permission || can(OWNER, x.permission)))) {
        const entry = nav.find((n) => n.key === s.key);
        expect(entry, s.key).toMatchObject(navLink(basePath, s, (p) => can(OWNER, p)));
        expect(entry?.planned, s.key).toBe(!s.implemented);
      }
    });
  }
});
