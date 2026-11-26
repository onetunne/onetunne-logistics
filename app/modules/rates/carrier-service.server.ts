/**
 * Реєстрація CarrierService у Shopify (тарифи доставки в Checkout) і захист callback-адреси.
 *
 * Shopify НЕ підписує запити до callbackUrl (жодних HMAC/заголовків у документації CarrierService — НЕ ЗАДОКУМЕНТОВАНО),
 * тому адреса містить секретний токен: HMAC-SHA256(SHOPIFY_API_SECRET, "carrier-service:v1:" + shop), base64url, 32 символи
 * (192 біти). Токен не логується й не повертається в UI. Після зміни SHOPIFY_API_SECRET токен змінюється —
 * потрібно повторно зареєструвати сервіс (кнопка «Підключити» оновить адресу).
 *
 * Доступ: `write_shipping` (мутації), `read_shipping` (запит; входить у write_shipping).
 * Вимога тарифного плану магазину (Advanced або вище / Shopify з річною оплатою / dev-магазин не на Basic) —
 * інакше створення завершується userError CARRIER_SERVICE_CREATE_FAILED (текст помилки не задокументований).
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { requirePermission } from "~/domain/permissions";
import { adminClientFor, type AdminGraphql } from "~/integrations/shopify/admin-client.server";
import {
  CARRIER_SERVICE_CREATE_MUTATION,
  CARRIER_SERVICE_DELETE_MUTATION,
  CARRIER_SERVICE_UPDATE_MUTATION,
  CARRIER_SERVICES_QUERY,
  type CarrierServiceCreateData,
  type CarrierServiceCreateInput,
  type CarrierServiceDeleteData,
  type CarrierServicesQueryData,
  type CarrierServiceUpdateData,
  type CarrierServiceUpdateInput,
  type GqlCarrierService,
  type GqlCarrierServiceUserError,
} from "~/integrations/shopify/carrier-service-graphql";
import { getEnv } from "~/lib/env.server";
import { DomainError } from "~/lib/errors";
import { writeAudit } from "~/modules/audit/audit.server";
import { currentShop } from "~/modules/shopify-sync/sync.server";
import type { ServiceContext } from "~/server/types";

export const DEFAULT_CARRIER_SERVICE_NAME = "ONE TUNNE Logistics";
export const CARRIER_SERVICE_SCOPE = "write_shipping";
/** Шлях маршруту app/routes/carrier-service.tsx (routes.ts: "carrier-service/:token"). */
export const CARRIER_SERVICE_PATH = "/carrier-service/";

const TOKEN_LENGTH = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

// ---------------------------------------------------------------------------
// Токен callback-адреси
// ---------------------------------------------------------------------------

export function carrierServiceToken(secret: string, shop: string): string {
  if (!secret) throw new Error("carrier service secret is not configured");
  return createHmac("sha256", secret)
    .update(`carrier-service:v1:${shop.trim().toLowerCase()}`)
    .digest("base64url")
    .slice(0, TOKEN_LENGTH);
}

export function isCarrierServiceTokenFormat(token: string): boolean {
  return TOKEN_RE.test(token);
}

/** Порівняння за сталий час (хеші однакової довжини незалежно від введення). */
export function verifyCarrierServiceToken(secret: string, shop: string, token: string): boolean {
  if (!secret || !isCarrierServiceTokenFormat(token)) return false;
  const expected = createHash("sha256").update(carrierServiceToken(secret, shop)).digest();
  const actual = createHash("sha256").update(token).digest();
  return timingSafeEqual(expected, actual);
}

/** Публічна адреса callback. Лише https (токен у шляху не має передаватися відкрито). */
export function carrierServiceCallbackUrl(appUrl: string, token: string): string {
  let base: URL;
  try {
    base = new URL(appUrl);
  } catch {
    throw new DomainError("carrierService.invalidAppUrl", 400);
  }
  if (base.protocol !== "https:") throw new DomainError("carrierService.httpsRequired", 400);
  const prefix = base.pathname.replace(/\/+$/, "");
  return `${base.origin}${prefix}${CARRIER_SERVICE_PATH}${encodeURIComponent(token)}`;
}

