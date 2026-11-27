ALTER TABLE "order_line_items" ADD COLUMN "discounted_unit_price" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shopify_fulfillment_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
-- Етап 5 (A4): варіанти, уже видалені в Shopify за попереднім правилом (після повної синхронізації товару варіант, якого
-- не було в переліку, лишався зі старішим updated_at, ніж товар), отримують явну позначку removed_at.
UPDATE "product_variants" AS v SET "removed_at" = p."updated_at"
FROM "products" AS p
WHERE p."id" = v."product_id"
  AND p."shopify_product_id" IS NOT NULL
  AND p."status" IS DISTINCT FROM 'DELETED'
  AND v."removed_at" IS NULL
  AND v."updated_at" < p."updated_at";
