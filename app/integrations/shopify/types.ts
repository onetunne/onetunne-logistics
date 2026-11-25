import type { AddressInput } from "~/modules/validation/types";

/**
 * Шлюз до Shopify Admin GraphQL API (етап 2).
 * Демо використовує DemoShopifyGateway, який НІЧОГО не надсилає в Shopify.
 */
export type ShopifySyncResult =
  | { status: "synced" }
  | { status: "queued" }
  | { status: "skipped"; reason: "demo_mode" | "not_linked" | "not_implemented" | "invalid_data" }
  | { status: "failed"; error: string };

export interface ShopifyGateway {
  readonly kind: "demo" | "admin_api";
  /** Оновити адресу доставки замовлення в Shopify після ручного виправлення. */
  updateOrderShippingAddress(shopifyOrderId: string | null, address: AddressInput): Promise<ShopifySyncResult>;
  /** Оновити email/телефон замовлення. */
  updateOrderContact(
    shopifyOrderId: string | null,
    contact: { email: string | null; phone: string | null },
  ): Promise<ShopifySyncResult>;
}

/** Демо-шлюз: фіксує, що синхронізацію пропущено (демо), реальних запитів немає. */
export class DemoShopifyGateway implements ShopifyGateway {
  readonly kind = "demo" as const;
  async updateOrderShippingAddress(): Promise<ShopifySyncResult> {
    return { status: "skipped", reason: "demo_mode" };
  }
  async updateOrderContact(): Promise<ShopifySyncResult> {
    return { status: "skipped", reason: "demo_mode" };
  }
}

/**
 * Заглушка робочого шлюзу до реалізації етапу 2: нічого не змінює в Shopify.
 * Справжня реалізація використовуватиме `admin.graphql` (GraphQL Admin API 2026-10).
 */
export class PendingShopifyGateway implements ShopifyGateway {
  readonly kind = "admin_api" as const;
  async updateOrderShippingAddress(shopifyOrderId: string | null): Promise<ShopifySyncResult> {
    return shopifyOrderId ? { status: "skipped", reason: "not_implemented" } : { status: "skipped", reason: "not_linked" };
  }
  async updateOrderContact(shopifyOrderId: string | null): Promise<ShopifySyncResult> {
    return shopifyOrderId ? { status: "skipped", reason: "not_implemented" } : { status: "skipped", reason: "not_linked" };
  }
}
