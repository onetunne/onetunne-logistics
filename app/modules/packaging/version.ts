/**
 * Мітка версії рядка для оптимістичного блокування форм (у packaging_materials і kit_templates немає колонки version):
 * updated_at у мікросекундах (рядок). Кожна зміна ставить updated_at = clock_timestamp() — мітка завжди змінюється.
 * Застаріла мітка (дані змінив інший користувач після відкриття форми) → ConflictError.
 */
import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import { ConflictError } from "~/lib/errors";

export const versionToken = (column: AnyColumn): SQL<string> => sql<string>`((extract(epoch from ${column}) * 1000000)::bigint)::text`;

/** Умова WHERE «версія не змінилася». Некоректна мітка → ConflictError. */
export function matchesVersion(column: AnyColumn, token: string): SQL {
  if (!/^\d{1,20}$/.test(token)) throw new ConflictError();
  return sql`(extract(epoch from ${column}) * 1000000)::bigint = ${token}::bigint`;
}

/** Значення updated_at для змін (сервер БД, мікросекунди; відрізняється для кожної транзакції). */
export const touchedAt = (): SQL<Date> => sql<Date>`clock_timestamp()`;
