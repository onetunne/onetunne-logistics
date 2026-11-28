/**
 * Еталонна модель (WP12a): збирання журналу з кількох замовлень, витрат і наслідків рушія собівартості.
 */
import type { RefEntry } from "./journal";
import { postOrder, type OrderPosting, type RefOrderFacts, type RefPostingSettings } from "./order-posting";
import type { RefJournal } from "./pnl";

/** Журнал (рівень 2) з проведених замовлень і додаткових записів періоду (витрати, наслідки складу). */
export function journalFrom(postings: readonly OrderPosting[], extraEntries: readonly RefEntry[] = []): RefJournal {
  return {
    entries: [...postings.flatMap((p) => p.entries), ...extraEntries],
    orders: postings.map((p) => p.order),
    forecasts: postings.flatMap((p) => p.forecasts),
  };
}

/** Проведення набору замовлень станом на asOf. */
export function postOrders(orders: readonly RefOrderFacts[], asOf: string, settings: RefPostingSettings = {}): OrderPosting[] {
  return orders.map((o) => postOrder(o, asOf, settings));
}
