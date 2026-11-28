/**
 * Етап 6, WP1: блокування «курс валюти на дату» (docs/stage6-design.md §20.3; клас FIOP, ключ `fx-rate:<CUR>:<дата>`).
 * Його беруть ДО читання курсів і ДО блокування місяця (FIPE):
 * - ручний курс (saveManualRate / voidManualRate) — одне блокування своєї валюти й дати;
 * - обмін валюти (createFxConversion) — блокування кожної валюти обміну, крім гривні, у порядку кодів.
 * Тож паралельні обмін і зміна курсу тієї самої дати впорядковані: або обмін читає вже збережений новий курс, або зміна
 * курсу чекає, поки обмін збережеться, і перераховує його (repriceConversions) / бачить його в conversionsNeedingRate.
 */
import type { Tx } from "~/db/client.server";
import { FX_QUOTE_CURRENCY } from "~/domain/finance";
import { lockFinanceOperation } from "~/modules/finance/core/locks.server";

export const rateLockKey = (currency: string, date: string): string => `fx-rate:${currency}:${date}`;

/** Блокування курсів валют на дату (без гривні; без повторів; у порядку кодів — без взаємоблокувань). */
export async function lockRateDates(tx: Tx, currencies: readonly string[], date: string): Promise<void> {
  for (const c of [...new Set(currencies)].filter((x) => x !== FX_QUOTE_CURRENCY).sort()) {
    await lockFinanceOperation(tx, rateLockKey(c, date));
  }
}
