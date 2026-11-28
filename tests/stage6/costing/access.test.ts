/**
 * Етап 6, WP2: КОЖЕН сервіс читання / керування собівартістю перевіряє requireFinance сам (docs/stage6-design.md §14.1,
 * §14.2 «працівник → 403»), не лише loader сторінки: працівник і ПІДРОБЛЕНИЙ актор (дозволи фінансів прямо в наборі, але
 * роль staff — обхід resolvePermissions) отримують 403 і нічого не записують. Таблиця охоплює всі експортовані функції
 * модулів сервісів; нова експортована функція без рядка тут (або в переліку «без грошей») — тест падає.
 */
import { randomUUID } from "node:crypto";
import { count } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { financeChangeLog, financeEntries, financeExpenses, stockItemCosts } from "~/db/schema";
import type { Actor } from "~/domain/permissions";
import type { AdminGraphql } from "~/integrations/shopify/admin-client.server";
import * as batchWriteOff from "~/modules/costing/batch-writeoff.server";
import * as manualCosts from "~/modules/costing/manual-costs.server";
import * as queries from "~/modules/costing/queries.server";
import * as shopifyCosts from "~/modules/costing/shopify-costs.server";
import { OWNER, STAFF } from "../../helpers";
import { move, openCostEnv, product, type CostEnv } from "./db-helpers";

/** Підроблений актор: finance.view і finance.manage прямо в наборі дозволів, роль staff. */
const FORGED: Actor = { ...STAFF, id: "forged-costs", permissions: new Set([...STAFF.permissions, "finance.view", "finance.manage"]) };

let env: CostEnv;
let stockItemId: string;
beforeAll(async () => {
  env = await openCostEnv();
  const p = await product(env.db);
  stockItemId = p.stockItemId;
  await move(env.db, { stockItemId, type: "receipt_manual", onHandDelta: 2, reason: "found" });
});
afterAll(async () => {
  await env.close();
});

const failingAdmin: AdminGraphql = (() => {
  throw new Error("Admin API must not be called without finance.manage");
}) as unknown as AdminGraphql;

type Call = (actor: Actor) => Promise<unknown>;

/**
 * База, що падає за БУДЬ-ЯКОГО звернення: перевірка доступу має бути першою дією сервісу (не покладатися на перевірку
 * глибше — напр. у listFinanceChanges — після читання даних).
 */
const TRAP_DB = new Proxy(
  {},
  {
    get() {
      throw new Error("database touched before the access check");
    },
  },
) as CostEnv["db"];

/** Усі сервіси з перевіркою доступу: назва експорту → виклик (trap — база-пастка замість справжньої). */
function services(trap = false): Record<string, Call> {
  const ctx = (actor: Actor, mode?: "production") => ({ ...env.ctx(actor, mode ? { mode } : {}), ...(trap ? { db: TRAP_DB } : {}) });
  const today = new Date().toISOString().slice(0, 10);
  const saveInput = () => ({
    operationId: randomUUID(),
    target: { kind: "stockItems" as const, stockItemIds: [stockItemId] },
    unitCost: "10.00",
    currency: "UAH",
    effectiveFrom: today,
    applyToStock: true,
    applyToSold: true,
  });
  return {
    "queries.inventoryValueAt": (a) => queries.inventoryValueAt(ctx(a), { date: today }),
    "queries.modelColorCosts": (a) => queries.modelColorCosts(ctx(a), { from: today, to: today, today }),
    "queries.batchCosts": (a) => queries.batchCosts(ctx(a)),
    "queries.defectsSummary": (a) => queries.defectsSummary(ctx(a), { from: today, to: today }),
    "queries.costsAttention": (a) => queries.costsAttention(ctx(a)),
    "queries.costHistory": (a) => queries.costHistory(ctx(a), { stockItemId }),
    "batchWriteOff.writeOffBatchCosts": (a) =>
      batchWriteOff.writeOffBatchCosts(ctx(a), { operationId: randomUUID(), batchId: randomUUID(), amount: "1.00", currency: "UAH", date: today, reason: "x" }),
    "batchWriteOff.batchWriteOffs": (a) => batchWriteOff.batchWriteOffs(ctx(a), [randomUUID()]),
    "shopifyCosts.importShopifyCostSuggestions": (a) => shopifyCosts.importShopifyCostSuggestions(ctx(a, "production"), failingAdmin),
    "shopifyCosts.listCostSuggestions": (a) => shopifyCosts.listCostSuggestions(ctx(a)),
    "shopifyCosts.confirmCostSuggestions": (a) =>
      shopifyCosts.confirmCostSuggestions(ctx(a), { operationId: randomUUID(), suggestionIds: [randomUUID()], effectiveFrom: today, applyToStock: true, applyToSold: true }),
    "manualCosts.saveManualCost": (a) => manualCosts.saveManualCost(ctx(a), saveInput()),
    "manualCosts.saveManualCostTx": (a) =>
      trap ? manualCosts.saveManualCostTx(TRAP_DB as never, ctx(a), saveInput()) : env.db.transaction((tx) => manualCosts.saveManualCostTx(tx, ctx(a), saveInput())),
    "manualCosts.manualCostPreview": (a) => manualCosts.manualCostPreview(ctx(a), { target: { kind: "stockItems", stockItemIds: [stockItemId] }, effectiveFrom: today }),
  };
}

