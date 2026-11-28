/**
 * Етап 6 (WP0): фінансовий журнал (F2, §3.4, I3, I14). Ідемпотентне проведення (той самий ключ двічі → один рядок),
 * CHECK amount <> 0 у БД, пізні записи в закритий місяць, сторно (fx_on і original_on — з оригіналу; оригінал +
 * сторно = 0 у кожній валюті показу), без персональних даних у details. Результати внутрішніх функцій — лише кількості.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { financeEntries, financePeriods, fxRates } from "~/db/schema";
import { QUICK_CURRENCIES } from "~/domain/finance";
import { SYSTEM_ACTOR } from "~/domain/permissions";
import { assertSupportedCurrency, convertMinor, ratePerUnitScaled, scaledToDecimal, toMinor } from "~/lib/decimal";
import { activeEntryRefs, postEntries, repostEntries, reverseEntries, reverseEntry } from "~/modules/finance/core/entries.server";
import { makeEntryInput } from "~/modules/finance/core/fakes";
import { financeKeys, generationOf, isBaseFactKey, withGeneration } from "~/modules/finance/core/keys";
import { createRateResolver } from "~/modules/fx/rate-for.server";
import { createTestEnv, type TestEnv } from "../../helpers";

let env: TestEnv;
const actor = { id: "test-staff" };
beforeAll(async () => {
  env = await createTestEnv({ seed: false });
});
afterAll(async () => {
  await env.close();
});

const rows = (key: string) => env.handle.db.select().from(financeEntries).where(eq(financeEntries.idempotencyKey, key));

describe("postEntries", () => {
  it("is idempotent: the same key twice → one row; the result carries only counts", async () => {
    const entry = makeEntryInput({ idempotencyKey: financeKeys.sale("gid://shopify/Sale/1", "net"), amount: "50.00" });
    const first = await env.handle.db.transaction((tx) => postEntries(tx, actor, [entry]));
    const second = await env.handle.db.transaction((tx) => postEntries(tx, actor, [entry, { ...entry }].slice(0, 1)));
    expect(first).toEqual({ inserted: 1, skipped: 0, skippedReversed: 0, late: 0 });
    expect(second).toEqual({ inserted: 0, skipped: 1, skippedReversed: 0, late: 0 });
    const saved = await rows(entry.idempotencyKey);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ storeId: "default", amount: "50.00", currency: "EUR", postedBy: "test-staff", isLate: false, originalOn: "2026-11-10" });
    expect(typeof saved[0]!.seq).toBe("number");
    // Дубль ключа в одному виклику — помилка програміста.
    await expect(env.handle.db.transaction((tx) => postEntries(tx, actor, [makeEntryInput({ idempotencyKey: "dup:1" }), makeEntryInput({ idempotencyKey: "dup:1" })]))).rejects.toThrow();
  });

  it("rejects zero, unsupported currencies, fractional 0-decimal amounts and PII keys in details", async () => {
    const post = (e: Parameters<typeof makeEntryInput>[0]) => env.handle.db.transaction((tx) => postEntries(tx, actor, [makeEntryInput(e)]));
    await expect(post({ amount: "0.00" })).rejects.toMatchObject({ code: "finance.error.invalidEntry" });
    await expect(post({ currency: "KWD" })).rejects.toMatchObject({ code: "finance.error.unsupportedCurrency" });
    await expect(post({ currency: "JPY", amount: "12.50" })).rejects.toMatchObject({ code: "finance.error.invalidEntry" });
    await expect(post({ details: { customerName: "x" } })).rejects.toThrow(/details/);
    await expect(post({ details: { shippingAddress: "x" } })).rejects.toThrow(/details/);
    await expect(post({ recognizedOn: "2026-13-01" })).rejects.toMatchObject({ code: "finance.error.invalidEntry" });
    await expect(post({ idempotencyKey: "k".repeat(197) })).rejects.toMatchObject({ code: "finance.error.invalidEntry" });
  });

  it("the database itself refuses amount = 0 (CHECK) and a duplicate (store, key)", async () => {
    const insert = (key: string, amount: string) =>
      env.handle.db.insert(financeEntries).values({
        idempotencyKey: key,
        category: "advertising",
        recognizedOn: "2026-11-01",
        originalOn: "2026-11-01",
        fxOn: "2026-11-01",
        amount,
        currency: "UAH",
        sourceType: "expense",
        sourceId: "x",
        postedBy: "test",
      });
    await expect(insert("chk:zero", "0")).rejects.toThrow();
    await expect(insert("chk:cat", "1").then(() => env.handle.db.execute(sql`update finance_entries set category = 'bogus' where idempotency_key = 'chk:cat'`))).rejects.toThrow();
    await insert("chk:dup", "1.00");
    await expect(insert("chk:dup", "2.00")).rejects.toThrow();
  });

  it("a fact belonging to a CLOSED month is posted on the posting date with is_late, keeping original_on and fx_on", async () => {
    await env.handle.db.insert(financePeriods).values({ month: "2026-09-01", status: "closed", closedAt: new Date(), closedBy: "test-owner" });
    const entry = makeEntryInput({ idempotencyKey: "late:1", recognizedOn: "2026-09-15", fxOn: "2026-09-14", category: "cogs", amount: "-10.00" });
    const r = await env.handle.db.transaction((tx) => postEntries(tx, actor, [entry], { now: new Date("2026-11-28T10:00:00Z") }));
    expect(r).toEqual({ inserted: 1, skipped: 0, skippedReversed: 0, late: 1 });
    const [row] = await rows("late:1");
    expect(row).toMatchObject({ recognizedOn: "2026-11-28", originalOn: "2026-09-15", fxOn: "2026-09-14", isLate: true });
  });
});

describe("reverseEntry (F2, I14)", () => {
  beforeAll(async () => {
    // Курси для валют показу на дату курсу оригіналу й на іншу дату (сторно мусить узяти дату оригіналу).
    const rate = (currency: string, date: string, value: string) => ({
      source: "nbu" as const,
      currency,
      effectiveDate: date,
      rate: value,
      units: 1,
      ratePerUnit: scaledToDecimal(ratePerUnitScaled(value, 1), 10),
    });
    await env.handle.db.insert(fxRates).values([
      rate("EUR", "2026-10-05", "48.5000"),
      rate("EUR", "2026-11-28", "49.9000"),
      rate("USD", "2026-10-05", "41.2000"),
      rate("USD", "2026-11-28", "42.0000"),
      rate("GBP", "2026-10-05", "55.1000"),
      rate("GBP", "2026-11-28", "56.3000"),
      rate("PLN", "2026-10-05", "11.0300"),
      rate("PLN", "2026-11-28", "11.2900"),
    ]);
  });

  it("copies category, dimensions, original_on and fx_on; negates the amount; original + reversal = 0 in every display currency", async () => {
    const original = makeEntryInput({
      idempotencyKey: "rev:orig:1",
      category: "sales_product",
      recognizedOn: "2026-10-05",
      fxOn: "2026-10-05",
      amount: "123.47",
      currency: "EUR",
      presentmentAmount: "106.66",
      presentmentCurrency: "GBP",
      countryCode: "DE",
      quantity: 2,
      details: { lineType: "PRODUCT" },
    });
    await env.handle.db.transaction((tx) => postEntries(tx, actor, [original]));
    const [orig] = await rows("rev:orig:1");
    // Місяць оригіналу закрито ПІСЛЯ проведення — сторно стає пізнім записом, але fx_on — з оригіналу.
    await env.handle.db.insert(financePeriods).values({ month: "2026-10-01", status: "closed", closedAt: new Date(), closedBy: "test-owner" });
    const r1 = await env.handle.db.transaction((tx) => reverseEntry(tx, SYSTEM_ACTOR, orig!.id, { reasonCode: "replaced", now: new Date("2026-11-28T09:00:00Z") }));
    const r2 = await env.handle.db.transaction((tx) => reverseEntry(tx, SYSTEM_ACTOR, orig!.id));
    expect(r1).toEqual({ reversed: 1 });
    expect(r2).toEqual({ reversed: 0 });
    const [rev] = await rows(financeKeys.reversal("rev:orig:1"));
    expect(rev).toMatchObject({
      category: "sales_product",
      amount: "-123.47",
      currency: "EUR",
      presentmentAmount: "-106.66",
      presentmentCurrency: "GBP",
      countryCode: "DE",
      quantity: 2,
      reversesEntryId: orig!.id,
      originalOn: "2026-10-05",
      fxOn: "2026-10-05",
      recognizedOn: "2026-11-28",
      isLate: true,
      postedBy: "system",
    });
    expect(rev!.details).toMatchObject({ lineType: "PRODUCT", reversal: true, reversalReason: "replaced" });

    const resolver = await createRateResolver(env.handle.db, { currencies: ["EUR", "USD", "GBP", "PLN"], from: "2026-10-01", to: "2026-11-30" }, { mode: "production", fallbackDays: 7 });
    for (const target of QUICK_CURRENCIES) {
      const dY = assertSupportedCurrency(target);
      const conv = (e: typeof orig) => {
        if (e!.currency === target) return toMinor(e!.amount);
        const px = resolver.scaled(e!.currency, e!.fxOn)!;
        const py = resolver.scaled(target, e!.fxOn)!;
        return convertMinor(toMinor(e!.amount), px, py, dY);
      };
      expect(conv(orig) + conv(rev), target).toBe(0n);
    }
  });

  it("a reversal of a reversal is refused; reverseEntries counts; activeEntryRefs excludes reversed entries", async () => {
    const [rev] = await rows(financeKeys.reversal("rev:orig:1"));
    await expect(env.handle.db.transaction((tx) => reverseEntry(tx, actor, rev!.id))).rejects.toMatchObject({ code: "finance.error.reverseReversal" });
    await env.handle.db.transaction((tx) =>
      postEntries(tx, actor, [
        makeEntryInput({ idempotencyKey: "exp:e1:v1:2026-11-01", category: "advertising", amount: "-33.34", currency: "UAH", recognizedOn: "2026-11-01", fxOn: "2026-11-01", sourceType: "expense", sourceId: "e1" }),
        makeEntryInput({ idempotencyKey: "exp:e1:v1:2026-11-02", category: "advertising", amount: "-33.33", currency: "UAH", recognizedOn: "2026-11-02", fxOn: "2026-11-02", sourceType: "expense", sourceId: "e1" }),
      ]),
    );
    const before = await activeEntryRefs(env.handle.db, { keyPrefix: "exp:e1:v1:" });
    expect(before.map((r) => r.idempotencyKey)).toEqual(["exp:e1:v1:2026-11-01", "exp:e1:v1:2026-11-02"]);
    expect(Object.keys(before[0]!).sort()).toEqual(["category", "id", "idempotencyKey"]);
    const r = await env.handle.db.transaction((tx) => reverseEntries(tx, actor, before.map((b) => b.id)));
    expect(r).toEqual({ reversed: 2 });
    expect(await activeEntryRefs(env.handle.db, { sourceType: "expense", sourceId: "e1" })).toEqual([]);
    const all = await env.handle.db.select().from(financeEntries).where(and(eq(financeEntries.sourceType, "expense"), eq(financeEntries.sourceId, "e1")));
    expect(all.reduce((acc, e) => acc + toMinor(e.amount), 0n)).toBe(0n);
  });
});

describe("re-posting a fact that becomes valid again (F2 generations; §2.5 includeTestOrders on → off → on)", () => {
  const sum = async (base: string) => {
    const all = await env.handle.db
      .select({ key: financeEntries.idempotencyKey, amount: financeEntries.amount })
      .from(financeEntries)
      .where(sql`${financeEntries.idempotencyKey} = ${base} or ${financeEntries.idempotencyKey} like ${`${base}:%`}`);
    return all.reduce((acc, e) => acc + toMinor(e.amount), 0n);
  };

  it("key generations: 1 = the §14.5 base key, n > 1 = `:g<n>`; parts may not imitate a reversal or a generation", () => {
    expect(financeKeys.sale("gid://shopify/Sale/9", "net")).toBe("sale:gid://shopify/Sale/9:net");
    expect(financeKeys.sale("gid://shopify/Sale/9", "net", 1)).toBe("sale:gid://shopify/Sale/9:net");
    expect(financeKeys.sale("gid://shopify/Sale/9", "net", 3)).toBe("sale:gid://shopify/Sale/9:net:g3");
    expect(financeKeys.fee("f1", 2)).toBe("fee:f1:g2");
    expect(financeKeys.fxAdjustment("a1", 2)).toBe("fxadj:a1:g2");
    expect(financeKeys.cogs("v1", undefined, 2)).toBe("cogs:v1:g2");
    expect(financeKeys.valuation("v1", "inventory_loss", 2)).toBe("val:v1:inventory_loss:g2");
    expect(financeKeys.valuationCompletion("c1", undefined, 4)).toBe("valc:c1:g4");
    expect(financeKeys.payout("p1", 2)).toBe("pay:p1:g2");
    expect(withGeneration("cb:d1:loss:v1", 2)).toBe("cb:d1:loss:v1:g2");
    expect(financeKeys.reversal(financeKeys.fee("f1", 2))).toBe("fee:f1:g2:rev");
    expect(generationOf("fee:f1", "fee:f1")).toBe(1);
    expect(generationOf("fee:f1:g2", "fee:f1")).toBe(2);
    expect(generationOf("fee:f1:g1", "fee:f1")).toBeNull();
    expect(generationOf("fee:f1:gain", "fee:f1")).toBeNull();
    expect(generationOf("fee:f1:g2:rev", "fee:f1")).toBeNull();
    expect(generationOf("fee:f10", "fee:f1")).toBeNull();
    expect(isBaseFactKey("fee:f1")).toBe(true);
    expect(isBaseFactKey("fee:f1:g2")).toBe(false);
    expect(isBaseFactKey("fee:f1:rev")).toBe(false);
    expect(() => withGeneration("fee:f1", 0)).toThrow(RangeError);
    expect(() => withGeneration("fee:f1:rev", 2)).toThrow(RangeError);
    expect(() => financeKeys.valuation("v1", "rev")).toThrow(RangeError);
    expect(() => financeKeys.valuation("v1", "g2")).toThrow(RangeError);
    expect(() => financeKeys.cogs("v1", "a:b")).toThrow(RangeError);
  });

  it("postEntries reports a key that exists only as a reversed entry (skippedReversed) instead of hiding it in skipped", async () => {
    const entry = makeEntryInput({ idempotencyKey: financeKeys.sale("gid://shopify/OrderSale/77", "net"), amount: "100.00" });
    await env.handle.db.transaction((tx) => postEntries(tx, actor, [entry]));
    const [orig] = await rows(entry.idempotencyKey);
    await env.handle.db.transaction((tx) => reverseEntry(tx, actor, orig!.id));
    const again = await env.handle.db.transaction((tx) => postEntries(tx, actor, [entry, makeEntryInput({ idempotencyKey: "skip:fresh:1" })]));
    expect(again).toEqual({ inserted: 1, skipped: 1, skippedReversed: 1, late: 0 });
    expect(await sum(entry.idempotencyKey)).toBe(0n);
  });

  it("repostEntries: post → reverse → repost → reverse → repost; Σ = the amount in every 'on' state, 0 in every 'off' state", async () => {
    const base = financeKeys.sale("gid://shopify/OrderSale/88", "net");
    const fee = financeKeys.fee("gid://shopify/TransactionFee/88");
    const entries = [
      makeEntryInput({ idempotencyKey: base, amount: "100.00", orderId: null, sourceType: "shopify_sale", sourceId: "s88" }),
      makeEntryInput({ idempotencyKey: fee, category: "payment_fees", amount: "-3.20", sourceType: "shopify_fee", sourceId: "f88" }),
    ];
    const off = async () => {
      const active = [...(await activeEntryRefs(env.handle.db, { keyPrefix: base })), ...(await activeEntryRefs(env.handle.db, { keyPrefix: fee }))];
      return env.handle.db.transaction((tx) => reverseEntries(tx, actor, active.map((a) => a.id)));
    };
    // on (перше проведення — базовий ключ, покоління 1)
    expect(await env.handle.db.transaction((tx) => repostEntries(tx, actor, entries))).toEqual({ inserted: 2, skipped: 0, skippedReversed: 0, late: 0, reposted: 0 });
    // повтор у стані on — ідемпотентно
    expect(await env.handle.db.transaction((tx) => repostEntries(tx, actor, entries))).toEqual({ inserted: 0, skipped: 2, skippedReversed: 0, late: 0, reposted: 0 });
    expect([await sum(base), await sum(fee)]).toEqual([10000n, -320n]);
    for (let round = 2; round <= 3; round++) {
      expect(await off()).toEqual({ reversed: 2 });
      expect([await sum(base), await sum(fee)]).toEqual([0n, 0n]);
      expect(await activeEntryRefs(env.handle.db, { keyPrefix: base })).toEqual([]);
      const on = await env.handle.db.transaction((tx) => repostEntries(tx, actor, entries));
      expect(on).toEqual({ inserted: 2, skipped: 0, skippedReversed: 0, late: 0, reposted: 2 });
      expect([await sum(base), await sum(fee)]).toEqual([10000n, -320n]);
      const active = await activeEntryRefs(env.handle.db, { keyPrefix: base });
      expect(active.map((a) => a.idempotencyKey)).toEqual([withGeneration(base, round)]);
      // повтор у стані on — без нового покоління
      expect((await env.handle.db.transaction((tx) => repostEntries(tx, actor, entries))).inserted).toBe(0);
    }
    expect(await off()).toEqual({ reversed: 2 });
    expect([await sum(base), await sum(fee)]).toEqual([0n, 0n]);
    // generation / reversal keys are not accepted as base keys
    await expect(env.handle.db.transaction((tx) => repostEntries(tx, actor, [makeEntryInput({ idempotencyKey: `${fee}:g2` })]))).rejects.toMatchObject({ code: "finance.error.invalidEntry" });
    await expect(env.handle.db.transaction((tx) => repostEntries(tx, actor, [makeEntryInput({ idempotencyKey: `${fee}:rev` })]))).rejects.toMatchObject({ code: "finance.error.invalidEntry" });
  });

  it("LIKE wildcards in a base key do not match other facts", async () => {
    const a = makeEntryInput({ idempotencyKey: "wild:a_b", amount: "1.00" });
    const other = makeEntryInput({ idempotencyKey: "wild:axb:g2", amount: "1.00" });
    await env.handle.db.transaction((tx) => postEntries(tx, actor, [other]));
    const r = await env.handle.db.transaction((tx) => repostEntries(tx, actor, [a]));
    expect(r).toMatchObject({ inserted: 1, reposted: 0 });
    expect(await rows("wild:a_b")).toHaveLength(1);
  });
});
