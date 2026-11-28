/**
 * Етап 6, WP2: підказки собівартості з Shopify (docs/stage6-design.md §6.6 «Підказки з Shopify», §16.2, D-22).
 * «Завантажити собівартість із Shopify» читає InventoryItem.unitCost усіх варіантів (OtVariantCosts, дочитує сторінки)
 * → НЕПІДТВЕРДЖЕНІ рядки stock_item_costs (source = shopify_unit_cost, confirmed = false; лише прогноз); власник
 * підтверджує масово → підтверджені рядки (факт за даними власника) + за вибором завершення «до залишку» / «до вже
 * проданих». Лише робочий режим (у демо Shopify немає). Сервіси — requireFinance; мережевий клієнт передає викликач
 * (сторінка — adminClientFor поточного магазину; тести — імітація).
 */
import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { products, productVariants, stockItemCosts, stockItems } from "~/db/schema";
import { VARIANT_COSTS_MAX_PAGES, VARIANT_COSTS_QUERY, type VariantCostsPage } from "~/integrations/shopify/cost-graphql";
import type { AdminGraphql } from "~/integrations/shopify/admin-client.server";
import { DomainError } from "~/lib/errors";
import { isSupportedCurrency, parseDecimalStrict, toMinorForCurrency } from "~/lib/decimal";
import { businessDate, parseIsoDate } from "~/lib/periods";
import { writeAudit } from "~/modules/audit/audit.server";
import { requireFinance } from "~/modules/finance/core/access.server";
import { ensureStockItemsForVariants } from "~/modules/inventory/ledger.server";
import type { ServiceContext } from "~/server/types";
import { minorToDecimal } from "./engine";
import { saveManualCostTx, validateEffectiveFrom, type SaveManualCostResult } from "./manual-costs.server";

export interface ShopifyCostImportResult {
  /** Варіантів прочитано з Shopify. */
  variants: number;
  /** Нових непідтверджених підказок. */
  suggestions: number;
  /** Варіантів без unitCost (null — підказки немає, не 0). */
  withoutCost: number;
  /** Варіантів, яких немає в застосунку. */
  unknownVariants: number;
  truncated: boolean;
}

/** Розбір сторінки OtVariantCosts (строгий: некоректна сума / валюта → без підказки). */
export function parseVariantCosts(page: VariantCostsPage): Array<{ gid: string; amount: string | null; currency: string | null }> {
  return (page.productVariants?.nodes ?? []).map((n) => {
    const cost = n.inventoryItem?.unitCost ?? null;
    if (!cost) return { gid: n.id, amount: null, currency: null };
    const r = parseDecimalStrict(String(cost.amount), 2);
    const currency = String(cost.currencyCode ?? "");
    if (!r || r.num < 0n || !isSupportedCurrency(currency)) return { gid: n.id, amount: null, currency: null };
    try {
      return { gid: n.id, amount: minorToDecimal(toMinorForCurrency(String(cost.amount), currency)), currency };
    } catch {
      return { gid: n.id, amount: null, currency: null };
    }
  });
}

export async function importShopifyCostSuggestions(ctx: ServiceContext, admin: AdminGraphql): Promise<ShopifyCostImportResult> {
  requireFinance(ctx, "manage");
  if (ctx.mode !== "production") throw new DomainError("financeCosts.error.shopifyUnavailable", 409);
  const read: Array<{ gid: string; amount: string | null; currency: string | null }> = [];
  let after: string | null = null;
  let truncated = false;
  for (let page = 0; ; page++) {
    if (page >= VARIANT_COSTS_MAX_PAGES) {
      truncated = true;
      break;
    }
    const data: VariantCostsPage = await admin<VariantCostsPage>(VARIANT_COSTS_QUERY, { after });
    read.push(...parseVariantCosts(data));
    const info = data.productVariants?.pageInfo;
    if (!info?.hasNextPage || !info.endCursor) break;
    after = info.endCursor;
  }
  const today = businessDate(ctx.now());
  return ctx.db.transaction(async (tx) => {
    const gids = [...new Set(read.map((r) => r.gid))];
    const variants = gids.length
      ? await tx.select({ id: productVariants.id, gid: productVariants.shopifyVariantId }).from(productVariants).where(inArray(productVariants.shopifyVariantId, gids))
      : [];
    const variantByGid = new Map(variants.map((v) => [v.gid!, v.id]));
    const stock = await ensureStockItemsForVariants(tx, variants.map((v) => v.id));
    let suggestions = 0;
    let withoutCost = 0;
    let unknownVariants = 0;
    for (const r of read) {
      const variantId = variantByGid.get(r.gid);
      if (!variantId) {
        unknownVariants += 1;
        continue;
      }
      if (r.amount === null || r.currency === null) {
        withoutCost += 1;
        continue;
      }
      const stockItemId = stock.get(variantId)!;
      const [last] = await tx
        .select({ unitCost: stockItemCosts.unitCost, currency: stockItemCosts.currency })
        .from(stockItemCosts)
        .where(and(eq(stockItemCosts.stockItemId, stockItemId), eq(stockItemCosts.source, "shopify_unit_cost")))
        .orderBy(desc(stockItemCosts.createdAt), desc(stockItemCosts.id))
        .limit(1);
      if (last && last.unitCost === r.amount && last.currency === r.currency) continue;
      const inserted = await tx
        .insert(stockItemCosts)
        .values({
          stockItemId,
          unitCost: r.amount,
          currency: r.currency,
          effectiveFrom: today,
          source: "shopify_unit_cost",
          confirmed: false,
          idempotencyKey: `shopify:${today}:${variantId}`,
          createdBy: ctx.actor.id,
        })
        .onConflictDoNothing({ target: stockItemCosts.idempotencyKey })
        .returning({ id: stockItemCosts.id });
      suggestions += inserted.length;
    }
    await writeAudit(tx, ctx.actor, "finance.shopify_costs_imported", { type: "stock_item_cost" }, { variants: read.length, suggestions, withoutCost, unknownVariants, truncated });
    return { variants: read.length, suggestions, withoutCost, unknownVariants, truncated };
  });
}

