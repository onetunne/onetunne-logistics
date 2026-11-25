import type { Db } from "~/db/client.server";
import { enqueueJob } from "~/modules/jobs/queue.server";
import { JOB } from "~/modules/shopify-sync/sync.server";
import type { ShopifyGateway, ShopifySyncResult } from "./types";

/**
 * Робочий шлюз: підтверджені зміни контактів/адреси передаються в Shopify через надійну чергу
 * (orderUpdate з повторами). Одне завдання на замовлення надсилає поточний стан повністю.
 */
export class QueueingShopifyGateway implements ShopifyGateway {
  readonly kind = "admin_api" as const;
  constructor(
    private readonly db: Db,
    private readonly shop: () => Promise<string | null>,
  ) {}

  private async queue(shopifyOrderId: string | null): Promise<ShopifySyncResult> {
    if (!shopifyOrderId) return { status: "skipped", reason: "not_linked" };
    const shop = await this.shop();
    if (!shop) return { status: "skipped", reason: "not_linked" };
    await enqueueJob(this.db, JOB.pushOrder, { shop, shopifyOrderId }, { dedupeKey: `push:${shopifyOrderId}` });
    return { status: "queued" };
  }

  updateOrderShippingAddress(shopifyOrderId: string | null) {
    return this.queue(shopifyOrderId);
  }

  updateOrderContact(shopifyOrderId: string | null) {
    return this.queue(shopifyOrderId);
  }
}
