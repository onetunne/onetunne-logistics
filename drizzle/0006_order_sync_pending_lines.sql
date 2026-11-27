ALTER TABLE "order_line_items" ADD COLUMN "shopify_added_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shopify_lines_pending_at" timestamp with time zone;