export function hasScope(scopes: string | null | undefined, scope: string): boolean {
  return (scopes ?? "")
    .split(",")
    .map((s) => s.trim())
    .includes(scope);
}

// ---------------------------------------------------------------------------
// Помилки
// ---------------------------------------------------------------------------

/** userErrors Shopify → DomainError із текстом Shopify (без токена/адреси callback). */
export class CarrierServiceError extends DomainError {
  constructor(
    readonly operation: "create" | "update" | "delete",
    readonly shopifyCode: string | null,
    message: string,
  ) {
    super("carrierService.shopifyError", 502, { operation, message, code: shopifyCode ?? "" });
    this.name = "CarrierServiceError";
  }
}

function sanitizeMessage(message: string, secrets: string[]): string {
  let out = message;
  for (const s of secrets) if (s) out = out.split(s).join("[hidden]");
  return out.replace(/\/carrier-service\/[A-Za-z0-9_%-]+/g, "/carrier-service/[hidden]").slice(0, 300);
}

function throwUserErrors(operation: CarrierServiceError["operation"], errors: GqlCarrierServiceUserError[], secrets: string[]): void {
  if (!errors.length) return;
  const message = sanitizeMessage(errors.map((e) => e.message).join("; "), secrets);
  throw new CarrierServiceError(operation, errors[0]?.code ?? null, message);
}

// ---------------------------------------------------------------------------
// Операції через Admin GraphQL
// ---------------------------------------------------------------------------

const normalizeUrl = (url: string): string => {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
};

const pathOf = (url: string | null): string | null => {
  if (!url) return null;
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
};

export async function listCarrierServices(admin: AdminGraphql): Promise<GqlCarrierService[]> {
  const data = await admin<CarrierServicesQueryData>(CARRIER_SERVICES_QUERY);
  return data.carrierServices?.nodes ?? [];
}

export type CarrierServiceMatch = "exact" | "token" | "name";

/**
 * Наш сервіс: 1) точний збіг callbackUrl; 2) той самий шлях із токеном на іншому хості (змінилася адреса застосунку);
 * 3) (якщо передано name) та сама назва і шлях нашого маршруту (змінився секрет). Інші сервіси магазину не чіпаємо.
 */
export async function findOurCarrierService(
  admin: AdminGraphql,
  callbackUrl: string,
  name?: string,
): Promise<{ service: GqlCarrierService; match: CarrierServiceMatch } | null> {
  const services = await listCarrierServices(admin);
  const target = normalizeUrl(callbackUrl);
  const exact = services.find((s) => s.callbackUrl !== null && normalizeUrl(s.callbackUrl) === target);
  if (exact) return { service: exact, match: "exact" };
  const tokenPath = pathOf(callbackUrl);
  const byToken = tokenPath ? services.find((s) => pathOf(s.callbackUrl) === tokenPath) : undefined;
  if (byToken) return { service: byToken, match: "token" };
  if (name) {
    const byName = services.find((s) => s.name === name && (pathOf(s.callbackUrl) ?? "").includes(CARRIER_SERVICE_PATH));
    if (byName) return { service: byName, match: "name" };
  }
  return null;
}

export interface CarrierServiceParams {
  appUrl: string;
  shop: string;
  secret: string;
  name?: string;
}

export interface RegisterCarrierServiceResult {
  id: string;
  result: "created" | "updated" | "unchanged";
  active: boolean;
}

