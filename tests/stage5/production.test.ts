import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { inventoryMovements, productionBatchLines, productionBatches, productionReceipts, productVariants, products } from "~/db/schema";
import { ForbiddenError, makeActor } from "~/domain/permissions";
import { ConflictError, DomainError, NotFoundError } from "~/lib/errors";
import { ensureStockItemForVariant } from "~/modules/inventory/ledger.server";
import {
  cancelBatch,
  closeBatch,
  createBatch,
  receiveProduction,
  startProduction,
  updateBatch,
  updateBatchCosts,
  type BatchInput,
} from "~/modules/production/batches.server";
import {
  REMAINDER_KIND,
  allocateReceipt,
  batchCostSummary,
  billedQuantity,
  defectRatePercent,
  divideMinorHalfUp,
  formatBatchNumber,
  inProductionQuantity,
  isOverdue,
  isValidDateString,
  kyivDate,
  landedUnitCost,
  parseBatchNumber,
  parseMoneyInput,
  parseQuantityInput,
  quantityTotals,
  statusAfterReceipt,
} from "~/modules/production/calc";
import { ProductionValidationError } from "~/modules/production/errors";
import { countProductionDue, getBatchDetail, listBatchFilterOptions, listBatches, loadVariantGrid, openProductionByVariant } from "~/modules/production/queries.server";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";
import { balance, insertProduct, movementCount } from "./helpers";

/**
 * Виробництво (етап 5): життєвий цикл партії, часткові надходження, ідемпотентність, понаднадходження, закриття й
 * скасування (вплив на журнал), собівартість, конкурентні надходження. PGlite або TEST_DATABASE_URL (справжній PostgreSQL).
 */
let env: TestEnv;
let year: number;
let product: { productId: string; variantIds: string[] };
let other: { productId: string; variantIds: string[] };
const uuid = () => globalThis.crypto.randomUUID();
const MANAGER_NO_FINANCE = makeActor({ id: "test-manager", displayName: "Manager", role: "staff", overrides: { grant: ["production.manage"] } });
const VIEWER = makeActor({ id: "test-viewer", displayName: "Viewer", role: "staff", overrides: { revoke: ["warehouse.receive"] } });

beforeAll(async () => {
  env = await createTestEnv();
  year = Number(kyivDate(new Date()).slice(0, 4));
  // Вигаданий товар: моделі X/S × кольори Чорний/Білий.
  product = await insertProduct(env.handle.db, "Тестове крило", [
    { sku: "PT-X-BLK", model: "X", color: "Чорний" },
    { sku: "PT-X-WHT", model: "X", color: "Білий" },
    { sku: "PT-S-BLK", model: "S", color: "Чорний" },
  ]);
  other = await insertProduct(env.handle.db, "Тестова сумка", [{ sku: "PT-BAG", color: "Сірий" }]);
});

afterAll(async () => {
  await env.close();
});

const db = () => env.handle.db;
const item = (variantId: string) => ensureStockItemForVariant(db(), variantId);
const bal = async (variantId: string) => balance(db(), await item(variantId));

async function batchRow(id: string) {
  const [row] = await db().select().from(productionBatches).where(eq(productionBatches.id, id));
  return row!;
}

async function lines(batchId: string) {
  const rows = await db().select().from(productionBatchLines).where(eq(productionBatchLines.batchId, batchId));
  return new Map(rows.map((r) => [r.variantId, r]));
}

function input(over: Partial<BatchInput> = {}): BatchInput {
  return {
    title: "Тестова партія",
    plannedReadyDate: "2030-01-15",
    manufacturer: "Вигаданий виробник",
    notes: null,
    lines: [
      { variantId: product.variantIds[0]!, quantity: 10 },
      { variantId: product.variantIds[1]!, quantity: 5 },
    ],
    ...over,
  };
}

async function started(over: Partial<BatchInput> = {}) {
  const { batchId } = await createBatch(env.ctx(OWNER), input(over));
  await startProduction(env.ctx(OWNER), batchId, (await batchRow(batchId)).version);
  return { batchId, lines: await lines(batchId) };
}

async function expectDomain(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof DomainError && e.code === code);
}

