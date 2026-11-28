/**
 * Етап 6, WP1: заповнення демо-курсів (docs/stage6-design.md §5.8, §19 п. 2) — для WP11 (`seedDemoFinance` викликає
 * `seedDemoRates(ctx)` ПЕРШИМ кроком, до фактів, щоб оцінка й журнал мали курси). Лише демо (`source = demo` лише в
 * демо-базі): в іншому режимі — відмова. Ідемпотентно: детерміновані значення + ON CONFLICT DO NOTHING (наступного дня
 * додається лише новий день); дві ручні версії EUR — один раз на демо-базу (якщо демо-версій ще немає й на ту дату немає
 * ручних рядків). Без історії змін і без перерахунків (заповнення порожньої бази).
 */
import { and, eq, or } from "drizzle-orm";
import { fxRates } from "~/db/schema";
import { FX_QUOTE_CURRENCY } from "~/domain/finance";
import { DomainError } from "~/lib/errors";
import { ratePerUnitScaled, scaledRateToDecimal } from "~/lib/decimal";
import { businessDate } from "~/lib/periods";
import type { ServiceContext } from "~/server/types";
import { demoManualEurVersions, generateDemoRates } from "./demo-rates";

const CHUNK = 400;

/** Хто «вніс» демо-версії ручного курсу (entered_by). */
export const DEMO_RATES_ACTOR_ID = "demo";

export async function seedDemoRates(ctx: Pick<ServiceContext, "db" | "mode" | "now">): Promise<{ inserted: number; manual: number }> {
  if (ctx.mode !== "demo") throw new DomainError("finance.error.demoOnly", 409);
  const today = businessDate(ctx.now());
  const rows = generateDemoRates(today).map((r) => ({
    source: "demo" as const,
    currency: r.currency,
    quoteCurrency: FX_QUOTE_CURRENCY,
    effectiveDate: r.effectiveDate,
    rate: r.rate,
    units: 1,
    ratePerUnit: scaledRateToDecimal(ratePerUnitScaled(r.rate, 1)),
    version: 1,
    isCurrent: true,
  }));
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const got = await ctx.db.insert(fxRates).values(rows.slice(i, i + CHUNK)).onConflictDoNothing().returning({ id: fxRates.id });
    inserted += got.length;
  }
  const versions = demoManualEurVersions(today);
  const first = versions[0]!;
  let manual = 0;
  await ctx.db.transaction(async (tx) => {
    const [any] = await tx
      .select({ id: fxRates.id })
      .from(fxRates)
      .where(
        or(
          and(eq(fxRates.source, "manual"), eq(fxRates.enteredBy, DEMO_RATES_ACTOR_ID)),
          and(eq(fxRates.source, "manual"), eq(fxRates.currency, first.currency), eq(fxRates.effectiveDate, first.effectiveDate)),
        ),
      )
      .limit(1);
    if (any) return;
    const last = versions.length - 1;
    for (const [i, v] of versions.entries()) {
      await tx.insert(fxRates).values({
        source: "manual",
        currency: v.currency,
        quoteCurrency: FX_QUOTE_CURRENCY,
        effectiveDate: v.effectiveDate,
        rate: v.rate,
        units: 1,
        ratePerUnit: scaledRateToDecimal(ratePerUnitScaled(v.rate, 1)),
        version: v.version,
        isCurrent: i === last,
        enteredBy: DEMO_RATES_ACTOR_ID,
        reason: v.reason,
      });
      manual++;
    }
  });
  return { inserted, manual };
}
