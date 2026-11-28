/**
 * Етап 6 (WP0): сервіси ядра — історія змін (zod на тип сутності, маскована причина), реєстр розбіжностей (ідемпотентно,
 * лише власник, ніколи не issues — I19), зовнішні номери накладних (нормалізація §7.4, без власних накладних),
 * знімки (канонічний JSON, версії), перевірка закритого місяця, назва прибутку (§2.7), стани (§2.6), ключі.
 */
import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { financeChangeLog, financeDiscrepancies, financePeriods, financeReportSnapshots, issues, orderExternalWaybills, shipments } from "~/db/schema";
import { ForbiddenError, SYSTEM_ACTOR, type Actor } from "~/domain/permissions";
import { assertChangeValues, CHANGE_LOG_FIELDS, listFinanceChanges, writeFinanceChange } from "~/modules/finance/core/change-log.server";
import { assertMonthOpen, closedMonthsBetween, isMonthClosed } from "~/modules/finance/core/closed-month.server";
import {
  autoResolveDiscrepancy,
  countOpenDiscrepancies,
  discrepancyKey,
  listDiscrepancies,
  openDiscrepancy,
  resolveDiscrepancy,
} from "~/modules/finance/core/discrepancies.server";
import { emptyReportData } from "~/modules/finance/core/fakes";
import { financeKeys, valuationEventKeys } from "~/modules/finance/core/keys";
import { profitLabelFor } from "~/modules/finance/core/profit-label";
import { loadProfitLabel } from "~/modules/finance/core/profit-label.server";
import { canonicalJson, saveReportSnapshot, sha256Hex } from "~/modules/finance/core/snapshots.server";
import { completenessMarker, emptyCompleteness, missingComponents, parseOrderComponents, profitStateOf } from "~/modules/finance/core/states";
import { normalizeInvoiceNumber, normalizeWaybillNumber } from "~/modules/finance/core/waybills";
import { recordExternalWaybills } from "~/modules/finance/core/waybills.server";
import { DEFAULT_STORE_ID } from "~/modules/finance/core/store.server";
import { FINANCE_CHANGE_ENTITY_TYPES } from "~/domain/finance";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../../helpers";

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});
const FORGED: Actor = { ...STAFF, id: "forged", permissions: new Set([...STAFF.permissions, "finance.view", "finance.manage"]) };

