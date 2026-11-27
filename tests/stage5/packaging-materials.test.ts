import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLog, inventoryMovements, packagingMaterials, stockAlerts, stockItems } from "~/db/schema";
import { ForbiddenError, makeActor } from "~/domain/permissions";
import { ConflictError, DomainError } from "~/lib/errors";
import { listOpenAlerts, movementHistory } from "~/modules/inventory/ledger.server";
import {
  applyMaterialStock,
  createMaterial,
  getMaterial,
  listMaterials,
  setMaterialThreshold,
  setMaterialsActive,
  updateMaterial,
} from "~/modules/packaging/materials.server";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";
import { balance, movementCount } from "./helpers";

/** Пакувальні матеріали: довідник, собівартість лише власнику, операції із залишком через журнал (ідемпотентно). */
let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});

/** Працівник із правом коригувань (warehouse.adjust), але без finance.view (його не можна надати працівнику). */
const STAFF_ADJUST = makeActor({ id: "staff-adjust", displayName: "Staff Adjust", role: "staff", overrides: { grant: ["warehouse.adjust", "finance.view"] } });

const uuid = () => globalThis.crypto.randomUUID();
const boxInput = (code: string, extra: Record<string, unknown> = {}) => ({
  code,
  name: `Box ${code}`,
  kind: "box" as const,
  unit: "pcs" as const,
  innerLengthMm: "250",
  innerWidthMm: "200",
  innerHeightMm: "100",
  maxWeightGrams: "3000",
  tareWeightGrams: "150",
  lowStockThreshold: "",
  active: true,
  ...extra,
});

async function stockItemOf(materialId: string) {
  const [row] = await env.handle.db.select().from(stockItems).where(eq(stockItems.materialId, materialId));
  return row!.id;
}

