CREATE TABLE "inventory_balances" (
	"warehouse_id" uuid NOT NULL,
	"stock_item_id" uuid NOT NULL,
	"on_hand" integer DEFAULT 0 NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"defective" integer DEFAULT 0 NOT NULL,
	"in_production" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_balances_pk" PRIMARY KEY("warehouse_id","stock_item_id"),
	CONSTRAINT "inventory_balances_reserved_chk" CHECK ("inventory_balances"."reserved" >= 0),
	CONSTRAINT "inventory_balances_defective_chk" CHECK ("inventory_balances"."defective" >= 0),
	CONSTRAINT "inventory_balances_in_production_chk" CHECK ("inventory_balances"."in_production" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stock_item_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"source" text DEFAULT 'shopify' NOT NULL,
	"app_on_hand" integer NOT NULL,
	"shopify_on_hand" integer NOT NULL,
	"shopify_available" integer,
	"expected_diff" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	CONSTRAINT "inventory_conflicts_status_chk" CHECK ("inventory_conflicts"."status" in ('open', 'accepted_shopify', 'pushed_app', 'dismissed')),
	CONSTRAINT "inventory_conflicts_source_chk" CHECK ("inventory_conflicts"."source" = 'shopify')
);
--> statement-breakpoint
CREATE TABLE "inventory_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"stock_item_id" uuid NOT NULL,
	"type" text NOT NULL,
	"on_hand_delta" integer DEFAULT 0 NOT NULL,
	"reserved_delta" integer DEFAULT 0 NOT NULL,
	"defective_delta" integer DEFAULT 0 NOT NULL,
	"in_production_delta" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"order_id" uuid,
	"order_line_item_id" uuid,
	"production_batch_id" uuid,
	"packing_id" uuid,
	"unit_cost" numeric(14, 2),
	"cost_currency" char(3),
	"reason" text,
	"note" text,
	"actor_id" text NOT NULL,
	"actor_name" text NOT NULL,
	"shopify_sync_state" text DEFAULT 'none' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_movements_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "inventory_movements_sync_state_chk" CHECK ("inventory_movements"."shopify_sync_state" in ('none', 'pending', 'pushed', 'failed', 'skipped')),
	CONSTRAINT "inventory_movements_cost_chk" CHECK ("inventory_movements"."unit_cost" is null or ("inventory_movements"."unit_cost" >= 0 and "inventory_movements"."cost_currency" is not null))
);
--> statement-breakpoint
CREATE TABLE "kit_template_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"per" text DEFAULT 'order' NOT NULL,
	CONSTRAINT "kit_template_lines_quantity_chk" CHECK ("kit_template_lines"."quantity" > 0),
	CONSTRAINT "kit_template_lines_per_chk" CHECK ("kit_template_lines"."per" in ('order', 'item'))
);
--> statement-breakpoint
CREATE TABLE "kit_template_products" (
	"template_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	CONSTRAINT "kit_template_products_pk" PRIMARY KEY("template_id","product_id")
);
--> statement-breakpoint
CREATE TABLE "kit_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"applies_to" text DEFAULT 'all' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kit_templates_applies_to_chk" CHECK ("kit_templates"."applies_to" in ('all', 'products'))
);
--> statement-breakpoint
CREATE TABLE "order_packing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"checklist" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"box_material_id" uuid,
	"parcel_weight_grams" integer,
	"parcel_length_mm" integer,
	"parcel_width_mm" integer,
	"parcel_height_mm" integer,
	"started_by" text,
	"started_by_name" text,
	"started_at" timestamp with time zone,
	"packed_by" text,
	"packed_by_name" text,
	"packed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_packing_status_chk" CHECK ("order_packing"."status" in ('queued', 'in_progress', 'packed', 'cancelled')),
	CONSTRAINT "order_packing_parcel_chk" CHECK (("order_packing"."parcel_weight_grams" is null or "order_packing"."parcel_weight_grams" > 0)
        and ("order_packing"."parcel_length_mm" is null or "order_packing"."parcel_length_mm" > 0)
        and ("order_packing"."parcel_width_mm" is null or "order_packing"."parcel_width_mm" > 0)
        and ("order_packing"."parcel_height_mm" is null or "order_packing"."parcel_height_mm" > 0))
);
--> statement-breakpoint
CREATE TABLE "packaging_materials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"unit" text DEFAULT 'pcs' NOT NULL,
	"inner_length_mm" integer,
	"inner_width_mm" integer,
	"inner_height_mm" integer,
	"max_weight_grams" integer,
	"tare_weight_grams" integer,
	"unit_cost" numeric(14, 2),
	"cost_currency" char(3),
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "packaging_materials_code_unique" UNIQUE("code"),
	CONSTRAINT "packaging_materials_kind_chk" CHECK ("packaging_materials"."kind" in ('box', 'mailer', 'sticker', 'instruction', 'card', 'bolt', 'filler', 'tape', 'other')),
	CONSTRAINT "packaging_materials_unit_chk" CHECK ("packaging_materials"."unit" in ('pcs', 'm', 'kg')),
	CONSTRAINT "packaging_materials_dims_chk" CHECK (("packaging_materials"."inner_length_mm" is null or "packaging_materials"."inner_length_mm" > 0)
        and ("packaging_materials"."inner_width_mm" is null or "packaging_materials"."inner_width_mm" > 0)
        and ("packaging_materials"."inner_height_mm" is null or "packaging_materials"."inner_height_mm" > 0)
        and ("packaging_materials"."max_weight_grams" is null or "packaging_materials"."max_weight_grams" > 0)
        and ("packaging_materials"."tare_weight_grams" is null or "packaging_materials"."tare_weight_grams" >= 0)),
	CONSTRAINT "packaging_materials_cost_chk" CHECK ("packaging_materials"."unit_cost" is null or ("packaging_materials"."unit_cost" >= 0 and "packaging_materials"."cost_currency" is not null))
);
--> statement-breakpoint
CREATE TABLE "production_batch_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity_ordered" integer NOT NULL,
	"quantity_received" integer DEFAULT 0 NOT NULL,
	"quantity_defective" integer DEFAULT 0 NOT NULL,
	"unit_cost" numeric(14, 2),
	"cost_currency" char(3),
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "production_batch_lines_ordered_chk" CHECK ("production_batch_lines"."quantity_ordered" > 0),
	CONSTRAINT "production_batch_lines_received_chk" CHECK ("production_batch_lines"."quantity_received" >= 0),
	CONSTRAINT "production_batch_lines_defective_chk" CHECK ("production_batch_lines"."quantity_defective" >= 0),
	CONSTRAINT "production_batch_lines_cost_chk" CHECK ("production_batch_lines"."unit_cost" is null or ("production_batch_lines"."unit_cost" >= 0 and "production_batch_lines"."cost_currency" is not null))
);
--> statement-breakpoint
CREATE TABLE "production_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"planned_ready_date" date,
	"manufacturer" text,
	"notes" text,
	"extra_cost" numeric(14, 2),
	"cost_currency" char(3),
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "production_batches_number_unique" UNIQUE("number"),
	CONSTRAINT "production_batches_status_chk" CHECK ("production_batches"."status" in ('planned', 'in_production', 'partially_received', 'received', 'closed', 'cancelled')),
	CONSTRAINT "production_batches_cost_chk" CHECK ("production_batches"."extra_cost" is null or ("production_batches"."extra_cost" >= 0 and "production_batches"."cost_currency" is not null))
);
--> statement-breakpoint
CREATE TABLE "production_receipt_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_id" uuid NOT NULL,
	"batch_line_id" uuid NOT NULL,
	"good_qty" integer DEFAULT 0 NOT NULL,
	"defective_qty" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "production_receipt_lines_good_chk" CHECK ("production_receipt_lines"."good_qty" >= 0),
	CONSTRAINT "production_receipt_lines_defective_chk" CHECK ("production_receipt_lines"."defective_qty" >= 0)
);
--> statement-breakpoint
CREATE TABLE "production_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"received_by" text NOT NULL,
	"received_by_name" text NOT NULL,
	"note" text,
	CONSTRAINT "production_receipts_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "stock_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stock_item_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "stock_alerts_kind_chk" CHECK ("stock_alerts"."kind" in ('low_stock', 'out_of_stock', 'negative_on_hand', 'oversold')),
	CONSTRAINT "stock_alerts_status_chk" CHECK ("stock_alerts"."status" in ('open', 'resolved'))
);
--> statement-breakpoint
CREATE TABLE "stock_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"variant_id" uuid,
	"material_id" uuid,
	"low_stock_threshold" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_items_variant_id_unique" UNIQUE("variant_id"),
	CONSTRAINT "stock_items_material_id_unique" UNIQUE("material_id"),
	CONSTRAINT "stock_items_kind_chk" CHECK (("stock_items"."kind" = 'product' and "stock_items"."variant_id" is not null and "stock_items"."material_id" is null)
        or ("stock_items"."kind" = 'material' and "stock_items"."material_id" is not null and "stock_items"."variant_id" is null)),
	CONSTRAINT "stock_items_threshold_chk" CHECK ("stock_items"."low_stock_threshold" is null or "stock_items"."low_stock_threshold" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stock_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_line_item_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"stock_item_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"reserved_qty" integer DEFAULT 0 NOT NULL,
	"consumed_qty" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_reservations_order_line_item_id_unique" UNIQUE("order_line_item_id"),
	CONSTRAINT "stock_reservations_status_chk" CHECK ("stock_reservations"."status" in ('reserved', 'consumed', 'released', 'partial')),
	CONSTRAINT "stock_reservations_qty_chk" CHECK ("stock_reservations"."reserved_qty" >= 0 and "stock_reservations"."consumed_qty" >= 0)
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "priority" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "parcel_weight_grams" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "parcel_length_mm" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "parcel_width_mm" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "parcel_height_mm" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "parcel_box_material_id" uuid;--> statement-breakpoint
ALTER TABLE "warehouses" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "warehouses" ADD COLUMN "inventory_initialized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_stock_item_id_stock_items_id_fk" FOREIGN KEY ("stock_item_id") REFERENCES "public"."stock_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_conflicts" ADD CONSTRAINT "inventory_conflicts_stock_item_id_stock_items_id_fk" FOREIGN KEY ("stock_item_id") REFERENCES "public"."stock_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_conflicts" ADD CONSTRAINT "inventory_conflicts_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_stock_item_id_stock_items_id_fk" FOREIGN KEY ("stock_item_id") REFERENCES "public"."stock_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_production_batch_id_production_batches_id_fk" FOREIGN KEY ("production_batch_id") REFERENCES "public"."production_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_packing_id_order_packing_id_fk" FOREIGN KEY ("packing_id") REFERENCES "public"."order_packing"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kit_template_lines" ADD CONSTRAINT "kit_template_lines_template_id_kit_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."kit_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kit_template_lines" ADD CONSTRAINT "kit_template_lines_material_id_packaging_materials_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."packaging_materials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kit_template_products" ADD CONSTRAINT "kit_template_products_template_id_kit_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."kit_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kit_template_products" ADD CONSTRAINT "kit_template_products_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_packing" ADD CONSTRAINT "order_packing_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_packing" ADD CONSTRAINT "order_packing_box_material_id_packaging_materials_id_fk" FOREIGN KEY ("box_material_id") REFERENCES "public"."packaging_materials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_batch_lines" ADD CONSTRAINT "production_batch_lines_batch_id_production_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."production_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_batch_lines" ADD CONSTRAINT "production_batch_lines_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_receipt_lines" ADD CONSTRAINT "production_receipt_lines_receipt_id_production_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."production_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_receipt_lines" ADD CONSTRAINT "production_receipt_lines_batch_line_id_production_batch_lines_id_fk" FOREIGN KEY ("batch_line_id") REFERENCES "public"."production_batch_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_receipts" ADD CONSTRAINT "production_receipts_batch_id_production_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."production_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_alerts" ADD CONSTRAINT "stock_alerts_stock_item_id_stock_items_id_fk" FOREIGN KEY ("stock_item_id") REFERENCES "public"."stock_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_alerts" ADD CONSTRAINT "stock_alerts_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_material_id_packaging_materials_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."packaging_materials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_stock_item_id_stock_items_id_fk" FOREIGN KEY ("stock_item_id") REFERENCES "public"."stock_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_balances_item_idx" ON "inventory_balances" USING btree ("stock_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_conflicts_open_uq" ON "inventory_conflicts" USING btree ("stock_item_id","warehouse_id") WHERE "inventory_conflicts"."status" = 'open';--> statement-breakpoint
CREATE INDEX "inventory_conflicts_status_idx" ON "inventory_conflicts" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "inventory_movements_item_idx" ON "inventory_movements" USING btree ("stock_item_id","created_at");--> statement-breakpoint
CREATE INDEX "inventory_movements_created_idx" ON "inventory_movements" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "inventory_movements_order_idx" ON "inventory_movements" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "inventory_movements_batch_idx" ON "inventory_movements" USING btree ("production_batch_id");--> statement-breakpoint
CREATE INDEX "inventory_movements_packing_idx" ON "inventory_movements" USING btree ("packing_id");--> statement-breakpoint
CREATE INDEX "inventory_movements_shopify_pending_idx" ON "inventory_movements" USING btree ("created_at") WHERE "inventory_movements"."shopify_sync_state" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "kit_template_lines_uq" ON "kit_template_lines" USING btree ("template_id","material_id","per");--> statement-breakpoint
CREATE INDEX "kit_template_products_product_idx" ON "kit_template_products" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_packing_one_active_uq" ON "order_packing" USING btree ("order_id") WHERE "order_packing"."status" in ('queued', 'in_progress', 'packed');--> statement-breakpoint
CREATE UNIQUE INDEX "order_packing_generation_uq" ON "order_packing" USING btree ("order_id","generation");--> statement-breakpoint
CREATE INDEX "order_packing_status_idx" ON "order_packing" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "packaging_materials_kind_idx" ON "packaging_materials" USING btree ("kind","active");--> statement-breakpoint
CREATE INDEX "production_batch_lines_batch_idx" ON "production_batch_lines" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "production_batch_lines_variant_idx" ON "production_batch_lines" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "production_batches_status_idx" ON "production_batches" USING btree ("status","planned_ready_date");--> statement-breakpoint
CREATE INDEX "production_receipt_lines_receipt_idx" ON "production_receipt_lines" USING btree ("receipt_id");--> statement-breakpoint
CREATE INDEX "production_receipt_lines_batch_line_idx" ON "production_receipt_lines" USING btree ("batch_line_id");--> statement-breakpoint
CREATE INDEX "production_receipts_batch_idx" ON "production_receipts" USING btree ("batch_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_alerts_open_uq" ON "stock_alerts" USING btree ("stock_item_id","warehouse_id","kind") WHERE "stock_alerts"."status" = 'open';--> statement-breakpoint
CREATE INDEX "stock_alerts_status_idx" ON "stock_alerts" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "stock_reservations_order_idx" ON "stock_reservations" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "stock_reservations_item_idx" ON "stock_reservations" USING btree ("stock_item_id","status");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_parcel_box_material_id_packaging_materials_id_fk" FOREIGN KEY ("parcel_box_material_id") REFERENCES "public"."packaging_materials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_line_items_variant_idx" ON "order_line_items" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "orders_packing_queue_idx" ON "orders" USING btree ("status","priority","placed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "warehouses_one_default_uq" ON "warehouses" USING btree ("is_default") WHERE "warehouses"."is_default";--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_priority_chk" CHECK ("orders"."priority" between 0 and 2);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_parcel_override_chk" CHECK (("orders"."parcel_weight_grams" is null or "orders"."parcel_weight_grams" > 0)
        and ("orders"."parcel_length_mm" is null or "orders"."parcel_length_mm" > 0)
        and ("orders"."parcel_width_mm" is null or "orders"."parcel_width_mm" > 0)
        and ("orders"."parcel_height_mm" is null or "orders"."parcel_height_mm" > 0));