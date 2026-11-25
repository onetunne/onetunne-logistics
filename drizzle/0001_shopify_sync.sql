CREATE TABLE "shop_installations" (
	"shop" text PRIMARY KEY NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"uninstalled_at" timestamp with time zone,
	"scopes" text,
	"webhooks_registered_at" timestamp with time zone,
	"products_synced_at" timestamp with time zone,
	"orders_synced_at" timestamp with time zone,
	"import_state" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" DROP CONSTRAINT "jobs_dedupe_key_unique";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "billing_country_code" char(2);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "fulfillment_status" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shopify_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "inventory_item_id" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "status" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "shopify_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "staff_members" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_queued_dedupe_uq" ON "jobs" USING btree ("dedupe_key") WHERE "jobs"."status" = 'queued';--> statement-breakpoint
CREATE UNIQUE INDEX "order_line_items_shopify_uq" ON "order_line_items" USING btree ("order_id","shopify_line_item_id");--> statement-breakpoint
CREATE INDEX "product_variants_inventory_item_idx" ON "product_variants" USING btree ("inventory_item_id");