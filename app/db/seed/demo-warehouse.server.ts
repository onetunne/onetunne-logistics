/**
 * ВИГАДАНІ демо-дані складу (етап 5): пакувальні матеріали (коробки з габаритами), шаблони комплектації,
 * виробнича партія «у виробництві» та початкові залишки (знімок демо-кількостей «Shopify» + резерви відкритих
 * замовлень через initializeInventory). Ідемпотентно: якщо матеріали вже є — нічого не робить.
 */
import { count, eq, inArray } from "drizzle-orm";
import {
  kitTemplateLines,
  kitTemplateProducts,
  kitTemplates,
  packagingMaterials,
  productionBatches,
  productionBatchLines,
  productVariants,
  products,
  type MaterialUnit,
  type PackagingMaterialKind,
} from "~/db/schema";
import { SYSTEM_ACTOR } from "~/domain/permissions";
import { inventoryKeys } from "~/modules/inventory/keys";
import { applyMovements, ensureStockItemForMaterial, ensureStockItemsForVariants, type MovementInput } from "~/modules/inventory/ledger.server";
import { initializeInventory } from "~/modules/inventory/opening.server";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import type { ServiceContext } from "~/server/types";

interface DemoMaterialSeed {
  code: string;
  name: string;
  kind: PackagingMaterialKind;
  unit?: MaterialUnit;
  dims?: [number, number, number];
  maxWeightGrams?: number;
  tareWeightGrams?: number;
  unitCost: string;
  stock: number;
}

export const DEMO_MATERIALS: DemoMaterialSeed[] = [
  { code: "box_s", name: "Коробка S", kind: "box", dims: [200, 150, 80], maxWeightGrams: 2000, tareWeightGrams: 120, unitCost: "12.00", stock: 40 },
  { code: "box_m", name: "Коробка M", kind: "box", dims: [300, 200, 120], maxWeightGrams: 5000, tareWeightGrams: 220, unitCost: "18.00", stock: 25 },
  { code: "box_l", name: "Коробка L", kind: "box", dims: [400, 300, 200], maxWeightGrams: 10000, tareWeightGrams: 380, unitCost: "27.00", stock: 4 },
  { code: "mailer_m", name: "Пакет-конверт M", kind: "mailer", dims: [340, 240, 50], maxWeightGrams: 1000, tareWeightGrams: 30, unitCost: "4.50", stock: 120 },
  { code: "sticker_logo", name: "Наклейка з логотипом", kind: "sticker", unitCost: "1.20", stock: 300 },
  { code: "instruction_fender", name: "Інструкція з монтажу крила", kind: "instruction", unitCost: "0.80", stock: 150 },
  { code: "card_thanks", name: "Візитка «Дякуємо»", kind: "card", unitCost: "0.60", stock: 200 },
  { code: "bolts_m5", name: "Болти M5 (комплект)", kind: "bolt", unitCost: "6.00", stock: 3 },
  { code: "tape", name: "Скотч пакувальний", kind: "tape", unit: "m", unitCost: "0.40", stock: 50 },
];

const COST_CURRENCY = "UAH";

export async function isDemoWarehouseSeeded(ctx: ServiceContext): Promise<boolean> {
  const [row] = await ctx.db.select({ c: count() }).from(packagingMaterials);
  return Number(row?.c ?? 0) > 0;
}

