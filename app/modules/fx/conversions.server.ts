/**
 * Етап 6, WP1: обмін валюти (`fx_conversions`, форма «Обмін валюти» на сторінці «Курси»; docs/stage6-design.md §5.7,
 * §10.4, §14.5). Продано a у валюті A, отримано b у валюті B, дата D → ОДИН запис `fx_difference` = b − convert(a, A→B, D)
 * у валюті B (`recognized_on` = `fx_on` = D, R7; ключ `fxconv:<id>:v<n>`). Нульова різниця — без запису (CHECK
 * amount ≠ 0), обмін зберігається.
 *
 * - Курси — лише rateFor (§5.4) ТОЧНО на дату обміну (запасний курс не приймається: опублікований пізніше курс дати
 *   зробив би проведену різницю застарілою). Немає курсу будь-якої з валют → відмова «Немає курсу EUR на 27.11.2026 —
 *   додайте курс» (finance.error.noRate).
 * - Один operationId — одна операція (унікальний; під блокуванням операції — повтор повертає той самий обмін).
 * - Дата в закритому місяці — відмова. Анулювання — з причиною: сторно запису (F2), статус voided.
 * - Зміна курсу дати обміну (нова ручна версія, анулювання) → repriceConversions: сторно + новий запис наступної версії.
 * - Паралельність (§20.3): обмін бере блокування курсу кожної своєї валюти на дату (rate-lock.server.ts) ДО читання
 *   курсів — те саме, що зміна курсу. Тож або обмін читає вже збережений новий курс, або зміна курсу чекає й
 *   перераховує щойно збережений обмін (анулювання єдиного точного курсу — відмова).
 * Тут — лише сервіси власника (requireFinance). Внутрішні repriceConversions / conversionsNeedingRate (без перевірки
 * актора, без грошей у результаті) — у conversions-internal.server.ts.
 */
import { and, desc, eq, gte, lte } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { fxConversions } from "~/db/schema";
import { FX_CONVERSION_COUNTERPARTIES } from "~/domain/finance";
import { ConflictError, DomainError, NotFoundError } from "~/lib/errors";
import { fromMinor, parseOwnerAmount, toMinorForCurrency, UnsupportedCurrencyError } from "~/lib/decimal";
import { businessDate, parseIsoDate } from "~/lib/periods";
import { writeAudit } from "~/modules/audit/audit.server";
import { requireFinance } from "~/modules/finance/core/access.server";
import { writeFinanceChange } from "~/modules/finance/core/change-log.server";
import { assertMonthOpen } from "~/modules/finance/core/closed-month.server";
import { activeEntryRefs, postEntries, reverseEntries } from "~/modules/finance/core/entries.server";
import { lockFinanceOperation } from "~/modules/finance/core/locks.server";
import { DEFAULT_STORE_ID } from "~/modules/finance/core/store.server";
import { maskFreeTextNote } from "~/modules/privacy/notes";
import type { AppMode, ServiceContext } from "~/server/types";
import { conversionDifference } from "./conversion-calc";
import { conversionEntries, conversionEntry, exactRate, type ConversionRow } from "./conversions-internal.server";
import { lockRateDates } from "./rate-lock.server";
import { rateFor, type RateFound } from "./rate-for.server";
import { parseRateCurrency } from "./rate-input";

export type FxConversionCounterparty = (typeof FX_CONVERSION_COUNTERPARTIES)[number];
export const FX_CONVERSION_NOTE_MAX = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = Pick<ServiceContext, "db" | "actor" | "mode" | "now">;

export interface CreateFxConversionInput {
  operationId: string;
  occurredOn: string;
  /** Суми з форми власника («1 000,00»). */
  soldAmount: string;
  soldCurrency: string;
  boughtAmount: string;
  boughtCurrency: string;
  counterparty?: string;
  note?: string | null;
}

export interface UsedRate {
  currency: string;
  ratePerUnit: string;
  source: RateFound["source"];
  version: number | null;
}

export interface FxConversionResult {
  id: string;
  /** Той самий operationId уже збережено — повернуто наявний обмін. */
  duplicate: boolean;
  version: number;
  occurredOn: string;
  /** Очікувана сума у валюті купівлі за курсами дати обміну (null — курсу на дату зараз немає). */
  expected: { amount: string; currency: string } | null;
  /** Курсова різниця у валюті купівлі (проведена; "0.00" — без запису). */
  difference: { amount: string; currency: string };
  /** Курси дати обміну (null — курсу зараз немає). */
  rates: { sold: UsedRate | null; bought: UsedRate | null };
}

function currencyOf(input: string, field: string): string {
  const c = parseRateCurrency(input);
  if (c.ok) return c.currency;
  const code = (input ?? "").trim().toUpperCase();
  // Гривня — допустима сторона обміну (курс рівно 1).
  if (code === "UAH") return code;
  throw new DomainError(c.error, 400, { field, currency: code.slice(0, 3) });
}

