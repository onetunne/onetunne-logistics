CREATE TABLE "shipment_tracking_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"status" text NOT NULL,
	"code" text DEFAULT '' NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"location" text,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "customs_description_local" text;--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "material" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "service_code" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "tracking_status" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "carrier_status_code" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "carrier_status_text" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "carrier_status_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "last_tracked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "handed_over_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "shopify_fulfillment_id" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "shopify_fulfilled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipment_tracking_events" ADD CONSTRAINT "shipment_tracking_events_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_tracking_events_uq" ON "shipment_tracking_events" USING btree ("shipment_id","occurred_at","code");--> statement-breakpoint
CREATE INDEX "shipment_tracking_events_shipment_idx" ON "shipment_tracking_events" USING btree ("shipment_id","occurred_at");--> statement-breakpoint
CREATE INDEX "shipments_tracking_idx" ON "shipments" USING btree ("status","last_tracked_at");