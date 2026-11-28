/**
 * Етап 6, WP1: збереження офіційних курсів НБУ в `fx_rates` (docs/stage6-design.md §5.3, §5.6). Лише вставка:
 * рядок (nbu, валюта, UAH, дата) унікальний; повторне отримання того самого значення — без змін; ІНШЕ значення →
 * рядок НЕ змінюється, відкривається розбіжність `fx_rate_conflict` (критична, «Потребує уваги» фінансів, НІКОЛИ не
 * `issues`). Курси НБУ на дати закритого місяця зберігаються (це факти), але знімків не змінюють (§3.4).
 *
 * Новий рядок змінює сконвертовані значення записів, що досі брали запасний курс або були «без курсу» (F6) — тоді в
 * історію змін пишеться рядок `fx_rate` (джерело nbu) з кількістю зачеплених записів і Δ у валюті звітності; без
 * зачеплених записів — нічого (без шуму).
 *
 * Внутрішня функція завдань (SYSTEM_ACTOR): актора не перевіряє, грошей не повертає (лише кількості).
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "~/db/client.server";
import { fxRates } from "~/db/schema";
import { FX_QUOTE_CURRENCY } from "~/domain/finance";
import { SYSTEM_ACTOR, type Actor } from "~/domain/permissions";
import type { OfficialFxRate } from "~/integrations/directories/types";
import { ratePerUnitScaled, scaledRateFromDb, scaledRateToDecimal } from "~/lib/decimal";
import { addDays } from "~/lib/periods";
import { writeFinanceChange } from "~/modules/finance/core/change-log.server";
import { discrepancyKey, openDiscrepancy } from "~/modules/finance/core/discrepancies.server";
import { loadFinanceSettings } from "~/modules/finance/core/settings.server";
import type { AppMode } from "~/server/types";
import { loadRateRows, rateChangeImpact, type RateRow } from "./impact.server";

export interface StoreOfficialRatesResult {
  /** Нових рядків. */
  inserted: number;
  /** Уже були з тим самим значенням. */
  unchanged: number;
  /** Уже були з ІНШИМ значенням (рядок не змінено, розбіжність fx_rate_conflict). */
  conflicts: number;
  /** Валюти з новими рядками (для завершення оцінок, що чекали курсу). */
  insertedCurrencies: string[];
}

const CHUNK = 200;

function rowKey(currency: string, date: string): string {
  return `${currency}|${date}`;
}

