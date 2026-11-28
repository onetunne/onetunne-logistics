/**
 * Етап 6, WP1: ВНУТРІШНЯ частина обміну валюти (docs/stage6-design.md §5.7, §10.4, §14.1 F8). Тут — функції, які
 * актора не перевіряють і грошей не повертають (лише кількості й id записів): їх викликають сервіси власника
 * (`conversions.server.ts`, `manual-rates.server.ts`) у своїх транзакціях. Модуль не імпортується зі сторінок, маршрутів,
 * команд та інструментів ШІ (сканер tests/stage6/fx/internal-scanner.test.ts; CORE REQUEST — внести в
 * INTERNAL_POSTING_FUNCTIONS / INTERNAL_ONLY_MODULES).
 *
 * - exactRate — курс ТОЧНО на дату (запасний не приймається) або finance.error.noRate.
 * - repriceConversions — після зміни курсу дати: чинні обміни дати з цією валютою → сторно чинного запису + новий запис
 *   наступної версії (`fxconv:<id>:v<n+1>`), історія змін; повертає кількість і id записів (для Δ зміни курсу).
 * - conversionsNeedingRate — скільки чинних обмінів дати з валютою не мають зараз точного курсу.
 * Обидві викликаються під блокуванням курсу дати (rate-lock.server.ts), яке бере й createFxConversion.
 */
import { and, eq, inArray, or } from "drizzle-orm";
import type { DbOrTx, Tx } from "~/db/client.server";
import { financeEntries, fxConversions } from "~/db/schema";
import type { Actor } from "~/domain/permissions";
import { DomainError } from "~/lib/errors";
import { fromMinor, toMinor, toMinorForCurrency } from "~/lib/decimal";
import { writeFinanceChange } from "~/modules/finance/core/change-log.server";
import { postEntries, reverseEntries } from "~/modules/finance/core/entries.server";
import { financeKeys } from "~/modules/finance/core/keys";
import { DEFAULT_STORE_ID } from "~/modules/finance/core/store.server";
import type { AppMode } from "~/server/types";
import { conversionDifference } from "./conversion-calc";
import { rateFor, type RateFound } from "./rate-for.server";

export type ConversionRow = typeof fxConversions.$inferSelect;

/** Курс валюти ТОЧНО на дату (fallbackDays = 0); немає → finance.error.noRate. */
export async function exactRate(db: DbOrTx, currency: string, date: string, mode: AppMode): Promise<RateFound> {
  const r = await rateFor(db, currency, date, { mode, fallbackDays: 0 });
  if (!r.ok) throw new DomainError("finance.error.noRate", 422, { currency, date });
  return r;
}

export interface ConversionEntries {
  /** Сума чинних (не сторнованих) записів у мінорних одиницях. */
  amount: bigint;
  /** Чинні записи. */
  ids: string[];
  /** Усі записи обміну (зокрема сторно). */
  all: string[];
}

/** Записи курсової різниці обмінів: чинна сума й id. */
export async function conversionEntries(db: DbOrTx, conversionIds: readonly string[]): Promise<Map<string, ConversionEntries>> {
  const out = new Map<string, ConversionEntries>();
  if (conversionIds.length === 0) return out;
  const rows = await db
    .select({ id: financeEntries.id, sourceId: financeEntries.sourceId, amount: financeEntries.amount, reversesEntryId: financeEntries.reversesEntryId })
    .from(financeEntries)
    .where(and(eq(financeEntries.storeId, DEFAULT_STORE_ID), eq(financeEntries.sourceType, "fx_conversion"), inArray(financeEntries.sourceId, [...conversionIds])));
  const reversed = new Set(rows.map((r) => r.reversesEntryId).filter((v): v is string => v !== null));
  for (const r of rows) {
    const cur = out.get(r.sourceId) ?? { amount: 0n, ids: [], all: [] };
    cur.all.push(r.id);
    if (r.reversesEntryId === null && !reversed.has(r.id)) {
      cur.amount += toMinor(r.amount);
      cur.ids.push(r.id);
    }
    out.set(r.sourceId, cur);
  }
  return out;
}