/** Створює сервіс (active, supportsServiceDiscovery) або оновлює наявний (адреса, назва, active). */
export async function registerCarrierService(admin: AdminGraphql, params: CarrierServiceParams): Promise<RegisterCarrierServiceResult> {
  const name = params.name?.trim() || DEFAULT_CARRIER_SERVICE_NAME;
  const token = carrierServiceToken(params.secret, params.shop);
  const callbackUrl = carrierServiceCallbackUrl(params.appUrl, token);
  const secrets = [callbackUrl, token];
  const found = await findOurCarrierService(admin, callbackUrl, name);

  if (!found) {
    const input: CarrierServiceCreateInput = { name, callbackUrl, active: true, supportsServiceDiscovery: true };
    const data = await admin<CarrierServiceCreateData>(CARRIER_SERVICE_CREATE_MUTATION, { input });
    throwUserErrors("create", data.carrierServiceCreate.userErrors, secrets);
    const created = data.carrierServiceCreate.carrierService;
    if (!created) throw new CarrierServiceError("create", null, "Shopify returned no carrier service");
    return { id: created.id, result: "created", active: created.active };
  }

  const s = found.service;
  const upToDate =
    found.match === "exact" && s.active && s.supportsServiceDiscovery && s.name === name;
  if (upToDate) return { id: s.id, result: "unchanged", active: true };

  const input: CarrierServiceUpdateInput = { id: s.id, name, callbackUrl, active: true, supportsServiceDiscovery: true };
  const data = await admin<CarrierServiceUpdateData>(CARRIER_SERVICE_UPDATE_MUTATION, { input });
  throwUserErrors("update", data.carrierServiceUpdate.userErrors, secrets);
  const updated = data.carrierServiceUpdate.carrierService;
  return { id: updated?.id ?? s.id, result: "updated", active: updated?.active ?? true };
}

/** Вимикає (active=false) — сервіс лишається в Shopify; тарифи в Checkout не надходять. */
export async function deactivateCarrierService(
  admin: AdminGraphql,
  params: CarrierServiceParams,
): Promise<{ id: string | null; result: "deactivated" | "not_found" | "unchanged" }> {
  const token = carrierServiceToken(params.secret, params.shop);
  const callbackUrl = carrierServiceCallbackUrl(params.appUrl, token);
  const found = await findOurCarrierService(admin, callbackUrl);
  if (!found) return { id: null, result: "not_found" };
  if (!found.service.active) return { id: found.service.id, result: "unchanged" };
  const input: CarrierServiceUpdateInput = { id: found.service.id, active: false };
  const data = await admin<CarrierServiceUpdateData>(CARRIER_SERVICE_UPDATE_MUTATION, { input });
  throwUserErrors("update", data.carrierServiceUpdate.userErrors, [callbackUrl, token]);
  return { id: found.service.id, result: "deactivated" };
}

/** Видаляє сервіс із Shopify (carrierServiceDelete). */
export async function unregisterCarrierService(
  admin: AdminGraphql,
  params: CarrierServiceParams,
): Promise<{ deletedId: string | null; result: "deleted" | "not_found" }> {
  const token = carrierServiceToken(params.secret, params.shop);
  const callbackUrl = carrierServiceCallbackUrl(params.appUrl, token);
  const found = await findOurCarrierService(admin, callbackUrl);
  if (!found) return { deletedId: null, result: "not_found" };
  const data = await admin<CarrierServiceDeleteData>(CARRIER_SERVICE_DELETE_MUTATION, { id: found.service.id });
  throwUserErrors("delete", data.carrierServiceDelete.userErrors, [callbackUrl, token]);
  return { deletedId: data.carrierServiceDelete.deletedId ?? found.service.id, result: "deleted" };
}

export interface CarrierServiceStatus {
  registered: boolean;
  active: boolean;
  id: string | null;
  name: string | null;
  /** false — сервіс знайдено, але адреса застаріла (змінився хост або секрет) → потрібна повторна реєстрація. */
  callbackUrlCurrent: boolean;
}

export async function carrierServiceStatus(admin: AdminGraphql, params: CarrierServiceParams): Promise<CarrierServiceStatus> {
  const name = params.name?.trim() || DEFAULT_CARRIER_SERVICE_NAME;
  const callbackUrl = carrierServiceCallbackUrl(params.appUrl, carrierServiceToken(params.secret, params.shop));
  const found = await findOurCarrierService(admin, callbackUrl, name);
  if (!found) return { registered: false, active: false, id: null, name: null, callbackUrlCurrent: false };
  return {
    registered: true,
    active: found.service.active,
    id: found.service.id,
    name: found.service.name,
    callbackUrlCurrent: found.match === "exact",
  };
}

