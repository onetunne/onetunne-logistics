CREATE TABLE "country_rules_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"country_code" char(2) NOT NULL,
	"version" integer NOT NULL,
	"source" text DEFAULT 'update' NOT NULL,
	"value" jsonb NOT NULL,
	"changed_by" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "country_rules_history_code_version_uq" ON "country_rules_history" USING btree ("country_code","version");