/**
 * Експорти без перевірки доступу, що НЕ повертають грошей (чисті функції, кількості, ідентифікатори, дати, константи).
 * Внутрішні читання вартості — лише в costing/pool-read.server.ts (не тут).
 */
const NO_MONEY_EXPORTS = new Set([
  "queries.centsAverage",
  "batchWriteOff.WRITE_OFF_REASON_MAX",
  "batchWriteOff.batchWriteOffEligible",
  "batchWriteOff.writeOffEligibleBatchIds",
  "shopifyCosts.parseVariantCosts",
  "shopifyCosts.suggestionOperationId",
  "manualCosts.MANUAL_COST_NOTE_MAX",
  "manualCosts.MAX_MANUAL_COST_ITEMS",
  "manualCosts.resolveCostTarget",
  "manualCosts.nextEffectiveFrom",
  "manualCosts.validateEffectiveFrom",
  "manualCosts.unvaluedCounts",
  "manualCosts.soldWithoutCostSplit",
]);

async function writes() {
  const n = async (t: typeof financeEntries | typeof stockItemCosts | typeof financeExpenses | typeof financeChangeLog) => Number((await env.db.select({ c: count() }).from(t))[0]!.c);
  return [await n(financeEntries), await n(stockItemCosts), await n(financeExpenses), await n(financeChangeLog)];
}

describe("every costing service enforces requireFinance itself (§14.1, §14.2)", () => {
  it("the table covers every exported function of the service modules", () => {
    const exported = [
      ...Object.keys(queries).map((k) => `queries.${k}`),
      ...Object.keys(batchWriteOff).map((k) => `batchWriteOff.${k}`),
      ...Object.keys(shopifyCosts).map((k) => `shopifyCosts.${k}`),
      ...Object.keys(manualCosts).map((k) => `manualCosts.${k}`),
    ];
    const covered = new Set([...Object.keys(services()), ...NO_MONEY_EXPORTS]);
    expect(exported.filter((e) => !covered.has(e))).toEqual([]);
    // Внутрішні читання вартості пулу більше не експортуються модулем, який імпортують сторінки.
    expect(Object.keys(queries)).not.toContain("loadPoolValues");
    expect(Object.keys(queries)).not.toContain("poolStatesAt");
  });

  for (const [who, actor] of [
    ["staff", STAFF],
    ["forged staff with finance.view + finance.manage in the set", FORGED],
  ] as const) {
    it(`${who} → 403 on every service, nothing written`, async () => {
      const before = await writes();
      // Справжня база: 403, нічого не записано.
      for (const [name, call] of Object.entries(services())) {
        await expect(call(actor), name).rejects.toMatchObject({ status: 403 });
      }
      expect(await writes()).toEqual(before);
      // База-пастка: 403 ДО будь-якого читання (перевірка — перша дія кожного сервісу).
      for (const [name, call] of Object.entries(services(true))) {
        await expect(call(actor), `${name} (access check first)`).rejects.toMatchObject({ status: 403 });
      }
    });
  }

  it("the owner passes the access check of every read service", async () => {
    const reads = Object.entries(services()).filter(([n]) => n.startsWith("queries.") || n.endsWith("batchWriteOffs") || n.endsWith("listCostSuggestions") || n.endsWith("manualCostPreview"));
    for (const [name, call] of reads) await expect(call(OWNER), name).resolves.toBeDefined();
  });
});
