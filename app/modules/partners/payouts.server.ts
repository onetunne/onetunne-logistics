/**
 * Етап 6, WP7: виплати партнерам (docs/stage6-design.md §9.5, §14.5, §20.3). Сервіси власника (finance.manage).
 *
 * - `operation_id` (uuid форми) унікальний: подвійне натискання / повтор — одна виплата (FINANCE_OP_LOCK + унікальний
 *   індекс); виплати одному партнеру — послідовно під FINANCE_PARTNER_LOCK (перевірка «До виплати» й запис — в одній
 *   транзакції);
 * - covers_amount + covers_currency — скільки балансу комісії закрито, ЗАВЖДИ у валюті комісії (валюта подій партнера,
 *   до першого нарахування — валюта магазину; currency.server.ts), ніколи у валюті виплати чи звітності: інакше аванс
 *   утворив би окремий баланс, який наступні нарахування не зменшують. = amount, якщо валюта та сама; інакше —
 *   конвертація на paid_on (rateFor, без запасного вигадування), власник може змінити; без курсу — відмова з
 *   проханням ввести суму вручну; валюта покриття не з валют комісії — відмова; валюту комісії не визначено (немає
 *   жодного замовлення) — відмова;
 * - виплата більша за «До виплати» → лише з підтвердженням «Виплата перевищує доступний баланс — утвориться аванс»;
 * - гроші — довідковий запис `partner_payout_memo` (не P&L; ключ pay:<payoutId>), дата = paid_on; курсова різниця між
 *   нарахуванням і виплатою автоматично НЕ рахується (власник може внести fx_difference вручну);
 * - анулювання — з причиною (історія змін), сторно довідкового запису; закритий місяць — відмова (§3.4).
 */
import { and, eq } from "drizzle-orm";
import type { Tx } from "~/db/client.server";
import { partnerPayouts, partners } from "~/db/schema";
import { PAYOUT_METHODS } from "~/domain/finance";
import { DomainError, NotFoundError } from "~/lib/errors";
import { fromMinor, isSupportedCurrency, parseOwnerAmount, toMinorForCurrency } from "~/lib/decimal";
import { businessDate, parseIsoDate } from "~/lib/periods";
import { writeAudit } from "~/modules/audit/audit.server";
import { requireFinance } from "~/modules/finance/core/access.server";
import { writeFinanceChange } from "~/modules/finance/core/change-log.server";
import { assertMonthOpen } from "~/modules/finance/core/closed-month.server";
import { activeEntryRefs, postEntries, reverseEntries } from "~/modules/finance/core/entries.server";
import { financeKeys } from "~/modules/finance/core/keys";
import { lockFinanceOperation, lockFinancePartner } from "~/modules/finance/core/locks.server";
import { convertAmount } from "~/modules/fx/convert";
import { rateFor } from "~/modules/fx/rate-for.server";
import { maskFreeTextNote } from "~/modules/privacy/notes";
import type { ServiceContext } from "~/server/types";
import { PARTNER_NOTE_MAX, PARTNER_REFERENCE_MAX } from "./input";
import { commissionCurrenciesOf } from "./currency.server";
import { loadPartnerEvents } from "./events.server";
import { deriveLedger } from "./ledger";
import type { Money, PayoutMethod } from "./types";

type Ctx = Pick<ServiceContext, "db" | "actor" | "now" | "mode">;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (code: string, params: Record<string, string | number> = {}, status = 400): never => {
  throw new DomainError(`partners.error.${code}`, status, params);
};

export interface CreatePayoutInput {
  operationId: string;
  partnerId: string;
  paidOn: string;
  /** Сума з форми власника («412,00»). */
  amount: string;
  currency: string;
  /** Скільки балансу комісії закрито (якщо валюта інша; порожньо — конвертація на дату виплати). */
  coversAmount?: string | null;
  coversCurrency?: string | null;
  method: string;
  reference?: string | null;
  note?: string | null;
  /** Підтвердження «утвориться аванс». */
  confirmAdvance?: boolean;
}

export interface CreatePayoutResult {
  id: string;
  duplicate: boolean;
  /** Виплата перевищила «До виплати» (аванс). */
  advance: boolean;
  amount: Money;
  covers: Money;
  /** «До виплати» до цієї виплати (у валюті комісії). */
  payableBefore: Money;
}

function currencyOf(raw: string | null | undefined): string {
  const c = (raw ?? "").trim().toUpperCase();
  if (!isSupportedCurrency(c)) fail("currencyInvalid");
  return c;
}

