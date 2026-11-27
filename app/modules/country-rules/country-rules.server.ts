import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx, Tx } from "~/db/client.server";
import { countryRules, countryRulesHistory, orders } from "~/db/schema";
import { requirePermission } from "~/domain/permissions";
import { ConflictError, DomainError, NotFoundError } from "~/lib/errors";
import { writeAudit } from "~/modules/audit/audit.server";
import { VALIDATABLE_STATUSES, validateOrderInTx } from "~/modules/orders/workflow.server";
import { normalizePostalCode, type CountryRule } from "~/modules/validation";
import { compilePostalPattern, MAX_POSTAL_LENGTH } from "~/modules/validation/postal";
import type { ServiceContext } from "~/server/types";
import {
  ERR,
  MAX_EXAMPLE_LENGTH,
  MAX_PATTERN_LENGTH,
  changedFields,
  countryCodeSchema,
  countryRuleValueSchema,
  defaultRuleFor,
  fieldErrorsOf,
  newCountryRuleSchema,
  pickRuleValue,
  pickSnapshot,
  type CountryRuleSnapshot,
  type CountryRuleValue,
  type EditableRuleField,
  needsVerification,
  withoutVerifyMarker,
} from "./schema";

/**
 * Правила країн (етап 4): зміна власником з перевіркою (zod + компіляція шаблону індексу), оптимістичною версією,
 * історією (country_rules_history), журналом (audit_log, без персональних даних) і повторною перевіркою
 * відкритих замовлень цієї країни. Логіка перевірки замовлень — modules/validation (лише споживаємо).
 */

/** Чисті допоміжні функції для loader сторінки (імпорт через .server — не потрапляють у клієнтський код). */
export { defaultRuleFor, isChangedFromDefault, needsVerification, withVerifyMarker, withoutVerifyMarker } from "./schema";

export type CountryRuleRow = typeof countryRules.$inferSelect;
export type CountryRuleHistoryRow = typeof countryRulesHistory.$inferSelect;
export type HistorySource = "initial" | "add" | "update" | "reset" | "verify";

export type CountryRuleChangeResult =
  | { ok: true; countryCode: string; version: number; changed: EditableRuleField[]; unchanged: boolean; revalidated: number }
  | { ok: false; fieldErrors: Record<string, string> };

const MANAGE = "settings.manage" as const;

function snapshotOf(row: CountryRuleRow): CountryRuleSnapshot {
  return pickSnapshot(row);
}

function sameSnapshot(a: CountryRuleSnapshot, b: CountryRuleSnapshot): boolean {
  return changedFields(a, b).length === 0 && a.nameEn === b.nameEn && a.nameUk === b.nameUk;
}

function normalizeCode(countryCode: string): string {
  const parsed = countryCodeSchema.safeParse(countryCode);
  if (!parsed.success) throw new NotFoundError("countryRule");
  return parsed.data;
}

export async function getCountryRule(db: DbOrTx, countryCode: string): Promise<CountryRuleRow | null> {
  const parsed = countryCodeSchema.safeParse(countryCode);
  if (!parsed.success) return null;
  const [row] = await db.select().from(countryRules).where(eq(countryRules.countryCode, parsed.data));
  return row ?? null;
}

export async function listCountryRules(db: DbOrTx): Promise<CountryRuleRow[]> {
  return db.select().from(countryRules).orderBy(asc(countryRules.countryCode));
}

/** Історія версій (новіші спочатку). */
export async function listHistory(db: DbOrTx, countryCode: string, limit = 50): Promise<CountryRuleHistoryRow[]> {
  const parsed = countryCodeSchema.safeParse(countryCode);
  if (!parsed.success) return [];
  return db
    .select()
    .from(countryRulesHistory)
    .where(eq(countryRulesHistory.countryCode, parsed.data))
    .orderBy(desc(countryRulesHistory.version))
    .limit(limit);
}

/**
 * Записує в історію стан правила ДО першої зміни в застосунку (типові правила створюються під час
 * початкового заповнення без історії). Ідемпотентно.
 */
async function ensureBaseline(tx: DbOrTx, row: CountryRuleRow): Promise<void> {
  await tx
    .insert(countryRulesHistory)
    .values({
      countryCode: row.countryCode,
      version: row.version,
      source: "initial",
      value: snapshotOf(row),
      changedBy: "system",
      changedAt: row.updatedAt,
    })
    .onConflictDoNothing();
}