describe("production calc (pure)", () => {
  it("batch numbers, dates and overdue", () => {
    expect(formatBatchNumber(2026, 1)).toBe("PB-2026-0001");
    expect(formatBatchNumber(2026, 12345)).toBe("PB-2026-12345");
    expect(parseBatchNumber("PB-2026-0042")).toEqual({ year: 2026, seq: 42 });
    expect(parseBatchNumber("PB-26-1")).toBeNull();
    // Кордон доби: 22:30 UTC 26.11 — це вже 27.11 у Києві (UTC+2).
    expect(kyivDate(new Date("2026-11-26T22:30:00Z"))).toBe("2026-11-27");
    expect(isValidDateString("2026-02-29")).toBe(false);
    expect(isValidDateString("2028-02-29")).toBe(true);
    expect(isOverdue("in_production", "2026-11-26", "2026-11-27")).toBe(true);
    expect(isOverdue("partially_received", "2026-11-27", "2026-11-27")).toBe(false);
    expect(isOverdue("received", "2026-01-01", "2026-11-27")).toBe(false);
    expect(isOverdue("planned", null, "2026-11-27")).toBe(false);
  });

  it("form parsing, quantities, defects and receipt allocation", () => {
    expect(parseMoneyInput("1 250,5")).toBe("1250.50");
    expect(parseMoneyInput("")).toBeNull();
    for (const bad of ["-1", "1.234", "abc", "1e3", "1234567890123"]) expect(parseMoneyInput(bad)).toBe("invalid");
    expect(parseQuantityInput("")).toBe(0);
    expect(parseQuantityInput("12")).toBe(12);
    for (const bad of ["-1", "1.5", "100001", "x"]) expect(parseQuantityInput(bad)).toBe("invalid");
    expect(defectRatePercent(1, 3)).toBe(33.3);
    expect(defectRatePercent(0, 0)).toBeNull();
    expect(statusAfterReceipt([{ ordered: 10, received: 9, defective: 1 }])).toBe("received");
    expect(statusAfterReceipt([{ ordered: 10, received: 5, defective: 0 }, { ordered: 1, received: 1, defective: 0 }])).toBe("partially_received");
    expect(allocateReceipt(5, 6, 1)).toEqual({ fromInProduction: 5, over: 2 });
    expect(allocateReceipt(0, 2, 0)).toEqual({ fromInProduction: 0, over: 2 });
    expect(quantityTotals([{ ordered: 10, received: 12, defective: 1 }, { ordered: 5, received: 0, defective: 0 }])).toMatchObject({
      ordered: 15,
      produced: 13,
      remaining: 5,
      overReceived: 3,
      defectRate: 7.7,
    });
  });

  it("cost: total, cost per good unit (defects carried by good units), half-up rounding", () => {
    expect(divideMinorHalfUp(5n, 2n)).toBe(3n);
    expect(divideMinorHalfUp(4n, 3n)).toBe(1n);
    const received = batchCostSummary(
      [
        { id: "a", ordered: 50, received: 45, defective: 5, unitCost: "210.00", costCurrency: "UAH" },
        { id: "b", ordered: 30, received: 30, defective: 0, unitCost: "320.00", costCurrency: "UAH" },
      ],
      "1500.00",
      "UAH",
      "received",
    );
    // 50 × 210 + 30 × 320 + 1500 = 21 600; усе виготовлено → вартість виготовленого = загальна; якісних 75 → 288.00.
    expect(received).toMatchObject({ complete: true, linesTotal: "20100.00", total: "21600.00", producedTotal: "21600.00", goodReceived: 75, costPerGoodUnit: "288.00" });
    // Частка додаткових витрат пропорційна кількості: 1500 × 50/80 = 937.50; (10500 + 937.50) / 45 якісних = 254.17.
    expect(received.lines[0]).toMatchObject({ total: "10500.00", extraShare: "937.50", landedUnitCost: "228.75", costPerGoodUnit: "254.17" });
    expect(landedUnitCost("210.00", "1500.00", 80)).toBe("228.75");
    const incomplete = batchCostSummary([{ id: "a", ordered: 2, received: 2, defective: 0, unitCost: null, costCurrency: null }], "10.00", "EUR", "received");
    expect(incomplete).toMatchObject({ complete: false, linesWithoutCost: 1, total: "10.00", costPerGoodUnit: null });
  });

  it("cost of a partially received batch: planned total, but cost per good unit only over what was produced", () => {
    const lines = [
      { id: "a", ordered: 50, received: 45, defective: 5, unitCost: "210.00", costCurrency: "UAH" },
      { id: "b", ordered: 30, received: 20, defective: 0, unitCost: "320.00", costCurrency: "UAH" },
    ];
    const s = batchCostSummary(lines, "1500.00", "UAH", "partially_received");
    // Планова загальна — за замовленим (21 600). Виготовлено 70 з 80: 50 × 210 + 20 × 320 + 1500 × 70/80 = 18 212.50;
    // ÷ 65 якісних = 280.19 (а не 21 600 ÷ 65 = 332.31 — ще не виготовлені 10 од. завищували б показник).
    expect(s).toMatchObject({ total: "21600.00", producedTotal: "18212.50", goodReceived: 65, costPerGoodUnit: "280.19" });
    expect(s.lines[1]).toMatchObject({ billedQty: 30, total: "9600.00", costPerGoodUnit: "338.75" });
  });

  it("cost of a batch closed short bills only produced units (regression)", () => {
    // Рецензія: закрита партія з 4 якісними з 10 рахувала 1000.00 і 250.00 за якісну од.
    const one = [{ id: "a", ordered: 10, received: 4, defective: 0, unitCost: "100.00", costCurrency: "UAH" }];
    expect(batchCostSummary(one, null, "UAH", "closed")).toMatchObject({ total: "400.00", producedTotal: "400.00", costPerGoodUnit: "100.00", lines: [{ billedQty: 4 }] });
    // Та сама партія ще відкрита: планова загальна 1000.00, але за якісну од. — лише за виготовленим.
    expect(batchCostSummary(one, null, "UAH", "partially_received")).toMatchObject({ total: "1000.00", producedTotal: "400.00", costPerGoodUnit: "100.00", lines: [{ billedQty: 10 }] });
    const closed = batchCostSummary(
      [
        { id: "a", ordered: 50, received: 45, defective: 5, unitCost: "210.00", costCurrency: "UAH" },
        { id: "b", ordered: 30, received: 20, defective: 0, unitCost: "320.00", costCurrency: "UAH" },
      ],
      "1500.00",
      "UAH",
      "closed",
    );
    // 50 × 210 + 20 × 320 + 1500 (додаткові витрати — повністю на виготовлене) = 18 400; ÷ 65 = 283.08.
    expect(closed).toMatchObject({ linesTotal: "16900.00", total: "18400.00", producedTotal: "18400.00", costPerGoodUnit: "283.08" });
    expect(closed.lines[1]).toMatchObject({ billedQty: 20, total: "6400.00" });
    // Скасована до надходжень: позиції не оплачуються, лишаються тільки додаткові витрати.
    expect(batchCostSummary(one.map((l) => ({ ...l, received: 0 })), "50.00", "UAH", "cancelled")).toMatchObject({ linesTotal: "0.00", total: "50.00", costPerGoodUnit: null });
    expect(billedQuantity({ ordered: 10, received: 12, defective: 1 }, "closed")).toBe(13);
    expect(billedQuantity({ ordered: 10, received: 2, defective: 1 }, "in_production")).toBe(10);
  });

  it("remainder meaning by status: only a started batch has units in production", () => {
    expect(REMAINDER_KIND).toEqual({
      planned: "toProduce",
      in_production: "inProduction",
      partially_received: "inProduction",
      received: "inProduction",
      closed: "notProduced",
      cancelled: "notProduced",
    });
    expect(inProductionQuantity("planned", 15)).toBe(0);
    expect(inProductionQuantity("partially_received", 6)).toBe(6);
    expect(inProductionQuantity("closed", 6)).toBe(0);
    expect(inProductionQuantity("cancelled", 15)).toBe(0);
  });
});