describe("finance_change_log (§14.4)", () => {
  it("every entity type has an allow-list; unknown keys and PII-ish keys are refused", () => {
    expect(Object.keys(CHANGE_LOG_FIELDS).sort()).toEqual([...FINANCE_CHANGE_ENTITY_TYPES].sort());
    expect(assertChangeValues("fx_rate", { currency: "EUR", effectiveDate: "2026-11-20", rate: "49.5335", affectedEntries: 14, deltaReporting: "31.20" })).toBeTruthy();
    expect(() => assertChangeValues("partner", { displayName: "Іван" })).toThrow(/displayName/);
    expect(() => assertChangeValues("expense", { amount: 12.5 })).toThrow(/amount/);
    expect(() => assertChangeValues("expense", { description: "x" })).toThrow();
    expect(() => assertChangeValues("carrier_invoice", { invoiceNumber: "a b" })).toThrow();
  });

  it("writes in the caller's transaction with a masked reason; reading is owner-only", async () => {
    await env.handle.db.transaction((tx) =>
      writeFinanceChange(tx, OWNER, {
        entityType: "fx_rate",
        entityId: "rate-1",
        action: "update",
        before: { rateVersion: 1, rate: "49.6000" },
        after: { rateVersion: 2, rate: "49.7000", affectedEntries: 3 },
        reason: "Курс банку, дзвонив +380 67 123 45 67, ivan@example.com",
      }),
    );
    const rows = await listFinanceChanges({ db: env.handle.db, actor: OWNER }, { entityType: "fx_rate", entityId: "rate-1" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "update", actorRole: "owner", before: { rateVersion: 1, rate: "49.6000" } });
    expect(rows[0]!.reason).not.toMatch(/380|ivan@/);
    await expect(listFinanceChanges({ db: env.handle.db, actor: FORGED })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("finance_discrepancies (§7.5)", () => {
  it("open is idempotent; resolve is owner-only with history; auto-resolve; never creates issues (I19)", async () => {
    const db = env.handle.db;
    const orderId = await env.orderId("#1001");
    const [issuesBefore] = await db.select({ c: count() }).from(issues);
    // Реєстр не порожній (демо засіває розбіжності інших пакетів, напр. cost_state_out_of_sync WP2) — рахуємо за типом.
    const allBefore = await countOpenDiscrepancies({ db, actor: OWNER });
    expect(await countOpenDiscrepancies({ db, actor: OWNER }, DEFAULT_STORE_ID, { type: "shipping_loss" })).toEqual({ total: 0, critical: 0 });
    const key = discrepancyKey("shipping_loss", orderId);
    const a = await openDiscrepancy(db, SYSTEM_ACTOR, { type: "shipping_loss", dedupeKey: key, orderId, details: { lossAmount: "60.00", currency: "UAH" } });
    const b = await openDiscrepancy(db, SYSTEM_ACTOR, { type: "shipping_loss", dedupeKey: key, orderId });
    expect(a).toMatchObject({ created: true });
    expect(b).toEqual({ id: a.id, created: false, reopened: false });
    expect(await countOpenDiscrepancies({ db, actor: OWNER }, DEFAULT_STORE_ID, { type: "shipping_loss" })).toEqual({ total: 1, critical: 0 });
    expect(await countOpenDiscrepancies({ db, actor: OWNER })).toEqual({ total: allBefore.total + 1, critical: allBefore.critical });
    await expect(countOpenDiscrepancies({ db, actor: FORGED })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(resolveDiscrepancy({ db, actor: FORGED }, { id: a.id, status: "resolved", resolutionCode: "accepted" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listDiscrepancies({ db, actor: STAFF })).rejects.toBeInstanceOf(ForbiddenError);
    const r = await resolveDiscrepancy({ db, actor: OWNER }, { id: a.id, status: "resolved", resolutionCode: "accepted", note: "ok", expectedVersion: 1 });
    expect(r).toEqual({ version: 2 });
    await expect(resolveDiscrepancy({ db, actor: OWNER }, { id: a.id, status: "ignored", resolutionCode: "other", expectedVersion: 1 })).rejects.toMatchObject({ code: "error.conflict" });
    // Розв'язану власником повторна подія не відкриває (без reopen); з reopen — відкриває.
    expect(await openDiscrepancy(db, SYSTEM_ACTOR, { type: "shipping_loss", dedupeKey: key, orderId })).toMatchObject({ created: false, reopened: false });
    expect(await openDiscrepancy(db, SYSTEM_ACTOR, { type: "shipping_loss", dedupeKey: key, orderId, reopen: true })).toMatchObject({ reopened: true });
    expect(await autoResolveDiscrepancy(db, SYSTEM_ACTOR, key)).toEqual({ resolved: 1 });
    const [row] = await db.select().from(financeDiscrepancies).where(eq(financeDiscrepancies.id, a.id));
    expect(row).toMatchObject({ status: "resolved", resolutionCode: "auto_resolved", severity: "warning" });
    const history = await db.select().from(financeChangeLog).where(eq(financeChangeLog.entityId, a.id));
    expect(history.map((h) => h.action)).toEqual(["create", "resolve", "reopen", "resolve"]);
    const [issuesAfter] = await db.select({ c: count() }).from(issues);
    expect(issuesAfter!.c).toBe(issuesBefore!.c);
    await expect(openDiscrepancy(db, SYSTEM_ACTOR, { type: "fx_rate_conflict", dedupeKey: "x", details: { customerEmail: "a" } as never })).rejects.toThrow();
  });

  it("listDiscrepancies puts critical items first (explicit order, not text order), then newest", async () => {
    const db = env.handle.db;
    await openDiscrepancy(db, SYSTEM_ACTOR, { type: "unmatched_waybill", dedupeKey: discrepancyKey("unmatched_waybill", "sev-w1") });
    await openDiscrepancy(db, SYSTEM_ACTOR, { type: "invoice_total_mismatch", dedupeKey: discrepancyKey("invoice_total_mismatch", "sev-c1") });
    await openDiscrepancy(db, SYSTEM_ACTOR, { type: "unmatched_waybill", dedupeKey: discrepancyKey("unmatched_waybill", "sev-w2") });
    const rows = await listDiscrepancies({ db, actor: OWNER }, { status: "open" });
    const severities = rows.map((r) => r.severity);
    expect(severities[0]).toBe("critical");
    expect(severities.indexOf("warning")).toBeGreaterThan(severities.lastIndexOf("critical"));
    expect(rows.find((r) => r.type === "invoice_total_mismatch")?.severity).toBe("critical");
  });
});

describe("waybill numbers (§7.4) and recordExternalWaybills", () => {
  it("normalisation: NFKC, spaces/NBSP removed, upper case, hyphens kept; Excel-damaged numbers rejected; classes", () => {
    expect(normalizeWaybillNumber(" 2045 0012 345678 ")).toEqual({ ok: true, norm: "20450012345678", numberClass: "ua14" });
    expect(normalizeWaybillNumber("abcd 1234567890")).toEqual({ ok: true, norm: "ABCD1234567890", numberClass: "eu" });
    expect(normalizeWaybillNumber("TEST0000000901")).toMatchObject({ numberClass: "test" });
    expect(normalizeWaybillNumber("UA-12-34")).toEqual({ ok: true, norm: "UA-12-34", numberClass: "unrecognized" });
    expect(normalizeWaybillNumber("２０４５０"))?.toMatchObject({ ok: true, norm: "20450" });
    expect(normalizeWaybillNumber("2.0451E+13")).toEqual({ ok: false, error: "invalid_number" });
    expect(normalizeWaybillNumber("20450012345678.5")).toEqual({ ok: false, error: "invalid_number" });
    expect(normalizeWaybillNumber(20450012345678)).toEqual({ ok: true, norm: "20450012345678", numberClass: "ua14" });
    expect(normalizeWaybillNumber(1.5)).toEqual({ ok: false, error: "invalid_number" });
    expect(normalizeWaybillNumber("   ")).toEqual({ ok: false, error: "empty" });
    expect(normalizeInvoiceNumber(" inv 12 34 ")).toBe("INV1234");
  });

  it("records external numbers idempotently and never the app's own waybill of the order", async () => {
    const db = env.handle.db;
    const [own] = await db.select({ orderId: shipments.orderId, waybill: shipments.waybillNumber }).from(shipments).limit(1);
    expect(own?.waybill).toBeTruthy();
    const input = {
      orderId: own!.orderId,
      source: "shopify_fulfillment" as const,
      numbers: [{ number: own!.waybill!.toLowerCase() }, { number: "2045 0012 345678", carrierCode: "nova_post" }, { number: "20450012345678" }, { number: "2.0451E+13" }],
    };
    const r1 = await db.transaction((tx) => recordExternalWaybills(tx, STAFF, input));
    const r2 = await db.transaction((tx) => recordExternalWaybills(tx, STAFF, input));
    expect(r1).toEqual({ inserted: 1, skipped: 1, invalid: 1, ownShipment: 1 });
    expect(r2).toEqual({ inserted: 0, skipped: 2, invalid: 1, ownShipment: 1 });
    const rows = await db.select().from(orderExternalWaybills).where(eq(orderExternalWaybills.orderId, own!.orderId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ numberNorm: "20450012345678", numberClass: "ua14", carrierCode: "nova_post", source: "shopify_fulfillment", createdBy: STAFF.id, storeId: "default" });
  });
});

describe("report snapshots (§13.1)", () => {
  it("canonical JSON without top-level generatedAt; versions increase; owner/system only; change log written", async () => {
    const data = emptyReportData({ kind: "month", period: { from: "2026-10-01", to: "2026-10-31" }, reportingCurrency: "UAH" });
    const other = { ...data, generatedAt: "2030-01-01T00:00:00.000Z" };
    expect(canonicalJson(data)).toBe(canonicalJson(other));
    expect(canonicalJson({ b: 1, a: { d: 1, c: [2, { f: 1, e: 2 }] } })).toBe('{"a":{"c":[2,{"e":2,"f":1}],"d":1},"b":1}');
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const input = { kind: "month" as const, periodFrom: "2026-10-01", periodTo: "2026-10-31", reportingCurrency: "UAH", source: "manual" as const, isFinal: false, schemaVersion: 1, data, ratesUsed: [] };
    const first = await env.handle.db.transaction((tx) => saveReportSnapshot(tx, OWNER, input));
    const second = await env.handle.db.transaction((tx) => saveReportSnapshot(tx, SYSTEM_ACTOR, { ...input, data: other, source: "scheduled" }));
    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(second.dataSha256).toBe(first.dataSha256);
    await expect(env.handle.db.transaction((tx) => saveReportSnapshot(tx, FORGED, input))).rejects.toBeInstanceOf(ForbiddenError);
    const [row] = await env.handle.db.select().from(financeReportSnapshots).where(eq(financeReportSnapshots.id, first.id));
    expect(row).toMatchObject({ kind: "month", version: 1, generatedBy: OWNER.id, dataSha256: first.dataSha256 });
    expect((row!.data as { generatedAt?: string }).generatedAt).toBe(data.generatedAt);
    const log = await env.handle.db.select().from(financeChangeLog).where(eq(financeChangeLog.entityId, first.id));
    expect(log[0]).toMatchObject({ entityType: "report_snapshot", action: "create" });
  });
});

describe("closed months (§3.4) and the profit label (§2.7)", () => {
  it("assertMonthOpen refuses manual changes dated in a closed month", async () => {
    const db = env.handle.db;
    await db.insert(financePeriods).values([
      { month: "2026-08-01", status: "closed", netProfitEligible: true },
      { month: "2026-09-01", status: "closed", netProfitEligible: false },
      { month: "2026-10-01", status: "open" },
    ]);
    expect(await isMonthClosed(db, "2026-08-31")).toBe(true);
    expect(await isMonthClosed(db, "2026-10-05")).toBe(false);
    expect(await closedMonthsBetween(db, "2026-07-15", "2026-10-15")).toEqual(["2026-08-01", "2026-09-01"]);
    await expect(db.transaction((tx) => assertMonthOpen(tx, "2026-08-15"))).rejects.toMatchObject({ code: "finance.error.monthClosed", params: { month: "2026-08-01" } });
    await expect(db.transaction((tx) => assertMonthOpen(tx, "2026-10-15"))).resolves.toBeUndefined();
    expect(await loadProfitLabel(db, { from: "2026-08-01", to: "2026-08-31" })).toBe("net_profit");
    expect(await loadProfitLabel(db, { from: "2026-08-01", to: "2026-09-30" })).toBe("profit_after_recorded_costs");
    expect(await loadProfitLabel(db, { from: "2026-10-01", to: "2026-10-31" })).toBe("profit_after_recorded_costs");
  });

  it("profitLabelFor: every month of the range closed and eligible", () => {
    const closed = (month: string, eligible = true) => ({ month, status: "closed" as const, netProfitEligible: eligible });
    expect(profitLabelFor({ from: "2026-08-10", to: "2026-08-20" }, [closed("2026-08-01")])).toBe("net_profit");
    expect(profitLabelFor({ from: "2026-08-01", to: "2026-09-30" }, [closed("2026-08-01")])).toBe("profit_after_recorded_costs");
    expect(profitLabelFor({ from: "2026-08-01", to: "2026-09-30" }, [closed("2026-08-01"), closed("2026-09-01", false)])).toBe("profit_after_recorded_costs");
    expect(profitLabelFor({ from: "2026-08-01", to: "2026-09-30" }, [closed("2026-08-01"), closed("2026-09-01")])).toBe("net_profit");
  });
});

describe("states (§2.6)", () => {
  const c = (state: string, extra: Record<string, unknown> = {}) => ({ state, reason: null, basis: null, hasForecast: false, actual: [], required: true, ...extra });
  it("final / preliminary / incomplete by the required components", () => {
    const parse = (v: unknown) => parseOrderComponents(v)!;
    const base = { revenue: c("actual"), cogs: c("actual"), packaging: c("not_applicable", { reason: "packaging_accounted_in_total" }), shipping_cost: c("actual"), fees: c("zero_confirmed", { reason: "fee_rule_no_fees" }) };
    expect(profitStateOf(parse(base))).toBe("final");
    expect(profitStateOf(parse({ ...base, shipping_cost: c("missing", { reason: "no_waybill", hasForecast: true, basis: "owner_table" }) }))).toBe("preliminary");
    expect(profitStateOf(parse({ ...base, revenue: c("partial", { reason: "reconciliation_mismatch" }) }))).toBe("preliminary");
    const incomplete = parse({ ...base, cogs: c("missing", { reason: "no_cost" }), fees: c("missing", { reason: "no_fee_data" }) });
    expect(profitStateOf(incomplete)).toBe("incomplete");
    expect(missingComponents(incomplete)).toEqual([
      { component: "cogs", reason: "no_cost" },
      { component: "fees", reason: "no_fee_data" },
    ]);
    // Необов'язковий складник не впливає; без складників — неповно.
    expect(profitStateOf(parse({ ...base, partner: c("missing", { required: false }) }))).toBe("final");
    expect(profitStateOf(parse({}))).toBe("incomplete");
    expect(parseOrderComponents({ revenue: { state: "bogus" } })).toBeNull();
    expect(parseOrderComponents({ revenue: { ...c("actual"), actual: [{ currency: "EUR", amount: "1" }] } })).toBeNull();
  });

  it("completeness marker", () => {
    const e = emptyCompleteness();
    expect(completenessMarker(e)).toBe("complete");
    expect(completenessMarker({ ...e, preliminary: 1 })).toBe("with_forecast");
    expect(completenessMarker({ ...e, incomplete: 1 })).toBe("incomplete");
    expect(completenessMarker({ ...e, unconverted: [{ currency: "PLN", amount: "1.00", entries: 1 }] })).toBe("incomplete");
  });
});

describe("keys (§14.5)", () => {
  it("one builder per business event; versions are positive", () => {
    expect(financeKeys.sale("gid://shopify/Sale/7", "net")).toBe("sale:gid://shopify/Sale/7:net");
    expect(financeKeys.expense("e1", 2, "2026-11-03")).toBe("exp:e1:v2:2026-11-03");
    expect(financeKeys.allocation("e1", "o1", 1)).toBe("alloc:e1:o1:v1");
    expect(financeKeys.invoiceLine("l1", 3)).toBe("inv:l1:m3");
    expect(financeKeys.chargeback("d1", "loss", 1)).toBe("cb:d1:loss:v1");
    expect(financeKeys.batchAdjustment("mv1", 2)).toBe("adj:mv1:v2");
    expect(financeKeys.reversal("fee:1")).toBe("fee:1:rev");
    expect(valuationEventKeys.movement("m1")).toBe("mv:m1");
    expect(() => financeKeys.standardCogs("l1", 0)).toThrow();
  });
});
