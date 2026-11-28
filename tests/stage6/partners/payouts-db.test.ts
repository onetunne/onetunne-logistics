/**
 * Етап 6, WP7: виплати на БД (§9.5, §14.5, §3.4): operation_id — одна виплата; довідковий запис partner_payout_memo
 * (pay:<id>, не P&L); виплата понад «До виплати» — лише з підтвердженням аванса; інша валюта — covers на дату виплати
 * (курс фінансів; без курсу — відмова з проханням ввести вручну; ручне значення власника); анулювання — сторно запису й
 * повернення балансу; закритий місяць і майбутня дата — відмова; історія змін і журнал аудиту без імен.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, financeChangeLog, financeEntries, financePeriods, fxRates, partnerPayouts } from "~/db/schema";
import { affectsProfit } from "~/domain/finance";
import { getPartnerDetail } from "~/modules/partners/partners.server";
import { createPayout, voidPayout } from "~/modules/partners/payouts.server";
import { createTestEnv, type TestEnv } from "../../helpers";
import { g1Order, makePartner, ownerCtx, recognize, sync } from "./helpers";

let env: TestEnv;
let partnerId = "";
const NOW = "2026-11-28T10:00:00Z";
const ctx = () => ownerCtx(env, NOW);

beforeAll(async () => {
  env = await createTestEnv({ seed: false });
  partnerId = await makePartner(env, { name: "Демо-партнер Виплати", codes: [{ source: "discount_code", code: "PAYME" }] });
  for (let i = 0; i < 2; i++) {
    const o = await g1Order(env, "PAYME");
    await recognize(env, o, "2026-10-05");
    await sync(env, o, { finance: { state: "recognized", recognizedOn: "2026-10-05", recognizedAt: new Date("2026-10-05T10:00:00Z"), newlyRecognized: true } });
  }
  // Демо-курси (контекст тестів — демо): EUR 20.11 = 48,8000.
  await env.handle.db.insert(fxRates).values({ source: "demo", currency: "EUR", effectiveDate: "2026-11-20", rate: "48.8", units: 1, ratePerUnit: "48.8000000000" });
});
afterAll(async () => {
  await env.close();
});

const ledger = async () => (await getPartnerDetail(ctx(), partnerId))!.ledger[0]!;
const base = () => ({ partnerId, method: "bank" });

describe("payouts", () => {
  it("payable 23,40; a payout within it → memo entry pay:<id> (not P&L), change log and audit without names", async () => {
    expect(await ledger()).toMatchObject({ payable: "23.40", balance: "23.40" });
    const op = randomUUID();
    const r = await createPayout(ctx(), { ...base(), operationId: op, paidOn: "2026-11-20", amount: "10,00", currency: "EUR", reference: "PAY-1", note: "Перша виплата" });
    expect(r).toMatchObject({ duplicate: false, advance: false, amount: { amount: "10.00", currency: "EUR" }, covers: { amount: "10.00", currency: "EUR" }, payableBefore: { amount: "23.40" } });
    const [row] = await env.handle.db.select().from(partnerPayouts).where(eq(partnerPayouts.id, r.id));
    expect(row).toMatchObject({ operationId: op, status: "active", reference: "PAY-1", note: "Перша виплата", paidOn: "2026-11-20" });
    const entries = await env.handle.db.select().from(financeEntries).where(and(eq(financeEntries.sourceType, "partner_payout"), eq(financeEntries.sourceId, r.id)));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ idempotencyKey: `pay:${r.id}`, category: "partner_payout_memo", amount: "10.00", currency: "EUR", recognizedOn: "2026-11-20", fxOn: "2026-11-20", partnerId });
    expect(affectsProfit("partner_payout_memo")).toBe(false);
    const [log] = await env.handle.db.select().from(financeChangeLog).where(eq(financeChangeLog.entityId, r.id));
    expect(log).toMatchObject({ entityType: "payout", action: "create" });
    expect(log!.after).toEqual({ partnerId, paidOn: "2026-11-20", amount: "10.00", currency: "EUR", coversAmount: "10.00", coversCurrency: "EUR", method: "bank", status: "active" });
    const audits = await env.handle.db.select().from(auditLog).where(eq(auditLog.entityId, r.id));
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toMatch(/Демо-партнер|Перша виплата/);
    expect(await ledger()).toMatchObject({ paid: "10.00", balance: "13.40", payable: "13.40" });
  });

  it("the same operationId twice → one payout and one entry", async () => {
    const op = randomUUID();
    const a = await createPayout(ctx(), { ...base(), operationId: op, paidOn: "2026-11-21", amount: "1.00", currency: "EUR" });
    const b = await createPayout(ctx(), { ...base(), operationId: op, paidOn: "2026-11-21", amount: "1.00", currency: "EUR" });
    expect(b).toMatchObject({ id: a.id, duplicate: true });
    expect(await env.handle.db.select().from(partnerPayouts).where(eq(partnerPayouts.operationId, op))).toHaveLength(1);
    expect(await env.handle.db.select().from(financeEntries).where(eq(financeEntries.sourceId, a.id))).toHaveLength(1);
    expect(await ledger()).toMatchObject({ paid: "11.00", payable: "12.40" });
  });

  it("beyond «Payable» → refused without the advance confirmation; with it → advance (negative balance)", async () => {
    await expect(createPayout(ctx(), { ...base(), operationId: randomUUID(), paidOn: "2026-11-22", amount: "20", currency: "EUR" })).rejects.toMatchObject({
      code: "partners.error.payoutExceedsPayable",
      params: { payable: "12.40", covers: "20.00", currency: "EUR" },
    });
    const r = await createPayout(ctx(), { ...base(), operationId: randomUUID(), paidOn: "2026-11-22", amount: "20", currency: "EUR", confirmAdvance: true });
    expect(r).toMatchObject({ advance: true });
    expect(await ledger()).toMatchObject({ paid: "31.00", balance: "-7.60", owes: "7.60", payable: "0.00" });
  });

  it("void → reversal of the memo entry (Σ = 0), balance restored; a second void is refused", async () => {
    const [last] = await env.handle.db.select().from(partnerPayouts).where(eq(partnerPayouts.amount, "20.00"));
    expect(await voidPayout(ctx(), { id: last!.id, reason: "Помилкова сума" })).toEqual({ reversed: 1 });
    const entries = await env.handle.db.select().from(financeEntries).where(eq(financeEntries.sourceId, last!.id)).orderBy(financeEntries.seq);
    expect(entries.map((e) => [e.idempotencyKey, e.amount])).toEqual([
      [`pay:${last!.id}`, "20.00"],
      [`pay:${last!.id}:rev`, "-20.00"],
    ]);
    expect(await ledger()).toMatchObject({ paid: "11.00", balance: "12.40", payable: "12.40" });
    await expect(voidPayout(ctx(), { id: last!.id, reason: "Ще раз" })).rejects.toMatchObject({ code: "partners.error.payoutAlreadyVoided" });
    await expect(voidPayout(ctx(), { id: last!.id, reason: "" })).rejects.toMatchObject({ code: "partners.error.reasonRequired" });
    const detail = (await getPartnerDetail(ctx(), partnerId))!;
    expect(detail.payouts.find((p) => p.id === last!.id)).toMatchObject({ status: "voided", voidReason: "Помилкова сума" });
  });

  it("another currency: covers converted on the payout date; without a rate → refused (enter manually); manual covers accepted", async () => {
    const r = await createPayout(ctx(), { ...base(), operationId: randomUUID(), paidOn: "2026-11-20", amount: "244,00", currency: "UAH", coversCurrency: "EUR" });
    expect(r).toMatchObject({ amount: { amount: "244.00", currency: "UAH" }, covers: { amount: "5.00", currency: "EUR" }, advance: false });
    await expect(createPayout(ctx(), { ...base(), operationId: randomUUID(), paidOn: "2026-11-01", amount: "100", currency: "UAH", coversCurrency: "EUR" })).rejects.toMatchObject({
      code: "partners.error.coversRateMissing",
      params: { currency: "EUR", date: "2026-11-01" },
    });
    const manual = await createPayout(ctx(), { ...base(), operationId: randomUUID(), paidOn: "2026-11-01", amount: "100", currency: "UAH", coversCurrency: "EUR", coversAmount: "2,00" });
    expect(manual.covers).toEqual({ amount: "2.00", currency: "EUR" });
    expect(await ledger()).toMatchObject({ paid: "18.00", balance: "5.40" });
    const memo = await env.handle.db.select().from(financeEntries).where(eq(financeEntries.sourceId, manual.id));
    expect(memo[0]).toMatchObject({ amount: "100.00", currency: "UAH", category: "partner_payout_memo" });
  });

  it("closed month and a future date are refused; invalid input is refused", async () => {
    await env.handle.db.insert(financePeriods).values({ month: "2026-10-01", status: "closed", closedAt: new Date(), closedBy: "test" });
    await expect(createPayout(ctx(), { ...base(), operationId: randomUUID(), paidOn: "2026-10-30", amount: "1", currency: "EUR" })).rejects.toMatchObject({ code: "finance.error.monthClosed" });
    await expect(createPayout(ctx(), { ...base(), operationId: randomUUID(), paidOn: "2026-11-29", amount: "1", currency: "EUR" })).rejects.toMatchObject({ code: "partners.error.dateInFuture" });
    await expect(createPayout(ctx(), { ...base(), operationId: randomUUID(), paidOn: "2026-11-20", amount: "0", currency: "EUR" })).rejects.toMatchObject({ code: "partners.error.amountNotPositive" });
    await expect(createPayout(ctx(), { ...base(), operationId: randomUUID(), paidOn: "2026-11-20", amount: "1,005", currency: "EUR" })).rejects.toMatchObject({ code: "finance.error.amountTooPrecise" });
    await expect(createPayout(ctx(), { ...base(), operationId: randomUUID(), paidOn: "2026-11-20", amount: "1", currency: "EUR", method: "crypto" })).rejects.toMatchObject({ code: "partners.error.methodInvalid" });
    await expect(createPayout(ctx(), { ...base(), operationId: "nope", paidOn: "2026-11-20", amount: "1", currency: "EUR" })).rejects.toMatchObject({ code: "partners.error.operationInvalid" });
    await expect(createPayout(ctx(), { ...base(), operationId: randomUUID(), paidOn: "2026-11-20", amount: "1,50", currency: "JPY" })).rejects.toMatchObject({ code: "finance.error.amountWholeUnits" });
  });

  it("reference and note are masked (no card numbers)", async () => {
    const r = await createPayout(ctx(), { ...base(), operationId: randomUUID(), paidOn: "2026-11-20", amount: "1", currency: "EUR", reference: "card 4111 1111 1111 1111", confirmAdvance: true });
    const [row] = await env.handle.db.select().from(partnerPayouts).where(eq(partnerPayouts.id, r.id));
    expect(row!.reference).not.toMatch(/4111/);
  });
});