/** Запис курсової різниці обміну версії `version` (у валюті купівлі, fx_on = recognized_on = дата обміну). */
export function conversionEntry(
  row: Pick<ConversionRow, "id" | "occurredOn" | "soldCurrency" | "boughtCurrency" | "counterparty" | "storeId">,
  version: number,
  difference: string,
  sold: RateFound,
  bought: RateFound,
) {
  return {
    idempotencyKey: financeKeys.fxConversion(row.id, version),
    category: "fx_difference" as const,
    recognizedOn: row.occurredOn,
    fxOn: row.occurredOn,
    amount: difference,
    currency: row.boughtCurrency,
    sourceType: "fx_conversion" as const,
    sourceId: row.id,
    storeId: row.storeId,
    details: {
      soldCurrency: row.soldCurrency,
      boughtCurrency: row.boughtCurrency,
      soldRate: sold.ratePerUnit,
      boughtRate: bought.ratePerUnit,
      soldRateSource: sold.source,
      boughtRateSource: bought.source,
      counterparty: row.counterparty,
      version,
    },
  };
}

async function activeConversionsOn(tx: Tx, input: { currency: string; date: string }): Promise<ConversionRow[]> {
  return tx
    .select()
    .from(fxConversions)
    .where(
      and(
        eq(fxConversions.status, "active"),
        eq(fxConversions.occurredOn, input.date),
        or(eq(fxConversions.soldCurrency, input.currency), eq(fxConversions.boughtCurrency, input.currency)),
      ),
    )
    .orderBy(fxConversions.id)
    .for("update");
}

/** Скільки чинних обмінів дати з валютою не мають зараз точного курсу (внутрішня; без грошей). */
export async function conversionsNeedingRate(tx: Tx, input: { currency: string; date: string; mode: AppMode }): Promise<number> {
  let n = 0;
  for (const row of await activeConversionsOn(tx, input)) {
    const s = await rateFor(tx, row.soldCurrency, row.occurredOn, { mode: input.mode, fallbackDays: 0 });
    const b = await rateFor(tx, row.boughtCurrency, row.occurredOn, { mode: input.mode, fallbackDays: 0 });
    if (!s.ok || !b.ok) n++;
  }
  return n;
}

export interface RepriceResult {
  /** Обмінів з перерахованою різницею. */
  repriced: number;
  /** Записи, додані перерахунком: сторно попередніх версій і нові версії (для Δ зміни курсу). */
  postedEntryIds: string[];
  /** Попередні записи, які перерахунок сторнував. */
  reversedEntryIds: string[];
}

/**
 * Перераховує курсову різницю чинних обмінів дати з валютою після зміни курсу (внутрішня; у транзакції зміни курсу, під
 * блокуванням курсу дати). Змінилася різниця → сторно чинного запису + новий запис наступної версії
 * (`fxconv:<id>:v<n+1>`), історія змін. Повертає кількість і id записів (без сум).
 */
export async function repriceConversions(tx: Tx, actor: Pick<Actor, "id" | "role">, input: { currency: string; date: string; mode: AppMode }): Promise<RepriceResult> {
  const result: RepriceResult = { repriced: 0, postedEntryIds: [], reversedEntryIds: [] };
  const rows = await activeConversionsOn(tx, input);
  if (rows.length === 0) return result;
  const entries = await conversionEntries(tx, rows.map((r) => r.id));
  const changed: string[] = [];
  for (const row of rows) {
    const sold = await exactRate(tx, row.soldCurrency, row.occurredOn, input.mode);
    const bought = await exactRate(tx, row.boughtCurrency, row.occurredOn, input.mode);
    const calc = conversionDifference({
      soldAmount: row.soldAmount,
      soldCurrency: row.soldCurrency,
      boughtAmount: row.boughtAmount,
      boughtCurrency: row.boughtCurrency,
      soldRate: sold.scaled,
      boughtRate: bought.scaled,
    });
    const now = entries.get(row.id) ?? { amount: 0n, ids: [], all: [] };
    const next = toMinorForCurrency(calc.difference, row.boughtCurrency);
    if (next === now.amount) continue;
    const version = row.version + 1;
    if (now.ids.length > 0) await reverseEntries(tx, actor, now.ids);
    if (next !== 0n) await postEntries(tx, actor, [conversionEntry(row, version, calc.difference, sold, bought)]);
    await tx.update(fxConversions).set({ version }).where(eq(fxConversions.id, row.id));
    await writeFinanceChange(tx, actor, {
      entityType: "fx_conversion",
      entityId: row.id,
      action: "update",
      before: { difference: fromMinor(now.amount), differenceCurrency: row.boughtCurrency, version: row.version },
      after: { difference: calc.difference, differenceCurrency: row.boughtCurrency, version },
    });
    result.reversedEntryIds.push(...now.ids);
    changed.push(row.id);
    result.repriced++;
  }
  if (changed.length > 0) {
    const known = new Set(changed.flatMap((id) => entries.get(id)?.all ?? []));
    for (const e of (await conversionEntries(tx, changed)).values()) for (const id of e.all) if (!known.has(id)) result.postedEntryIds.push(id);
  }
  return result;
}
