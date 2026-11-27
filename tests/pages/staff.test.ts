import { eq } from "drizzle-orm";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { Outlet, StaticRouterProvider, createStaticHandler, createStaticRouter } from "react-router";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellData } from "~/components/shell-types";
import { auditLog, staffMembers } from "~/db/schema";
import {
  DELEGABLE_PERMISSIONS,
  OWNER_ONLY_PERMISSIONS,
  STAFF_DEFAULT_PERMISSIONS,
  resolvePermissions,
  staffOverridesFromSelection,
  type Actor,
} from "~/domain/permissions";
import { DICTIONARIES } from "~/i18n";
import type { RequestContext } from "~/server/types";
import { resolveShopifyActor } from "~/server/context.server";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";

/**
 * «Працівники» (gap-1): власник надає/знімає окремі права працівнику (staff_members.permission_overrides), напр.
 * warehouse.adjust для інвентаризації чи production.manage — без ролі «Власник». Права лише власника
 * (OWNER_ONLY_PERMISSIONS) надати не можна — перевіряє сервер. Контекст запиту підмінено; база — PGlite.
 */
const m = vi.hoisted(() => ({ ctx: null as RequestContext | null }));
vi.mock("~/server/context.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/server/context.server")>();
  return {
    ...actual,
    getRequestContext: async () => {
      if (!m.ctx) throw new Error("test context is not set");
      return m.ctx;
    },
  };
});

let env: TestEnv;
let page: typeof import("~/pages/staff");
let memberId: string;
const WORKER_ID = "880001";

beforeAll(async () => {
  env = await createTestEnv();
  page = await import("~/pages/staff");
  const [row] = await env.handle.db
    .insert(staffMembers)
    .values({ shopifyUserId: WORKER_ID, displayName: "Test Worker", role: "staff" })
    .returning({ id: staffMembers.id });
  memberId = row!.id;
});
afterAll(async () => {
  await env.close();
});

function setContext(actor: Actor = OWNER) {
  m.ctx = { ...env.ctx(actor), basePath: "/demo", locale: "uk" };
}
beforeEach(() => setContext());

const BASE = "http://localhost/demo/staff";
const load = () => page.loader({ request: new Request(BASE), params: {}, context: {} } as never);
function act(fields: Record<string, string>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  return page.action({ request: new Request(BASE, { method: "POST", body }), params: {}, context: {} } as never);
}
const perms = (list: readonly string[]) => Object.fromEntries(list.map((p) => [`perm.${p}`, "on"]));
const memberRow = async () => (await env.handle.db.select().from(staffMembers).where(eq(staffMembers.id, memberId)))[0]!;
const base = () => ({ memberId, role: "staff", active: "on", displayName: "Test Worker", permissionsForm: "1" });

describe("staff permission overrides (pure)", () => {
  it("owner-only permissions are never delegable; selection → minimal grant/revoke", () => {
    for (const p of OWNER_ONLY_PERMISSIONS) expect(DELEGABLE_PERMISSIONS).not.toContain(p);
    expect(DELEGABLE_PERMISSIONS).toContain("warehouse.adjust");
    expect(DELEGABLE_PERMISSIONS).toContain("production.manage");
    expect(staffOverridesFromSelection([...STAFF_DEFAULT_PERMISSIONS])).toEqual({ ok: true, overrides: { grant: [], revoke: [] } });
    const r = staffOverridesFromSelection([...STAFF_DEFAULT_PERMISSIONS.filter((p) => p !== "orders.bulk"), "warehouse.adjust"]);
    expect(r).toEqual({ ok: true, overrides: { grant: ["warehouse.adjust"], revoke: ["orders.bulk"] } });
    expect(staffOverridesFromSelection(["finance.view", "orders.view"])).toEqual({ ok: false, rejected: ["finance.view"] });
    expect(staffOverridesFromSelection(["nope"])).toMatchObject({ ok: false });
  });
});

