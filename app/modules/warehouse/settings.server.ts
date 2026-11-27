/**
 * Налаштування складу (етап 5): пороги, параметри рекомендацій виробництва, передача змін у Shopify, політика
 * розбіжностей. Критичні налаштування — лише власник (settings.manage, перевіряє updateSetting).
 *
 * Зміна загального порогу «мало на складі» переоцінює попередження позицій без власного порогу. Переоцінка — після
 * збереження, короткими транзакціями: спершу баланси (у порядку блокувань ядра), потім попередження, — тож вона не
 * конфліктує з рухами складу (ті блокують баланси в тому ж порядку).
 */
import { inArray, isNull } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { inventoryBalances, stockItems } from "~/db/schema";
import { evaluateStockAlerts, lockBalances } from "~/modules/inventory/ledger.server";
import { getSetting, updateSetting, type UpdateSettingResult } from "~/modules/settings/settings.server";
import type { ServiceContext } from "~/server/types";

/** Позицій за одну транзакцію переоцінки попереджень. */
const ALERT_CHUNK = 200;

export interface SaveWarehouseSettingsResult {
  result: UpdateSettingResult<"warehouse">;
  /** Скільки позицій переоцінено (зміна загального порогу), відкрито й закрито попереджень. */
  alerts: { evaluated: number; opened: number; resolved: number } | null;
}

export async function saveWarehouseSettings(
  ctx: ServiceContext,
  input: Record<string, unknown>,
  expectedVersion: number,
): Promise<SaveWarehouseSettingsResult> {
  const before = await getSetting(ctx.db, "warehouse");
  const result = await updateSetting(ctx.db, ctx.actor, "warehouse", { ...before, ...input }, expectedVersion);
  if (!result.ok || result.value.lowStockThreshold === before.lowStockThreshold) return { result, alerts: null };
  return { result, alerts: await reevaluateDefaultThresholdAlerts(ctx.db, result.value.lowStockThreshold) };
}

/** Переоцінює попередження всіх позицій без власного порогу (stock_items.low_stock_threshold IS NULL). */
export async function reevaluateDefaultThresholdAlerts(
  db: DbOrTx,
  threshold: number,
): Promise<{ evaluated: number; opened: number; resolved: number }> {
  const items = await db.select({ id: stockItems.id }).from(stockItems).where(isNull(stockItems.lowStockThreshold)).orderBy(stockItems.id);
  const total = { evaluated: 0, opened: 0, resolved: 0 };
  for (let i = 0; i < items.length; i += ALERT_CHUNK) {
    const ids = items.slice(i, i + ALERT_CHUNK).map((r) => r.id);
    const r = await db.transaction(async (tx) => {
      const pairs = await tx
        .select({ warehouseId: inventoryBalances.warehouseId, stockItemId: inventoryBalances.stockItemId })
        .from(inventoryBalances)
        .where(inArray(inventoryBalances.stockItemId, ids));
      if (pairs.length === 0) return null;
      await lockBalances(tx, pairs);
      return evaluateStockAlerts(tx, [...new Set(pairs.map((p) => p.stockItemId))], { defaultThreshold: threshold });
    });
    if (!r) continue;
    total.evaluated += ids.length;
    total.opened += r.opened.length;
    total.resolved += r.resolved.length;
  }
  return total;
}
