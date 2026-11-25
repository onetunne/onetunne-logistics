import { and, eq } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { settings, settingsHistory } from "~/db/schema";
import { requirePermission, type Actor, type Permission } from "~/domain/permissions";
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
};

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

/**
 * Оновлює налаштування з перевіркою прав, валідацією, оптимістичним блокуванням,
 * історією версій і записом у журнал.
 */
export async function updateSetting<K extends SettingsKey>(
  db: DbOrTx,
  actor: Actor,
  key: K,
  input: unknown,
  expectedVersion?: number,
): Promise<UpdateSettingResult<K>> {
  requirePermission(actor, PERMISSION_FOR_KEY[key]);
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
