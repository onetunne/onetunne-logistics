/**
 * Дані оболонки (server/shell.server.ts buildShellData) — пункт меню «Аналітика» (S5-NAV, паритет із вбудованим
 * меню Shopify Admin; етап 6 — finance.view + fallbackToRelated, docs/stage6-design.md §14.3 п. 1). routes/app-layout.tsx
 * будує NavMenu з shell.nav (пункти без planned), тож пункт веде туди, куди його вже спрямували дані оболонки (navLink):
 * власник — аналітика бізнесу, працівник із warehouse.view — аналітика складу, без обох — пункту немає.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SECTIONS, navLink, sectionVisible } from "~/domain/navigation";
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
    it(`${basePath}: «Аналітика» — business analytics for the owner, warehouse analytics for staff with warehouse.view`, async () => {
      const owner = await shellNav(OWNER, basePath);
      expect(owner.find((n) => n.key === "analytics")).toMatchObject({ href: `${basePath}/analytics`, planned: false });
      expect(owner.find((n) => n.key === "finance")).toMatchObject({ href: `${basePath}/finance`, planned: false });
      const staff = await shellNav(STAFF, basePath);
      expect(staff.find((n) => n.key === "analytics")).toMatchObject({ href: `${basePath}/warehouse/analytics`, planned: false });
      expect(staff.find((n) => n.key === "finance")).toBeUndefined();
      // Вбудоване меню (app-layout.tsx): пункти shell.nav без planned.
      expect(staff.filter((n) => !n.planned).map((n) => n.href)).toContain(`${basePath}/warehouse/analytics`);
      expect(staff.filter((n) => !n.planned).map((n) => n.href)).not.toContain(`${basePath}/analytics`);
    });

    it(`${basePath}: without warehouse.view (and finance.view) there is no «Аналітика» entry`, async () => {
      const nav = await shellNav(NO_WAREHOUSE, basePath);
      expect(nav.find((n) => n.key === "analytics")).toBeUndefined();
      expect(nav.map((n) => n.href)).not.toContain(`${basePath}/warehouse/analytics`);
    });

    it(`${basePath}: every other entry is unchanged (href = section path, planned = not implemented)`, async () => {
      for (const actor of [OWNER, STAFF]) {
        const nav = await shellNav(actor, basePath);
        for (const s of SECTIONS.filter((x) => x.key !== "analytics" && sectionVisible(x, (p) => can(actor, p)))) {
          const entry = nav.find((n) => n.key === s.key);
          expect(entry, s.key).toMatchObject(navLink(basePath, s, (p) => can(actor, p)));
          expect(entry?.planned, s.key).toBe(!s.implemented);
        }
      }
    });
  }
});