function positiveAmount(raw: string | null | undefined, currency: string): string {
  const parsed = parseOwnerAmount(raw);
  if (!parsed.ok) throw new DomainError(parsed.error, 400);
  const value = (parsed as { ok: true; value: string }).value;
  let minor: bigint;
  try {
    minor = toMinorForCurrency(value, currency);
  } catch {
    throw new DomainError("finance.error.amountWholeUnits", 400);
  }
  if (minor <= 0n) fail("amountNotPositive");
  return fromMinor(minor);
}

/** «До виплати» й валюти комісії партнера на сьогодні (у транзакції, під блокуванням партнера). */
async function payableOf(tx: Tx, partnerId: string, today: string): Promise<Map<string, bigint>> {
  const events = await loadPartnerEvents(tx, [partnerId]);
  const payouts = await tx
    .select({ id: partnerPayouts.id, coversAmount: partnerPayouts.coversAmount, coversCurrency: partnerPayouts.coversCurrency, status: partnerPayouts.status })
    .from(partnerPayouts)
    .where(eq(partnerPayouts.partnerId, partnerId));
  const out = new Map<string, bigint>();
  for (const l of deriveLedger(events, payouts, today)) out.set(l.currency, toMinorForCurrency(l.payable, l.currency));
  return out;
}

/** «Створити виплату» (сума, дата, спосіб, посилання, валюта; підтвердження аванса). */
export async function createPayout(ctx: Ctx, input: CreatePayoutInput): Promise<CreatePayoutResult> {
  requireFinance(ctx, "manage");
  if (!UUID_RE.test(input.operationId)) fail("operationInvalid");
  if (!UUID_RE.test(input.partnerId)) fail("notFound", {}, 404);
  const today = businessDate(ctx.now());
  const paidOn = parseIsoDate(input.paidOn);
  if (!paidOn) fail("dateInvalid");
  if (paidOn! > today) fail("dateInFuture");
  const currency = currencyOf(input.currency);
  const amount = positiveAmount(input.amount, currency);
  const method = input.method as PayoutMethod;
  if (!(PAYOUT_METHODS as readonly string[]).includes(method)) fail("methodInvalid");
  const reference = maskFreeTextNote(input.reference, PARTNER_REFERENCE_MAX);
  const note = maskFreeTextNote(input.note, PARTNER_NOTE_MAX);
  return ctx.db.transaction(async (tx) => {
    await lockFinanceOperation(tx, input.operationId);
    const [existing] = await tx.select().from(partnerPayouts).where(eq(partnerPayouts.operationId, input.operationId));
    if (existing) {
      if (existing.partnerId !== input.partnerId) fail("operationInvalid", {}, 409);
      return {
        id: existing.id,
        duplicate: true,
        advance: false,
        amount: { amount: existing.amount, currency: existing.currency },
        covers: { amount: existing.coversAmount, currency: existing.coversCurrency },
        payableBefore: { amount: "0.00", currency: existing.coversCurrency },
      };
    }
    await lockFinancePartner(tx, input.partnerId);
    const [partner] = await tx.select({ id: partners.id }).from(partners).where(eq(partners.id, input.partnerId));
    if (!partner) throw new NotFoundError("partner");
    await assertMonthOpen(tx, paidOn!);
    const payable = await payableOf(tx, partner.id, today);
    const commission = (await commissionCurrenciesOf(tx, [partner.id])).get(partner.id) ?? { primary: null, allowed: [] };
    let coversCurrency: string;
    if (input.coversCurrency && input.coversCurrency.trim() !== "") {
      coversCurrency = currencyOf(input.coversCurrency);
      if (!commission.allowed.includes(coversCurrency)) fail("coversCurrencyInvalid", { currency: coversCurrency });
    } else if (commission.primary) {
      coversCurrency = commission.primary;
    } else {
      coversCurrency = fail(commission.allowed.length === 0 ? "commissionCurrencyUnknown" : "coversCurrencyRequired", {}, 409);
    }
    let coversAmount: string;
    if (input.coversAmount && input.coversAmount.trim() !== "") coversAmount = positiveAmount(input.coversAmount, coversCurrency);
    else if (coversCurrency === currency) coversAmount = amount;
    else {
      const [px, py] = [await rateFor(tx, currency, paidOn!, { mode: ctx.mode }), await rateFor(tx, coversCurrency, paidOn!, { mode: ctx.mode })];
      if (!px.ok || !py.ok) fail("coversRateMissing", { currency: !px.ok ? currency : coversCurrency, date: paidOn! }, 409);
      coversAmount = convertAmount(amount, currency, coversCurrency, (px as { scaled: bigint }).scaled, (py as { scaled: bigint }).scaled);
      if (toMinorForCurrency(coversAmount, coversCurrency) <= 0n) fail("amountNotPositive");
    }
    const payableMinor = payable.get(coversCurrency) ?? 0n;
    const advance = toMinorForCurrency(coversAmount, coversCurrency) > payableMinor;
    if (advance && !input.confirmAdvance) {
      fail("payoutExceedsPayable", { payable: fromMinor(payableMinor), covers: coversAmount, currency: coversCurrency }, 409);
    }
    const [row] = await tx
      .insert(partnerPayouts)
      .values({
        partnerId: partner.id,
        operationId: input.operationId,
        paidOn: paidOn!,
        amount,
        currency,
        coversAmount,
        coversCurrency,
        method,
        reference,
        note,
        createdBy: ctx.actor.id,
      })
      .returning();
    const payout = row!;
    await postEntries(tx, ctx.actor, [
      {
        idempotencyKey: financeKeys.payout(payout.id),
        category: "partner_payout_memo",
        recognizedOn: paidOn!,
        fxOn: paidOn!,
        amount,
        currency,
        partnerId: partner.id,
        sourceType: "partner_payout",
        sourceId: payout.id,
        details: { method, coversAmount, coversCurrency, advance },
      },
    ], { now: ctx.now() });
    await writeFinanceChange(tx, ctx.actor, {
      entityType: "payout",
      entityId: payout.id,
      action: "create",
      after: { partnerId: partner.id, paidOn: paidOn!, amount, currency, coversAmount, coversCurrency, method, status: "active" },
    });
    await writeAudit(tx, ctx.actor, "finance.partner_payout_created", { type: "partner_payout", id: payout.id }, { partnerId: partner.id, advance });
    return {
      id: payout.id,
      duplicate: false,
      advance,
      amount: { amount, currency },
      covers: { amount: coversAmount, currency: coversCurrency },
      payableBefore: { amount: fromMinor(payableMinor), currency: coversCurrency },
    };
  });
}

