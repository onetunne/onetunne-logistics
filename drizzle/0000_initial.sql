CREATE TYPE "public"."change_source" AS ENUM('auto_fix', 'manual', 'suggestion_accepted', 'shopify_sync', 'system');--> statement-breakpoint
CREATE TYPE "public"."duty_payer" AS ENUM('company', 'customer', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."issue_severity" AS ENUM('error', 'warning');--> statement-breakpoint
CREATE TYPE "public"."issue_status" AS ENUM('open', 'resolved', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'dead');--> statement-breakpoint
CREATE TYPE "public"."order_source" AS ENUM('demo', 'shopify');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('paid', 'awaiting_review', 'needs_correction', 'waybill_created', 'awaiting_picking', 'packed', 'handed_to_carrier', 'in_transit', 'customs', 'delivered', 'delivery_problem', 'returned', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."staff_role" AS ENUM('owner', 'staff');--> statement-breakpoint
CREATE TYPE "public"."shipment_mode" AS ENUM('test', 'live');--> statement-breakpoint
CREATE TYPE "public"."shipment_status" AS ENUM('creating', 'created', 'unknown', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "country_rules" (
	"country_code" char(2) PRIMARY KEY NOT NULL,
	"name_en" text NOT NULL,
	"name_uk" text NOT NULL,
	"shipping_enabled" boolean DEFAULT true NOT NULL,
	"postal_code_required" boolean DEFAULT true NOT NULL,
	"postal_code_pattern" text,
	"postal_code_example" text,
	"province_required" boolean DEFAULT false NOT NULL,
	"phone_required" boolean DEFAULT true NOT NULL,
	"duty_payer" "duty_payer" DEFAULT 'unknown' NOT NULL,
	"notes" text,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid,
	"shipment_id" uuid,
	"code" text NOT NULL,
	"severity" "issue_severity" NOT NULL,
	"status" "issue_status" DEFAULT 'open' NOT NULL,
	"field" text,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"suggestion" jsonb,
	"fingerprint" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"dedupe_key" text,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "legal_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"country_code" char(2) NOT NULL,
	"tax_id" text,
	"base_currency" char(3) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"field" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"source" "change_source" NOT NULL,
	"rule_id" text,
	"reason" text,
	"actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_line_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"variant_id" uuid,
	"shopify_line_item_id" text,
	"title" text NOT NULL,
	"variant_title" text,
	"sku" text,
	"quantity" integer NOT NULL,
	"unit_price" numeric(14, 2) NOT NULL,
	"currency" char(3) NOT NULL,
	"image_url" text,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "order_source" NOT NULL,
	"shopify_order_id" text,
	"order_number" text NOT NULL,
	"status" "order_status" DEFAULT 'paid' NOT NULL,
	"financial_status" text DEFAULT 'paid' NOT NULL,
	"currency" char(3) NOT NULL,
	"subtotal" numeric(14, 2) NOT NULL,
	"shipping_paid" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total" numeric(14, 2) NOT NULL,
	"email" text,
	"contact_phone" text,
	"ship_first_name" text,
	"ship_last_name" text,
	"ship_company" text,
	"ship_address1" text,
	"ship_address2" text,
	"ship_city" text,
	"ship_province" text,
	"ship_postal_code" text,
	"ship_country_code" char(2),
	"ship_phone" text,
	"note" text,
	"automation_paused" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"last_validated_at" timestamp with time zone,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_shopify_order_id_unique" UNIQUE("shopify_order_id"),
	CONSTRAINT "orders_order_number_unique" UNIQUE("order_number")
);
--> statement-breakpoint
CREATE TABLE "product_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"shopify_variant_id" text,
	"title" text NOT NULL,
	"sku" text,
	"barcode" text,
	"color" text,
	"model" text,
	"price" numeric(14, 2) NOT NULL,
	"currency" char(3) NOT NULL,
	"weight_grams" integer,
	"length_mm" integer,
	"width_mm" integer,
	"height_mm" integer,
	"hs_code" text,
	"country_of_origin" char(2),
	"customs_description" text,
	"image_url" text,
	"inventory_available" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_variants_shopify_variant_id_unique" UNIQUE("shopify_variant_id")
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shopify_product_id" text,
	"title" text NOT NULL,
	"handle" text,
	"image_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_shopify_product_id_unique" UNIQUE("shopify_product_id")
);
--> statement-breakpoint
CREATE TABLE "sandbox_carrier_shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"waybill_number" text NOT NULL,
	"payload" jsonb,
	"cancelled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_carrier_shipments_reference_unique" UNIQUE("reference"),
	CONSTRAINT "sandbox_carrier_shipments_waybill_number_unique" UNIQUE("waybill_number")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"version" integer NOT NULL,
	"value" jsonb NOT NULL,
	"changed_by" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"type" text NOT NULL,
	"message" text,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"carrier_code" text NOT NULL,
	"mode" "shipment_mode" NOT NULL,
	"status" "shipment_status" NOT NULL,
	"carrier_reference" text NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"carrier_shipment_id" text,
	"waybill_number" text,
	"tracking_number" text,
	"actual_weight_grams" integer,
	"volumetric_weight_grams" integer,
	"chargeable_weight_grams" integer,
	"package_code" text,
	"declared_value" numeric(14, 2),
	"currency" char(3),
	"request_snapshot" jsonb,
	"last_error" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shopify_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"shop" text NOT NULL,
	"state" text NOT NULL,
	"isOnline" boolean DEFAULT false NOT NULL,
	"scope" text,
	"expires" timestamp,
	"accessToken" text NOT NULL,
	"userId" bigint,
	"firstName" text,
	"lastName" text,
	"email" text,
	"accountOwner" boolean,
	"locale" text,
	"collaborator" boolean,
	"emailVerified" boolean,
	"refreshToken" text,
	"refreshTokenExpires" timestamp
);
--> statement-breakpoint
CREATE TABLE "staff_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shopify_user_id" text,
	"display_name" text NOT NULL,
	"role" "staff_role" DEFAULT 'staff' NOT NULL,
	"permission_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_members_shopify_user_id_unique" UNIQUE("shopify_user_id")
);
--> statement-breakpoint
CREATE TABLE "warehouses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legal_entity_id" uuid,
	"name" text NOT NULL,
	"country_code" char(2) NOT NULL,
	"city" text NOT NULL,
	"address" text,
	"shopify_location_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"webhook_id" text NOT NULL,
	"topic" text NOT NULL,
	"shop" text NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "webhook_events_webhook_id_unique" UNIQUE("webhook_id")
);
--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_changes" ADD CONSTRAINT "order_changes_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_line_items" ADD CONSTRAINT "order_line_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_line_items" ADD CONSTRAINT "order_line_items_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_log_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "issues_open_fingerprint_uq" ON "issues" USING btree ("fingerprint") WHERE "issues"."status" = 'open';--> statement-breakpoint
CREATE INDEX "issues_order_idx" ON "issues" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "issues_status_idx" ON "issues" USING btree ("status");--> statement-breakpoint
CREATE INDEX "jobs_pick_idx" ON "jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE INDEX "order_changes_order_idx" ON "order_changes" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "order_line_items_order_idx" ON "order_line_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "orders_country_idx" ON "orders" USING btree ("ship_country_code");--> statement-breakpoint
CREATE INDEX "orders_placed_at_idx" ON "orders" USING btree ("placed_at");--> statement-breakpoint
CREATE INDEX "product_variants_sku_idx" ON "product_variants" USING btree ("sku");--> statement-breakpoint
CREATE INDEX "product_variants_barcode_idx" ON "product_variants" USING btree ("barcode");--> statement-breakpoint
CREATE UNIQUE INDEX "settings_history_key_version_uq" ON "settings_history" USING btree ("key","version");--> statement-breakpoint
CREATE INDEX "shipment_events_shipment_idx" ON "shipment_events" USING btree ("shipment_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_one_active_per_order_uq" ON "shipments" USING btree ("order_id") WHERE "shipments"."status" in ('creating', 'created', 'unknown');--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_carrier_reference_uq" ON "shipments" USING btree ("carrier_code","carrier_reference");--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_waybill_uq" ON "shipments" USING btree ("carrier_code","waybill_number");--> statement-breakpoint
CREATE INDEX "shipments_order_idx" ON "shipments" USING btree ("order_id");