function amountOf(input: string, currency: string, field: string): string {
  const r = parseOwnerAmount(input);
  if (!r.ok) throw new DomainError(r.error, 400, { field });
  try {
    if (toMinorForCurrency(r.value, currency) <= 0n) throw new DomainError("financeFx.error.amountNotPositive", 400, { field });
  } catch (e) {
    if (e instanceof DomainError) throw e;
    if (e instanceof UnsupportedCurrencyError) throw new DomainError("finance.error.unsupportedCurrency", 400, { currency });
    throw new DomainError("finance.error.amountWholeUnits", 400, { field });
  }
  return r.value;
}

const used = (r: RateFound): UsedRate => ({ currency: r.currency, ratePerUnit: r.ratePerUnit, source: r.source, version: r.version });

/** Зберігає обмін і проводить курсову різницю (див. вгорі файла). */
export async function createFxConversion(ctx: Ctx, input: CreateFxConversionInput): Promise<FxConversionResult> {
  requireFinance(ctx, "manage");
  if (!UUID_RE.test(input.operationId ?? "")) throw new DomainError("financeFx.error.operationInvalid", 400);
  const today = businessDate(ctx.now());
  const date = parseIsoDate(input.occurredOn);
  if (!date) throw new DomainError("financeFx.error.dateInvalid", 400);
  if (date > today) throw new DomainError("financeFx.error.dateInFuture", 400);
  const soldCurrency = currencyOf(input.soldCurrency, "soldCurrency");
  const boughtCurrency = currencyOf(input.boughtCurrency, "boughtCurrency");
  if (soldCurrency === boughtCurrency) throw new DomainError("financeFx.error.sameCurrency", 400);
  const soldAmount = amountOf(input.soldAmount, soldCurrency, "soldAmount");
  const boughtAmount = amountOf(input.boughtAmount, boughtCurrency, "boughtAmount");
  const counterparty = (input.counterparty ?? "bank") as FxConversionCounterparty;
  if (!(FX_CONVERSION_COUNTERPARTIES as readonly string[]).includes(counterparty)) throw new DomainError("financeFx.error.counterpartyInvalid", 400);
  const note = maskFreeTextNote(input.note, FX_CONVERSION_NOTE_MAX);
  return ctx.db.transaction(async (tx) => {
    await lockFinanceOperation(tx, input.operationId);
    const [dup] = await tx.select().from(fxConversions).where(eq(fxConversions.operationId, input.operationId));
    if (dup) return describeExisting(tx, ctx.mode, dup);
    // Блокування курсу дати — до читання курсів і до блокування місяця (той самий порядок, що в сервісі ручних курсів).
    await lockRateDates(tx, [soldCurrency, boughtCurrency], date);
    await assertMonthOpen(tx, date);
    const sold = await exactRate(tx, soldCurrency, date, ctx.mode);
    const bought = await exactRate(tx, boughtCurrency, date, ctx.mode);
    const calc = conversionDifference({ soldAmount, soldCurrency, boughtAmount, boughtCurrency, soldRate: sold.scaled, boughtRate: bought.scaled });
    const [row] = await tx
      .insert(fxConversions)
      .values({
        occurredOn: date,
        soldAmount,
        soldCurrency,
        boughtAmount,
        boughtCurrency,
        counterparty,
        note,
        operationId: input.operationId,
        createdBy: ctx.actor.id,
      })
      .returning();
    if (toMinorForCurrency(calc.difference, boughtCurrency) !== 0n) {
      await postEntries(tx, ctx.actor, [conversionEntry(row!, 1, calc.difference, sold, bought)], { now: ctx.now() });
    }
    await writeFinanceChange(tx, ctx.actor, {
      entityType: "fx_conversion",
      entityId: row!.id,
      action: "create",
      after: {
        occurredOn: date,
        soldAmount,
        soldCurrency,
        boughtAmount,
        boughtCurrency,
        counterparty,
        status: "active",
        difference: calc.difference,
        differenceCurrency: boughtCurrency,
        version: 1,
      },
      reason: note,
    });
    await writeAudit(tx, ctx.actor, "finance.fx_conversion_created", { type: "fx_conversion", id: row!.id });
    return {
      id: row!.id,
      duplicate: false,
      version: 1,
      occurredOn: date,
      expected: { amount: calc.expected, currency: boughtCurrency },
      difference: { amount: calc.difference, currency: boughtCurrency },
      rates: { sold: used(sold), bought: used(bought) },
    };
  });
}

async function describeExisting(db: DbOrTx, mode: AppMode, row: ConversionRow): Promise<FxConversionResult> {
  const active = (await conversionEntries(db, [row.id])).get(row.id);
  const sold = await rateFor(db, row.soldCurrency, row.occurredOn, { mode, fallbackDays: 0 });
  const bought = await rateFor(db, row.boughtCurrency, row.occurredOn, { mode, fallbackDays: 0 });
  const expected =
    sold.ok && bought.ok
      ? conversionDifference({ soldAmount: row.soldAmount, soldCurrency: row.soldCurrency, boughtAmount: row.boughtAmount, boughtCurrency: row.boughtCurrency, soldRate: sold.scaled, boughtRate: bought.scaled }).expected
      : null;
  return {
    id: row.id,
    duplicate: true,
    version: row.version,
    occurredOn: row.occurredOn,
    expected: expected === null ? null : { amount: expected, currency: row.boughtCurrency },
    difference: { amount: fromMinor(active?.amount ?? 0n), currency: row.boughtCurrency },
    rates: { sold: sold.ok ? used(sold) : null, bought: bought.ok ? used(bought) : null },
  };
}