/** Зберігає нову версію правила (compare-and-set за версією) + історія + журнал. Повертає змінені поля. */
async function writeVersion(
  tx: Tx,
  ctx: Pick<ServiceContext, "actor" | "now">,
  code: string,
  expectedVersion: number,
  next: CountryRuleSnapshot,
  source: HistorySource,
): Promise<{ version: number; changed: EditableRuleField[]; unchanged: boolean }> {
  const [current] = await tx.select().from(countryRules).where(eq(countryRules.countryCode, code)).for("update");
  if (!current) throw new NotFoundError("countryRule");
  if (current.version !== expectedVersion) throw new ConflictError();
  const before = snapshotOf(current);
  const changed = changedFields(before, next);
  if (sameSnapshot(before, next)) return { version: current.version, changed: [], unchanged: true };

  await ensureBaseline(tx, current);
  const version = current.version + 1;
  const now = ctx.now();
  const updated = await tx
    .update(countryRules)
    .set({ ...next, version, updatedAt: now })
    .where(and(eq(countryRules.countryCode, code), eq(countryRules.version, expectedVersion)))
    .returning({ code: countryRules.countryCode });
  if (updated.length === 0) throw new ConflictError();
  await tx.insert(countryRulesHistory).values({ countryCode: code, version, source, value: next, changedBy: ctx.actor.id, changedAt: now });
  const action = source === "reset" ? "country_rule.reset" : source === "verify" ? "country_rule.verified" : "country_rule.update";
  await writeAudit(tx, ctx.actor, action, { type: "country_rule", id: code }, {
    version,
    fields: changed,
  });
  return { version, changed, unchanged: false };
}

/**
 * Повторна перевірка відкритих замовлень країни — кожне в окремій транзакції.
 * Замовлення з накладною в процесі/на розгляді пропускаються (DomainError), як в updateVariantCustomsData.
 */
export async function revalidateCountryOrders(ctx: ServiceContext, countryCode: string): Promise<number> {
  const rows = await ctx.db
    .select({ id: orders.id })
    .from(orders)
    .where(and(sql`upper(trim(${orders.shipCountryCode})) = ${countryCode}`, inArray(orders.status, [...VALIDATABLE_STATUSES])))
    .orderBy(asc(orders.createdAt));
  let revalidated = 0;
  for (const { id } of rows) {
    try {
      await ctx.db.transaction((tx) => validateOrderInTx(tx, ctx, id, "country_rule_edit"));
      revalidated++;
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
    }
  }
  return revalidated;
}

/** Зміна правила країни власником. Застаріла версія → ConflictError; некоректні дані → fieldErrors. */
export async function updateCountryRule(
  ctx: ServiceContext,
  countryCode: string,
  input: unknown,
  expectedVersion: number,
): Promise<CountryRuleChangeResult> {
  requirePermission(ctx.actor, MANAGE);
  const code = normalizeCode(countryCode);
  const parsed = countryRuleValueSchema.safeParse(input);
  if (!parsed.success) return { ok: false, fieldErrors: fieldErrorsOf(parsed.error) };
  const value: CountryRuleValue = parsed.data;
  const result = await ctx.db.transaction(async (tx) => {
    const [current] = await tx.select().from(countryRules).where(eq(countryRules.countryCode, code));
    if (!current) throw new NotFoundError("countryRule");
    return writeVersion(tx, ctx, code, expectedVersion, { nameEn: current.nameEn, nameUk: current.nameUk, ...value }, "update");
  });
  const revalidated = result.unchanged ? 0 : await revalidateCountryOrders(ctx, code);
  return { ok: true, countryCode: code, ...result, revalidated };
}

/** Повернення до типового правила (DEFAULT_COUNTRY_RULES), включно з назвами країни. */
export async function resetCountryRuleToDefault(
  ctx: ServiceContext,
  countryCode: string,
  expectedVersion: number,
): Promise<CountryRuleChangeResult> {
  requirePermission(ctx.actor, MANAGE);
  const code = normalizeCode(countryCode);
  const def = defaultRuleFor(code);
  if (!def) throw new DomainError("countryRules.error.noDefault", 404, { country: code });
  const next: CountryRuleSnapshot = { nameEn: def.nameEn, nameUk: def.nameUk, ...pickRuleValue(def) };
  const result = await ctx.db.transaction((tx) => writeVersion(tx, ctx, code, expectedVersion, next, "reset"));
  const revalidated = result.unchanged ? 0 : await revalidateCountryOrders(ctx, code);
  return { ok: true, countryCode: code, ...result, revalidated };
}

/**
 * «Позначити як перевірене»: власник підтвердив значення типового правила — позначку «verify before production»
 * прибрано з приміток (решта тексту приміток зберігається), нова версія з історією (джерело "verify") і журналом.
 * Значення перевірки замовлень не змінюються, тож повторна перевірка не потрібна. Без позначки — «змін немає».
 */
