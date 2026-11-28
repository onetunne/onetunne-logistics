CREATE TABLE "carrier_import_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text DEFAULT 'default' NOT NULL,
	"carrier_code" text NOT NULL,
	"name" text NOT NULL,
	"header_signature" text NOT NULL,
	"sheet" text,
	"header_row" integer DEFAULT 1 NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"builtin" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "carrier_import_profiles_header_row_chk" CHECK ("carrier_import_profiles"."header_row" >= 1)
);
--> statement-breakpoint
CREATE TABLE "carrier_invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"sheet" text DEFAULT '' NOT NULL,
	"row_number" integer NOT NULL,
	"waybill_raw" text,
	"waybill_norm" text,
	"number_class" text,
	"line_kind" text NOT NULL,
	"service_name" text,
	"charge_type" text NOT NULL,
	"charge_date" date,
	"amount" numeric(14, 2) NOT NULL,
	"amount_excl_vat" numeric(14, 2),
	"vat_amount" numeric(14, 2),
	"currency" char(3) NOT NULL,
	"billed_weight_grams" integer,
	"shipment_id" uuid,
	"external_waybill_id" uuid,
	"order_id" uuid,
	"match_status" text NOT NULL,
	"match_version" integer DEFAULT 1 NOT NULL,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "carrier_invoice_lines_kind_chk" CHECK ("carrier_invoice_lines"."line_kind" in ('charge', 'credit', 'total', 'ignored')),
	CONSTRAINT "carrier_invoice_lines_charge_chk" CHECK ("carrier_invoice_lines"."charge_type" in ('delivery', 'additional_service', 'customs_duty', 'return_delivery', 'redirect', 'storage', 'insurance', 'other', 'credit')),
	CONSTRAINT "carrier_invoice_lines_match_chk" CHECK ("carrier_invoice_lines"."match_status" in ('matched', 'unmatched', 'ambiguous', 'invalid', 'manual', 'ignored')),
	CONSTRAINT "carrier_invoice_lines_service_chk" CHECK ("carrier_invoice_lines"."service_name" is null or char_length("carrier_invoice_lines"."service_name") <= 200),
	CONSTRAINT "carrier_invoice_lines_currency_chk" CHECK ("carrier_invoice_lines"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "carrier_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text DEFAULT 'default' NOT NULL,
	"carrier_code" text NOT NULL,
	"account_ref" text DEFAULT '' NOT NULL,
	"document_kind" text NOT NULL,
	"parent_invoice_id" uuid,
	"posting" boolean DEFAULT false NOT NULL,
	"invoice_number" text NOT NULL,
	"invoice_number_norm" text NOT NULL,
	"invoice_date" date,
	"period_from" date,
	"period_to" date,
	"currency" char(3),
	"control_total" numeric(14, 2),
	"totals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"file_sha256" char(64) NOT NULL,
	"file_size" integer NOT NULL,
	"file_kind" text NOT NULL,
	"encoding" text,
	"delimiter" text,
	"profile_id" uuid,
	"profile_version" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"replaces_id" uuid,
	"row_count" integer DEFAULT 0 NOT NULL,
	"matched_count" integer DEFAULT 0 NOT NULL,
	"discrepancy_count" integer DEFAULT 0 NOT NULL,
	"operation_id" uuid NOT NULL,
	"imported_by" text NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	CONSTRAINT "carrier_invoices_operation_id_unique" UNIQUE("operation_id"),
	CONSTRAINT "carrier_invoices_kind_chk" CHECK ("carrier_invoices"."document_kind" in ('invoice', 'specification', 'credit_note')),
	CONSTRAINT "carrier_invoices_status_chk" CHECK ("carrier_invoices"."status" in ('active', 'replaced', 'voided')),
	CONSTRAINT "carrier_invoices_file_kind_chk" CHECK ("carrier_invoices"."file_kind" in ('xlsx', 'csv', 'csv_text')),
	CONSTRAINT "carrier_invoices_sha_chk" CHECK ("carrier_invoices"."file_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "carrier_invoices_currency_chk" CHECK ("carrier_invoices"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "finance_change_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"store_id" text DEFAULT 'default' NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"actor_id" text NOT NULL,
	"actor_role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_change_log_entity_chk" CHECK ("finance_change_log"."entity_type" in ('expense', 'expense_allocation', 'stock_item_cost', 'batch_cost', 'material_cost', 'fx_rate', 'fx_conversion', 'fee_rule', 'partner', 'partner_code', 'partner_rate', 'partner_attribution', 'payout', 'import_profile', 'carrier_invoice', 'invoice_line_match', 'discrepancy', 'chargeback', 'order_component_override', 'period', 'report_snapshot', 'settings_finance', 'valuation_completion')),
	CONSTRAINT "finance_change_log_action_chk" CHECK ("finance_change_log"."action" in ('create', 'update', 'void', 'replace', 'resolve', 'match', 'unmatch', 'close', 'reopen', 'confirm')),
	CONSTRAINT "finance_change_log_reason_chk" CHECK ("finance_change_log"."reason" is null or char_length("finance_change_log"."reason") <= 300)
);
--> statement-breakpoint
CREATE TABLE "finance_discrepancies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text DEFAULT 'default' NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"severity" text DEFAULT 'warning' NOT NULL,
	"order_id" uuid,
	"shipment_id" uuid,
	"invoice_line_id" uuid,
	"carrier_code" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resolution_code" text,
	"resolution_note" text,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"dedupe_key" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_discrepancies_type_chk" CHECK ("finance_discrepancies"."type" in ('unmatched_waybill', 'unrecognized_number', 'invalid_number', 'ambiguous_match', 'carrier_mismatch', 'shipment_cancelled', 'shipment_not_handed_over', 'order_not_recognized', 'currency_mismatch', 'amount_vs_forecast', 'weight_mismatch', 'shipping_loss', 'duplicate_in_file', 'possible_double_billing', 'similar_document', 'credit_without_charge', 'invoice_total_mismatch', 'manual_cost_exists', 'test_waybill_in_production', 'fx_rate_conflict', 'cost_state_out_of_sync', 'reconciliation_mismatch', 'partner_attribution_ambiguous', 'chargeback_refund_overlap', 'chargeback_fee_overlap', 'order_unreadable')),
	CONSTRAINT "finance_discrepancies_status_chk" CHECK ("finance_discrepancies"."status" in ('open', 'resolved', 'ignored')),
	CONSTRAINT "finance_discrepancies_severity_chk" CHECK ("finance_discrepancies"."severity" in ('warning', 'critical')),
	CONSTRAINT "finance_discrepancies_resolution_chk" CHECK ("finance_discrepancies"."resolution_code" is null or "finance_discrepancies"."resolution_code" in ('accepted', 'matched', 'expense_without_order', 'replaced_manual', 'kept_both', 'marked_duplicate', 'credit_expected', 'confirmed', 'linked_as_specification', 'not_ours', 'fixed_file', 'partner_chosen', 'auto_resolved', 'other'))
);
--> statement-breakpoint
CREATE TABLE "finance_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "finance_entries_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" text DEFAULT 'default' NOT NULL,
	"idempotency_key" text NOT NULL,
	"category" text NOT NULL,
	"recognized_on" date NOT NULL,
	"original_on" date NOT NULL,
	"fx_on" date NOT NULL,
	"is_late" boolean DEFAULT false NOT NULL,
	"is_late_completion" boolean DEFAULT false NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" char(3) NOT NULL,
	"presentment_amount" numeric(14, 2),
	"presentment_currency" char(3),
	"order_id" uuid,
	"order_line_item_id" uuid,
	"variant_id" uuid,
	"stock_item_id" uuid,
	"quantity" integer,
	"shipment_id" uuid,
	"partner_id" uuid,
	"carrier_code" text,
	"country_code" char(2),
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"reverses_entry_id" uuid,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"posted_by" text NOT NULL,
	CONSTRAINT "finance_entries_amount_chk" CHECK ("finance_entries"."amount" <> 0),
	CONSTRAINT "finance_entries_key_len_chk" CHECK (char_length("finance_entries"."idempotency_key") between 1 and 200),
	CONSTRAINT "finance_entries_category_chk" CHECK ("finance_entries"."category" in ('sales_product', 'sales_shipping', 'sales_other', 'sales_adjustment', 'sales_unknown', 'refund_product', 'refund_shipping', 'refund_other', 'refund_adjustment', 'refund_unknown', 'chargeback_loss', 'cogs', 'cogs_return', 'cogs_adjustment', 'shipping_cost', 'return_shipping_cost', 'return_handling', 'duties_paid', 'packaging', 'payment_fees', 'platform_fees', 'chargeback_fees', 'partner_commission', 'shipping_unallocated', 'packaging_unlinked', 'advertising', 'partner_fixed_fee', 'inventory_loss', 'salaries', 'rent', 'services', 'bank_fees', 'other_expense', 'inventory_gain', 'other_income', 'fx_difference', 'taxes_company', 'tax_collected_memo', 'discount_memo', 'gift_card_memo', 'production_capitalized_memo', 'materials_purchased_memo', 'partner_payout_memo', 'shopify_fx_adjustment_memo')),
	CONSTRAINT "finance_entries_source_type_chk" CHECK ("finance_entries"."source_type" in ('shopify_sale', 'shopify_fee', 'shopify_transaction', 'valuation', 'owner_standard', 'cost_adjustment', 'invoice_line', 'expense', 'allocation', 'partner_event', 'partner_payout', 'chargeback', 'fx_conversion', 'owner_confirmation', 'demo')),
	CONSTRAINT "finance_entries_currency_chk" CHECK ("finance_entries"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "finance_entries_presentment_currency_chk" CHECK ("finance_entries"."presentment_currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "finance_entries_presentment_chk" CHECK (("finance_entries"."presentment_amount" is null) = ("finance_entries"."presentment_currency" is null))
);
--> statement-breakpoint
CREATE TABLE "finance_expense_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expense_id" uuid NOT NULL,
	"expense_version" integer NOT NULL,
	"order_id" uuid NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" char(3) NOT NULL,
	"weight_basis" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_expense_allocations_basis_chk" CHECK ("finance_expense_allocations"."weight_basis" in ('forecast', 'revenue')),
	CONSTRAINT "finance_expense_allocations_currency_chk" CHECK ("finance_expense_allocations"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "finance_expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text DEFAULT 'default' NOT NULL,
	"category" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" char(3) NOT NULL,
	"expense_date" date,
	"period_from" date,
	"period_to" date,
	"description" text,
	"channel" text,
	"gateway" text,
	"carrier_code" text,
	"partner_id" uuid,
	"order_id" uuid,
	"return_id" uuid,
	"production_batch_id" uuid,
	"document" text,
	"covers_forecast" boolean DEFAULT false NOT NULL,
	"separate_from_forecast" boolean DEFAULT false NOT NULL,
	"separate_reason" text,
	"status" text DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"operation_id" uuid NOT NULL,
	"supersedes_id" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	CONSTRAINT "finance_expenses_operation_id_unique" UNIQUE("operation_id"),
	CONSTRAINT "finance_expenses_category_chk" CHECK ("finance_expenses"."category" in ('return_shipping_cost', 'return_handling', 'shipping_cost', 'duties_paid', 'packaging', 'payment_fees', 'platform_fees', 'chargeback_fees', 'other_expense', 'advertising', 'partner_fixed_fee', 'salaries', 'rent', 'services', 'bank_fees', 'taxes_company', 'fx_difference', 'other_income', 'inventory_loss')),
	CONSTRAINT "finance_expenses_amount_chk" CHECK ("finance_expenses"."amount" <> 0),
	CONSTRAINT "finance_expenses_status_chk" CHECK ("finance_expenses"."status" in ('active', 'voided')),
	CONSTRAINT "finance_expenses_channel_chk" CHECK ("finance_expenses"."channel" is null or "finance_expenses"."channel" in ('meta', 'google', 'tiktok', 'instagram', 'influencer', 'other')),
	CONSTRAINT "finance_expenses_order_required_chk" CHECK ("finance_expenses"."category" not in ('return_shipping_cost', 'return_handling') or "finance_expenses"."order_id" is not null),
	CONSTRAINT "finance_expenses_order_forbidden_chk" CHECK ("finance_expenses"."category" not in ('advertising', 'partner_fixed_fee', 'salaries', 'rent', 'services', 'bank_fees', 'taxes_company', 'fx_difference', 'other_income', 'inventory_loss') or ("finance_expenses"."order_id" is null and "finance_expenses"."return_id" is null)),
	CONSTRAINT "finance_expenses_batch_chk" CHECK (("finance_expenses"."category" = 'inventory_loss') = ("finance_expenses"."production_batch_id" is not null)),
	CONSTRAINT "finance_expenses_partner_chk" CHECK ("finance_expenses"."category" <> 'partner_fixed_fee' or "finance_expenses"."partner_id" is not null),
	CONSTRAINT "finance_expenses_return_chk" CHECK ("finance_expenses"."return_id" is null or "finance_expenses"."order_id" is not null),
	CONSTRAINT "finance_expenses_date_chk" CHECK (("finance_expenses"."expense_date" is not null) or ("finance_expenses"."period_from" is not null and "finance_expenses"."period_to" is not null)),
	CONSTRAINT "finance_expenses_period_chk" CHECK (("finance_expenses"."period_from" is null) = ("finance_expenses"."period_to" is null) and ("finance_expenses"."period_from" is null or ("finance_expenses"."period_from" <= "finance_expenses"."period_to" and "finance_expenses"."period_to" - "finance_expenses"."period_from" < 366))),
	CONSTRAINT "finance_expenses_forecast_chk" CHECK (not ("finance_expenses"."covers_forecast" and "finance_expenses"."separate_from_forecast") and (not "finance_expenses"."separate_from_forecast" or "finance_expenses"."separate_reason" is not null)),
	CONSTRAINT "finance_expenses_description_chk" CHECK ("finance_expenses"."description" is null or char_length("finance_expenses"."description") <= 200),
	CONSTRAINT "finance_expenses_currency_chk" CHECK ("finance_expenses"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "finance_fee_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text DEFAULT 'default' NOT NULL,
	"gateway" text NOT NULL,
	"kind" text NOT NULL,
	"percent_bp" integer DEFAULT 0 NOT NULL,
	"fixed_amount" numeric(14, 2),
	"fixed_currency" char(3),
	"no_fees" boolean DEFAULT false NOT NULL,
	"applies_from" date NOT NULL,
	"applies_to" date,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_fee_rules_kind_chk" CHECK ("finance_fee_rules"."kind" in ('payment', 'platform')),
	CONSTRAINT "finance_fee_rules_percent_chk" CHECK ("finance_fee_rules"."percent_bp" between 0 and 10000),
	CONSTRAINT "finance_fee_rules_fixed_chk" CHECK (("finance_fee_rules"."fixed_amount" is null) = ("finance_fee_rules"."fixed_currency" is null) and ("finance_fee_rules"."fixed_amount" is null or "finance_fee_rules"."fixed_amount" >= 0)),
	CONSTRAINT "finance_fee_rules_period_chk" CHECK ("finance_fee_rules"."applies_to" is null or "finance_fee_rules"."applies_from" <= "finance_fee_rules"."applies_to"),
	CONSTRAINT "finance_fee_rules_currency_chk" CHECK ("finance_fee_rules"."fixed_currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "finance_periods" (
	"store_id" text DEFAULT 'default' NOT NULL,
	"month" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"checklist" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"net_profit_eligible" boolean DEFAULT false NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" text,
	"reopened_at" timestamp with time zone,
	"reopened_by" text,
	"reopen_reason" text,
	"snapshot_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_periods_pk" PRIMARY KEY("store_id","month"),
	CONSTRAINT "finance_periods_status_chk" CHECK ("finance_periods"."status" in ('open', 'closed')),
	CONSTRAINT "finance_periods_month_chk" CHECK (extract(day from "finance_periods"."month") = 1)
);
--> statement-breakpoint
CREATE TABLE "finance_report_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text DEFAULT 'default' NOT NULL,
	"kind" text NOT NULL,
	"period_from" date NOT NULL,
	"period_to" date NOT NULL,
	"reporting_currency" char(3) NOT NULL,
	"source" text NOT NULL,
	"is_final" boolean DEFAULT false NOT NULL,
	"schema_version" integer NOT NULL,
	"data" jsonb NOT NULL,
	"rates_used" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"data_sha256" char(64) NOT NULL,
	"version" integer NOT NULL,
	"generated_by" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_report_snapshots_kind_chk" CHECK ("finance_report_snapshots"."kind" in ('day', 'week', 'month', 'year', 'custom')),
	CONSTRAINT "finance_report_snapshots_source_chk" CHECK ("finance_report_snapshots"."source" in ('manual', 'scheduled', 'close')),
	CONSTRAINT "finance_report_snapshots_period_chk" CHECK ("finance_report_snapshots"."period_from" <= "finance_report_snapshots"."period_to"),
	CONSTRAINT "finance_report_snapshots_version_chk" CHECK ("finance_report_snapshots"."version" >= 1),
	CONSTRAINT "finance_report_snapshots_currency_chk" CHECK ("finance_report_snapshots"."reporting_currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "finance_state" (
	"store_id" text PRIMARY KEY NOT NULL,
	"reconcile_watermark" timestamp with time zone,
	"valuation_backfilled_at" timestamp with time zone,
	"backfilled_at" timestamp with time zone,
	"backfill_cursor" text,
	"fx_fetched_at" timestamp with time zone,
	"fx_fetch_status" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fx_conversions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text DEFAULT 'default' NOT NULL,
	"occurred_on" date NOT NULL,
	"sold_amount" numeric(14, 2) NOT NULL,
	"sold_currency" char(3) NOT NULL,
	"bought_amount" numeric(14, 2) NOT NULL,
	"bought_currency" char(3) NOT NULL,
	"counterparty" text DEFAULT 'bank' NOT NULL,
	"note" text,
	"status" text DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"operation_id" uuid NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	CONSTRAINT "fx_conversions_operation_id_unique" UNIQUE("operation_id"),
	CONSTRAINT "fx_conversions_amounts_chk" CHECK ("fx_conversions"."sold_amount" > 0 and "fx_conversions"."bought_amount" > 0),
	CONSTRAINT "fx_conversions_currencies_chk" CHECK ("fx_conversions"."sold_currency" <> "fx_conversions"."bought_currency"),
	CONSTRAINT "fx_conversions_counterparty_chk" CHECK ("fx_conversions"."counterparty" in ('bank', 'payment_provider', 'other')),
	CONSTRAINT "fx_conversions_status_chk" CHECK ("fx_conversions"."status" in ('active', 'voided')),
	CONSTRAINT "fx_conversions_sold_currency_chk" CHECK ("fx_conversions"."sold_currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "fx_conversions_bought_currency_chk" CHECK ("fx_conversions"."bought_currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "fx_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"currency" char(3) NOT NULL,
	"quote_currency" char(3) DEFAULT 'UAH' NOT NULL,
	"effective_date" date NOT NULL,
	"rate" numeric(18, 6) NOT NULL,
	"units" integer DEFAULT 1 NOT NULL,
	"rate_per_unit" numeric(20, 10) NOT NULL,
	"set_on" date,
	"version" integer DEFAULT 1 NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"entered_by" text,
	"reason" text,
	"fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_rates_source_chk" CHECK ("fx_rates"."source" in ('nbu', 'manual', 'demo')),
	CONSTRAINT "fx_rates_units_chk" CHECK ("fx_rates"."units" in (1, 10, 100, 1000, 10000)),
	CONSTRAINT "fx_rates_rate_chk" CHECK ("fx_rates"."rate" > 0),
	CONSTRAINT "fx_rates_per_unit_chk" CHECK ("fx_rates"."rate_per_unit" * "fx_rates"."units" = "fx_rates"."rate"),
	CONSTRAINT "fx_rates_not_self_chk" CHECK ("fx_rates"."currency" <> "fx_rates"."quote_currency"),
	CONSTRAINT "fx_rates_version_chk" CHECK ("fx_rates"."version" >= 1),
	CONSTRAINT "fx_rates_currency_chk" CHECK ("fx_rates"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "fx_rates_quote_currency_chk" CHECK ("fx_rates"."quote_currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "inventory_cost_layers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"stock_item_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"qty_in" integer NOT NULL,
	"qty_open" integer NOT NULL,
	"value_open" numeric(14, 2),
	"pending_unit_cost" numeric(14, 2),
	"pending_currency" char(3),
	"source_valuation_id" uuid,
	"origin_valuation_id" uuid,
	"created_seq" bigint NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_cost_layers_kind_chk" CHECK ("inventory_cost_layers"."kind" in ('unknown', 'deficit', 'defect')),
	CONSTRAINT "inventory_cost_layers_reason_chk" CHECK ("inventory_cost_layers"."reason" in ('opening', 'receipt_without_cost', 'fx_pending', 'surplus_without_cost', 'return_without_cost', 'deficit', 'defect_mark')),
	CONSTRAINT "inventory_cost_layers_qty_chk" CHECK ("inventory_cost_layers"."qty_in" > 0 and "inventory_cost_layers"."qty_open" >= 0 and "inventory_cost_layers"."qty_open" <= "inventory_cost_layers"."qty_in"),
	CONSTRAINT "inventory_cost_layers_value_chk" CHECK ("inventory_cost_layers"."value_open" is null or ("inventory_cost_layers"."kind" = 'defect' and "inventory_cost_layers"."value_open" >= 0)),
	CONSTRAINT "inventory_cost_layers_pending_chk" CHECK (("inventory_cost_layers"."pending_unit_cost" is null) = ("inventory_cost_layers"."pending_currency" is null) and ("inventory_cost_layers"."pending_unit_cost" is null or "inventory_cost_layers"."pending_unit_cost" >= 0)),
	CONSTRAINT "inventory_cost_layers_pending_currency_chk" CHECK ("inventory_cost_layers"."pending_currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "inventory_cost_state" (
	"warehouse_id" uuid NOT NULL,
	"stock_item_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"known_qty" integer DEFAULT 0 NOT NULL,
	"known_value" numeric(14, 2) DEFAULT '0' NOT NULL,
	"unknown_qty" integer DEFAULT 0 NOT NULL,
	"deficit_qty" integer DEFAULT 0 NOT NULL,
	"last_avg_unit" numeric(20, 10),
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_cost_state_pk" PRIMARY KEY("warehouse_id","stock_item_id"),
	CONSTRAINT "inventory_cost_state_nonneg_chk" CHECK ("inventory_cost_state"."known_qty" >= 0 and "inventory_cost_state"."known_value" >= 0 and "inventory_cost_state"."unknown_qty" >= 0 and "inventory_cost_state"."deficit_qty" >= 0),
	CONSTRAINT "inventory_cost_state_currency_chk" CHECK ("inventory_cost_state"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "inventory_valuation_completions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"valuation_id" uuid NOT NULL,
	"layer_id" uuid,
	"qty" integer NOT NULL,
	"value" numeric(14, 2) NOT NULL,
	"basis" text NOT NULL,
	"event_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_valuation_completions_event_key_unique" UNIQUE("event_key"),
	CONSTRAINT "inventory_valuation_completions_qty_chk" CHECK ("inventory_valuation_completions"."qty" > 0 and "inventory_valuation_completions"."value" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_valuations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "inventory_valuations_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"movement_seq" bigint,
	"event_key" text NOT NULL,
	"movement_id" uuid,
	"warehouse_id" uuid NOT NULL,
	"stock_item_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"kind" text NOT NULL,
	"qty" integer NOT NULL,
	"known_qty" integer DEFAULT 0 NOT NULL,
	"unknown_qty" integer DEFAULT 0 NOT NULL,
	"deficit_qty" integer DEFAULT 0 NOT NULL,
	"value" numeric(14, 2),
	"value_source" text NOT NULL,
	"drawn_layers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"returned_qty" integer DEFAULT 0 NOT NULL,
	"original_amount" numeric(14, 2),
	"original_currency" char(3),
	"rate_date" date,
	"rate_source" text,
	"order_id" uuid,
	"order_line_item_id" uuid,
	"known_qty_after" integer,
	"known_value_after" numeric(14, 2),
	"unknown_qty_after" integer,
	"deficit_qty_after" integer,
	"occurred_on" date NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_valuations_event_key_unique" UNIQUE("event_key"),
	CONSTRAINT "inventory_valuations_movement_id_unique" UNIQUE("movement_id"),
	CONSTRAINT "inventory_valuations_kind_chk" CHECK ("inventory_valuations"."kind" in ('inflow', 'outflow', 'revaluation', 'stock_completion', 'sale_completion')),
	CONSTRAINT "inventory_valuations_value_source_chk" CHECK ("inventory_valuations"."value_source" in ('movement_cost', 'batch', 'original_sale', 'pool_average', 'owner_standard', 'catalogue', 'zero', 'none')),
	CONSTRAINT "inventory_valuations_qty_chk" CHECK ("inventory_valuations"."qty" >= 0 and "inventory_valuations"."known_qty" >= 0 and "inventory_valuations"."unknown_qty" >= 0 and "inventory_valuations"."deficit_qty" >= 0 and "inventory_valuations"."returned_qty" >= 0),
	CONSTRAINT "inventory_valuations_currency_chk" CHECK ("inventory_valuations"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "inventory_valuations_original_currency_chk" CHECK ("inventory_valuations"."original_currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "order_disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text DEFAULT 'default' NOT NULL,
	"order_id" uuid NOT NULL,
	"dispute_gid" text NOT NULL,
	"initiated_as" text,
	"status" text,
	"amount" numeric(14, 2),
	"recovered_amount" numeric(14, 2),
	"vat_reducible" boolean,
	"full_partner_cancellation" boolean DEFAULT false NOT NULL,
	"currency" char(3),
	"fee" numeric(14, 2),
	"fee_currency" char(3),
	"outcome" text,
	"decided_on" date,
	"source" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status_changed_at" timestamp with time zone,
	"updated_by" text,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "order_disputes_outcome_chk" CHECK ("order_disputes"."outcome" is null or "order_disputes"."outcome" in ('lost', 'accepted', 'won', 'prevented')),
	CONSTRAINT "order_disputes_source_chk" CHECK ("order_disputes"."source" in ('shopify', 'manual', 'demo')),
	CONSTRAINT "order_disputes_amounts_chk" CHECK (("order_disputes"."amount" is null or "order_disputes"."amount" >= 0) and ("order_disputes"."recovered_amount" is null or "order_disputes"."recovered_amount" >= 0) and ("order_disputes"."fee" is null or "order_disputes"."fee" >= 0)),
	CONSTRAINT "order_disputes_currency_chk" CHECK ("order_disputes"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "order_disputes_fee_currency_chk" CHECK ("order_disputes"."fee_currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "order_external_waybills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text DEFAULT 'default' NOT NULL,
	"order_id" uuid NOT NULL,
	"carrier_code" text,
	"number_norm" text NOT NULL,
	"number_class" text NOT NULL,
	"source" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_external_waybills_source_chk" CHECK ("order_external_waybills"."source" in ('shopify_fulfillment', 'manual', 'demo')),
	CONSTRAINT "order_external_waybills_class_chk" CHECK ("order_external_waybills"."number_class" in ('ua14', 'eu', 'test', 'unrecognized'))
);
--> statement-breakpoint
CREATE TABLE "order_finance" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"store_id" text DEFAULT 'default' NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"recognized_on" date,
	"recognized_at" timestamp with time zone,
	"recognition_basis" text,
	"shop_currency" char(3),
	"components" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"profit_state" text DEFAULT 'n/a' NOT NULL,
	"needs_review" boolean DEFAULT false NOT NULL,
	"review_reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"facts_source" text DEFAULT 'none' NOT NULL,
	"facts_fetched_at" timestamp with time zone,
	"shopify_updated_at" timestamp with time zone,
	"overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_finance_state_chk" CHECK ("order_finance"."state" in ('open', 'recognized', 'closed_unrecognized', 'excluded')),
	CONSTRAINT "order_finance_profit_state_chk" CHECK ("order_finance"."profit_state" in ('final', 'preliminary', 'incomplete', 'n/a')),
	CONSTRAINT "order_finance_basis_chk" CHECK ("order_finance"."recognition_basis" in ('handover', 'consume', 'placed_fallback')),
	CONSTRAINT "order_finance_facts_source_chk" CHECK ("order_finance"."facts_source" in ('shopify', 'demo', 'order_snapshot', 'none')),
	CONSTRAINT "order_finance_recognized_chk" CHECK (("order_finance"."state" <> 'recognized' or "order_finance"."recognized_on" is not null) and ("order_finance"."recognized_on" is null) = ("order_finance"."recognized_at" is null)),
	CONSTRAINT "order_finance_shop_currency_chk" CHECK ("order_finance"."shop_currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "order_finance_forecasts" (
	"order_id" uuid NOT NULL,
	"component" text NOT NULL,
	"currency" char(3) NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"basis" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_finance_forecasts_pk" PRIMARY KEY("order_id","component","currency"),
	CONSTRAINT "order_finance_forecasts_component_chk" CHECK ("order_finance_forecasts"."component" in ('revenue', 'cogs', 'packaging', 'shipping_cost', 'fees', 'partner', 'duties_paid')),
	CONSTRAINT "order_finance_forecasts_basis_chk" CHECK ("order_finance_forecasts"."basis" in ('shopify', 'demo', 'invoice', 'valuation', 'owner_standard', 'unconfirmed_standard', 'allocated', 'carrier_reported', 'country_average', 'owner_table', 'fee_rule', 'kit_plan', 'pool_average', 'last_batch', 'catalogue', 'order_snapshot', 'owner_confirmed', 'manual')),
	CONSTRAINT "order_finance_forecasts_currency_chk" CHECK ("order_finance_forecasts"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "order_refund_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"refund_id" uuid NOT NULL,
	"shopify_line_item_id" text NOT NULL,
	"order_line_item_id" uuid,
	"quantity" integer NOT NULL,
	"restock_type" text,
	"restocked" boolean,
	"subtotal" numeric(14, 2),
	"currency" char(3),
	CONSTRAINT "order_refund_lines_currency_chk" CHECK ("order_refund_lines"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "order_refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text DEFAULT 'default' NOT NULL,
	"order_id" uuid NOT NULL,
	"shopify_refund_id" text NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at_shopify" timestamp with time zone,
	"total" numeric(14, 2) NOT NULL,
	"currency" char(3) NOT NULL,
	"p_total" numeric(14, 2),
	"p_currency" char(3),
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_refunds_currency_chk" CHECK ("order_refunds"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "order_refunds_p_currency_chk" CHECK ("order_refunds"."p_currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "order_return_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"return_id" uuid NOT NULL,
	"order_line_item_id" uuid,
	"variant_id" uuid,
	"quantity" integer NOT NULL,
	"condition" text DEFAULT 'unknown' NOT NULL,
	"restocked_qty" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_return_lines_qty_chk" CHECK ("order_return_lines"."quantity" > 0 and "order_return_lines"."restocked_qty" >= 0 and "order_return_lines"."restocked_qty" <= "order_return_lines"."quantity"),
	CONSTRAINT "order_return_lines_condition_chk" CHECK ("order_return_lines"."condition" in ('resellable', 'damaged', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "order_returns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text DEFAULT 'default' NOT NULL,
	"order_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"reason_code" text DEFAULT 'unknown' NOT NULL,
	"reason_note" text,
	"source" text NOT NULL,
	"source_key" text NOT NULL,
	"first_signal_at" timestamp with time zone DEFAULT now() NOT NULL,
	"received_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_returns_source_key_unique" UNIQUE("source_key"),
	CONSTRAINT "order_returns_kind_chk" CHECK ("order_returns"."kind" in ('customer_return', 'carrier_return', 'refused', 'lost', 'refund_only', 'other')),
	CONSTRAINT "order_returns_status_chk" CHECK ("order_returns"."status" in ('open', 'in_transit', 'received', 'closed')),
	CONSTRAINT "order_returns_reason_chk" CHECK ("order_returns"."reason_code" in ('defective', 'damaged_in_transit', 'wrong_item', 'not_as_described', 'size_or_fit', 'changed_mind', 'too_late', 'refused_delivery', 'customs_refused', 'address_problem', 'other', 'unknown')),
	CONSTRAINT "order_returns_source_chk" CHECK ("order_returns"."source" in ('shopify_refund', 'stock_receipt', 'carrier_hint', 'manual', 'demo')),
	CONSTRAINT "order_returns_note_chk" CHECK ("order_returns"."reason_note" is null or char_length("order_returns"."reason_note") <= 300)
);
--> statement-breakpoint
CREATE TABLE "order_sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text DEFAULT 'default' NOT NULL,
	"order_id" uuid NOT NULL,
	"shopify_sale_id" text NOT NULL,
	"agreement_id" text NOT NULL,
	"agreement_kind" text NOT NULL,
	"agreement_reason" text,
	"happened_at" timestamp with time zone NOT NULL,
	"refund_id" text,
	"action_type" text NOT NULL,
	"line_type" text NOT NULL,
	"quantity" integer,
	"line_item_gid" text,
	"order_line_item_id" uuid,
	"total_amount" numeric(14, 2) NOT NULL,
	"total_tax" numeric(14, 2) NOT NULL,
	"discount_before_tax" numeric(14, 2),
	"currency" char(3) NOT NULL,
	"p_total_amount" numeric(14, 2) NOT NULL,
	"p_total_tax" numeric(14, 2) NOT NULL,
	"p_currency" char(3) NOT NULL,
	"source" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_sales_agreement_kind_chk" CHECK ("order_sales"."agreement_kind" in ('order', 'order_edit', 'refund', 'return', 'unknown')),
	CONSTRAINT "order_sales_source_chk" CHECK ("order_sales"."source" in ('shopify', 'demo')),
	CONSTRAINT "order_sales_currency_chk" CHECK ("order_sales"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "order_sales_p_currency_chk" CHECK ("order_sales"."p_currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "order_shopify_finance" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"store_id" text DEFAULT 'default' NOT NULL,
	"shop_currency" char(3),
	"presentment_currency" char(3),
	"taxes_included" boolean,
	"edited" boolean,
	"return_status" text,
	"display_financial_status" text,
	"payment_gateway_names" text[] DEFAULT '{}'::text[] NOT NULL,
	"discount_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"referral_code" text,
	"journey_ready" boolean,
	"journey_checks" smallint DEFAULT 0 NOT NULL,
	"transactions_count" integer,
	"snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reconciliation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"shopify_updated_at" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_shopify_finance_shop_currency_chk" CHECK ("order_shopify_finance"."shop_currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "order_shopify_finance_presentment_currency_chk" CHECK ("order_shopify_finance"."presentment_currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "order_transaction_fees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text DEFAULT 'default' NOT NULL,
	"transaction_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"shopify_fee_id" text NOT NULL,
	"type" text,
	"amount" numeric(14, 2) NOT NULL,
	"currency" char(3) NOT NULL,
	"flat_fee" numeric(14, 2),
	"flat_fee_currency" char(3),
	"rate" text,
	"rate_name" text,
	"tax_amount" numeric(14, 2),
	"tax_currency" char(3),
	"created_at_shopify" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_transaction_fees_currency_chk" CHECK ("order_transaction_fees"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "order_transaction_fees_flat_currency_chk" CHECK ("order_transaction_fees"."flat_fee_currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "order_transaction_fees_tax_currency_chk" CHECK ("order_transaction_fees"."tax_currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "order_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text DEFAULT 'default' NOT NULL,
	"order_id" uuid NOT NULL,
	"shopify_transaction_id" text NOT NULL,
	"parent_transaction_id" text,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"test" boolean DEFAULT false NOT NULL,
	"gateway" text,
	"manual_gateway" boolean,
	"amount" numeric(14, 2) NOT NULL,
	"currency" char(3) NOT NULL,
	"p_amount" numeric(14, 2),
	"p_currency" char(3),
	"settlement_currency" char(3),
	"settlement_rate" numeric(20, 10),
	"fx_adjustment_id" text,
	"fx_adjustment" numeric(14, 2),
	"fx_adjustment_currency" char(3),
	"processed_at" timestamp with time zone,
	"created_at_shopify" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_transactions_currency_chk" CHECK ("order_transactions"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "order_transactions_p_currency_chk" CHECK ("order_transactions"."p_currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "order_transactions_settlement_currency_chk" CHECK ("order_transactions"."settlement_currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "order_transactions_fx_currency_chk" CHECK ("order_transactions"."fx_adjustment_currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "partner_attributions" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"store_id" text DEFAULT 'default' NOT NULL,
	"partner_id" uuid,
	"code_id" uuid,
	"source" text NOT NULL,
	"rate_bp" integer,
	"hold_days" integer,
	"status" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"reason" text,
	CONSTRAINT "partner_attributions_source_chk" CHECK ("partner_attributions"."source" in ('discount_code', 'referral', 'owner')),
	CONSTRAINT "partner_attributions_status_chk" CHECK ("partner_attributions"."status" in ('attributed', 'ambiguous', 'removed')),
	CONSTRAINT "partner_attributions_attributed_chk" CHECK ("partner_attributions"."status" <> 'attributed' or ("partner_attributions"."partner_id" is not null and "partner_attributions"."rate_bp" is not null and "partner_attributions"."hold_days" is not null)),
	CONSTRAINT "partner_attributions_rate_chk" CHECK ("partner_attributions"."rate_bp" is null or "partner_attributions"."rate_bp" between 0 and 10000)
);
--> statement-breakpoint
CREATE TABLE "partner_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text DEFAULT 'default' NOT NULL,
	"partner_id" uuid NOT NULL,
	"code" text NOT NULL,
	"code_norm" text NOT NULL,
	"source" text NOT NULL,
	"valid_from" date,
	"valid_to" date,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partner_codes_source_chk" CHECK ("partner_codes"."source" in ('discount_code', 'referral')),
	CONSTRAINT "partner_codes_validity_chk" CHECK ("partner_codes"."valid_from" is null or "partner_codes"."valid_to" is null or "partner_codes"."valid_from" <= "partner_codes"."valid_to")
);
--> statement-breakpoint
CREATE TABLE "partner_commission_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text DEFAULT 'default' NOT NULL,
	"partner_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"n" integer NOT NULL,
	"kind" text NOT NULL,
	"base" numeric(14, 2) NOT NULL,
	"rate_bp" integer NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" char(3) NOT NULL,
	"recognized_on" date NOT NULL,
	"hold_until" date,
	"idempotency_key" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partner_commission_events_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "partner_commission_events_kind_chk" CHECK ("partner_commission_events"."kind" in ('accrual', 'adjustment', 'cancellation', 'manual')),
	CONSTRAINT "partner_commission_events_rate_chk" CHECK ("partner_commission_events"."rate_bp" between 0 and 10000),
	CONSTRAINT "partner_commission_events_currency_chk" CHECK ("partner_commission_events"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "partner_payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text DEFAULT 'default' NOT NULL,
	"partner_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"paid_on" date NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" char(3) NOT NULL,
	"covers_amount" numeric(14, 2) NOT NULL,
	"covers_currency" char(3) NOT NULL,
	"method" text DEFAULT 'bank' NOT NULL,
	"reference" text,
	"note" text,
	"status" text DEFAULT 'active' NOT NULL,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partner_payouts_operation_id_unique" UNIQUE("operation_id"),
	CONSTRAINT "partner_payouts_amount_chk" CHECK ("partner_payouts"."amount" > 0 and "partner_payouts"."covers_amount" > 0),
	CONSTRAINT "partner_payouts_method_chk" CHECK ("partner_payouts"."method" in ('bank', 'card', 'cash', 'other')),
	CONSTRAINT "partner_payouts_status_chk" CHECK ("partner_payouts"."status" in ('active', 'voided')),
	CONSTRAINT "partner_payouts_reference_chk" CHECK ("partner_payouts"."reference" is null or char_length("partner_payouts"."reference") <= 100),
	CONSTRAINT "partner_payouts_currency_chk" CHECK ("partner_payouts"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "partner_payouts_covers_currency_chk" CHECK ("partner_payouts"."covers_currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "partner_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_id" uuid NOT NULL,
	"code_id" uuid,
	"rate_bp" integer NOT NULL,
	"effective_from" date NOT NULL,
	"reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partner_rates_uq" UNIQUE NULLS NOT DISTINCT("partner_id","code_id","effective_from"),
	CONSTRAINT "partner_rates_rate_chk" CHECK ("partner_rates"."rate_bp" between 0 and 10000)
);
--> statement-breakpoint
CREATE TABLE "partners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text DEFAULT 'default' NOT NULL,
	"display_name" text NOT NULL,
	"kind" text DEFAULT 'partner' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"hold_days" integer DEFAULT 30 NOT NULL,
	"payout_currency" char(3),
	"note" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partners_kind_chk" CHECK ("partners"."kind" in ('blogger', 'affiliate', 'partner', 'other')),
	CONSTRAINT "partners_status_chk" CHECK ("partners"."status" in ('active', 'paused', 'archived')),
	CONSTRAINT "partners_hold_chk" CHECK ("partners"."hold_days" between 0 and 365),
	CONSTRAINT "partners_name_chk" CHECK (char_length("partners"."display_name") between 1 and 120),
	CONSTRAINT "partners_payout_currency_chk" CHECK ("partners"."payout_currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "shipment_cost_estimates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text DEFAULT 'default' NOT NULL,
	"shipment_id" uuid NOT NULL,
	"carrier_code" text NOT NULL,
	"kind" text DEFAULT 'carrier_reported' NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" char(3) NOT NULL,
	"currency_assumed" boolean DEFAULT false NOT NULL,
	"service_code" text,
	"payer" text,
	"chargeable_weight_grams" integer,
	"source" text NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipment_cost_estimates_kind_chk" CHECK ("shipment_cost_estimates"."kind" in ('carrier_reported')),
	CONSTRAINT "shipment_cost_estimates_source_chk" CHECK ("shipment_cost_estimates"."source" in ('nova_post_create', 'test_carrier', 'demo')),
	CONSTRAINT "shipment_cost_estimates_amount_chk" CHECK ("shipment_cost_estimates"."amount" >= 0),
	CONSTRAINT "shipment_cost_estimates_currency_chk" CHECK ("shipment_cost_estimates"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "shipping_forecast_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text DEFAULT 'default' NOT NULL,
	"order_id" uuid NOT NULL,
	"waybill_key" text NOT NULL,
	"shipment_id" uuid,
	"external_waybill_id" uuid,
	"carrier_code" text,
	"country_code" char(2),
	"basis" text NOT NULL,
	"amount" numeric(14, 2),
	"currency" char(3),
	"basis_details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"late_snapshot" boolean DEFAULT false NOT NULL,
	"frozen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipping_forecast_snapshots_basis_chk" CHECK ("shipping_forecast_snapshots"."basis" in ('carrier_reported', 'country_average', 'owner_table', 'none')),
	CONSTRAINT "shipping_forecast_snapshots_amount_chk" CHECK (("shipping_forecast_snapshots"."basis" = 'none') = ("shipping_forecast_snapshots"."amount" is null) and ("shipping_forecast_snapshots"."amount" is null) = ("shipping_forecast_snapshots"."currency" is null)),
	CONSTRAINT "shipping_forecast_snapshots_currency_chk" CHECK ("shipping_forecast_snapshots"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "stock_item_costs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stock_item_id" uuid NOT NULL,
	"unit_cost" numeric(14, 2) NOT NULL,
	"currency" char(3) NOT NULL,
	"effective_from" date NOT NULL,
	"source" text NOT NULL,
	"confirmed" boolean DEFAULT true NOT NULL,
	"note" text,
	"idempotency_key" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_item_costs_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "stock_item_costs_source_chk" CHECK ("stock_item_costs"."source" in ('manual', 'bulk_model_color', 'material_catalogue', 'shopify_unit_cost', 'demo')),
	CONSTRAINT "stock_item_costs_cost_chk" CHECK ("stock_item_costs"."unit_cost" >= 0),
	CONSTRAINT "stock_item_costs_currency_chk" CHECK ("stock_item_costs"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "stores" (
	"id" text PRIMARY KEY NOT NULL,
	"shop_domain" text,
	"name" text NOT NULL,
	"shop_currency" char(3),
	"legal_entity_id" uuid,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stores_shop_domain_unique" UNIQUE("shop_domain"),
	CONSTRAINT "stores_shop_currency_chk" CHECK ("stores"."shop_currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
-- Етап 6 (docs/stage6-design.md §6.4): inventory_movements.seq — ручні оператори замість згенерованого
-- «ADD COLUMN … GENERATED ALWAYS AS IDENTITY» (він нумерує наявні рядки у фізичному порядку, а пізніший UPDATE такої
-- колонки заборонено). (1) колонка без identity; (2) нумерація наявних рядків: created_at (у межах однієї транзакції
-- однаковий), потім входи перед виходами (on_hand_delta > 0, = 0, < 0), потім ключ ідемпотентності (id випадковий);
-- (3) NOT NULL; (4) identity з тим самим ім'ям послідовності, що й у знімку drizzle; (5) послідовність — на max(seq);
-- (6) унікальний індекс inventory_movements_seq_uq — наприкінці файла.
ALTER TABLE "inventory_movements" ADD COLUMN "seq" bigint;--> statement-breakpoint
UPDATE "inventory_movements" AS m SET "seq" = o."rn"
FROM (
  SELECT "id", row_number() OVER (
    ORDER BY "created_at",
      CASE WHEN "on_hand_delta" > 0 THEN 0 WHEN "on_hand_delta" = 0 THEN 1 ELSE 2 END,
      "idempotency_key"
  ) AS "rn"
  FROM "inventory_movements"
) AS o
WHERE o."id" = m."id";--> statement-breakpoint
ALTER TABLE "inventory_movements" ALTER COLUMN "seq" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_movements" ALTER COLUMN "seq" ADD GENERATED ALWAYS AS IDENTITY (sequence name "inventory_movements_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1);--> statement-breakpoint
SELECT setval(pg_get_serial_sequence('inventory_movements', 'seq'), coalesce((SELECT max("seq") FROM "inventory_movements"), 0) + 1, false);--> statement-breakpoint
ALTER TABLE "order_line_items" ADD COLUMN "requires_shipping" boolean;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shopify_test" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "carrier_import_profiles" ADD CONSTRAINT "carrier_import_profiles_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_invoice_lines" ADD CONSTRAINT "carrier_invoice_lines_invoice_id_carrier_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."carrier_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_invoices" ADD CONSTRAINT "carrier_invoices_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_invoices" ADD CONSTRAINT "carrier_invoices_parent_invoice_id_carrier_invoices_id_fk" FOREIGN KEY ("parent_invoice_id") REFERENCES "public"."carrier_invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_invoices" ADD CONSTRAINT "carrier_invoices_profile_id_carrier_import_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."carrier_import_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_invoices" ADD CONSTRAINT "carrier_invoices_replaces_id_carrier_invoices_id_fk" FOREIGN KEY ("replaces_id") REFERENCES "public"."carrier_invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_change_log" ADD CONSTRAINT "finance_change_log_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_discrepancies" ADD CONSTRAINT "finance_discrepancies_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_discrepancies" ADD CONSTRAINT "finance_discrepancies_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_entries" ADD CONSTRAINT "finance_entries_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_entries" ADD CONSTRAINT "finance_entries_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_entries" ADD CONSTRAINT "finance_entries_reverses_entry_id_finance_entries_id_fk" FOREIGN KEY ("reverses_entry_id") REFERENCES "public"."finance_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_expense_allocations" ADD CONSTRAINT "finance_expense_allocations_expense_id_finance_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."finance_expenses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_expense_allocations" ADD CONSTRAINT "finance_expense_allocations_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_expenses" ADD CONSTRAINT "finance_expenses_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_expenses" ADD CONSTRAINT "finance_expenses_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_expenses" ADD CONSTRAINT "finance_expenses_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_expenses" ADD CONSTRAINT "finance_expenses_return_id_order_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."order_returns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_expenses" ADD CONSTRAINT "finance_expenses_production_batch_id_production_batches_id_fk" FOREIGN KEY ("production_batch_id") REFERENCES "public"."production_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_expenses" ADD CONSTRAINT "finance_expenses_supersedes_id_finance_expenses_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."finance_expenses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_fee_rules" ADD CONSTRAINT "finance_fee_rules_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_periods" ADD CONSTRAINT "finance_periods_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_report_snapshots" ADD CONSTRAINT "finance_report_snapshots_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_state" ADD CONSTRAINT "finance_state_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_conversions" ADD CONSTRAINT "fx_conversions_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_cost_layers" ADD CONSTRAINT "inventory_cost_layers_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_cost_layers" ADD CONSTRAINT "inventory_cost_layers_stock_item_id_stock_items_id_fk" FOREIGN KEY ("stock_item_id") REFERENCES "public"."stock_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_cost_layers" ADD CONSTRAINT "inventory_cost_layers_source_valuation_id_inventory_valuations_id_fk" FOREIGN KEY ("source_valuation_id") REFERENCES "public"."inventory_valuations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_cost_layers" ADD CONSTRAINT "inventory_cost_layers_origin_valuation_id_inventory_valuations_id_fk" FOREIGN KEY ("origin_valuation_id") REFERENCES "public"."inventory_valuations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_cost_state" ADD CONSTRAINT "inventory_cost_state_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_cost_state" ADD CONSTRAINT "inventory_cost_state_stock_item_id_stock_items_id_fk" FOREIGN KEY ("stock_item_id") REFERENCES "public"."stock_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_valuation_completions" ADD CONSTRAINT "inventory_valuation_completions_valuation_id_inventory_valuations_id_fk" FOREIGN KEY ("valuation_id") REFERENCES "public"."inventory_valuations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_valuation_completions" ADD CONSTRAINT "inventory_valuation_completions_layer_id_inventory_cost_layers_id_fk" FOREIGN KEY ("layer_id") REFERENCES "public"."inventory_cost_layers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_valuations" ADD CONSTRAINT "inventory_valuations_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_valuations" ADD CONSTRAINT "inventory_valuations_stock_item_id_stock_items_id_fk" FOREIGN KEY ("stock_item_id") REFERENCES "public"."stock_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_disputes" ADD CONSTRAINT "order_disputes_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_disputes" ADD CONSTRAINT "order_disputes_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_external_waybills" ADD CONSTRAINT "order_external_waybills_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_external_waybills" ADD CONSTRAINT "order_external_waybills_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_finance" ADD CONSTRAINT "order_finance_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_finance" ADD CONSTRAINT "order_finance_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_finance_forecasts" ADD CONSTRAINT "order_finance_forecasts_order_id_order_finance_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."order_finance"("order_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_refund_lines" ADD CONSTRAINT "order_refund_lines_refund_id_order_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."order_refunds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_refunds" ADD CONSTRAINT "order_refunds_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_refunds" ADD CONSTRAINT "order_refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_return_lines" ADD CONSTRAINT "order_return_lines_return_id_order_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."order_returns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_returns" ADD CONSTRAINT "order_returns_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_returns" ADD CONSTRAINT "order_returns_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_sales" ADD CONSTRAINT "order_sales_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_sales" ADD CONSTRAINT "order_sales_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_shopify_finance" ADD CONSTRAINT "order_shopify_finance_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_shopify_finance" ADD CONSTRAINT "order_shopify_finance_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_transaction_fees" ADD CONSTRAINT "order_transaction_fees_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_transaction_fees" ADD CONSTRAINT "order_transaction_fees_transaction_id_order_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."order_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_transaction_fees" ADD CONSTRAINT "order_transaction_fees_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_transactions" ADD CONSTRAINT "order_transactions_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_transactions" ADD CONSTRAINT "order_transactions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_attributions" ADD CONSTRAINT "partner_attributions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_attributions" ADD CONSTRAINT "partner_attributions_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_attributions" ADD CONSTRAINT "partner_attributions_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_attributions" ADD CONSTRAINT "partner_attributions_code_id_partner_codes_id_fk" FOREIGN KEY ("code_id") REFERENCES "public"."partner_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_codes" ADD CONSTRAINT "partner_codes_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_codes" ADD CONSTRAINT "partner_codes_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_commission_events" ADD CONSTRAINT "partner_commission_events_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_commission_events" ADD CONSTRAINT "partner_commission_events_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_commission_events" ADD CONSTRAINT "partner_commission_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_payouts" ADD CONSTRAINT "partner_payouts_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_payouts" ADD CONSTRAINT "partner_payouts_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_rates" ADD CONSTRAINT "partner_rates_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_rates" ADD CONSTRAINT "partner_rates_code_id_partner_codes_id_fk" FOREIGN KEY ("code_id") REFERENCES "public"."partner_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partners" ADD CONSTRAINT "partners_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_cost_estimates" ADD CONSTRAINT "shipment_cost_estimates_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_cost_estimates" ADD CONSTRAINT "shipment_cost_estimates_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_forecast_snapshots" ADD CONSTRAINT "shipping_forecast_snapshots_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_forecast_snapshots" ADD CONSTRAINT "shipping_forecast_snapshots_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_item_costs" ADD CONSTRAINT "stock_item_costs_stock_item_id_stock_items_id_fk" FOREIGN KEY ("stock_item_id") REFERENCES "public"."stock_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "carrier_import_profiles_active_uq" ON "carrier_import_profiles" USING btree ("store_id","carrier_code","header_signature") WHERE "carrier_import_profiles"."active";--> statement-breakpoint
CREATE UNIQUE INDEX "carrier_invoice_lines_uq" ON "carrier_invoice_lines" USING btree ("invoice_id","sheet","row_number");--> statement-breakpoint
CREATE INDEX "carrier_invoice_lines_waybill_idx" ON "carrier_invoice_lines" USING btree ("waybill_norm");--> statement-breakpoint
CREATE INDEX "carrier_invoice_lines_shipment_idx" ON "carrier_invoice_lines" USING btree ("shipment_id");--> statement-breakpoint
CREATE INDEX "carrier_invoice_lines_order_idx" ON "carrier_invoice_lines" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "carrier_invoices_file_uq" ON "carrier_invoices" USING btree ("store_id","carrier_code","file_sha256") WHERE "carrier_invoices"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "carrier_invoices_document_uq" ON "carrier_invoices" USING btree ("store_id","carrier_code","account_ref","invoice_number_norm","document_kind") WHERE "carrier_invoices"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "carrier_invoices_posting_uq" ON "carrier_invoices" USING btree ("store_id","carrier_code","account_ref","invoice_number_norm") WHERE "carrier_invoices"."status" = 'active' and "carrier_invoices"."posting";--> statement-breakpoint
CREATE INDEX "finance_change_log_entity_idx" ON "finance_change_log" USING btree ("entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "finance_change_log_store_idx" ON "finance_change_log" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_discrepancies_dedupe_uq" ON "finance_discrepancies" USING btree ("store_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "finance_discrepancies_status_idx" ON "finance_discrepancies" USING btree ("store_id","status","type");--> statement-breakpoint
CREATE INDEX "finance_discrepancies_order_idx" ON "finance_discrepancies" USING btree ("order_id") WHERE "finance_discrepancies"."order_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "finance_entries_seq_uq" ON "finance_entries" USING btree ("seq");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_entries_key_uq" ON "finance_entries" USING btree ("store_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_entries_reverses_uq" ON "finance_entries" USING btree ("reverses_entry_id");--> statement-breakpoint
CREATE INDEX "finance_entries_recognized_idx" ON "finance_entries" USING btree ("store_id","recognized_on");--> statement-breakpoint
CREATE INDEX "finance_entries_order_idx" ON "finance_entries" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "finance_entries_category_idx" ON "finance_entries" USING btree ("store_id","category","recognized_on");--> statement-breakpoint
CREATE INDEX "finance_entries_source_idx" ON "finance_entries" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "finance_entries_partner_idx" ON "finance_entries" USING btree ("partner_id") WHERE "finance_entries"."partner_id" is not null;--> statement-breakpoint
CREATE INDEX "finance_entries_stock_item_idx" ON "finance_entries" USING btree ("stock_item_id") WHERE "finance_entries"."stock_item_id" is not null;--> statement-breakpoint
CREATE INDEX "finance_entries_fx_on_idx" ON "finance_entries" USING btree ("fx_on");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_expense_allocations_uq" ON "finance_expense_allocations" USING btree ("expense_id","expense_version","order_id");--> statement-breakpoint
CREATE INDEX "finance_expense_allocations_order_idx" ON "finance_expense_allocations" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "finance_expenses_date_idx" ON "finance_expenses" USING btree ("store_id","expense_date");--> statement-breakpoint
CREATE INDEX "finance_expenses_category_idx" ON "finance_expenses" USING btree ("category");--> statement-breakpoint
CREATE INDEX "finance_expenses_order_idx" ON "finance_expenses" USING btree ("order_id") WHERE "finance_expenses"."order_id" is not null;--> statement-breakpoint
CREATE INDEX "finance_fee_rules_gateway_idx" ON "finance_fee_rules" USING btree ("gateway","applies_from");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_report_snapshots_uq" ON "finance_report_snapshots" USING btree ("store_id","kind","period_from","reporting_currency","version");--> statement-breakpoint
CREATE INDEX "fx_conversions_date_idx" ON "fx_conversions" USING btree ("store_id","occurred_on");--> statement-breakpoint
CREATE UNIQUE INDEX "fx_rates_auto_uq" ON "fx_rates" USING btree ("source","currency","quote_currency","effective_date") WHERE "fx_rates"."source" in ('nbu', 'demo');--> statement-breakpoint
CREATE UNIQUE INDEX "fx_rates_manual_version_uq" ON "fx_rates" USING btree ("currency","quote_currency","effective_date","version") WHERE "fx_rates"."source" = 'manual';--> statement-breakpoint
CREATE UNIQUE INDEX "fx_rates_manual_current_uq" ON "fx_rates" USING btree ("currency","quote_currency","effective_date") WHERE "fx_rates"."source" = 'manual' and "fx_rates"."is_current";--> statement-breakpoint
CREATE INDEX "fx_rates_currency_date_idx" ON "fx_rates" USING btree ("currency","effective_date");--> statement-breakpoint
CREATE INDEX "inventory_cost_layers_open_idx" ON "inventory_cost_layers" USING btree ("warehouse_id","stock_item_id","kind","created_seq") WHERE "inventory_cost_layers"."qty_open" > 0;--> statement-breakpoint
CREATE INDEX "inventory_cost_state_item_idx" ON "inventory_cost_state" USING btree ("stock_item_id");--> statement-breakpoint
CREATE INDEX "inventory_valuation_completions_valuation_idx" ON "inventory_valuation_completions" USING btree ("valuation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_valuations_seq_uq" ON "inventory_valuations" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "inventory_valuations_item_seq_idx" ON "inventory_valuations" USING btree ("stock_item_id","seq");--> statement-breakpoint
CREATE INDEX "inventory_valuations_item_date_idx" ON "inventory_valuations" USING btree ("stock_item_id","occurred_on");--> statement-breakpoint
CREATE INDEX "inventory_valuations_order_idx" ON "inventory_valuations" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_disputes_uq" ON "order_disputes" USING btree ("store_id","dispute_gid");--> statement-breakpoint
CREATE INDEX "order_disputes_order_idx" ON "order_disputes" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_external_waybills_uq" ON "order_external_waybills" USING btree ("order_id","number_norm");--> statement-breakpoint
CREATE INDEX "order_external_waybills_number_idx" ON "order_external_waybills" USING btree ("number_norm");--> statement-breakpoint
CREATE INDEX "order_finance_state_idx" ON "order_finance" USING btree ("state","recognized_on");--> statement-breakpoint
CREATE INDEX "order_finance_profit_state_idx" ON "order_finance" USING btree ("profit_state");--> statement-breakpoint
CREATE INDEX "order_finance_review_idx" ON "order_finance" USING btree ("needs_review") WHERE "order_finance"."needs_review";--> statement-breakpoint
CREATE UNIQUE INDEX "order_refund_lines_uq" ON "order_refund_lines" USING btree ("refund_id","shopify_line_item_id");--> statement-breakpoint
CREATE INDEX "order_refund_lines_line_idx" ON "order_refund_lines" USING btree ("order_line_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_refunds_uq" ON "order_refunds" USING btree ("store_id","shopify_refund_id");--> statement-breakpoint
CREATE INDEX "order_refunds_order_idx" ON "order_refunds" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_return_lines_return_idx" ON "order_return_lines" USING btree ("return_id");--> statement-breakpoint
CREATE INDEX "order_returns_order_idx" ON "order_returns" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_returns_status_idx" ON "order_returns" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "order_sales_sale_uq" ON "order_sales" USING btree ("store_id","shopify_sale_id");--> statement-breakpoint
CREATE INDEX "order_sales_order_idx" ON "order_sales" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_transaction_fees_uq" ON "order_transaction_fees" USING btree ("store_id","shopify_fee_id");--> statement-breakpoint
CREATE INDEX "order_transaction_fees_order_idx" ON "order_transaction_fees" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_transactions_uq" ON "order_transactions" USING btree ("store_id","shopify_transaction_id");--> statement-breakpoint
CREATE INDEX "order_transactions_order_idx" ON "order_transactions" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "partner_attributions_partner_idx" ON "partner_attributions" USING btree ("partner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "partner_codes_active_uq" ON "partner_codes" USING btree ("store_id","source","code_norm") WHERE "partner_codes"."active";--> statement-breakpoint
CREATE INDEX "partner_codes_partner_idx" ON "partner_codes" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "partner_commission_events_partner_idx" ON "partner_commission_events" USING btree ("partner_id","recognized_on");--> statement-breakpoint
CREATE INDEX "partner_commission_events_order_idx" ON "partner_commission_events" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "partner_payouts_partner_idx" ON "partner_payouts" USING btree ("partner_id","paid_on");--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_cost_estimates_uq" ON "shipment_cost_estimates" USING btree ("shipment_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "shipping_forecast_snapshots_uq" ON "shipping_forecast_snapshots" USING btree ("order_id","waybill_key");--> statement-breakpoint
CREATE INDEX "stock_item_costs_lookup_idx" ON "stock_item_costs" USING btree ("stock_item_id","effective_from" DESC NULLS LAST,"created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "stores_one_default_uq" ON "stores" USING btree ("is_default") WHERE "stores"."is_default";--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_movements_seq_uq" ON "inventory_movements" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "shipments_waybill_norm_idx" ON "shipments" USING btree ("carrier_code",upper(regexp_replace("waybill_number", '\s', '', 'g')));--> statement-breakpoint
-- Етап 6 (§15): магазин за замовчуванням (єдиний; getDefaultStore) і рядок стану фінансів цього магазину.
INSERT INTO "stores" ("id", "name", "is_default") VALUES ('default', 'default', true) ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
INSERT INTO "finance_state" ("store_id") VALUES ('default') ON CONFLICT ("store_id") DO NOTHING;