describe("create and update", () => {
  it("creates a planned batch with the next PB-YYYY-NNNN number (demo already has 0001) and no stock movement", async () => {
    const before = await movementCount(db());
    const { batchId, number } = await createBatch(env.ctx(OWNER), input());
    expect(number).toMatch(new RegExp(`^PB-${year}-\\d{4}$`));
    expect(parseBatchNumber(number)!.seq).toBeGreaterThanOrEqual(2);
    const b = await batchRow(batchId);
    expect(b).toMatchObject({ status: "planned", title: "Тестова партія", plannedReadyDate: "2030-01-15", createdBy: OWNER.id, version: 1 });
    expect([...(await lines(batchId)).values()].map((l) => l.quantityOrdered).sort((a, b) => a - b)).toEqual([5, 10]);
    expect(await movementCount(db())).toBe(before);
  });

  it("parallel creation gets distinct numbers", async () => {
    const results = await Promise.all([1, 2, 3].map(() => createBatch(env.ctx(OWNER), input())));
    expect(new Set(results.map((r) => r.number)).size).toBe(3);
  });

  it("many parallel creations (more than the pool and any retry budget) all succeed with consecutive numbers", async () => {
    // Регресія: max+1 із повторами вичерпував спроби на справжньому PostgreSQL при ~10 одночасних створеннях.
    const settled = await Promise.allSettled(Array.from({ length: 14 }, () => createBatch(env.ctx(OWNER), input())));
    const failures = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected").map((s) => String(s.reason));
    expect(failures).toEqual([]);
    const seqs = settled
      .map((s) => parseBatchNumber((s as PromiseFulfilledResult<{ number: string }>).value.number)!.seq)
      .sort((a, b) => a - b);
    expect(new Set(seqs).size).toBe(14);
    expect(seqs[13]! - seqs[0]!).toBe(13);
  });

  it("validates fields and lines", async () => {
    const err = await createBatch(env.ctx(OWNER), input({ title: " ", plannedReadyDate: "2026-02-30", lines: [{ variantId: product.variantIds[0]!, quantity: 0 }] })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProductionValidationError);
    expect((err as ProductionValidationError).fieldErrors).toMatchObject({
      title: "production.fieldError.required",
      plannedReadyDate: "production.fieldError.invalidDate",
      [`qty.${product.variantIds[0]}`]: "production.fieldError.invalidQuantity",
    });
    const noLines = (await createBatch(env.ctx(OWNER), input({ lines: [] })).catch((e: unknown) => e)) as ProductionValidationError;
    expect(noLines.fieldErrors.lines).toBe("production.fieldError.noLines");
    const dup = (await createBatch(
      env.ctx(OWNER),
      input({ lines: [{ variantId: product.variantIds[0]!, quantity: 1 }, { variantId: product.variantIds[0]!, quantity: 2 }] }),
    ).catch((e: unknown) => e)) as ProductionValidationError;
    expect(dup.fieldErrors[`qty.${product.variantIds[0]}`]).toBe("production.fieldError.duplicate");
    const money = (await createBatch(env.ctx(OWNER), input({ extraCost: "-5", costCurrency: "UAH" })).catch((e: unknown) => e)) as ProductionValidationError;
    expect(money.fieldErrors.extraCost).toBe("production.fieldError.invalidMoney");
    const noCurrency = (await createBatch(env.ctx(OWNER), input({ extraCost: "5", costCurrency: null })).catch((e: unknown) => e)) as ProductionValidationError;
    expect(noCurrency.fieldErrors.costCurrency).toBe("production.fieldError.required");
    await expect(createBatch(env.ctx(OWNER), input({ lines: [{ variantId: uuid(), quantity: 1 }] }))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("permissions: staff cannot manage; costs need finance.view even with production.manage", async () => {
    await expect(createBatch(env.ctx(STAFF), input())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createBatch(env.ctx(MANAGER_NO_FINANCE), input({ extraCost: "10.00", costCurrency: "UAH" }))).rejects.toMatchObject({
      permission: "finance.view",
    });
    await expect(
      createBatch(env.ctx(MANAGER_NO_FINANCE), input({ lines: [{ variantId: product.variantIds[0]!, quantity: 1, unitCost: null }] })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const { batchId } = await createBatch(env.ctx(MANAGER_NO_FINANCE), input());
    expect((await batchRow(batchId)).extraCost).toBeNull();
  });

  it("update: planned only, optimistic version, adds/removes lines, keeps costs for a non-finance manager", async () => {
    const { batchId } = await createBatch(
      env.ctx(OWNER),
      input({
        extraCost: "100.00",
        costCurrency: "EUR",
        lines: [
          { variantId: product.variantIds[0]!, quantity: 10, unitCost: "2.50" },
          { variantId: product.variantIds[1]!, quantity: 5, unitCost: "3" },
        ],
      }),
    );
    const v1 = (await batchRow(batchId)).version;
    await expect(updateBatch(env.ctx(OWNER), batchId, v1 + 7, input())).rejects.toBeInstanceOf(ConflictError);
    const { version } = await updateBatch(env.ctx(MANAGER_NO_FINANCE), batchId, v1, {
      title: "Змінена",
      lines: [
        { variantId: product.variantIds[0]!, quantity: 12 },
        { variantId: product.variantIds[2]!, quantity: 4 },
      ],
    });
    expect(version).toBe(v1 + 1);
    const b = await batchRow(batchId);
    expect(b).toMatchObject({ title: "Змінена", extraCost: "100.00", costCurrency: "EUR" });
    const l = await lines(batchId);
    expect(l.size).toBe(2);
    expect(l.get(product.variantIds[0]!)).toMatchObject({ quantityOrdered: 12, unitCost: "2.50", costCurrency: "EUR", version: 2 });
    expect(l.get(product.variantIds[2]!)).toMatchObject({ quantityOrdered: 4, unitCost: null });
    expect(l.has(product.variantIds[1]!)).toBe(false);

    await startProduction(env.ctx(OWNER), batchId, version);
    await expectDomain(updateBatch(env.ctx(OWNER), batchId, version + 1, input()), "production.error.invalidStatus");
  });
});

describe("lifecycle and ledger", () => {
  it("start → partial receipts → received → close; in_production returns to 0", async () => {
    const [vA, vB] = [product.variantIds[0]!, product.variantIds[1]!];
    const [a0, b0] = [await bal(vA), await bal(vB)];
    const { batchId } = await createBatch(env.ctx(OWNER), input());
    await expect(startProduction(env.ctx(STAFF), batchId, 1)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(startProduction(env.ctx(OWNER), batchId, 99)).rejects.toBeInstanceOf(ConflictError);
    expect(await startProduction(env.ctx(OWNER), batchId, 1)).toEqual({ lines: 2, units: 15 });
    expect((await batchRow(batchId)).status).toBe("in_production");
    expect((await bal(vA)).inProduction - a0.inProduction).toBe(10);
    expect((await bal(vB)).inProduction - b0.inProduction).toBe(5);
    const l = await lines(batchId);
    const lineA = l.get(vA)!;
    const lineB = l.get(vB)!;
    expect(await movementCount(db(), { key: `production_start:${lineA.id}:${lineA.version}` })).toBe(1);
    await expectDomain(startProduction(env.ctx(OWNER), batchId, 2), "production.error.invalidStatus");

    // Часткове надходження працівником складу (warehouse.receive).
    const r1 = await receiveProduction(env.ctx(STAFF), batchId, {
      idempotencyKey: uuid(),
      lines: [{ batchLineId: lineA.id, good: 6, defective: 1, defectReason: "подряпини" }],
      note: "Накладна виробника 17",
    });
    expect(r1).toMatchObject({ duplicate: false, status: "partially_received", good: 6, defective: 1, overReceived: 0 });
    const a1 = await bal(vA);
    expect([a1.onHand - a0.onHand, a1.defective - a0.defective, a1.inProduction - a0.inProduction]).toEqual([6, 1, 3]);
    const [receipt] = await db().select().from(productionReceipts).where(eq(productionReceipts.id, r1.receiptId));
    expect(receipt).toMatchObject({ receivedBy: STAFF.id, receivedByName: STAFF.displayName, note: "Накладна виробника 17" });

    // Решта: увесь залишок як якісні.
    const r2 = await receiveProduction(env.ctx(STAFF), batchId, { idempotencyKey: uuid(), lines: "remaining" });
    expect(r2).toMatchObject({ status: "received", good: 8, defective: 0, lines: 2 });
    const [a2, b2] = [await bal(vA), await bal(vB)];
    expect(a2.inProduction).toBe(a0.inProduction);
    expect(b2.inProduction).toBe(b0.inProduction);
    expect(a2.onHand - a0.onHand).toBe(9);
    expect(b2.onHand - b0.onHand).toBe(5);

    const detail = (await getBatchDetail(db(), batchId, { today: kyivDate(new Date()), includeCosts: false }))!;
    expect(detail.totals).toMatchObject({ ordered: 15, received: 14, defective: 1, remaining: 0, defectRate: 6.7 });
    expect(detail.receipts).toHaveLength(2);
    const first = detail.receipts.find((r) => r.id === r1.receiptId)!;
    expect(first.lines).toEqual([{ batchLineId: lineA.id, good: 6, defective: 1, defectReason: "подряпини" }]);
    expect(detail.costs).toBeNull();

    await expect(closeBatch(env.ctx(STAFF), batchId, 1)).rejects.toBeInstanceOf(ForbiddenError);
    const version = (await batchRow(batchId)).version;
    expect(await closeBatch(env.ctx(OWNER), batchId, version)).toEqual({ lines: 0, closedUnits: 0 });
    expect((await batchRow(batchId)).status).toBe("closed");
    await expectDomain(receiveProduction(env.ctx(OWNER), batchId, { idempotencyKey: uuid(), lines: "remaining" }), "production.error.invalidStatus");
    void lineB;
  });

  it("close with a remainder: production_close takes it out of in_production once", async () => {
    const vA = product.variantIds[0]!;
    const a0 = await bal(vA);
    const { batchId, lines: l } = await started();
    const lineA = l.get(vA)!;
    await receiveProduction(env.ctx(OWNER), batchId, { idempotencyKey: uuid(), lines: [{ batchLineId: lineA.id, good: 4, defective: 0 }] });
    const v = (await batchRow(batchId)).version;
    expect(await closeBatch(env.ctx(OWNER), batchId, v)).toEqual({ lines: 2, closedUnits: 11 });
    const a1 = await bal(vA);
    expect(a1.inProduction).toBe(a0.inProduction);
    expect(a1.onHand - a0.onHand).toBe(4);
    expect(await movementCount(db(), { key: `production_close:${lineA.id}` })).toBe(1);
    await expectDomain(closeBatch(env.ctx(OWNER), batchId, v + 1), "production.error.invalidStatus");
    const detail = (await getBatchDetail(db(), batchId, { today: "2026-01-01" }))!;
    expect(detail.allowed).toMatchObject({ receive: false, close: false, cancel: false });
    // Залишок 11 — «не виготовлено», а не «у виробництві» (у журналі in_production від партії вже 0).
    expect(detail).toMatchObject({ remainderKind: "notProduced", inProduction: 0, totals: { remaining: 11 } });
    const listed = await listBatches(db(), { search: (await batchRow(batchId)).number }, { today: "2026-01-01" });
    expect(listed.rows[0]).toMatchObject({ remainderKind: "notProduced", inProduction: 0 });
  });

  it("cancel: planned without movements; started without receipts releases in_production; with receipts — not allowed", async () => {
    const vA = product.variantIds[0]!;
    const a0 = await bal(vA);
    const planned = await createBatch(env.ctx(OWNER), input());
    // Запланована партія: залишок — «до виготовлення», у кошику «У виробництві» нічого немає.
    expect(await getBatchDetail(db(), planned.batchId, { today: "2026-01-01" })).toMatchObject({ remainderKind: "toProduce", inProduction: 0, totals: { remaining: 15 } });
    const before = await movementCount(db());
    expect(await cancelBatch(env.ctx(OWNER), planned.batchId, 1)).toEqual({ releasedUnits: 0 });
    expect(await movementCount(db())).toBe(before);
    expect((await batchRow(planned.batchId)).status).toBe("cancelled");

    const s = await started();
    expect((await bal(vA)).inProduction - a0.inProduction).toBe(10);
    expect(await getBatchDetail(db(), s.batchId, { today: "2026-01-01" })).toMatchObject({ remainderKind: "inProduction", inProduction: 15 });
    expect(await cancelBatch(env.ctx(OWNER), s.batchId, (await batchRow(s.batchId)).version)).toEqual({ releasedUnits: 15 });
    expect((await bal(vA)).inProduction).toBe(a0.inProduction);
    expect(await getBatchDetail(db(), s.batchId, { today: "2026-01-01" })).toMatchObject({ remainderKind: "notProduced", inProduction: 0, totals: { remaining: 15 } });

    const r = await started();
    await receiveProduction(env.ctx(OWNER), r.batchId, { idempotencyKey: uuid(), lines: [{ batchLineId: r.lines.get(vA)!.id, good: 1, defective: 0 }] });
    await expectDomain(cancelBatch(env.ctx(OWNER), r.batchId, (await batchRow(r.batchId)).version), "production.error.cannotCancel");
    await closeBatch(env.ctx(OWNER), r.batchId, (await batchRow(r.batchId)).version);
    expect((await bal(vA)).inProduction).toBe(a0.inProduction);
  });
});

describe("receipts: idempotency and over-receipt", () => {
  it("the same form key twice records one receipt (duplicate result, balances unchanged)", async () => {
    const vA = product.variantIds[0]!;
    const { batchId, lines: l } = await started();
    const key = uuid();
    const form = { idempotencyKey: key, lines: [{ batchLineId: l.get(vA)!.id, good: 3, defective: 1 }] };
    const first = await receiveProduction(env.ctx(STAFF), batchId, form);
    const after = await bal(vA);
    const movements = await movementCount(db());
    const again = await receiveProduction(env.ctx(STAFF), batchId, form);
    expect(again).toMatchObject({ duplicate: true, receiptId: first.receiptId, good: 3, defective: 1 });
    expect(await bal(vA)).toMatchObject({ onHand: after.onHand, defective: after.defective, inProduction: after.inProduction });
    expect(await movementCount(db())).toBe(movements);
    // Той самий ключ для іншої партії — помилка, а не «тихий» повтор.
    const second = await started();
    await expectDomain(receiveProduction(env.ctx(STAFF), second.batchId, form), "production.error.receiptKey");
    await expectDomain(receiveProduction(env.ctx(STAFF), batchId, { ...form, idempotencyKey: "not-a-uuid" }), "production.error.receiptKey");
    await expectDomain(receiveProduction(env.ctx(STAFF), batchId, { idempotencyKey: uuid(), lines: [{ batchLineId: l.get(vA)!.id, good: 0, defective: 0 }] }), "production.error.emptyReceipt");
  });

  it("more than remaining only with the flag; the surplus goes straight to on_hand/defective", async () => {
    const vB = product.variantIds[1]!;
    const b0 = await bal(vB);
    const { batchId, lines: l } = await started();
    const lineB = l.get(vB)!;
    const movements = await movementCount(db());
    const err = await receiveProduction(env.ctx(STAFF), batchId, { idempotencyKey: uuid(), lines: [{ batchLineId: lineB.id, good: 6, defective: 1 }] }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DomainError);
    expect(err).toMatchObject({ code: "production.error.overReceipt", params: { remaining: 5, requested: 7, item: expect.stringContaining("PT-X-WHT") } });
    expect(await movementCount(db())).toBe(movements);
    expect((await db().select().from(productionReceipts).where(eq(productionReceipts.batchId, batchId))).length).toBe(0);

    const ok = await receiveProduction(env.ctx(STAFF), batchId, {
      idempotencyKey: uuid(),
      lines: [{ batchLineId: lineB.id, good: 6, defective: 1 }],
      allowOverReceipt: true,
    });
    expect(ok).toMatchObject({ overReceived: 2, status: "partially_received" });
    const b1 = await bal(vB);
    expect([b1.onHand - b0.onHand, b1.defective - b0.defective, b1.inProduction - b0.inProduction]).toEqual([6, 1, 0]);
    const [mv] = await db()
      .select()
      .from(inventoryMovements)
      .where(and(eq(inventoryMovements.productionBatchId, batchId), eq(inventoryMovements.type, "receipt_production")));
    expect(mv).toMatchObject({ inProductionDelta: -5, onHandDelta: 6, defectiveDelta: 1, reason: "production_over_receipt" });

    // Після повного отримання — лише з прапорцем.
    const lineA = l.get(product.variantIds[0]!)!;
    expect((await receiveProduction(env.ctx(STAFF), batchId, { idempotencyKey: uuid(), lines: "remaining" })).status).toBe("received");
    await expectDomain(receiveProduction(env.ctx(STAFF), batchId, { idempotencyKey: uuid(), lines: [{ batchLineId: lineA.id, good: 1, defective: 0 }] }), "production.error.overReceipt");
    expect(
      (await receiveProduction(env.ctx(STAFF), batchId, { idempotencyKey: uuid(), lines: [{ batchLineId: lineA.id, good: 1, defective: 0 }], allowOverReceipt: true })).status,
    ).toBe("received");
    await closeBatch(env.ctx(OWNER), batchId, (await batchRow(batchId)).version);
    expect((await bal(vB)).inProduction).toBe(b0.inProduction);
  });

  it("requires warehouse.receive; validates quantities and lines of another batch", async () => {
    const { batchId, lines: l } = await started();
    const lineId = l.get(product.variantIds[0]!)!.id;
    await expect(receiveProduction(env.ctx(VIEWER), batchId, { idempotencyKey: uuid(), lines: "remaining" })).rejects.toBeInstanceOf(ForbiddenError);
    const bad = (await receiveProduction(env.ctx(STAFF), batchId, { idempotencyKey: uuid(), lines: [{ batchLineId: lineId, good: -1, defective: 1.5 }] }).catch(
      (e: unknown) => e,
    )) as ProductionValidationError;
    expect(Object.keys(bad.fieldErrors).sort()).toEqual([`defective.${lineId}`, `good.${lineId}`]);
    const foreign = await started();
    await expect(
      receiveProduction(env.ctx(STAFF), batchId, { idempotencyKey: uuid(), lines: [{ batchLineId: foreign.lines.get(product.variantIds[0]!)!.id, good: 1, defective: 0 }] }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const planned = await createBatch(env.ctx(OWNER), input());
    await expectDomain(receiveProduction(env.ctx(STAFF), planned.batchId, { idempotencyKey: uuid(), lines: "remaining" }), "production.error.invalidStatus");
  });
});

describe("concurrency", () => {
  it("two receipts of the whole remainder of one line at the same time: exactly one succeeds, no over-receipt", async () => {
    const vA = product.variantIds[0]!;
    const a0 = await bal(vA);
    const { batchId, lines: l } = await started({ lines: [{ variantId: vA, quantity: 8 }] });
    const lineId = l.get(vA)!.id;
    const settled = await Promise.allSettled(
      [1, 2].map(() => receiveProduction(env.ctx(STAFF), batchId, { idempotencyKey: uuid(), lines: [{ batchLineId: lineId, good: 8, defective: 0 }] })),
    );
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((s) => s.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "production.error.overReceipt" });
    const a1 = await bal(vA);
    expect(a1.onHand - a0.onHand).toBe(8);
    expect(a1.inProduction).toBe(a0.inProduction);
    expect((await lines(batchId)).get(vA)).toMatchObject({ quantityReceived: 8, quantityDefective: 0 });
  });

  it("concurrent partial receipts are serialized; with the flag the second becomes surplus, in_production never below 0", async () => {
    const vC = product.variantIds[2]!;
    const c0 = await bal(vC);
    const { batchId, lines: l } = await started({ lines: [{ variantId: vC, quantity: 6 }] });
    const lineId = l.get(vC)!.id;
    const results = await Promise.all(
      [4, 4].map((good) =>
        receiveProduction(env.ctx(STAFF), batchId, { idempotencyKey: uuid(), lines: [{ batchLineId: lineId, good, defective: 0 }], allowOverReceipt: true }),
      ),
    );
    expect(results.map((r) => r.overReceived).sort()).toEqual([0, 2]);
    const c1 = await bal(vC);
    expect(c1.onHand - c0.onHand).toBe(8);
    expect(c1.inProduction).toBe(c0.inProduction);
    expect((await batchRow(batchId)).status).toBe("received");
  });

  it("the same form submitted twice concurrently records one receipt", async () => {
    const vA = product.variantIds[0]!;
    const a0 = await bal(vA);
    const { batchId, lines: l } = await started({ lines: [{ variantId: vA, quantity: 5 }] });
    const form = { idempotencyKey: uuid(), lines: [{ batchLineId: l.get(vA)!.id, good: 2, defective: 0 }] };
    const results = await Promise.all([receiveProduction(env.ctx(STAFF), batchId, form), receiveProduction(env.ctx(STAFF), batchId, form)]);
    expect(results.map((r) => r.duplicate).sort()).toEqual([false, true]);
    expect(new Set(results.map((r) => r.receiptId)).size).toBe(1);
    expect((await bal(vA)).onHand - a0.onHand).toBe(2);
  });
});

describe("cost of production (owner only)", () => {
  it("stores the planned unit cost on movements; summary only with includeCosts; updateBatchCosts needs finance.view", async () => {
    const [vA, vB] = [product.variantIds[0]!, product.variantIds[1]!];
    const { batchId, lines: l } = await started({
      extraCost: "150.00",
      costCurrency: "UAH",
      lines: [
        { variantId: vA, quantity: 10, unitCost: "100.00" },
        { variantId: vB, quantity: 5, unitCost: "40" },
      ],
    });
    await receiveProduction(env.ctx(STAFF), batchId, { idempotencyKey: uuid(), lines: [{ batchLineId: l.get(vA)!.id, good: 9, defective: 1 }] });
    const [mv] = await db()
      .select()
      .from(inventoryMovements)
      .where(and(eq(inventoryMovements.productionBatchId, batchId), eq(inventoryMovements.type, "receipt_production")));
    // Планова собівартість одиниці ВИГОТОВЛЕНОГО: 100 + 150 / 15 = 110.00 (додаткові витрати порівну на одиницю),
    // однакова для 9 якісних і 1 браку руху — без розподілу браку (див. calc.ts).
    expect(mv).toMatchObject({ unitCost: "110.00", costCurrency: "UAH", onHandDelta: 9, defectiveDelta: 1 });

    const owner = (await getBatchDetail(db(), batchId, { today: "2026-01-01", includeCosts: true }))!;
    // Планова загальна: 10 × 100 + 5 × 40 + 150 = 1350. Виготовлено 10 (позиція B ще у виробництві):
    // 10 × 100 + 150 × 10/15 = 1100 = unit_cost руху × (якісні + брак); ÷ 9 якісних → 122.22 (брак на якісні).
    expect(owner.costs!.summary).toMatchObject({ total: "1350.00", producedTotal: "1100.00", costPerGoodUnit: "122.22", complete: true, currency: "UAH" });
    const staff = (await getBatchDetail(db(), batchId, { today: "2026-01-01", includeCosts: false }))!;
    expect(staff.costs).toBeNull();
    expect(JSON.stringify(staff)).not.toMatch(/unitCost|extraCost|1350|150\.00|100\.00/);
    const listed = await listBatches(db(), { search: (await batchRow(batchId)).number }, { today: "2026-01-01" });
    expect(listed.rows[0]!.cost).toBeNull();
    const listedOwner = await listBatches(db(), { search: (await batchRow(batchId)).number }, { today: "2026-01-01", includeCosts: true });
    expect(listedOwner.rows[0]!.cost).toMatchObject({ total: "1350.00", currency: "UAH" });

    const v = (await batchRow(batchId)).version;
    await expect(updateBatchCosts(env.ctx(MANAGER_NO_FINANCE), batchId, v, { extraCost: null, costCurrency: "UAH", lines: [] })).rejects.toBeInstanceOf(ForbiddenError);
    await updateBatchCosts(env.ctx(OWNER), batchId, v, { extraCost: "0", costCurrency: "EUR", lines: [{ batchLineId: l.get(vB)!.id, unitCost: "50.5" }] });
    const updated = await lines(batchId);
    expect(updated.get(vB)).toMatchObject({ unitCost: "50.50", costCurrency: "EUR" });
    expect(updated.get(vA)).toMatchObject({ unitCost: "100.00", costCurrency: "EUR" });
    expect(await batchRow(batchId)).toMatchObject({ extraCost: "0.00", costCurrency: "EUR" });
  });

  it("after closing short, the unproduced remainder is no longer billed (detail and list)", async () => {
    const vC = product.variantIds[2]!;
    const { batchId, lines: l } = await started({ costCurrency: "UAH", lines: [{ variantId: vC, quantity: 10, unitCost: "100.00" }] });
    await receiveProduction(env.ctx(STAFF), batchId, { idempotencyKey: uuid(), lines: [{ batchLineId: l.get(vC)!.id, good: 4, defective: 0 }] });
    const open = (await getBatchDetail(db(), batchId, { today: "2026-01-01", includeCosts: true }))!;
    expect(open.costs!.summary).toMatchObject({ total: "1000.00", producedTotal: "400.00", costPerGoodUnit: "100.00" });
    await closeBatch(env.ctx(OWNER), batchId, (await batchRow(batchId)).version);
    const closed = (await getBatchDetail(db(), batchId, { today: "2026-01-01", includeCosts: true }))!;
    expect(closed.costs!.summary).toMatchObject({ total: "400.00", producedTotal: "400.00", costPerGoodUnit: "100.00", lines: [{ billedQty: 4, total: "400.00" }] });
    const listed = await listBatches(db(), { search: (await batchRow(batchId)).number }, { today: "2026-01-01", includeCosts: true });
    expect(listed.rows[0]!.cost).toMatchObject({ total: "400.00", costPerGoodUnit: "100.00" });
  });
});

describe("variant grid", () => {
  it("orders variants with the same creation time deterministically (Shopify id numerically, then SKU)", async () => {
    const [p] = await db().insert(products).values({ title: "Тестова сітка", handle: "test-grid-order" }).returning({ id: products.id });
    const at = new Date("2026-01-01T00:00:00Z");
    const v = (sku: string, model: string, color: string, gid: string | null) => ({
      productId: p!.id,
      title: `${model} / ${color}`,
      sku,
      model,
      color,
      price: "1.00",
      currency: "EUR",
      shopifyVariantId: gid,
      createdAt: at,
    });
    await db()
      .insert(productVariants)
      .values([
        v("G-C", "M2", "Білий", null),
        v("G-B", "M2", "Чорний", "gid://shopify/ProductVariant/10"),
        v("G-A", "M1", "Чорний", "gid://shopify/ProductVariant/9"),
        v("G-D", "M1", "Білий", null),
      ]);
    for (let i = 0; i < 3; i++) {
      const [grid] = await loadVariantGrid(db(), [p!.id]);
      expect(grid!.variants.map((x) => x.sku)).toEqual(["G-A", "G-B", "G-C", "G-D"]);
      expect(grid).toMatchObject({ models: ["M1", "M2"], colors: ["Чорний", "Білий"] });
    }
  });
});

describe("list, filters and open production", () => {
  it("filters by status, product/model/color, overdue; status counts", async () => {
    const bag = await createBatch(env.ctx(OWNER), {
      title: "Сумки",
      plannedReadyDate: "2020-05-01",
      lines: [{ variantId: other.variantIds[0]!, quantity: 3 }],
    });
    const today = "2026-11-27";
    const byProduct = await listBatches(db(), { productIds: [other.productId] }, { today });
    expect(byProduct.rows.map((r) => r.id)).toEqual([bag.batchId]);
    expect(byProduct.rows[0]).toMatchObject({ overdue: true, totals: { ordered: 3, remaining: 3 }, productCount: 1 });
    expect(byProduct.rows[0]!.products[0]).toMatchObject({ title: "Тестова сумка" });
    // Сірий — ця партія й партія вигаданої історії демо із сірими грипсами (db/seed/demo-history.server.ts).
    const grey = await listBatches(db(), { colors: ["Сірий"] }, { today });
    expect(grey.rows.map((r) => r.id)).toContain(bag.batchId);
    expect(grey.rows.map((r) => r.title).sort()).toEqual(["Грипси й тримачі чорні", "Сумки"]);
    expect((await listBatches(db(), { colors: ["Сірий"], productIds: [other.productId] }, { today })).rows.map((r) => r.id)).toEqual([bag.batchId]);
    expect((await listBatches(db(), { models: ["S"], productIds: [other.productId] }, { today })).total).toBe(0);
    expect((await listBatches(db(), { overdue: true }, { today })).rows.map((r) => r.id)).toContain(bag.batchId);
    expect((await listBatches(db(), { search: "сумки" }, { today })).rows.map((r) => r.id)).toContain(bag.batchId);
    expect((await listBatches(db(), { search: "PT-BAG" }, { today })).rows.map((r) => r.id)).toContain(bag.batchId);
    const planned = await listBatches(db(), { statuses: ["planned"] }, { today });
    expect(planned.rows.every((r) => r.status === "planned")).toBe(true);
    expect(planned.statusCounts.planned).toBe(planned.total);
    expect(planned.statusCounts.in_production).toBeGreaterThan(0);
    const options = await listBatchFilterOptions(db());
    expect(options.models).toEqual(expect.arrayContaining(["X", "S"]));
    expect(options.colors).toEqual(expect.arrayContaining(["Сірий", "Чорний"]));

    const open = await openProductionByVariant(db(), [other.variantIds[0]!]);
    expect(open).toEqual([{ variantId: other.variantIds[0]!, inProduction: 0, planned: 3, nextReadyDate: "2020-05-01", batchIds: [bag.batchId] }]);
    await startProduction(env.ctx(OWNER), bag.batchId, 1);
    expect((await openProductionByVariant(db(), [other.variantIds[0]!]))[0]).toMatchObject({ inProduction: 3, planned: 0 });
  });
});

describe("countProductionDue (dashboard)", () => {
  it("counts active, overdue and due-soon batches by the planned ready date", async () => {
    const [soonBefore, lateBefore] = [await countProductionDue(db(), "2031-06-10"), await countProductionDue(db(), "2031-06-13")];
    const { batchId } = await createBatch(env.ctx(OWNER), input({ plannedReadyDate: "2031-06-12" }));
    const soon = await countProductionDue(db(), "2031-06-10");
    expect(soon.active).toBe(soonBefore.active + 1);
    expect(soon.dueSoon).toBe(soonBefore.dueSoon + 1);
    expect(soon.overdue).toBe(soonBefore.overdue);
    const late = await countProductionDue(db(), "2031-06-13");
    expect(late.overdue).toBe(lateBefore.overdue + 1);
    expect(late.dueSoon).toBe(lateBefore.dueSoon);
    // Скасована партія не рахується.
    await cancelBatch(env.ctx(OWNER), batchId, (await batchRow(batchId)).version);
    expect(await countProductionDue(db(), "2031-06-13")).toEqual(lateBefore);
  });
});