export async function markCountryRuleVerified(
  ctx: ServiceContext,
  countryCode: string,
  expectedVersion: number,
): Promise<CountryRuleChangeResult> {
  requirePermission(ctx.actor, MANAGE);
  const code = normalizeCode(countryCode);
  const result = await ctx.db.transaction(async (tx) => {
    const [current] = await tx.select().from(countryRules).where(eq(countryRules.countryCode, code));
    if (!current) throw new NotFoundError("countryRule");
    if (current.version !== expectedVersion) throw new ConflictError();
    if (!needsVerification(current.notes)) return { version: current.version, changed: [], unchanged: true };
    const next: CountryRuleSnapshot = { ...snapshotOf(current), notes: withoutVerifyMarker(current.notes) };
    return writeVersion(tx, ctx, code, expectedVersion, next, "verify");
  });
  return { ok: true, countryCode: code, ...result, revalidated: 0 };
}

/** Назва країни з Intl (якщо власник не вказав). */
function intlRegionName(code: string, locale: "uk" | "en"): string | null {
  try {
    const name = new Intl.DisplayNames([locale], { type: "region", fallback: "none" }).of(code);
    return name && name !== code ? name : null;
  } catch {
    return null;
  }
}

/** Нова країна (ISO 3166-1 alpha-2, ще не додана). Лише власник. */
export async function addCountryRule(ctx: ServiceContext, input: Record<string, unknown>): Promise<CountryRuleChangeResult> {
  requirePermission(ctx.actor, MANAGE);
  const head = newCountryRuleSchema.safeParse(input);
  const body = countryRuleValueSchema.safeParse(input);
  const fieldErrors = { ...(head.success ? {} : fieldErrorsOf(head.error)), ...(body.success ? {} : fieldErrorsOf(body.error)) };
  if (!head.success || !body.success) return { ok: false, fieldErrors };
  const code = head.data.countryCode;
  const nameEn = head.data.nameEn ?? intlRegionName(code, "en");
  const nameUk = head.data.nameUk ?? intlRegionName(code, "uk");
  if (!nameEn || !nameUk) {
    return {
      ok: false,
      fieldErrors: { ...(nameEn ? {} : { nameEn: ERR.nameRequired }), ...(nameUk ? {} : { nameUk: ERR.nameRequired }) },
    };
  }
  const snapshot: CountryRuleSnapshot = { nameEn, nameUk, ...body.data };
  const inserted = await ctx.db.transaction(async (tx) => {
    const now = ctx.now();
    const rows = await tx
      .insert(countryRules)
      .values({ countryCode: code, ...snapshot, version: 1, updatedAt: now })
      .onConflictDoNothing({ target: countryRules.countryCode })
      .returning({ code: countryRules.countryCode });
    if (rows.length === 0) return false;
    await tx.insert(countryRulesHistory).values({ countryCode: code, version: 1, source: "add", value: snapshot, changedBy: ctx.actor.id, changedAt: now });
    await writeAudit(tx, ctx.actor, "country_rule.add", { type: "country_rule", id: code }, { version: 1 });
    return true;
  });
  if (!inserted) return { ok: false, fieldErrors: { countryCode: ERR.codeExists } };
  const revalidated = await revalidateCountryOrders(ctx, code);
  return { ok: true, countryCode: code, version: 1, changed: [], unchanged: false, revalidated };
}

export interface PostalTestResult {
  /** false — шаблон не компілюється. */
  patternValid: boolean;
  /** Індекс після нормалізації (як його бачить перевірка замовлень). */
  normalized: string;
  /** null — формат не перевіряється (шаблону немає). */
  match: boolean | null;
}

/**
 * Перевірка зразка індексу шаблоном (чиста функція, виконується на сервері).
 * Нормалізація — та сама, що під час перевірки замовлення (normalizePostalCode).
 */
export function testPostalCode(rule: Pick<CountryRule, "countryCode" | "postalCodeRequired">, pattern: string | null, sample: string): PostalTestResult {
  const cleanPattern = pattern?.trim().slice(0, MAX_PATTERN_LENGTH) || null;
  const cleanSample = sample.slice(0, MAX_EXAMPLE_LENGTH * 2);
  if (cleanPattern === null) {
    return { patternValid: true, normalized: cleanSample.replace(/\s+/g, " ").trim().toUpperCase(), match: null };
  }
  const re = compilePostalPattern(cleanPattern);
  if (!re) return { patternValid: false, normalized: cleanSample.trim(), match: null };
  const full: CountryRule = {
    countryCode: rule.countryCode,
    nameEn: "",
    nameUk: "",
    shippingEnabled: true,
    postalCodeRequired: rule.postalCodeRequired,
    postalCodePattern: cleanPattern,
    postalCodeExample: null,
    provinceRequired: false,
    phoneRequired: false,
  };
  const normalized = normalizePostalCode(cleanSample, full).value;
  return { patternValid: true, normalized, match: normalized.length <= MAX_POSTAL_LENGTH && re.test(normalized) };
}
