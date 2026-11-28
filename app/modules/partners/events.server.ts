/**
 * Етап 6, WP7: читання подій винагороди з ознакою «чинна» (docs/stage6-design.md §9.4, F1, F2). Подія діє, поки діє
 * її запис журналу `partner_commission` (source_type = partner_event, source_id = id події): будь-яке покоління ключа
 * (`pc:<order>:<partner>:<n>` або `…:g<n>`, repostEntries), не сторноване. Сторно (замовлення виключено — тестове при
 * вимкненому includeTestOrders) робить подію нечинною: її сума не входить ні в баланс, ні в «бажана − Σ подій»; повторне
 * проведення (замовлення знову враховується) — знову чинна. Лише читання; грошей у результатах сервісів немає тут —
 * їх показують сервіси власника (requireFinance).
 */
import { asc, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { partnerCommissionEvents } from "~/db/schema";

/**
 * SQL-ознака «подія чинна» (для запитів із partner_commission_events без псевдоніма). Зовнішній стовпець — явно
 * кваліфікований: у полях select drizzle може не кваліфікувати стовпець таблиці, і тоді «id» у підзапиті означав би
 * finance_entries.id.
 */
export const eventActiveSql = sql<boolean>`exists (
  select 1 from finance_entries pe_fe
  where pe_fe.source_type = 'partner_event'
    and pe_fe.source_id = "partner_commission_events"."id"::text
    and pe_fe.reverses_entry_id is null
    and not exists (select 1 from finance_entries pe_fr where pe_fr.reverses_entry_id = pe_fe.id)
)`;

export type EventRow = typeof partnerCommissionEvents.$inferSelect & { active: boolean };

/** Усі події замовлення (у порядку n) з ознакою чинності. */
export async function loadOrderEvents(db: DbOrTx, orderId: string): Promise<EventRow[]> {
  const rows = await db
    .select({ e: partnerCommissionEvents, active: eventActiveSql })
    .from(partnerCommissionEvents)
    .where(eq(partnerCommissionEvents.orderId, orderId))
    .orderBy(asc(partnerCommissionEvents.n));
  return rows.map((r) => ({ ...r.e, active: Boolean(r.active) }));
}

/** Усі події партнерів з ознакою чинності (для балансу — ledger.ts бере лише чинні). */
export async function loadPartnerEvents(db: DbOrTx, partnerIds: readonly string[]): Promise<EventRow[]> {
  if (partnerIds.length === 0) return [];
  const rows = await db
    .select({ e: partnerCommissionEvents, active: eventActiveSql })
    .from(partnerCommissionEvents)
    .where(inArray(partnerCommissionEvents.partnerId, [...partnerIds]))
    .orderBy(asc(partnerCommissionEvents.orderId), asc(partnerCommissionEvents.n));
  return rows.map((r) => ({ ...r.e, active: Boolean(r.active) }));
}