/** Анулювати виплату (з причиною): статус voided, сторно довідкового запису, баланс перераховується при читанні. */
export async function voidPayout(ctx: Ctx, input: { id: string; reason: string }): Promise<{ reversed: number }> {
  requireFinance(ctx, "manage");
  if (!UUID_RE.test(input.id)) fail("payoutNotFound", {}, 404);
  const reason = maskFreeTextNote(input.reason, 300);
  if (!reason) fail("reasonRequired");
  return ctx.db.transaction(async (tx) => {
    const [peek] = await tx.select({ partnerId: partnerPayouts.partnerId }).from(partnerPayouts).where(eq(partnerPayouts.id, input.id));
    if (!peek) fail("payoutNotFound", {}, 404);
    await lockFinancePartner(tx, peek!.partnerId);
    const [row] = await tx.select().from(partnerPayouts).where(eq(partnerPayouts.id, input.id)).for("update");
    if (!row) fail("payoutNotFound", {}, 404);
    if (row!.status !== "active") fail("payoutAlreadyVoided", {}, 409);
    await assertMonthOpen(tx, row!.paidOn);
    const [updated] = await tx
      .update(partnerPayouts)
      .set({ status: "voided", voidedAt: new Date(), voidReason: reason })
      .where(and(eq(partnerPayouts.id, row!.id), eq(partnerPayouts.status, "active")))
      .returning({ id: partnerPayouts.id });
    if (!updated) fail("payoutAlreadyVoided", {}, 409);
    const refs = await activeEntryRefs(tx, { sourceType: "partner_payout", sourceId: row!.id });
    const { reversed } = await reverseEntries(tx, ctx.actor, refs.map((r) => r.id), { reasonCode: "payout_voided", now: ctx.now() });
    await writeFinanceChange(tx, ctx.actor, {
      entityType: "payout",
      entityId: row!.id,
      action: "void",
      before: { partnerId: row!.partnerId, paidOn: row!.paidOn, amount: row!.amount, currency: row!.currency, coversAmount: row!.coversAmount, coversCurrency: row!.coversCurrency, method: row!.method, status: "active" },
      after: { status: "voided" },
      reason,
    });
    await writeAudit(tx, ctx.actor, "finance.partner_payout_voided", { type: "partner_payout", id: row!.id }, { reversed });
    return { reversed };
  });
}
