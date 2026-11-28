/**
 * Етап 6: SQL-двійник конвертації (docs/stage6-design.md §5.5) — той самий вираз, що convertMinor (convert.ts), над
 * цілими numeric через div(): result = sign(n) × div(2|n| + D, 2D) × 10^(2 − dY), n = a × PX, D = PY × 10^(2 − dY).
 * Тест I6 (tests/stage6/core/fx-conversion.test.ts): SQL = TS на 10 000 випадків, зокрема валюти з 0 знаками, на PGlite
 * і PostgreSQL. Вибір курсу в SQL (sqlRateScaled) — те саме правило, що rateFor (rate-for.server.ts).
 */
import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { fxRates } from "~/db/schema";
import { FX_QUOTE_CURRENCY } from "~/domain/finance";
import { assertSupportedCurrency, RATE_SCALE_FACTOR } from "~/lib/decimal";
import type { AppMode } from "~/server/types";

type Expr = SQL | AnyPgColumn;

/** Автоматичні джерела курсів за режимом: робочий — НБУ, демо — вигадані демо-курси (§5.4 п. 3). */
export function automaticRateSources(mode: AppMode): readonly ("nbu" | "demo")[] {
  return mode === "demo" ? ["demo"] : ["nbu"];
}

/**
 * Конвертація в SQL: a — СОТІ частки (ціле numeric), PX/PY — курси × 10^10 (ціле numeric), dY ∈ {0, 2}.
 * NULL у будь-якому аргументі → NULL («немає курсу»), не 0.
 */
export function sqlConvertMinor(a: Expr, PX: Expr, PY: Expr, dY: number): SQL {
  if (dY !== 0 && dY !== 2) throw new RangeError(`unsupported target minor digits ${dY}`);
  const k = sql.raw(dY === 0 ? "100" : "1");
  const n = sql`((${a})::numeric * (${PX})::numeric)`;
  const D = sql`((${PY})::numeric * ${k})`;
  return sql`(sign(${n}) * div(2 * abs(${n}) + ${D}, 2 * ${D}) * ${k})`;
}

export interface SqlRateOptions {
  mode: AppMode;
  /** Запасний курс: до N днів назад (finance.fx.fallbackDays). */
  fallbackDays: number;
}

/**
 * P (курс × 10^10, ціле numeric) валюти на дату за правилом rateFor: UAH → 10^10; інакше найпізніший рядок у
 * [дата − fallbackDays, дата] серед поточних ручних і автоматичного джерела режиму, на ту саму дату — ручний першим.
 * Немає → NULL.
 */
export function sqlRateScaled(currency: Expr, date: Expr, opts: SqlRateOptions): SQL {
  if (!Number.isSafeInteger(opts.fallbackDays) || opts.fallbackDays < 0) throw new RangeError("fallbackDays");
  const auto = automaticRateSources(opts.mode)
    .map((s) => `'${s}'`)
    .join(", ");
  const scale = sql.raw(RATE_SCALE_FACTOR.toString());
  return sql`(case when (${currency})::text = ${FX_QUOTE_CURRENCY} then ${scale}::numeric else (
    select (r.rate_per_unit * ${scale})::numeric from ${fxRates} r
    where r.currency = (${currency})::char(3) and r.quote_currency = ${FX_QUOTE_CURRENCY}
      and ((r.source = 'manual' and r.is_current) or r.source in (${sql.raw(auto)}))
      and r.effective_date <= (${date})::date
      and r.effective_date >= (${date})::date - ${sql.raw(String(opts.fallbackDays))}
    order by r.effective_date desc, (r.source = 'manual') desc
    limit 1) end)`;
}

/**
 * Сума (numeric(14,2) колонка/вираз) у валюті `target` за курсом дати курсу запису; та сама валюта — без змін; без
 * курсу — NULL (запис не входить у суму, перелічується окремо). Результат — numeric з 2 знаками.
 */
export function sqlConvertAmount(amount: Expr, currency: Expr, fxOn: Expr, target: string, opts: SqlRateOptions): SQL {
  const dY = assertSupportedCurrency(target);
  const px = sqlRateScaled(currency, fxOn, opts);
  const py = sqlRateScaled(sql`${target}`, fxOn, opts);
  const converted = sqlConvertMinor(sql`round((${amount})::numeric * 100)`, px, py, dY);
  return sql`(case when (${currency})::text = ${target} then (${amount})::numeric else (${converted} / 100)::numeric(16, 2) end)`;
}
