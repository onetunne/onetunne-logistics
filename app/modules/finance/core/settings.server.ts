/**
 * Етап 6: фінансові налаштування (ключ `finance`, docs/stage6-design.md §5.2). Читання — finance.view, зміна —
 * finance.manage (обидва + роль owner). Кожна зміна — settings_history (writeFinanceSettingsVersion; загальний
 * updateSetting ключ finance відхиляє) + finance_change_log
 * (settings_finance) у ТІЙ САМІЙ транзакції. Валюта оцінки блокується після першого запису оцінки
 * (finance.error.valuationCurrencyLocked). Сторінка «Налаштування» ключ finance не показує (pages/settings.tsx).
 */
import { count } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { inventoryValuations } from "~/db/schema";
import { DomainError } from "~/lib/errors";
import type { FinanceSettings } from "~/modules/settings/schema";
import { getSetting, loadSettings, writeFinanceSettingsVersion, type UpdateSettingResult } from "~/modules/settings/settings.server";
import type { ServiceContext } from "~/server/types";
import { requireFinance } from "./access.server";
import { writeFinanceChange } from "./change-log.server";
import { canonicalJson } from "./snapshots.server";

/** Налаштування для сторінки фінансів (власник). */
export async function getFinanceSettings(ctx: Pick<ServiceContext, "db" | "actor">): Promise<{ value: FinanceSettings; version: number }> {
  requireFinance(ctx, "view");
  const { values, versions } = await loadSettings(ctx.db);
  return { value: values.finance, version: versions.finance };
}

/** Для внутрішніх розрахунків (без перевірки актора; нічого не повертає працівнику). */
export function loadFinanceSettings(db: DbOrTx): Promise<FinanceSettings> {
  return getSetting(db, "finance");
}

/** Чи вже є оцінки складу (валюта оцінки заблокована). */
export async function isValuationCurrencyLocked(db: DbOrTx): Promise<boolean> {
  const [row] = await db.select({ c: count() }).from(inventoryValuations);
  return Number(row?.c ?? 0) > 0;
}

/** Змінює фінансові налаштування (повний або частковий об'єкт поверх збереженого), з історією змін і причиною. */
export async function saveFinanceSettings(
  ctx: Pick<ServiceContext, "db" | "actor">,
  input: Partial<FinanceSettings>,
  opts: { expectedVersion?: number; reason?: string | null } = {},
): Promise<UpdateSettingResult<"finance">> {
  requireFinance(ctx, "manage");
  return ctx.db.transaction(async (tx) => {
    const before = await getSetting(tx, "finance");
    const merged = { ...before, ...input };
    if (merged.valuationCurrency !== before.valuationCurrency && (await isValuationCurrencyLocked(tx))) {
      throw new DomainError("finance.error.valuationCurrencyLocked", 409);
    }
    const result = await writeFinanceSettingsVersion(tx, ctx.actor, merged, opts.expectedVersion);
    if (result.ok) {
      const changedKeys = (Object.keys(result.value) as Array<keyof FinanceSettings>).filter(
        (k) => canonicalJson(result.value[k]) !== canonicalJson(before[k]),
      );
      const pick = (v: FinanceSettings) => Object.fromEntries(changedKeys.map((k) => [k, v[k]])) as Partial<FinanceSettings>;
      await writeFinanceChange(tx, ctx.actor, {
        entityType: "settings_finance",
        entityId: "finance",
        action: "update",
        before: { settings: pick(before) },
        after: { settings: pick(result.value), settingsVersion: result.version },
        reason: opts.reason ?? null,
      });
    }
    return result;
  });
}
