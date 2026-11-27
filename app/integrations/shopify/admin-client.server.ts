import { logger } from "~/lib/logger.server";

/**
 * Мінімальний клієнт GraphQL Admin API для фонових завдань.
 * Токен — офлайн-сесія магазину (expiring offline token з автооновленням бібліотекою Shopify).
 */
export type AdminGraphql = (<T>(query: string, variables?: Record<string, unknown>) => Promise<T>) & {
  /** X-Request-Id останньої відповіді Shopify (для звернення в підтримку Shopify). */
  lastRequestId?: string | null;
};

/** Помилка API. retryable — можна повторити пізніше (обмеження швидкості, 5xx, мережа). */
export class ShopifyApiError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ShopifyApiError";
  }
}

interface GraphqlResponseLike {
  json(): Promise<unknown>;
  status?: number;
  headers?: { get(name: string): string | null };
}

type RawGraphql = (query: string, options?: { variables?: Record<string, unknown> }) => Promise<GraphqlResponseLike>;

interface GraphqlErrorEntry {
  message: string;
  extensions?: { code?: string; cost?: number; maxCost?: number };
}

/**
 * shopify.dev (rate limits): «The response includes information about the cost of the request and the state of the
 * throttle. This data is returned under the `extensions` key» — extensions.cost.requestedQueryCost / actualQueryCost.
 */
interface QueryCostExtension {
  requestedQueryCost?: number;
  actualQueryCost?: number | null;
}

/** Тіло відповіді. Бібліотека Shopify (admin.graphql) додає в JSON ще й заголовки відповіді (headers). */
interface GraphqlBody<T> {
  data?: T;
  errors?: GraphqlErrorEntry[];
  extensions?: { cost?: QueryCostExtension };
  headers?: Record<string, string | string[]>;
}

/** «A single query may not exceed a cost of 1,000 points» (shopify.dev, rate limits). */
export const SHOPIFY_SINGLE_QUERY_MAX_COST = 1000;
/** Запитувана вартість понад цей поріг журналюється попередженням (власник бачить запити, близькі до ліміту). */
export const QUERY_COST_WARN_THRESHOLD = 800;

/** Назва операції з документа (`query OtOrder(...)` → OtOrder). Лише назва — без змінних і даних. */
export function operationNameOf(query: string): string {
  return /\b(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(query)?.[1] ?? "anonymous";
}

function logQueryCost(operation: string, cost: QueryCostExtension | undefined): void {
  const requested = cost?.requestedQueryCost;
  if (typeof requested !== "number" || requested <= QUERY_COST_WARN_THRESHOLD) return;
  logger.warn("shopify.query_cost_high", {
    operation,
    requested,
    actual: typeof cost?.actualQueryCost === "number" ? cost.actualQueryCost : null,
    limit: SHOPIFY_SINGLE_QUERY_MAX_COST,
  });
}

/** Помилки GraphQL → ShopifyApiError. Повторюються лише THROTTLED і INTERNAL_SERVER_ERROR. */
function graphqlError(errors: readonly GraphqlErrorEntry[], operation: string): ShopifyApiError {
  const code = errors[0]?.extensions?.code;
  // shopify.dev (Admin API, коди помилок): MAX_COST_EXCEEDED — «Query cost is …, which exceeds the single query max cost
  // limit (1000)»; extensions.cost / maxCost. Повтор не допоможе (запит той самий) — лише попередження в журналі.
  const overLimit = errors.find((e) => e.extensions?.code === "MAX_COST_EXCEEDED");
  if (overLimit) {
    logger.warn("shopify.query_cost_exceeded", {
      operation,
      requested: typeof overLimit.extensions?.cost === "number" ? overLimit.extensions.cost : null,
      limit: typeof overLimit.extensions?.maxCost === "number" ? overLimit.extensions.maxCost : SHOPIFY_SINGLE_QUERY_MAX_COST,
    });
  }
  return new ShopifyApiError(
    `Shopify GraphQL error: ${errors.map((e) => e.message).join("; ").slice(0, 300)}`,
    code === "THROTTLED" || code === "INTERNAL_SERVER_ERROR",
    code,
  );
}

function requestIdOf(response: GraphqlResponseLike, body: GraphqlBody<unknown>): string | null {
  const direct = response.headers?.get("x-request-id");
  if (direct) return direct;
  for (const [key, value] of Object.entries(body.headers ?? {})) {
    if (key.toLowerCase() !== "x-request-id") continue;
    const first = Array.isArray(value) ? value[0] : value;
    return typeof first === "string" ? first : null;
  }
  return null;
}

/**
 * GraphQL-помилки, які бібліотека Shopify КИДАЄ (GraphqlQueryError: відповідь 200 з errors): тіло — у `body`
 * ({ errors: { graphQLErrors: [...] }, extensions }). Без цього MAX_COST_EXCEEDED чи ACCESS_DENIED виглядали б як збій
 * мережі (повторювались би без причини в журналі).
 */
function thrownGraphqlBody(e: unknown): { errors: GraphqlErrorEntry[]; extensions?: GraphqlBody<unknown>["extensions"] } | null {
  const body = (e as { body?: { errors?: { graphQLErrors?: unknown }; extensions?: GraphqlBody<unknown>["extensions"] } } | null)?.body;
  const list = body?.errors?.graphQLErrors;
  if (!Array.isArray(list) || list.length === 0) return null;
  const errors = list.filter((x): x is GraphqlErrorEntry => Boolean(x) && typeof (x as { message?: unknown }).message === "string");
  return errors.length ? { errors, extensions: body?.extensions } : null;
}

/**
 * Обгортка над `admin.graphql` бібліотеки Shopify: розбір помилок і класифікація для повторів; запитувана/фактична
 * вартість (extensions.cost) понад QUERY_COST_WARN_THRESHOLD — попередження в журналі (лише назва операції й числа).
 */
export function wrapAdminGraphql(raw: RawGraphql): AdminGraphql {
  const fn: AdminGraphql = async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
    const operation = operationNameOf(query);
    let response: GraphqlResponseLike;
    try {
      response = await raw(query, variables ? { variables } : undefined);
    } catch (e) {
      const thrown = thrownGraphqlBody(e);
      if (thrown) {
        logQueryCost(operation, thrown.extensions?.cost);
        throw graphqlError(thrown.errors, operation);
      }
      // Бібліотека кидає помилку з відповіддю для 4xx/5xx; мережеві збої — теж тут.
      const status = (e as { response?: { code?: number }; status?: number })?.response?.code ?? (e as { status?: number })?.status;
      const retryable = status === undefined || status === 429 || status >= 500;
      throw new ShopifyApiError(`Shopify request failed${status ? ` (${status})` : ""}`, retryable, status ? String(status) : "NETWORK");
    }
    const body = (await response.json()) as GraphqlBody<T>;
    fn.lastRequestId = requestIdOf(response, body as GraphqlBody<unknown>);
    logQueryCost(operation, body.extensions?.cost);
    if (body.errors?.length) throw graphqlError(body.errors, operation);
    if (!body.data) throw new ShopifyApiError("Shopify GraphQL: empty response", true, "EMPTY");
    return body.data;
  };
  return fn;
}

/** Клієнт для конкретного магазину за збереженою офлайн-сесією. */
export async function adminClientFor(shop: string): Promise<AdminGraphql> {
  const { getShopify } = await import("~/shopify.server");
  const shopify = await getShopify();
  const { admin } = await shopify.unauthenticated.admin(shop);
  return wrapAdminGraphql(admin.graphql as unknown as RawGraphql);
}
