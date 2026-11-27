import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, countryRules, countryRulesHistory, issues, orders } from "~/db/schema";
import { ForbiddenError } from "~/domain/permissions";
import { ConflictError, DomainError } from "~/lib/errors";
import {
  addCountryRule,
  getCountryRule,
  listHistory,
  resetCountryRuleToDefault,
  testPostalCode,
  updateCountryRule,
} from "~/modules/country-rules/country-rules.server";
import { isChangedFromDefault, needsVerification, pickRuleValue } from "~/modules/country-rules/schema";
import { DEFAULT_COUNTRY_RULES } from "~/modules/validation";
import { validateOrderById } from "~/modules/orders/workflow.server";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";

let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv();
});

afterAll(async () => {
  await env.close();
});

async function rule(code: string) {
  const row = await getCountryRule(env.handle.db, code);
  if (!row) throw new Error(`rule ${code} not found`);
  return row;
}

async function valueOf(code: string) {
  return pickRuleValue(await rule(code));
}

async function openIssueCodes(orderNumber: string): Promise<string[]> {
  const id = await env.orderId(orderNumber);
  const rows = await env.handle.db
    .select({ code: issues.code })
    .from(issues)
    .where(and(eq(issues.orderId, id), eq(issues.status, "open")));
  return rows.map((r) => r.code).sort();
}

