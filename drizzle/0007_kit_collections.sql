CREATE TABLE "collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shopify_collection_id" text,
	"title" text NOT NULL,
	"handle" text,
	"shopify_updated_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collections_shopify_collection_id_unique" UNIQUE("shopify_collection_id")
);
--> statement-breakpoint
CREATE TABLE "kit_template_collections" (
	"template_id" uuid NOT NULL,
	"collection_id" uuid NOT NULL,
	CONSTRAINT "kit_template_collections_pk" PRIMARY KEY("template_id","collection_id")
);
--> statement-breakpoint
CREATE TABLE "product_collections" (
	"product_id" uuid NOT NULL,
	"collection_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_collections_pk" PRIMARY KEY("product_id","collection_id")
);
--> statement-breakpoint
ALTER TABLE "kit_templates" DROP CONSTRAINT "kit_templates_applies_to_chk";--> statement-breakpoint
ALTER TABLE "kit_templates" ADD COLUMN "variant_models" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "kit_templates" ADD COLUMN "variant_colors" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "collections_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shop_installations" ADD COLUMN "collections_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kit_template_collections" ADD CONSTRAINT "kit_template_collections_template_id_kit_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."kit_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kit_template_collections" ADD CONSTRAINT "kit_template_collections_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_collections" ADD CONSTRAINT "product_collections_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_collections" ADD CONSTRAINT "product_collections_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collections_title_idx" ON "collections" USING btree ("title");--> statement-breakpoint
CREATE INDEX "kit_template_collections_collection_idx" ON "kit_template_collections" USING btree ("collection_id");--> statement-breakpoint
CREATE INDEX "product_collections_collection_idx" ON "product_collections" USING btree ("collection_id");--> statement-breakpoint
ALTER TABLE "kit_templates" ADD CONSTRAINT "kit_templates_applies_to_chk" CHECK ("kit_templates"."applies_to" in ('all', 'products', 'collections'));