export interface VoidFxConversionInput {
  id: string;
  reason: string;
  expectedVersion?: number | null;
}

/** Анулює обмін (з причиною): сторно проведеної різниці, статус voided. Повторне анулювання — без змін. */
export async function voidFxConversion(ctx: Ctx, input: VoidFxConversionInput): Promise<{ voided: boolean; reversed: number }> {
  requireFinance(ctx, "manage");
  if (!UUID_RE.test(input.id ?? "")) throw new NotFoundError("fx_conversion");
  const reason = maskFreeTextNote(input.reason, 300);
  if (!reason) throw new DomainError("financeFx.error.reasonRequired", 400);
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx.select().from(fxConversions).where(eq(fxConversions.id, input.id)).for("update");
    if (!row) throw new NotFoundError("fx_conversion");
    if (row.status === "voided") return { voided: false, reversed: 0 };
    if (input.expectedVersion !== undefined && input.expectedVersion !== null && input.expectedVersion !== row.version) throw new ConflictError();
    await assertMonthOpen(tx, row.occurredOn);
    const refs = await activeEntryRefs(tx, { storeId: row.storeId, sourceType: "fx_conversion", sourceId: row.id });
    const { reversed } = await reverseEntries(tx, ctx.actor, refs.map((r) => r.id), { now: ctx.now() });
    const [updated] = await tx
      .update(fxConversions)
      .set({ status: "voided", voidedAt: ctx.now(), voidReason: reason, version: row.version + 1 })
      .where(and(eq(fxConversions.id, row.id), eq(fxConversions.version, row.version)))
      .returning({ version: fxConversions.version });
    if (!updated) throw new ConflictError();
    await writeFinanceChange(tx, ctx.actor, {
      entityType: "fx_conversion",
      entityId: row.id,
      action: "void",
      before: { status: "active", version: row.version },
      after: { status: "voided", version: updated.version },
      reason,
    });
    await writeAudit(tx, ctx.actor, "finance.fx_conversion_voided", { type: "fx_conversion", id: row.id }, { reversed });
    return { voided: true, reversed };
  });
}

export interface FxConversionListItem {
  id: string;
  occurredOn: string;
  soldAmount: string;
  soldCurrency: string;
  boughtAmount: string;
  boughtCurrency: string;
  counterparty: string;
  status: "active" | "voided";
  version: number;
  /** Очікувано за поточними курсами дати (null — курсу немає). */
  expected: string | null;
  /** Проведена різниця у валюті купівлі; null — анульовано (різниця сторнована). */
  difference: string | null;
  voidedAt: string | null;
  createdAt: string;
}

/** Обміни валюти (finance.view), новіші першими. */
export async function listFxConversions(ctx: Pick<ServiceContext, "db" | "actor" | "mode">, filter: { from?: string; to?: string; limit?: number } = {}): Promise<FxConversionListItem[]> {
  requireFinance(ctx, "view");
  const conds = [eq(fxConversions.storeId, DEFAULT_STORE_ID)];
  const from = parseIsoDate(filter.from ?? "");
  const to = parseIsoDate(filter.to ?? "");
  if (from) conds.push(gte(fxConversions.occurredOn, from));
  if (to) conds.push(lte(fxConversions.occurredOn, to));
  const rows = await ctx.db
    .select()
    .from(fxConversions)
    .where(and(...conds))
    .orderBy(desc(fxConversions.occurredOn), desc(fxConversions.createdAt))
    .limit(Math.min(Math.max(filter.limit ?? 50, 1), 500));
  const active = await conversionEntries(ctx.db, rows.map((r) => r.id));
  const out: FxConversionListItem[] = [];
  for (const r of rows) {
    const s = await rateFor(ctx.db, r.soldCurrency, r.occurredOn, { mode: ctx.mode, fallbackDays: 0 });
    const b = await rateFor(ctx.db, r.boughtCurrency, r.occurredOn, { mode: ctx.mode, fallbackDays: 0 });
    const expected =
      s.ok && b.ok
        ? conversionDifference({ soldAmount: r.soldAmount, soldCurrency: r.soldCurrency, boughtAmount: r.boughtAmount, boughtCurrency: r.boughtCurrency, soldRate: s.scaled, boughtRate: b.scaled }).expected
        : null;
    const status = r.status === "voided" ? "voided" : "active";
    out.push({
      id: r.id,
      occurredOn: r.occurredOn,
      soldAmount: r.soldAmount,
      soldCurrency: r.soldCurrency,
      boughtAmount: r.boughtAmount,
      boughtCurrency: r.boughtCurrency,
      counterparty: r.counterparty,
      status,
      version: r.version,
      expected,
      difference: status === "voided" ? null : fromMinor(active.get(r.id)?.amount ?? 0n),
      voidedAt: r.voidedAt ? r.voidedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    });
  }
  return out;
}