describe("updateCountryRule", () => {
  it("staff cannot change rules (settings.manage is owner-only)", async () => {
    const before = await rule("DE");
    await expect(updateCountryRule(env.ctx(STAFF), "DE", await valueOf("DE"), before.version)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(resetCountryRuleToDefault(env.ctx(STAFF), "DE", before.version)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(addCountryRule(env.ctx(STAFF), { countryCode: "IS", ...(await valueOf("DE")) })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await rule("DE")).version).toBe(before.version);
  });

  it("rejects a pattern that does not compile and an example that does not match", async () => {
    const de = await rule("DE");
    const bad = await updateCountryRule(env.ctx(OWNER), "DE", { ...(await valueOf("DE")), postalCodePattern: "^(\\d{5}$" }, de.version);
    expect(bad).toEqual({ ok: false, fieldErrors: { postalCodePattern: "countryRules.error.patternInvalid" } });

    const mismatch = await updateCountryRule(
      env.ctx(OWNER),
      "DE",
      { ...(await valueOf("DE")), postalCodePattern: "^\\d{5}$", postalCodeExample: "1011 AB" },
      de.version,
    );
    expect(mismatch).toEqual({ ok: false, fieldErrors: { postalCodeExample: "countryRules.error.exampleMismatch" } });

    const long = await updateCountryRule(env.ctx(OWNER), "DE", { ...(await valueOf("DE")), notes: "x".repeat(501) }, de.version);
    expect(long).toMatchObject({ ok: false, fieldErrors: { notes: "countryRules.error.tooLong" } });

    const badDuty = await updateCountryRule(env.ctx(OWNER), "DE", { ...(await valueOf("DE")), dutyPayer: "nobody" }, de.version);
    expect(badDuty).toMatchObject({ ok: false, fieldErrors: { dutyPayer: "countryRules.error.invalid" } });

    expect((await rule("DE")).version).toBe(de.version);
    expect(await listHistory(env.handle.db, "DE")).toEqual([]);
  });

  it("saves a valid change with version bump, baseline + new history rows and an audit entry without PII", async () => {
    const de = await rule("DE");
    const res = await updateCountryRule(
      env.ctx(OWNER),
      "de",
      { ...(await valueOf("DE")), dutyPayer: "customer", notes: "  Checked by owner  ", postalCodeExample: "" },
      de.version,
    );
    expect(res).toMatchObject({ ok: true, countryCode: "DE", version: de.version + 1, unchanged: false });
    expect(res.ok && res.changed.sort()).toEqual(["dutyPayer", "notes", "postalCodeExample"]);

    const after = await rule("DE");
    expect(after).toMatchObject({ dutyPayer: "customer", notes: "Checked by owner", postalCodeExample: null, version: de.version + 1 });
    expect(isChangedFromDefault(after)).toBe(true);
    expect(needsVerification(after.notes)).toBe(false);

    const history = await listHistory(env.handle.db, "DE");
    expect(history.map((h) => [h.version, h.source, h.changedBy])).toEqual([
      [de.version + 1, "update", OWNER.id],
      [de.version, "initial", "system"],
    ]);
    expect(history[0]?.value).toMatchObject({ dutyPayer: "customer", nameEn: "Germany" });
    expect(history[1]?.value).toMatchObject({ dutyPayer: "unknown", postalCodeExample: "10115" });

    const [audit] = await env.handle.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "country_rule.update"), eq(auditLog.entityId, "DE")));
    expect(audit?.details).toEqual({ version: de.version + 1, fields: expect.arrayContaining(["dutyPayer", "notes"]) });
  });

  it("rejects a stale version (optimistic locking) and leaves the rule unchanged", async () => {
    const de = await rule("DE");
    await expect(
      updateCountryRule(env.ctx(OWNER), "DE", { ...(await valueOf("DE")), dutyPayer: "company" }, de.version - 1),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await rule("DE")).toMatchObject({ version: de.version, dutyPayer: "customer" });
  });

  it("an unchanged submit does not create a version", async () => {
    const de = await rule("DE");
    const res = await updateCountryRule(env.ctx(OWNER), "DE", await valueOf("DE"), de.version);
    expect(res).toMatchObject({ ok: true, unchanged: true, version: de.version, revalidated: 0 });
    expect((await listHistory(env.handle.db, "DE")).length).toBe(2);
  });

  it("unknown country → not found", async () => {
    await expect(updateCountryRule(env.ctx(OWNER), "QQ", await valueOf("DE"), 1)).rejects.toMatchObject({ code: "error.notFound" });
    await expect(updateCountryRule(env.ctx(OWNER), "Q1", await valueOf("DE"), 1)).rejects.toBeInstanceOf(DomainError);
  });

  it("re-validates open orders of the country: enabling shipping to RU clears COUNTRY_SHIPPING_DISABLED on #1010", async () => {
    await validateOrderById(env.ctx(OWNER), await env.orderId("#1010"));
    expect(await openIssueCodes("#1010")).toContain("COUNTRY_SHIPPING_DISABLED");
    const ru = await rule("RU");
    const res = await updateCountryRule(env.ctx(OWNER), "RU", { ...pickRuleValue(ru), shippingEnabled: true }, ru.version);
    expect(res).toMatchObject({ ok: true, revalidated: 1 });
    expect(await openIssueCodes("#1010")).not.toContain("COUNTRY_SHIPPING_DISABLED");

    // Назад — проблема повертається.
    const back = await updateCountryRule(env.ctx(OWNER), "RU", { ...pickRuleValue(ru), shippingEnabled: false }, ru.version + 1);
    expect(back).toMatchObject({ ok: true, revalidated: 1 });
    expect(await openIssueCodes("#1010")).toContain("COUNTRY_SHIPPING_DISABLED");
  });

  it("making the FR postal code optional resolves POSTAL_CODE_MISSING on #1004; closed orders are not touched", async () => {
    await validateOrderById(env.ctx(OWNER), await env.orderId("#1004"));
    expect(await openIssueCodes("#1004")).toContain("POSTAL_CODE_MISSING");
    const fr = await rule("FR");
    const res = await updateCountryRule(env.ctx(OWNER), "FR", { ...pickRuleValue(fr), postalCodeRequired: false }, fr.version);
    // Лише відкриті замовлення FR (історичні з накладною/доставлені/скасовані не перевіряються).
    const open = await env.handle.db.select({ status: orders.status }).from(orders).where(eq(orders.shipCountryCode, "FR"));
    const validatable = open.filter((o) => ["paid", "awaiting_review", "needs_correction"].includes(o.status)).length;
    expect(res).toMatchObject({ ok: true, revalidated: validatable });
    expect(await openIssueCodes("#1004")).not.toContain("POSTAL_CODE_MISSING");
  });
});

describe("resetCountryRuleToDefault", () => {
  it("restores DEFAULT_COUNTRY_RULES values with a reset history row", async () => {
    const de = await rule("DE");
    const res = await resetCountryRuleToDefault(env.ctx(OWNER), "DE", de.version);
    expect(res).toMatchObject({ ok: true, version: de.version + 1, unchanged: false });
    const def = DEFAULT_COUNTRY_RULES.find((r) => r.countryCode === "DE")!;
    const after = await rule("DE");
    expect(pickRuleValue(after)).toEqual(pickRuleValue(def));
    expect(isChangedFromDefault(after)).toBe(false);
    expect(needsVerification(after.notes)).toBe(true);
    const [latest] = await listHistory(env.handle.db, "DE");
    expect(latest).toMatchObject({ version: de.version + 1, source: "reset", changedBy: OWNER.id });

    // Повторне скидання — без нової версії.
    expect(await resetCountryRuleToDefault(env.ctx(OWNER), "DE", de.version + 1)).toMatchObject({ ok: true, unchanged: true });
  });

  it("a stale version conflicts; a country without a default rule cannot be reset", async () => {
    await expect(resetCountryRuleToDefault(env.ctx(OWNER), "DE", 1)).rejects.toBeInstanceOf(ConflictError);
    await addCountryRule(env.ctx(OWNER), { countryCode: "MC", ...(await valueOf("DK")), notes: "" });
    await expect(resetCountryRuleToDefault(env.ctx(OWNER), "MC", 1)).rejects.toMatchObject({ code: "countryRules.error.noDefault" });
  });
});

