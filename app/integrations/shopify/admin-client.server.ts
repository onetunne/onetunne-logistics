/**
 * Мінімальний клієнт GraphQL Admin API для фонових завдань.
 * Токен — офлайн-сесія магазину (expiring offline token з автооновленням бібліотекою Shopify).
 */
export type AdminGraphql = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;

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
}

type RawGraphql = (query: string, options?: { variables?: Record<string, unknown> }) => Promise<GraphqlResponseLike>;

/** Обгортка над `admin.graphql` бібліотеки Shopify: розбір помилок і класифікація для повторів. */
export function wrapAdminGraphql(raw: RawGraphql): AdminGraphql {
  return async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
    let response: GraphqlResponseLike;
    try {
      response = await raw(query, variables ? { variables } : undefined);
    } catch (e) {
      // Бібліотека кидає помилку з відповіддю для 4xx/5xx; мережеві збої — теж тут.
      const status = (e as { response?: { code?: number }; status?: number })?.response?.code ?? (e as { status?: number })?.status;
      const retryable = status === undefined || status === 429 || status >= 500;
      throw new ShopifyApiError(`Shopify request failed${status ? ` (${status})` : ""}`, retryable, status ? String(status) : "NETWORK");
    }
    const body = (await response.json()) as { data?: T; errors?: Array<{ message: string; extensions?: { code?: string } }> };
    if (body.errors?.length) {
      const code = body.errors[0]?.extensions?.code;
      throw new ShopifyApiError(
        `Shopify GraphQL error: ${body.errors.map((e) => e.message).join("; ").slice(0, 300)}`,
        code === "THROTTLED" || code === "INTERNAL_SERVER_ERROR",
        code,
      );
    }
    if (!body.data) throw new ShopifyApiError("Shopify GraphQL: empty response", true, "EMPTY");
    return body.data;
  };
}

/** Клієнт для конкретного магазину за збереженою офлайн-сесією. */
export async function adminClientFor(shop: string): Promise<AdminGraphql> {
  const { getShopify } = await import("~/shopify.server");
  const shopify = await getShopify();
  const { admin } = await shopify.unauthenticated.admin(shop);
  return wrapAdminGraphql(admin.graphql as unknown as RawGraphql);
}