export interface CostSuggestion {
  id: string;
  stockItemId: string;
  variantId: string | null;
  productTitle: string;
  variantTitle: string | null;
  sku: string | null;
  model: string | null;
  color: string | null;
  unitCost: string;
  currency: string;
  suggestedOn: string;
  /** Поточна підтверджена ручна собівартість (для порівняння) або null. */
  current: { unitCost: string; currency: string } | null;
}

/** Непідтверджені підказки Shopify, новіші за будь-який підтверджений рядок позиції (finance.view). */
export async function listCostSuggestions(ctx: Pick<ServiceContext, "db" | "actor">, opts: { limit?: number } = {}): Promise<CostSuggestion[]> {
  requireFinance(ctx, "view");
  return loadSuggestions(ctx.db, opts.limit ?? 200);
}

async function loadSuggestions(db: DbOrTx, limit: number, ids?: readonly string[]): Promise<CostSuggestion[]> {
  const rows = await db
    .select({
      c: stockItemCosts,
      variantId: stockItems.variantId,
      productTitle: products.title,
      variantTitle: productVariants.title,
      sku: productVariants.sku,
      model: productVariants.model,
      color: productVariants.color,
    })
    .from(stockItemCosts)
    .innerJoin(stockItems, eq(stockItems.id, stockItemCosts.stockItemId))
    .innerJoin(productVariants, eq(productVariants.id, stockItems.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(and(eq(stockItemCosts.source, "shopify_unit_cost"), eq(stockItemCosts.confirmed, false), ids ? inArray(stockItemCosts.id, [...ids]) : undefined))
    .orderBy(desc(stockItemCosts.createdAt), desc(stockItemCosts.id))
    .limit(Math.min(Math.max(limit, 1), 1000));
  const latestPerItem = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!latestPerItem.has(r.c.stockItemId)) latestPerItem.set(r.c.stockItemId, r);
  const out: CostSuggestion[] = [];
  for (const r of latestPerItem.values()) {
    const [confirmed] = await db
      .select({ unitCost: stockItemCosts.unitCost, currency: stockItemCosts.currency, createdAt: stockItemCosts.createdAt })
      .from(stockItemCosts)
      .where(and(eq(stockItemCosts.stockItemId, r.c.stockItemId), eq(stockItemCosts.confirmed, true)))
      .orderBy(desc(stockItemCosts.effectiveFrom), desc(stockItemCosts.createdAt))
      .limit(1);
    if (confirmed && confirmed.createdAt > r.c.createdAt) continue;
    out.push({
      id: r.c.id,
      stockItemId: r.c.stockItemId,
      variantId: r.variantId,
      productTitle: r.productTitle,
      variantTitle: r.variantTitle,
      sku: r.sku,
      model: r.model,
      color: r.color,
      unitCost: r.c.unitCost,
      currency: r.c.currency,
      suggestedOn: r.c.effectiveFrom,
      current: confirmed ? { unitCost: confirmed.unitCost, currency: confirmed.currency } : null,
    });
  }
  return out.sort((a, b) => a.productTitle.localeCompare(b.productTitle) || (a.variantTitle ?? "").localeCompare(b.variantTitle ?? ""));
}

/** Детермінований uuid операції підтвердження окремої підказки (один operationId форми → одна операція на підказку). */
export function suggestionOperationId(operationId: string, suggestionId: string): string {
  const h = createHash("sha256").update(`${operationId}:${suggestionId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Масове підтвердження підказок (finance.manage): підтверджений рядок + за вибором завершення. */
export async function confirmCostSuggestions(
  ctx: ServiceContext,
  input: { operationId: string; suggestionIds: readonly string[]; effectiveFrom: string; applyToStock: boolean; applyToSold: boolean },
): Promise<{ confirmed: number; duplicates: number; completedStockUnits: number; completedSoldUnits: number }> {
  requireFinance(ctx, "manage");
  // Не пізніше сьогодні (§6.6: діє останній effective_from ≤ дата; майбутня дата оцінила б склад ціною, що ще не діє).
  const effectiveFrom = validateEffectiveFrom(input.effectiveFrom, businessDate(ctx.now()));
  const ids = [...new Set(input.suggestionIds)].slice(0, 500);
  if (ids.length === 0) throw new DomainError("financeCosts.error.invalid", 400, { field: "suggestionIds" });
  return ctx.db.transaction(async (tx) => {
    const suggestions = await loadSuggestions(tx, 1000, ids);
    let confirmed = 0;
    let duplicates = 0;
    let completedStockUnits = 0;
    let completedSoldUnits = 0;
    for (const s of suggestions) {
      const r: SaveManualCostResult = await saveManualCostTx(tx, ctx, {
        operationId: suggestionOperationId(input.operationId, s.id),
        target: { kind: "stockItems", stockItemIds: [s.stockItemId] },
        unitCost: s.unitCost,
        currency: s.currency,
        effectiveFrom,
        applyToStock: input.applyToStock,
        applyToSold: input.applyToSold,
        source: "shopify_unit_cost",
      });
      if (r.duplicate) duplicates += 1;
      else confirmed += 1;
      completedStockUnits += r.completedStockUnits;
      completedSoldUnits += r.completedSoldUnits;
    }
    return { confirmed, duplicates, completedStockUnits, completedSoldUnits };
  });
}