describe("addCountryRule", () => {
  it("adds a new ISO code with names from Intl, version 1 and history", async () => {
    const res = await addCountryRule(env.ctx(OWNER), {
      countryCode: " is ",
      nameUk: "",
      nameEn: "",
      shippingEnabled: true,
      postalCodeRequired: true,
      postalCodePattern: "^\\d{4}$",
      postalCodeExample: "0150",
      provinceRequired: false,
      phoneRequired: true,
      dutyPayer: "customer",
      notes: "",
    });
    expect(res).toMatchObject({ ok: true, countryCode: "IS", version: 1 });
    const added = await rule("IS");
    expect(added).toMatchObject({ nameEn: "Iceland", postalCodePattern: "^\\d{4}$", version: 1, notes: null });
    expect(added.nameUk.length).toBeGreaterThan(0);
    expect(isChangedFromDefault(added)).toBe(true);
    const history = await listHistory(env.handle.db, "IS");
    expect(history.map((h) => [h.version, h.source])).toEqual([[1, "add"]]);
    const audits = await env.handle.db.select().from(auditLog).where(eq(auditLog.action, "country_rule.add"));
    expect(audits.map((a) => a.entityId)).toContain("IS");
  });

  it("validates the code (2 letters A–Z, not yet present) and the rule fields", async () => {
    const base = await valueOf("DK");
    expect(await addCountryRule(env.ctx(OWNER), { ...base, countryCode: "DE" })).toEqual({
      ok: false,
      fieldErrors: { countryCode: "countryRules.error.codeExists" },
    });
    for (const code of ["D", "DEU", "1A", "Ä1", ""]) {
      expect(await addCountryRule(env.ctx(OWNER), { ...base, countryCode: code })).toMatchObject({
        ok: false,
        fieldErrors: { countryCode: "countryRules.error.codeInvalid" },
      });
    }
    expect(await addCountryRule(env.ctx(OWNER), { ...base, countryCode: "MT", postalCodePattern: "[" })).toMatchObject({
      ok: false,
      fieldErrors: { postalCodePattern: "countryRules.error.patternInvalid" },
    });
    expect(await getCountryRule(env.handle.db, "MT")).toBeNull();
  });

  it("an unknown region without names requires them", async () => {
    const res = await addCountryRule(env.ctx(OWNER), { ...(await valueOf("DK")), countryCode: "QZ", nameUk: "", nameEn: "" });
    expect(res).toMatchObject({ ok: false, fieldErrors: { nameEn: "countryRules.error.nameRequired", nameUk: "countryRules.error.nameRequired" } });
    const ok = await addCountryRule(env.ctx(OWNER), { ...(await valueOf("DK")), countryCode: "QZ", nameUk: "Тест", nameEn: "Test" });
    expect(ok).toMatchObject({ ok: true, countryCode: "QZ" });
  });

  it("history table has a unique (country, version) pair", async () => {
    const rows = await env.handle.db.select().from(countryRulesHistory).where(eq(countryRulesHistory.countryCode, "IS"));
    await expect(
      env.handle.db.insert(countryRulesHistory).values({ countryCode: "IS", version: rows[0]!.version, value: {}, changedBy: "x" }),
    ).rejects.toThrow();
    const [row] = await env.handle.db.select().from(countryRules).where(eq(countryRules.countryCode, "IS"));
    expect(row?.version).toBe(1);
  });
});

describe("testPostalCode", () => {
  const nl = { countryCode: "NL", postalCodeRequired: true };
  it("normalises like order validation and reports match / no match", () => {
    expect(testPostalCode(nl, "^[1-9]\\d{3} [A-Z]{2}$", "1012ab")).toEqual({ patternValid: true, normalized: "1012 AB", match: true });
    expect(testPostalCode(nl, "^[1-9]\\d{3} [A-Z]{2}$", "0123 AB")).toMatchObject({ patternValid: true, match: false });
  });
  it("invalid pattern and missing pattern", () => {
    expect(testPostalCode(nl, "(", "1012 AB")).toMatchObject({ patternValid: false, match: null });
    expect(testPostalCode(nl, null, " abc ")).toEqual({ patternValid: true, normalized: "ABC", match: null });
    expect(testPostalCode(nl, "   ", "x")).toMatchObject({ match: null });
  });
});