describe("material catalogue", () => {
  it("demo materials are listed with stock, status and kit usage; costs only with includeCosts", async () => {
    const withCosts = await listMaterials(env.handle.db, {}, { includeCosts: true });
    const boxM = withCosts.rows.find((r) => r.code === "box_m")!;
    expect(boxM).toMatchObject({ kind: "box", onHand: 25, status: "ok", isBox: true, selectable: true, unitCost: "18.00", costCurrency: "UAH" });
    expect(withCosts.rows.find((r) => r.code === "box_l")).toMatchObject({ onHand: 4, status: "low" });
    expect(withCosts.rows.find((r) => r.code === "sticker_logo")).toMatchObject({ isBox: false, selectable: false, kitLines: 1 });
    const noCosts = await listMaterials(env.handle.db);
    expect(noCosts.rows.every((r) => r.unitCost === null && r.costCurrency === null)).toBe(true);
    expect(noCosts.statusCounts.low).toBeGreaterThanOrEqual(2); // коробка L (4) і болти (3) при типовому порозі 5
    const low = await listMaterials(env.handle.db, { statuses: ["low"] });
    expect(low.rows.map((r) => r.code).sort()).toEqual(expect.arrayContaining(["bolts_m5", "box_l"]));
    expect(low.rows.every((r) => r.status === "low")).toBe(true);
    const boxes = await listMaterials(env.handle.db, { kinds: ["box", "mailer"], search: "m" });
    expect(boxes.rows.map((r) => r.code).sort()).toEqual(["box_m", "mailer_m"]);
  });

  it("owner creates a box with cost and threshold; staff cannot create", async () => {
    const { id } = await createMaterial(env.ctx(OWNER), boxInput("box_test", { unitCost: "9.90", costCurrency: "uah", lowStockThreshold: "2" }));
    const m = await getMaterial(env.handle.db, id, { includeCosts: true });
    expect(m).toMatchObject({ code: "box_test", innerLengthMm: 250, maxWeightGrams: 3000, tareWeightGrams: 150, unitCost: "9.90", costCurrency: "UAH", lowStockThreshold: 2, threshold: 2, onHand: 0, status: "out" });
    expect(m.stockItemId).toBeTruthy();
    await expect(createMaterial(env.ctx(STAFF), boxInput("box_staff"))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createMaterial(env.ctx(OWNER), boxInput("box_test"))).rejects.toMatchObject({ code: "packaging.error.codeTaken" });
    const audits = await env.handle.db.select().from(auditLog).where(eq(auditLog.action, "packaging.material.created"));
    expect(audits.some((a) => a.entityId === id)).toBe(true);
  });

  it("a non-owner with warehouse.adjust never writes costs (finance.view cannot be granted to staff)", async () => {
    expect(STAFF_ADJUST.permissions.has("finance.view")).toBe(false);
    const { id } = await createMaterial(env.ctx(STAFF_ADJUST), boxInput("box_nocost", { unitCost: "5.00", costCurrency: "UAH" }));
    expect((await getMaterial(env.handle.db, id, { includeCosts: true })).unitCost).toBeNull();
    // Власник задає собівартість; працівник змінює інші поля — собівартість лишається.
    const before = await getMaterial(env.handle.db, id);
    await updateMaterial(env.ctx(OWNER), id, boxInput("box_nocost", { unitCost: "7.25", costCurrency: "UAH" }), { expectedVersion: before.version });
    const owned = await getMaterial(env.handle.db, id);
    await updateMaterial(env.ctx(STAFF_ADJUST), id, boxInput("box_nocost", { name: "Renamed", unitCost: "0.01", costCurrency: "UAH" }), {
      expectedVersion: owned.version,
    });
    expect(await getMaterial(env.handle.db, id, { includeCosts: true })).toMatchObject({ name: "Renamed", unitCost: "7.25" });
  });

  it("rejects a stale form (optimistic lock) and validates input", async () => {
    const { id } = await createMaterial(env.ctx(OWNER), boxInput("box_lock"));
    const v1 = await getMaterial(env.handle.db, id);
    await updateMaterial(env.ctx(OWNER), id, boxInput("box_lock", { name: "First" }), { expectedVersion: v1.version });
    await expect(updateMaterial(env.ctx(OWNER), id, boxInput("box_lock", { name: "Second" }), { expectedVersion: v1.version })).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect((await getMaterial(env.handle.db, id)).name).toBe("First");
    await expect(createMaterial(env.ctx(OWNER), boxInput("box_bad", { innerHeightMm: "" }))).rejects.toMatchObject({ name: "ZodError" });
    await expect(createMaterial(env.ctx(OWNER), boxInput("BAD CODE"))).rejects.toMatchObject({ name: "ZodError" });
  });

  it("non-box kinds do not keep box dimensions", async () => {
    const { id } = await createMaterial(env.ctx(OWNER), boxInput("filler_test", { kind: "filler", unit: "kg" }));
    expect(await getMaterial(env.handle.db, id)).toMatchObject({ kind: "filler", unit: "kg", innerLengthMm: null, maxWeightGrams: null, tareWeightGrams: null, isBox: false });
  });

  it("bulk deactivation hides materials from the default list; threshold changes re-evaluate alerts", async () => {
    const { id } = await createMaterial(env.ctx(OWNER), boxInput("box_bulk"));
    expect((await setMaterialsActive(env.ctx(OWNER), [id, id], false)).updated).toBe(1);
    expect((await setMaterialsActive(env.ctx(OWNER), [id], false)).updated).toBe(0);
    expect((await listMaterials(env.handle.db)).rows.some((r) => r.id === id)).toBe(false);
    expect((await listMaterials(env.handle.db, { activity: "inactive" })).rows.map((r) => r.id)).toContain(id);
    await expect(setMaterialsActive(env.ctx(STAFF), [id], true)).rejects.toBeInstanceOf(ForbiddenError);
    await setMaterialsActive(env.ctx(OWNER), [id], true);

    const [boxM] = await env.handle.db.select().from(packagingMaterials).where(eq(packagingMaterials.code, "box_m"));
    const si = await stockItemOf(boxM!.id);
    await setMaterialThreshold(env.ctx(OWNER), boxM!.id, 30); // 25 ≤ 30 → «мало»
    const open = await env.handle.db.select().from(stockAlerts).where(and(eq(stockAlerts.stockItemId, si), eq(stockAlerts.status, "open")));
    expect(open.map((a) => a.kind)).toEqual(["low_stock"]);
    await setMaterialThreshold(env.ctx(OWNER), boxM!.id, null);
    const after = await env.handle.db.select().from(stockAlerts).where(and(eq(stockAlerts.stockItemId, si), eq(stockAlerts.status, "open")));
    expect(after).toEqual([]);
    await expect(setMaterialThreshold(env.ctx(STAFF), boxM!.id, 1)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("material stock operations", () => {
  async function material(code: string) {
    const [m] = await env.handle.db.select().from(packagingMaterials).where(eq(packagingMaterials.code, code));
    return { id: m!.id, stockItemId: await stockItemOf(m!.id) };
  }

  it("staff receives materials; repeating the same form does not double the receipt", async () => {
    const card = await material("card_thanks");
    const tape = await material("tape");
    const before = [(await balance(env.handle.db, card.stockItemId)).onHand, (await balance(env.handle.db, tape.stockItemId)).onHand];
    const operationId = uuid();
    const input = { operationId, operation: "receive" as const, lines: [{ materialId: card.id, quantity: "50" }, { materialId: tape.id, quantity: 25 }], note: "  " };
    const r1 = await applyMaterialStock(env.ctx(STAFF), input);
    expect(r1).toMatchObject({ applied: 2, duplicates: 0, totalDelta: 75 });
    expect(r1.lines.find((l) => l.materialId === card.id)).toMatchObject({ before: before[0], after: before[0]! + 50, status: "applied" });
    const r2 = await applyMaterialStock(env.ctx(STAFF), input);
    expect(r2).toMatchObject({ applied: 0, duplicates: 2, totalDelta: 0 });
    expect((await balance(env.handle.db, card.stockItemId)).onHand).toBe(before[0]! + 50);
    expect((await balance(env.handle.db, tape.stockItemId)).onHand).toBe(before[1]! + 25);
    expect(await movementCount(env.handle.db, { key: `manual:${operationId}:${card.id}` })).toBe(1);
    const [mv] = await env.handle.db.select().from(inventoryMovements).where(eq(inventoryMovements.idempotencyKey, `manual:${operationId}:${card.id}`));
    expect(mv).toMatchObject({ type: "receipt_manual", reason: "material_receipt", onHandDelta: 50, shopifySyncState: "none", actorId: STAFF.id, note: null });
  });

  it("write-off, adjustment and stock count require warehouse.adjust", async () => {
    const card = await material("card_thanks");
    for (const operation of ["writeoff", "adjust", "count"] as const) {
      await expect(applyMaterialStock(env.ctx(STAFF), { operationId: uuid(), operation, lines: [{ materialId: card.id, quantity: 1 }] })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    }
  });

  it("write-off and adjustment change stock; stock count sets the counted value and is idempotent", async () => {
    const sticker = await material("sticker_logo");
    const start = (await balance(env.handle.db, sticker.stockItemId)).onHand;
    await applyMaterialStock(env.ctx(OWNER), { operationId: uuid(), operation: "writeoff", lines: [{ materialId: sticker.id, quantity: 10 }] });
    expect((await balance(env.handle.db, sticker.stockItemId)).onHand).toBe(start - 10);
    await applyMaterialStock(env.ctx(OWNER), { operationId: uuid(), operation: "adjust", lines: [{ materialId: sticker.id, quantity: -5 }] });
    await applyMaterialStock(env.ctx(OWNER), { operationId: uuid(), operation: "adjust", lines: [{ materialId: sticker.id, quantity: "+3" }] });
    expect((await balance(env.handle.db, sticker.stockItemId)).onHand).toBe(start - 12);
    const count = await applyMaterialStock(env.ctx(OWNER), { operationId: uuid(), operation: "count", lines: [{ materialId: sticker.id, quantity: 100 }] });
    expect(count.lines[0]).toMatchObject({ before: start - 12, delta: 100 - (start - 12), after: 100, status: "applied" });
    const same = await applyMaterialStock(env.ctx(OWNER), { operationId: uuid(), operation: "count", lines: [{ materialId: sticker.id, quantity: 100 }] });
    expect(same).toMatchObject({ applied: 0, unchanged: 1 });
    const history = await movementHistory(env.handle.db, { materialIds: [sticker.id] }, { limit: 10 });
    expect(history.rows.slice(0, 4).map((r) => [r.type, r.reason])).toEqual([
      ["adjustment", "stock_count"],
      ["adjustment", "correction"],
      ["adjustment", "correction"],
      ["adjustment", "write_off"],
    ]);
  });

  it("refuses to make stock negative and records nothing (all-or-nothing)", async () => {
    const bolts = await material("bolts_m5");
    const card = await material("card_thanks");
    const before = [(await balance(env.handle.db, bolts.stockItemId)).onHand, (await balance(env.handle.db, card.stockItemId)).onHand];
    const movementsBefore = await movementCount(env.handle.db);
    const err = await applyMaterialStock(env.ctx(OWNER), {
      operationId: uuid(),
      operation: "writeoff",
      lines: [
        { materialId: card.id, quantity: 1 },
        { materialId: bolts.id, quantity: before[0]! + 1 },
      ],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect(err).toMatchObject({ code: "packaging.error.insufficient", params: { code: "bolts_m5", current: before[0], change: -(before[0]! + 1) } });
    expect([(await balance(env.handle.db, bolts.stockItemId)).onHand, (await balance(env.handle.db, card.stockItemId)).onHand]).toEqual(before);
    expect(await movementCount(env.handle.db)).toBe(movementsBefore);
  });

  it("validates lines: positive quantities, no duplicates, known materials", async () => {
    const card = await material("card_thanks");
    const op = (operation: "receive" | "writeoff" | "adjust" | "count", quantity: number) =>
      applyMaterialStock(env.ctx(OWNER), { operationId: uuid(), operation, lines: [{ materialId: card.id, quantity }] });
    await expect(op("receive", 0)).rejects.toMatchObject({ code: "packaging.error.stockQuantity" });
    await expect(op("writeoff", -1)).rejects.toMatchObject({ code: "packaging.error.stockQuantity" });
    await expect(op("adjust", 0)).rejects.toMatchObject({ code: "packaging.error.stockQuantity" });
    await expect(op("count", -1)).rejects.toMatchObject({ code: "packaging.error.stockQuantity" });
    await expect(
      applyMaterialStock(env.ctx(OWNER), {
        operationId: uuid(),
        operation: "receive",
        lines: [
          { materialId: card.id, quantity: 1 },
          { materialId: card.id.toUpperCase(), quantity: 2 },
        ],
      }),
    ).rejects.toMatchObject({ code: "packaging.error.stockDuplicate" });
    await expect(applyMaterialStock(env.ctx(OWNER), { operationId: uuid(), operation: "receive", lines: [{ materialId: uuid(), quantity: 1 }] })).rejects.toMatchObject({
      code: "error.notFound",
    });
    await expect(applyMaterialStock(env.ctx(OWNER), { operationId: "not-a-uuid", operation: "receive", lines: [{ materialId: card.id, quantity: 1 }] })).rejects.toMatchObject({
      name: "ZodError",
    });
  });

  it("unit cost on receipt: owner only, stored on the movement and shown only with includeCosts", async () => {
    const tape = await material("tape");
    await expect(
      applyMaterialStock(env.ctx(STAFF), { operationId: uuid(), operation: "receive", lines: [{ materialId: tape.id, quantity: 1 }], unitCost: "1.00", costCurrency: "UAH" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      applyMaterialStock(env.ctx(OWNER), { operationId: uuid(), operation: "writeoff", lines: [{ materialId: tape.id, quantity: 1 }], unitCost: "1.00", costCurrency: "UAH" }),
    ).rejects.toMatchObject({ code: "packaging.error.costOnlyReceive" });
    const operationId = uuid();
    await applyMaterialStock(env.ctx(OWNER), { operationId, operation: "receive", lines: [{ materialId: tape.id, quantity: 10 }], unitCost: "0,45", costCurrency: "uah" });
    const hidden = await movementHistory(env.handle.db, { materialIds: [tape.id] }, { limit: 1 });
    expect(hidden.rows[0]).toMatchObject({ type: "receipt_manual", unitCost: null, costCurrency: null });
    const shown = await movementHistory(env.handle.db, { materialIds: [tape.id] }, { limit: 1 }, { includeCosts: true });
    expect(shown.rows[0]).toMatchObject({ unitCost: "0.45", costCurrency: "UAH" });
  });
});

describe("stock alerts of inactive materials", () => {
  it("deactivation resolves open alerts; inactive materials open none; activation re-evaluates", async () => {
    // Регресія: деактивований матеріал зберігав відкрите попередження (лічильник «Склад» → прихований матеріал).
    const { id } = await createMaterial(env.ctx(OWNER), boxInput("box_alerts"));
    const si = await stockItemOf(id);
    const open = async () =>
      (await env.handle.db.select().from(stockAlerts).where(and(eq(stockAlerts.stockItemId, si), eq(stockAlerts.status, "open")))).map((a) => a.kind);
    await applyMaterialStock(env.ctx(OWNER), { operationId: uuid(), operation: "receive", lines: [{ materialId: id, quantity: 3 }] });
    expect(await open()).toEqual(["low_stock"]); // 3 ≤ типовий поріг 5
    await setMaterialsActive(env.ctx(OWNER), [id], false);
    expect(await open()).toEqual([]);
    expect((await listOpenAlerts(env.handle.db)).some((a) => a.stockItemId === si)).toBe(false);

    // Зміни залишку й порогу неактивного матеріалу попереджень не відкривають.
    await applyMaterialStock(env.ctx(OWNER), { operationId: uuid(), operation: "writeoff", lines: [{ materialId: id, quantity: 3 }] });
    await setMaterialThreshold(env.ctx(OWNER), id, 10);
    await applyMaterialStock(env.ctx(OWNER), { operationId: uuid(), operation: "count", lines: [{ materialId: id, quantity: 0 }] });
    expect(await open()).toEqual([]);

    // Активація — попередження за поточним залишком (0 → «немає»).
    await setMaterialsActive(env.ctx(OWNER), [id], true);
    expect(await open()).toEqual(["out_of_stock"]);
    // Деактивація з форми матеріалу (прапорець «Активний» знято) — так само закриває.
    const v = await getMaterial(env.handle.db, id);
    await updateMaterial(env.ctx(OWNER), id, boxInput("box_alerts", { active: false, lowStockThreshold: "10" }), { expectedVersion: v.version });
    expect(await open()).toEqual([]);
    const v2 = await getMaterial(env.handle.db, id);
    await updateMaterial(env.ctx(OWNER), id, boxInput("box_alerts", { active: true, lowStockThreshold: "10" }), { expectedVersion: v2.version });
    expect(await open()).toEqual(["out_of_stock"]);
  });
});

/**
 * Паралельні операції: на справжньому PostgreSQL (TEST_DATABASE_URL) транзакції йдуть одночасно (блокування балансів
 * FOR UPDATE, ключі ідемпотентності), PGlite їх серіалізує — інваріанти мають триматися в обох випадках.
 */
describe("concurrency", () => {
  type StockResult = Awaited<ReturnType<typeof applyMaterialStock>>;
  const fulfilled = (settled: PromiseSettledResult<StockResult>[]) =>
    settled.filter((r): r is PromiseFulfilledResult<StockResult> => r.status === "fulfilled").map((r) => r.value);
  const rejectedCodes = (settled: PromiseSettledResult<unknown>[]) =>
    settled.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => String((r.reason as { code?: string })?.code ?? r.reason));

  async function freshMaterial(code: string, stock: number) {
    const { id } = await createMaterial(env.ctx(OWNER), boxInput(code));
    if (stock > 0) await applyMaterialStock(env.ctx(OWNER), { operationId: uuid(), operation: "receive", lines: [{ materialId: id, quantity: stock }] });
    return { id, stockItemId: await stockItemOf(id) };
  }

  it("the same form submitted in parallel is applied once per material", async () => {
    const a = await freshMaterial("par_same_a", 0);
    const b = await freshMaterial("par_same_b", 0);
    const operationId = uuid();
    const input = { operationId, operation: "receive" as const, lines: [{ materialId: a.id, quantity: 5 }, { materialId: b.id, quantity: 7 }] };
    const settled = await Promise.allSettled(Array.from({ length: 10 }, () => applyMaterialStock(env.ctx(STAFF), input)));
    expect(rejectedCodes(settled)).toEqual([]);
    const results = fulfilled(settled);
    expect(results.reduce((s, r) => s + r.applied, 0)).toBe(2);
    expect(results.reduce((s, r) => s + r.duplicates, 0)).toBe(18);
    expect((await balance(env.handle.db, a.stockItemId)).onHand).toBe(5);
    expect((await balance(env.handle.db, b.stockItemId)).onHand).toBe(7);
    expect(await movementCount(env.handle.db, { key: `manual:${operationId}:${a.id}` })).toBe(1);
    expect(await movementCount(env.handle.db, { key: `manual:${operationId}:${b.id}` })).toBe(1);
  });

  it("competing write-offs never make stock negative", async () => {
    const m = await freshMaterial("par_writeoff", 5);
    const settled = await Promise.allSettled(
      Array.from({ length: 10 }, () => applyMaterialStock(env.ctx(OWNER), { operationId: uuid(), operation: "writeoff", lines: [{ materialId: m.id, quantity: 1 }] })),
    );
    expect(fulfilled(settled)).toHaveLength(5);
    expect(rejectedCodes(settled)).toEqual(Array.from({ length: 5 }, () => "packaging.error.insufficient"));
    expect((await balance(env.handle.db, m.stockItemId)).onHand).toBe(0);
    expect(await movementCount(env.handle.db, { stockItemId: m.stockItemId, type: "adjustment" })).toBe(5);
  });

  it("parallel stock counts in mixed line order: no deadlocks, deltas from locked values, one effective movement", async () => {
    const a = await freshMaterial("par_count_a", 3);
    const b = await freshMaterial("par_count_b", 8);
    const before = { a: await movementCount(env.handle.db, { stockItemId: a.stockItemId }), b: await movementCount(env.handle.db, { stockItemId: b.stockItemId }) };
    const settled = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        applyMaterialStock(env.ctx(OWNER), {
          operationId: uuid(),
          operation: "count",
          lines:
            i % 2 === 0
              ? [{ materialId: a.id, quantity: 10 }, { materialId: b.id, quantity: 20 }]
              : [{ materialId: b.id, quantity: 20 }, { materialId: a.id, quantity: 10 }],
        }),
      ),
    );
    expect(rejectedCodes(settled)).toEqual([]);
    const results = fulfilled(settled);
    // Лише перша (за блокуванням) інвентаризація змінює залишок; решта бачать уже підраховане значення.
    expect(results.reduce((s, r) => s + r.applied, 0)).toBe(2);
    expect(results.reduce((s, r) => s + r.unchanged, 0)).toBe(14);
    expect((await balance(env.handle.db, a.stockItemId)).onHand).toBe(10);
    expect((await balance(env.handle.db, b.stockItemId)).onHand).toBe(20);
    expect(await movementCount(env.handle.db, { stockItemId: a.stockItemId })).toBe(before.a + 1);
    expect(await movementCount(env.handle.db, { stockItemId: b.stockItemId })).toBe(before.b + 1);
  });

  it("parallel bulk activation/deactivation with overlapping sets and stock changes does not deadlock", async () => {
    const a = await freshMaterial("par_active_a", 2);
    const b = await freshMaterial("par_active_b", 2);
    const settled = await Promise.allSettled([
      setMaterialsActive(env.ctx(OWNER), [a.id, b.id], false),
      setMaterialsActive(env.ctx(OWNER), [b.id, a.id], false),
      applyMaterialStock(env.ctx(OWNER), { operationId: uuid(), operation: "adjust", lines: [{ materialId: b.id, quantity: 1 }, { materialId: a.id, quantity: 1 }] }),
      setMaterialThreshold(env.ctx(OWNER), a.id, 1),
    ]);
    expect(rejectedCodes(settled)).toEqual([]);
    const deactivated = settled.slice(0, 2).map((r) => (r as PromiseFulfilledResult<{ updated: number }>).value.updated);
    expect(deactivated.reduce((s, n) => s + n, 0)).toBe(2);
    const openAlerts = await env.handle.db
      .select()
      .from(stockAlerts)
      .where(and(eq(stockAlerts.status, "open")));
    expect(openAlerts.some((x) => x.stockItemId === a.stockItemId || x.stockItemId === b.stockItemId)).toBe(false);
  });
});