/** Зберігає рядки НБУ (див. вгорі файла). Одна транзакція. */
export async function storeOfficialRates(
  db: Db,
  rows: readonly OfficialFxRate[],
  opts: { fetchedAt: Date; mode: AppMode; actor?: Pick<Actor, "id" | "role"> },
): Promise<StoreOfficialRatesResult> {
  const result: StoreOfficialRatesResult = { inserted: 0, unchanged: 0, conflicts: 0, insertedCurrencies: [] };
  if (rows.length === 0) return result;
  const actor = opts.actor ?? SYSTEM_ACTOR;
  // Порядок вставки — (валюта, дата): паралельні отримання з перетином рядків беруть блокування унікального індексу в
  // одному порядку (без взаємоблокувань).
  const sorted = [...rows].sort((a, b) => (a.currency === b.currency ? (a.effectiveDate < b.effectiveDate ? -1 : 1) : a.currency < b.currency ? -1 : 1));
  const values = sorted.map((r) => ({
    source: "nbu" as const,
    currency: r.currency,
    quoteCurrency: FX_QUOTE_CURRENCY,
    effectiveDate: r.effectiveDate,
    rate: r.rate,
    units: r.units,
    ratePerUnit: scaledRateToDecimal(ratePerUnitScaled(r.rate, r.units)),
    setOn: r.setOn,
    version: 1,
    isCurrent: true,
    fetchedAt: opts.fetchedAt,
  }));
  const settings = await loadFinanceSettings(db);
  const fb = settings.fx.fallbackDays;
  const currencies = [...new Set(values.map((v) => v.currency))].sort();
  const dates = values.map((v) => v.effectiveDate).sort();
  const minDate = dates[0]!;
  const maxDate = dates[dates.length - 1]!;
  return db.transaction(async (tx) => {
    const before = await loadRateRows(tx, currencies, addDays(minDate, -fb), addDays(maxDate, fb));
    const inserted = new Set<string>();
    for (let i = 0; i < values.length; i += CHUNK) {
      const got = await tx
        .insert(fxRates)
        .values(values.slice(i, i + CHUNK))
        .onConflictDoNothing()
        .returning({ currency: fxRates.currency, effectiveDate: fxRates.effectiveDate });
      for (const g of got) inserted.add(rowKey(g.currency, g.effectiveDate));
    }
    result.inserted = inserted.size;
    // Не вставлені — порівняння з наявним рядком НБУ (той самий курс за одиницю — без змін).
    const skipped = values.filter((v) => !inserted.has(rowKey(v.currency, v.effectiveDate)));
    if (skipped.length > 0) {
      const existing = await tx
        .select({ currency: fxRates.currency, effectiveDate: fxRates.effectiveDate, rate: fxRates.rate, units: fxRates.units, ratePerUnit: fxRates.ratePerUnit })
        .from(fxRates)
        .where(
          and(
            eq(fxRates.source, "nbu"),
            eq(fxRates.quoteCurrency, FX_QUOTE_CURRENCY),
            inArray(fxRates.currency, [...new Set(skipped.map((s) => s.currency))]),
            inArray(fxRates.effectiveDate, [...new Set(skipped.map((s) => s.effectiveDate))]),
          ),
        );
      const byKey = new Map(existing.map((e) => [rowKey(e.currency, e.effectiveDate), e]));
      for (const s of skipped) {
        const e = byKey.get(rowKey(s.currency, s.effectiveDate));
        if (!e) continue;
        if (scaledRateFromDb(e.ratePerUnit) === scaledRateFromDb(s.ratePerUnit)) {
          result.unchanged++;
          continue;
        }
        result.conflicts++;
        await openDiscrepancy(tx, actor, {
          type: "fx_rate_conflict",
          dedupeKey: discrepancyKey("fx_rate_conflict", "nbu", s.currency, s.effectiveDate),
          details: {
            currency: s.currency,
            effectiveDate: s.effectiveDate,
            storedRate: scaledRateToDecimal(ratePerUnitScaled(e.rate, 1)),
            storedUnits: e.units,
            fetchedRate: s.rate,
            fetchedUnits: s.units,
          },
        });
      }
    }
    if (inserted.size === 0) return result;
    const after = await loadRateRows(tx, currencies, addDays(minDate, -fb), addDays(maxDate, fb));
    const insertedCurrencies = currencies.filter((c) => values.some((v) => v.currency === c && inserted.has(rowKey(c, v.effectiveDate))));
    result.insertedCurrencies = insertedCurrencies;
    for (const c of insertedCurrencies) {
      const own = values.filter((v) => v.currency === c && inserted.has(rowKey(c, v.effectiveDate))).sort((a, b) => (a.effectiveDate < b.effectiveDate ? -1 : 1));
      const first = own[0]!;
      const last = own[own.length - 1]!;
      const of = (list: readonly RateRow[]) => list.filter((r) => r.currency === c);
      const impact = await rateChangeImpact(tx, {
        currency: c,
        from: first.effectiveDate,
        to: last.effectiveDate,
        before: of(before),
        after: of(after),
        mode: opts.mode,
        fallbackDays: fb,
        reportingCurrency: settings.reportingCurrency,
      });
      if (impact.affectedEntries === 0) continue;
      await writeFinanceChange(tx, actor, {
        entityType: "fx_rate",
        entityId: `${c}:${first.effectiveDate}`,
        action: "create",
        before: null,
        after: {
          currency: c,
          quoteCurrency: FX_QUOTE_CURRENCY,
          effectiveDate: first.effectiveDate,
          rate: first.rate,
          units: first.units,
          ratePerUnit: first.ratePerUnit,
          source: "nbu",
          rateVersion: 1,
          affectedEntries: impact.affectedEntries,
          deltaReporting: impact.deltaReporting,
          reportingCurrency: impact.reportingCurrency,
        },
      });
    }
    return result;
  });
}