describe("staff page", () => {
  it("lists members with their effective delegable permissions (owner only)", async () => {
    const data = await load();
    expect(data.manage).toBe(true);
    const member = data.members.find((x) => x.id === memberId)!;
    expect(member.permissions).toEqual(DELEGABLE_PERMISSIONS.filter((p) => STAFF_DEFAULT_PERMISSIONS.includes(p)));
    expect(member.customized).toBe(0);
    expect(data.delegable).not.toContain("finance.view");
    setContext(STAFF);
    expect((await load()).members).toEqual([]);
  });

  it("owner grants warehouse.adjust and production.manage, revokes orders.bulk; the worker's actor follows", async () => {
    const selected = [...STAFF_DEFAULT_PERMISSIONS.filter((p) => p !== "orders.bulk"), "warehouse.adjust", "production.manage"];
    expect(await act({ ...base(), ...perms(selected) })).toMatchObject({ ok: true, message: "staff.saved" });
    const row = await memberRow();
    expect(row.permissionOverrides).toEqual({ grant: ["warehouse.adjust", "production.manage"], revoke: ["orders.bulk"] });
    expect(row.role).toBe("staff");
    const actor = await resolveShopifyActor(env.handle.db, WORKER_ID, new Set());
    expect(actor.role).toBe("staff");
    expect(actor.permissions.has("warehouse.adjust")).toBe(true);
    expect(actor.permissions.has("production.manage")).toBe(true);
    expect(actor.permissions.has("orders.bulk")).toBe(false);
    expect(actor.permissions.has("finance.view")).toBe(false);
    const member = (await load()).members.find((x) => x.id === memberId)!;
    expect(member.customized).toBe(3);
    expect(member.permissions).toContain("warehouse.adjust");
    const [audit] = await env.handle.db.select().from(auditLog).where(eq(auditLog.action, "staff.updated"));
    expect(audit!.details).toMatchObject({ role: "staff", grant: ["warehouse.adjust", "production.manage"], revoke: ["orders.bulk"] });
  });

  it("owner-only permissions cannot be granted, even with a forged form; nothing is saved", async () => {
    const before = await memberRow();
    for (const p of OWNER_ONLY_PERMISSIONS) {
      expect(await act({ ...base(), ...perms([...STAFF_DEFAULT_PERMISSIONS, p]) })).toMatchObject({ ok: false, error: "staff.error.ownerOnlyPermission" });
    }
    expect((await memberRow()).permissionOverrides).toEqual(before.permissionOverrides);
    const actor = await resolveShopifyActor(env.handle.db, WORKER_ID, new Set());
    for (const p of OWNER_ONLY_PERMISSIONS) expect(actor.permissions.has(p)).toBe(false);
  });

  it("staff cannot change permissions; a form without the permissions block keeps them; owner role clears them", async () => {
    const before = (await memberRow()).permissionOverrides;
    setContext(STAFF);
    expect(await act({ ...base(), ...perms(DELEGABLE_PERMISSIONS) })).toEqual({ ok: false, error: "error.forbidden" });
    setContext(OWNER);
    const { permissionsForm: _omit, ...withoutBlock } = base();
    expect(await act(withoutBlock)).toMatchObject({ ok: true });
    expect((await memberRow()).permissionOverrides).toEqual(before);
    // Порожній вибір = зняти всі права (типові теж).
    expect(await act(base())).toMatchObject({ ok: true });
    expect([...resolvePermissions("staff", (await memberRow()).permissionOverrides)]).toEqual([]);
    expect(await act({ ...base(), role: "owner" })).toMatchObject({ ok: true });
    expect((await memberRow()).permissionOverrides).toEqual({});
    await act({ ...base(), role: "staff", ...perms(STAFF_DEFAULT_PERMISSIONS) });
    expect((await memberRow()).permissionOverrides).toEqual({ grant: [], revoke: [] });
  });

  it("renders the permission checkboxes with labels (uk), without owner-only checkboxes", async () => {
    const actor = OWNER;
    const shell: ShellData = {
      mode: "demo",
      basePath: "/demo",
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
            id: "routes/demo-layout",
            path: "demo",
            loader: () => shell,
            Component: Outlet,
            children: [{ id: "page", path: "staff", loader: page.loader, action: page.action, Component: page.default }],
          },
        ],
      },
    ];
    const handler = createStaticHandler(routes as never);
    const context = await handler.query(new Request(BASE));
    if (context instanceof Response) throw new Error("unexpected response");
    const html = renderToString(h(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context }));
    expect(html).toContain(`name="perm.warehouse.adjust"`);
    expect(html).toContain(`name="permissionsForm"`);
    expect(html).not.toContain(`name="perm.finance.view"`);
    expect(html).toContain(DICTIONARIES.uk["staff.permissions.title"]!);
    expect(html).toContain(DICTIONARIES.uk["permission.warehouse.adjust"]!);
  });

  it("every permission has uk/en labels", () => {
    const missing = DELEGABLE_PERMISSIONS.concat(OWNER_ONLY_PERMISSIONS).flatMap((p) =>
      (["uk", "en"] as const).filter((l) => !(`permission.${p}` in DICTIONARIES[l])).map((l) => `${l}:${p}`),
    );
    expect(missing).toEqual([]);
  });
});

