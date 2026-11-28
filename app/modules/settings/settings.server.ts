import { and, eq } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { settings, settingsHistory } from "~/db/schema";
import { ForbiddenError, requirePermission, type Actor, type Permission } from "~/domain/permissions";
import { ConflictError } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import { writeAudit } from "~/modules/audit/audit.server";
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEYS,
  settingsSchemas,
  type AllSettings,
  type SettingsKey,
  type SettingsValue,
} from "./schema";

const PERMISSION_FOR_KEY: Record<SettingsKey, Permission> = {
  automation: "automation.manage",
  shipper: "settings.manage",
  packaging: "settings.manage",
  testCarrier: "settings.manage",
  customs: "settings.manage",
  novaPost: "settings.manage",
  checkoutRates: "settings.manage",
  tracking: "settings.manage",
  // Етап 5: пороги, передача в Shopify, політика розбіжностей — критичні налаштування власника.
  warehouse: "settings.manage",
  // Етап 6: фінанси — лише власник (finance.manage + роль owner; docs/stage6-design.md §5.2, §14.1).
  finance: "finance.manage",
};

/** Ключі, які змінює лише роль «Власник» (навіть якщо дозвіл якось опинився в працівника — підроблений актор). */
const OWNER_ROLE_KEYS: ReadonlySet<SettingsKey> = new Set<SettingsKey>(["finance"]);

/**
 * Ключі з ВЛАСНИМ сервісом збереження — updateSetting їх не змінює (інакше зміна обійшла б гарантії предметної
 * області). finance → saveFinanceSettings (modules/finance/core/settings.server.ts): finance_change_log у тій самій
 * транзакції й блокування валюти оцінки (docs/stage6-design.md §5.2, §5.6, §14.4).
 */
const DEDICATED_SAVE_KEYS: ReadonlySet<SettingsKey> = new Set<SettingsKey>(["finance"]);

/** Дозвіл, потрібний для зміни ключа налаштувань. */
export function permissionForSettingsKey(key: SettingsKey): Permission {
  return PERMISSION_FOR_KEY[key];
}

export interface VersionedSettings {
  values: AllSettings;
  versions: Record<SettingsKey, number>;
}

export async function loadSettings(db: DbOrTx): Promise<VersionedSettings> {
  const rows = await db.select().from(settings);
  const values = structuredClone(DEFAULT_SETTINGS) as AllSettings;
  const versions = Object.fromEntries(SETTINGS_KEYS.map((k) => [k, 0])) as Record<SettingsKey, number>;
  for (const row of rows) {
    if (!(row.key in settingsSchemas)) continue;
    const key = row.key as SettingsKey;
    const parsed = settingsSchemas[key].safeParse(row.value);
    if (parsed.success) {
      (values as Record<SettingsKey, unknown>)[key] = parsed.data;
      versions[key] = row.version;
    } else {
      logger.warn("settings.invalid_stored_value", { key });
    }
  }
  return { values, versions };
}

export async function getSettings(db: DbOrTx): Promise<AllSettings> {
  return (await loadSettings(db)).values;
}

export async function getSetting<K extends SettingsKey>(db: DbOrTx, key: K): Promise<SettingsValue<K>> {
  const [row] = await db.select().from(settings).where(eq(settings.key, key));
  if (row) {
    const parsed = settingsSchemas[key].safeParse(row.value);
    if (parsed.success) return parsed.data as SettingsValue<K>;
    logger.warn("settings.invalid_stored_value", { key });
  }
  return structuredClone(DEFAULT_SETTINGS[key]);
}

export type UpdateSettingResult<K extends SettingsKey> =
  | { ok: true; value: SettingsValue<K>; version: number }
  | { ok: false; fieldErrors: Record<string, string> };

function assertMayWrite(actor: Actor, key: SettingsKey): void {
  requirePermission(actor, PERMISSION_FOR_KEY[key]);
  if (OWNER_ROLE_KEYS.has(key) && actor.role !== "owner") throw new ForbiddenError(PERMISSION_FOR_KEY[key]);
}

/**
 * Оновлює налаштування з перевіркою прав, валідацією, оптимістичним блокуванням,
 * історією версій і записом у журнал. Ключі з власним сервісом (DEDICATED_SAVE_KEYS: finance) — відмова.
 */
export async function updateSetting<K extends SettingsKey>(
  db: DbOrTx,
  actor: Actor,
  key: K,
  input: unknown,
  expectedVersion?: number,
): Promise<UpdateSettingResult<K>> {
  assertMayWrite(actor, key);
  if (DEDICATED_SAVE_KEYS.has(key)) {
    throw new Error(`settings key "${key}" is saved only by its dedicated service (finance: saveFinanceSettings)`);
  }
  return writeSetting(db, actor, key, input, expectedVersion);
}

/**
 * ЛИШЕ для saveFinanceSettings (modules/finance/core/settings.server.ts, у його транзакції разом із finance_change_log і
 * перевіркою валюти оцінки). Інші модулі цю функцію не імпортують — тест tests/stage6/core/settings-routes.test.ts.
 */
export async function writeFinanceSettingsVersion(
  tx: DbOrTx,
  actor: Actor,
  input: unknown,
  expectedVersion?: number,
): Promise<UpdateSettingResult<"finance">> {
  assertMayWrite(actor, "finance");
  return writeSetting(tx, actor, "finance", input, expectedVersion);
}

async function writeSetting<K extends SettingsKey>(
  db: DbOrTx,
  actor: Actor,
  key: K,
  input: unknown,
  expectedVersion?: number,
): Promise<UpdateSettingResult<K>> {
  const parsed = settingsSchemas[key].safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const path = issue.path.join(".") || "_";
      fieldErrors[path] ??= issue.message;
    }
    return { ok: false, fieldErrors };
  }
  const value = parsed.data as SettingsValue<K>;
  const [current] = await db.select().from(settings).where(eq(settings.key, key));
  const currentVersion = current?.version ?? 0;
  if (expectedVersion !== undefined && expectedVersion !== currentVersion) throw new ConflictError();
  const version = currentVersion + 1;

  if (current) {
    const updated = await db
      .update(settings)
      .set({ value, version, updatedBy: actor.id, updatedAt: new Date() })
      .where(and(eq(settings.key, key), eq(settings.version, currentVersion)))
      .returning({ key: settings.key });
    if (updated.length === 0) throw new ConflictError();
  } else {
    const inserted = await db
      .insert(settings)
      .values({ key, value, version, updatedBy: actor.id })
      .onConflictDoNothing({ target: settings.key })
      .returning({ key: settings.key });
    if (inserted.length === 0) throw new ConflictError();
  }
  await db.insert(settingsHistory).values({ key, version, value, changedBy: actor.id });
  await writeAudit(db, actor, "settings.update", { type: "settings", id: key }, { version });
  return { ok: true, value, version };
}

/** Записує значення за замовчуванням для відсутніх ключів (ідемпотентно). */
export async function ensureDefaultSettings(
  db: DbOrTx,
  overrides: Partial<AllSettings> = {},
  updatedBy = "system",
): Promise<void> {
  for (const key of SETTINGS_KEYS) {
    const value = overrides[key] ?? DEFAULT_SETTINGS[key];
    const inserted = await db
      .insert(settings)
      .values({ key, value, version: 1, updatedBy })
      .onConflictDoNothing({ target: settings.key })
      .returning({ key: settings.key });
    if (inserted.length > 0) {
      await db.insert(settingsHistory).values({ key, version: 1, value, changedBy: updatedBy }).onConflictDoNothing();
    }
  }
}