// ---------------------------------------------------------------------------
// Операції власника (ServiceContext): дозвіл, встановлений магазин, доступ write_shipping
// ---------------------------------------------------------------------------

export interface CarrierServiceEnv {
  appUrl?: string | null;
  secret?: string | null;
  adminFor?: (shop: string) => Promise<AdminGraphql>;
}

export type CarrierServiceUnavailable =
  /** Демо або немає SHOPIFY_APP_URL / SHOPIFY_API_SECRET. */
  | { ok: false; reason: "not_configured" }
  /** Застосунок не встановлено в магазині. */
  | { ok: false; reason: "not_installed" }
  /** У встановлених доступах немає write_shipping: додати в shopify.app.toml і підтвердити в магазині. */
  | { ok: false; reason: "missing_scope"; scope: typeof CARRIER_SERVICE_SCOPE };

export type CarrierServiceOutcome<T> = { ok: true; value: T } | CarrierServiceUnavailable;

async function prepare(
  ctx: ServiceContext,
  env: CarrierServiceEnv,
): Promise<{ ok: true; admin: AdminGraphql; params: CarrierServiceParams } | CarrierServiceUnavailable> {
  requirePermission(ctx.actor, "settings.manage");
  const defaults = ctx.mode === "production" && (!env.appUrl || !env.secret) ? getEnv() : null;
  const appUrl = env.appUrl ?? defaults?.SHOPIFY_APP_URL ?? null;
  const secret = env.secret ?? defaults?.SHOPIFY_API_SECRET ?? null;
  if (ctx.mode !== "production" || !appUrl || !secret) return { ok: false, reason: "not_configured" };
  const shop = await currentShop(ctx.db);
  if (!shop) return { ok: false, reason: "not_installed" };
  if (!hasScope(shop.scopes, CARRIER_SERVICE_SCOPE)) return { ok: false, reason: "missing_scope", scope: CARRIER_SERVICE_SCOPE };
  const admin = await (env.adminFor ?? adminClientFor)(shop.shop);
  return { ok: true, admin, params: { appUrl, secret, shop: shop.shop } };
}

export async function getCarrierServiceStatus(
  ctx: ServiceContext,
  env: CarrierServiceEnv = {},
): Promise<CarrierServiceOutcome<CarrierServiceStatus>> {
  const p = await prepare(ctx, env);
  if (!p.ok) return p;
  return { ok: true, value: await carrierServiceStatus(p.admin, p.params) };
}

export async function enableCarrierService(
  ctx: ServiceContext,
  env: CarrierServiceEnv & { name?: string } = {},
): Promise<CarrierServiceOutcome<RegisterCarrierServiceResult>> {
  const p = await prepare(ctx, env);
  if (!p.ok) return p;
  const value = await registerCarrierService(p.admin, { ...p.params, name: env.name });
  await writeAudit(ctx.db, ctx.actor, "carrier_service.register", { type: "carrier_service", id: value.id }, { result: value.result });
  return { ok: true, value };
}

export async function disableCarrierService(
  ctx: ServiceContext,
  opts: { remove?: boolean } = {},
  env: CarrierServiceEnv = {},
): Promise<CarrierServiceOutcome<{ id: string | null; result: "deactivated" | "deleted" | "not_found" | "unchanged" }>> {
  const p = await prepare(ctx, env);
  if (!p.ok) return p;
  if (opts.remove) {
    const r = await unregisterCarrierService(p.admin, p.params);
    await writeAudit(ctx.db, ctx.actor, "carrier_service.delete", { type: "carrier_service", id: r.deletedId }, { result: r.result });
    return { ok: true, value: { id: r.deletedId, result: r.result } };
  }
  const r = await deactivateCarrierService(p.admin, p.params);
  await writeAudit(ctx.db, ctx.actor, "carrier_service.deactivate", { type: "carrier_service", id: r.id }, { result: r.result });
  return { ok: true, value: r };
}
