import { eq } from "drizzle-orm";
import { redirect } from "react-router";
import { staffMembers } from "~/db/schema";
import { makeActor, type Actor } from "~/domain/permissions";
import { PendingShopifyGateway, DemoShopifyGateway } from "~/integrations/shopify/types";
import { getEnv } from "~/lib/env.server";
import { demoAccessCookie, demoAccessToken, demoRoleCookie, isRole, readPreferences } from "./cookies.server";
import { getDemoRuntime } from "./demo-runtime.server";
import { getProductionRuntime } from "./production-runtime.server";
import type { RequestContext } from "./types";

export const DEMO_ACTORS = {
  owner: () => makeActor({ id: "demo-owner", displayName: "Demo Owner", role: "owner" }),
  staff: () => makeActor({ id: "demo-staff", displayName: "Demo Staff", role: "staff" }),
};

export function modeFromPath(pathname: string): "demo" | "production" | null {
  if (pathname === "/demo" || pathname.startsWith("/demo/")) return "demo";
  if (pathname === "/app" || pathname.startsWith("/app/")) return "production";
  return null;
}

export async function isDemoAuthorized(request: Request): Promise<boolean> {
  const env = getEnv();
  if (!env.DEMO_PASSWORD) return true;
  const value = await demoAccessCookie().parse(request.headers.get("Cookie"));
  return typeof value === "string" && value === demoAccessToken();
}

/**
 * Єдина точка отримання контексту запиту.
 * - /demo/* — лише якщо DEMO_MODE=true; окрема база PGlite; роль обирається в демо.
 * - /app/*  — ЗАВЖДИ через Shopify authenticate.admin (демо-режим не може це обійти).
 */
export async function getRequestContext(request: Request): Promise<RequestContext> {
  const url = new URL(request.url);
  const mode = modeFromPath(url.pathname);
  const { locale } = await readPreferences(request);
  const env = getEnv();

  if (mode === "demo") {
    if (!env.DEMO_MODE) throw new Response("Not Found", { status: 404 });
    if (!(await isDemoAuthorized(request))) {
      throw redirect(`/demo/login?next=${encodeURIComponent(url.pathname + url.search)}`);
    }
    const role = await demoRoleCookie.parse(request.headers.get("Cookie"));
    const actor = DEMO_ACTORS[isRole(role) ? role : "owner"]();
    const runtime = await getDemoRuntime();
    return {
      mode: "demo",
      basePath: "/demo",
      locale,
      db: runtime.handle.db,
      actor,
      carriers: runtime.carriers,
      shopify: new DemoShopifyGateway(),
      now: () => new Date(),
    };
  }

  if (mode === "production") {
    if (!env.shopifyConfigured) {
      throw new Response("Shopify app is not configured on this server", { status: 503 });
    }
    const { getShopify } = await import("~/shopify.server");
    const shopify = await getShopify();
    const { sessionToken } = await shopify.authenticate.admin(request);
    const runtime = await getProductionRuntime();
    const actor = await resolveShopifyActor(runtime.handle.db, String(sessionToken?.sub ?? ""), env.ownerShopifyUserIds);
    return {
      mode: "production",
      basePath: "/app",
      locale,
      db: runtime.handle.db,
      actor,
      carriers: runtime.carriers,
      shopify: new PendingShopifyGateway(),
      now: () => new Date(),
    };
  }

  throw new Response("Not Found", { status: 404 });
}

/**
 * Роль користувача Shopify Admin: власник — лише якщо його ID у OWNER_SHOPIFY_USER_IDS
 * або в таблиці працівників з роллю owner. Невідомі користувачі отримують мінімальні права (staff).
 */
export async function resolveShopifyActor(
  db: RequestContext["db"],
  userId: string,
  ownerIds: ReadonlySet<string>,
): Promise<Actor> {
  const id = userId || "unknown";
  if (ownerIds.has(id)) return makeActor({ id: `shopify:${id}`, displayName: "Owner", role: "owner" });
  if (userId) {
    const [member] = await db.select().from(staffMembers).where(eq(staffMembers.shopifyUserId, userId));
    if (member?.active) {
      return makeActor({
        id: `shopify:${id}`,
        displayName: member.displayName,
        role: member.role,
        overrides: member.permissionOverrides,
      });
    }
  }
  return makeActor({ id: `shopify:${id}`, displayName: "Staff", role: "staff" });
}