export async function seedDemoWarehouse(ctx: ServiceContext): Promise<void> {
  if (await isDemoWarehouseSeeded(ctx)) return;
  const actor = SYSTEM_ACTOR;
  const systemCtx: ServiceContext = { ...ctx, actor };

  // 1. Початкові залишки товарів (демо-кількості як «знімок Shopify») + резерви відкритих замовлень.
  await initializeInventory(systemCtx, { source: "shopify_snapshot" });

  await ctx.db.transaction(async (tx) => {
    const warehouse = await getDefaultWarehouse(tx);

    // 2. Пакувальні матеріали й комплектуючі з початковим залишком.
    const materialIds = new Map<string, string>();
    const openings: MovementInput[] = [];
    for (const m of DEMO_MATERIALS) {
      const [row] = await tx
        .insert(packagingMaterials)
        .values({
          code: m.code,
          name: m.name,
          kind: m.kind,
          unit: m.unit ?? "pcs",
          innerLengthMm: m.dims?.[0] ?? null,
          innerWidthMm: m.dims?.[1] ?? null,
          innerHeightMm: m.dims?.[2] ?? null,
          maxWeightGrams: m.maxWeightGrams ?? null,
          tareWeightGrams: m.tareWeightGrams ?? null,
          unitCost: m.unitCost,
          costCurrency: COST_CURRENCY,
        })
        .returning({ id: packagingMaterials.id });
      materialIds.set(m.code, row!.id);
      const stockItemId = await ensureStockItemForMaterial(tx, row!.id);
      openings.push({
        warehouseId: warehouse.id,
        stockItemId,
        type: "opening",
        idempotencyKey: inventoryKeys.opening(warehouse.id, stockItemId),
        onHandDelta: m.stock,
        reason: "demo_seed",
      });
    }
    await applyMovements(tx, actor, openings);

    // 3. Шаблони комплектації: загальний (на замовлення) і для крил (на кожну одиницю).
    const [general] = await tx
      .insert(kitTemplates)
      .values({ name: "Стандартний комплект", appliesTo: "all", priority: 0 })
      .returning({ id: kitTemplates.id });
    await tx.insert(kitTemplateLines).values([
      { templateId: general!.id, materialId: materialIds.get("sticker_logo")!, quantity: 1, per: "order" },
      { templateId: general!.id, materialId: materialIds.get("card_thanks")!, quantity: 1, per: "order" },
    ]);
    const [fenderProduct] = await tx.select({ id: products.id }).from(products).where(eq(products.handle, "rear-fender"));
    if (fenderProduct) {
      const [fender] = await tx
        .insert(kitTemplates)
        .values({ name: "Крило: болти та інструкція", appliesTo: "products", priority: 10 })
        .returning({ id: kitTemplates.id });
      await tx.insert(kitTemplateLines).values([
        { templateId: fender!.id, materialId: materialIds.get("bolts_m5")!, quantity: 1, per: "item" },
        { templateId: fender!.id, materialId: materialIds.get("instruction_fender")!, quantity: 1, per: "item" },
      ]);
      await tx.insert(kitTemplateProducts).values({ templateId: fender!.id, productId: fenderProduct.id });
    }

    // 4. Виробнича партія у виробництві (запуск: in_production +).
    const variants = await tx
      .select({ id: productVariants.id, sku: productVariants.sku })
      .from(productVariants)
      .where(inArray(productVariants.sku, ["OT-PH-WHT", "OT-FK-S"]));
    if (variants.length > 0) {
      const ready = new Date(ctx.now().getTime() + 14 * 86_400_000).toISOString().slice(0, 10);
      const [batch] = await tx
        .insert(productionBatches)
        .values({
          number: `PB-${ctx.now().getUTCFullYear()}-0001`,
          title: "Тримачі білі та крила Model S",
          status: "in_production",
          plannedReadyDate: ready,
          manufacturer: "Демо-виробник",
          notes: "DEMO",
          extraCost: "1500.00",
          costCurrency: COST_CURRENCY,
          createdBy: actor.id,
        })
        .returning({ id: productionBatches.id });
      const costs: Record<string, string> = { "OT-PH-WHT": "210.00", "OT-FK-S": "320.00" };
      const qty: Record<string, number> = { "OT-PH-WHT": 50, "OT-FK-S": 30 };
      const lines = await tx
        .insert(productionBatchLines)
        .values(
          variants.map((v) => ({
            batchId: batch!.id,
            variantId: v.id,
            quantityOrdered: qty[v.sku ?? ""] ?? 10,
            unitCost: costs[v.sku ?? ""] ?? null,
            costCurrency: costs[v.sku ?? ""] ? COST_CURRENCY : null,
          })),
        )
        .returning();
      const stockByVariant = await ensureStockItemsForVariants(tx, lines.map((l) => l.variantId));
      await applyMovements(
        tx,
        actor,
        lines.map((l) => ({
          warehouseId: warehouse.id,
          stockItemId: stockByVariant.get(l.variantId)!,
          type: "production_start" as const,
          idempotencyKey: inventoryKeys.productionStart(l.id, l.version),
          inProductionDelta: l.quantityOrdered,
          productionBatchId: batch!.id,
          unitCost: l.unitCost,
          costCurrency: l.costCurrency,
          reason: "batch_started",
        })),
      );
    }
  });
}
