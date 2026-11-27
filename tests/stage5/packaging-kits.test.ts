import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { inventoryMovements, kitTemplateLines, kitTemplates, orderLineItems, orderPacking, packagingMaterials, products, stockAlerts, stockItems } from "~/db/schema";
import { ForbiddenError } from "~/domain/permissions";
import { ConflictError } from "~/lib/errors";
import { consumeMaterialsForPacking, planPackingMaterials } from "~/modules/packaging/consumption.server";
import {
  createKitTemplate,
  deleteKitTemplate,
  getKitTemplate,
  listKitProductOptions,
  listKitTemplates,
  resolveKitMaterials,
  setKitTemplatesActive,
  updateKitTemplate,
} from "~/modules/packaging/kits.server";
import { applyMaterialStock, createMaterial, setMaterialsActive } from "~/modules/packaging/materials.server";
import { findOrderIdByNumber, previewOrderPacking } from "~/modules/packaging/preview.server";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";
import { ACTOR, balance, movementCount } from "./helpers";

/** Шаблони комплектації, розрахунок матеріалів замовлення й ідемпотентне списання при пакуванні. */
let env: TestEnv;
const ids: Record<string, string> = {};
beforeAll(async () => {
  env = await createTestEnv();
  for (const m of await env.handle.db.select().from(packagingMaterials)) ids[m.code] = m.id;
});
afterAll(async () => {
  await env.close();
});

const uuid = () => globalThis.crypto.randomUUID();
async function stockOf(code: string) {
  const [si] = await env.handle.db.select().from(stockItems).where(eq(stockItems.materialId, ids[code]!));
  return (await balance(env.handle.db, si!.id)).onHand;
}
async function productId(handle: string) {
  const [p] = await env.handle.db.select({ id: products.id }).from(products).where(eq(products.handle, handle));
  return p!.id;
}
const sortByCode = <T extends { code: string }>(rows: T[]) => [...rows].sort((a, b) => a.code.localeCompare(b.code));

describe("resolveKitMaterials (demo templates)", () => {
  it("combines the general template with the fender template (per item × effective quantity)", async () => {
    const order = await env.orderId("#1012"); // крило Model X + тримач
    const kit = await resolveKitMaterials(env.handle.db, order);
    expect(sortByCode(kit).map((k) => [k.code, k.quantity, k.templateIds.length])).toEqual([
      ["bolts_m5", 1, 1],
      ["card_thanks", 1, 1],
      ["instruction_fender", 1, 1],
      ["sticker_logo", 1, 1],
    ]);
    // Пріоритет: шаблон крила (10) — першим.
    expect(kit.slice(0, 2).map((k) => k.code).sort()).toEqual(["bolts_m5", "instruction_fender"]);
    // Без крила — лише загальний шаблон.
    const plain = await resolveKitMaterials(env.handle.db, await env.orderId("#1001"));
    expect(sortByCode(plain).map((k) => [k.code, k.quantity])).toEqual([
      ["card_thanks", 1],
      ["sticker_logo", 1],
    ]);
  });

  it("per item follows Shopify currentQuantity (returned/removed units are not packed)", async () => {
    const order = await env.orderId("#1002"); // крило Model X × 1
    const [line] = await env.handle.db.select().from(orderLineItems).where(eq(orderLineItems.orderId, order));
    await env.handle.db.update(orderLineItems).set({ quantity: 4, currentQuantity: 3 }).where(eq(orderLineItems.id, line!.id));
    const kit = await resolveKitMaterials(env.handle.db, order);
    expect(kit.find((k) => k.code === "bolts_m5")?.quantity).toBe(3);
    await env.handle.db.update(orderLineItems).set({ currentQuantity: 0 }).where(eq(orderLineItems.id, line!.id));
    expect(await resolveKitMaterials(env.handle.db, order)).toEqual([]);
    await env.handle.db.update(orderLineItems).set({ quantity: 1, currentQuantity: null }).where(eq(orderLineItems.id, line!.id));
  });
});

describe("kit template management", () => {
  it("owner creates, edits (lines + products replaced), disables and deletes templates; staff cannot", async () => {
    const product = await productId("rear-fender");
    const input = {
      name: "  Сумка: наповнювач  ",
      appliesTo: "products" as const,
      priority: "5",
      active: true,
      lines: [{ materialId: ids.tape!, quantity: "2", per: "item" as const }],
      productIds: [product],
    };
    await expect(createKitTemplate(env.ctx(STAFF), input)).rejects.toBeInstanceOf(ForbiddenError);
    const { id } = await createKitTemplate(env.ctx(OWNER), input);
    const created = await getKitTemplate(env.handle.db, id);
    expect(created).toMatchObject({ name: "Сумка: наповнювач", appliesTo: "products", priority: 5, active: true });
    expect(created.lines.map((l) => [l.materialCode, l.quantity, l.per])).toEqual([["tape", 2, "item"]]);
    expect(created.products.map((p) => p.id)).toEqual([product]);

    await updateKitTemplate(
      env.ctx(OWNER),
      id,
      { ...input, appliesTo: "all", lines: [{ materialId: ids.card_thanks!, quantity: 1, per: "order" }, { materialId: ids.tape!, quantity: 1, per: "order" }] },
      { expectedVersion: created.version },
    );
    const updated = await getKitTemplate(env.handle.db, id);
    expect(updated.appliesTo).toBe("all");
    expect(updated.products).toEqual([]); // для «усіх замовлень» товари не зберігаються
    expect(updated.lines.map((l) => l.materialCode).sort()).toEqual(["card_thanks", "tape"]);
    await expect(updateKitTemplate(env.ctx(OWNER), id, input, { expectedVersion: created.version })).rejects.toBeInstanceOf(ConflictError);
    await expect(updateKitTemplate(env.ctx(STAFF), id, input)).rejects.toBeInstanceOf(ForbiddenError);

    // Новий шаблон «усі» додає листівку до кожного замовлення разом із загальним.
    const plain = await resolveKitMaterials(env.handle.db, await env.orderId("#1001"));
    expect(plain.find((k) => k.code === "card_thanks")).toMatchObject({ quantity: 2, templateIds: expect.arrayContaining([id]) });

    expect((await setKitTemplatesActive(env.ctx(OWNER), [id], false)).updated).toBe(1);
    expect((await resolveKitMaterials(env.handle.db, await env.orderId("#1001"))).find((k) => k.code === "card_thanks")?.quantity).toBe(1);
    await expect(setKitTemplatesActive(env.ctx(STAFF), [id], true)).rejects.toBeInstanceOf(ForbiddenError);

    await expect(deleteKitTemplate(env.ctx(STAFF), id)).rejects.toBeInstanceOf(ForbiddenError);
    await deleteKitTemplate(env.ctx(OWNER), id);
    expect(await env.handle.db.select().from(kitTemplates).where(eq(kitTemplates.id, id))).toEqual([]);
    expect(await env.handle.db.select().from(kitTemplateLines).where(eq(kitTemplateLines.templateId, id))).toEqual([]);
    await expect(deleteKitTemplate(env.ctx(OWNER), id)).rejects.toMatchObject({ code: "error.notFound" });
  });

  it("rejects unknown materials/products and invalid templates", async () => {
    const base = { name: "X", appliesTo: "all" as const, lines: [{ materialId: uuid(), quantity: 1, per: "order" as const }] };
    await expect(createKitTemplate(env.ctx(OWNER), base)).rejects.toMatchObject({ code: "error.notFound" });
    await expect(
      createKitTemplate(env.ctx(OWNER), { ...base, appliesTo: "products", lines: [{ materialId: ids.tape!, quantity: 1, per: "order" }], productIds: [uuid()] }),
    ).rejects.toMatchObject({ code: "error.notFound" });
    await expect(createKitTemplate(env.ctx(OWNER), { ...base, lines: [] })).rejects.toMatchObject({ name: "ZodError" });
    // Жодного частково створеного шаблону.
    expect((await listKitTemplates(env.handle.db)).map((t) => t.name)).not.toContain("X");
  });

  it("product options include models, colours and SKUs for filtering", async () => {
    const options = await listKitProductOptions(env.handle.db);
    const fender = options.find((o) => o.models.includes("Model X"));
    expect(fender).toMatchObject({ models: ["Model S", "Model X"], skus: ["OT-FK-S", "OT-FK-X"] });
    expect(options.some((o) => o.colors.includes("Чорний"))).toBe(true);
  });
});

describe("order preview", () => {
  it("finds orders by number with or without # and previews kit + box", async () => {
    expect(await findOrderIdByNumber(env.handle.db, "1012")).toMatchObject({ orderNumber: "#1012" });
    expect(await findOrderIdByNumber(env.handle.db, "#1012")).toMatchObject({ orderNumber: "#1012" });
    expect(await findOrderIdByNumber(env.handle.db, "9999")).toBeNull();
    const id = (await findOrderIdByNumber(env.handle.db, "1012"))!.id;
    const preview = await previewOrderPacking(env.handle.db, id);
    expect(preview.materials.length).toBe(4);
    expect(preview.materials.find((m) => m.code === "bolts_m5")?.templateNames).toEqual(["Крило: болти та інструкція"]);
    // Демо-товари без габаритів → підбір лише за вагою (позначено).
    expect(preview.boxReason).toBe("weight_only");
    expect(preview.goods).toMatchObject({ units: 2, measuredUnits: 0, weightGrams: 470 });
  });
});

describe("consumeMaterialsForPacking", () => {
  async function newPacking(orderNumber: string) {
    const orderId = await env.orderId(orderNumber);
    await env.handle.db.update(orderPacking).set({ status: "cancelled" }).where(eq(orderPacking.orderId, orderId));
    const gens = await env.handle.db.select({ g: orderPacking.generation }).from(orderPacking).where(eq(orderPacking.orderId, orderId));
    const [row] = await env.handle.db
      .insert(orderPacking)
      .values({ orderId, status: "in_progress", generation: Math.max(0, ...gens.map((x) => x.g)) + 1 })
      .returning({ id: orderPacking.id });
    return { orderId, packingId: row!.id };
  }

  it("consumes the box and kit materials once per packing (repeat → alreadyConsumed, no new movements)", async () => {
    const { orderId, packingId } = await newPacking("#1012");
    const before = { box: await stockOf("box_m"), bolts: await stockOf("bolts_m5"), sticker: await stockOf("sticker_logo"), card: await stockOf("card_thanks") };
    const plan = await planPackingMaterials(env.handle.db, orderId, ids.box_m!);
    expect(plan[0]).toMatchObject({ code: "box_m", isBox: true, required: 1, onHand: before.box });
    const r1 = await env.handle.db.transaction((tx) => consumeMaterialsForPacking(tx, ACTOR, { packingId, orderId, boxMaterialId: ids.box_m! }));
    expect(r1.alreadyConsumed).toBe(false);
    expect(r1.applied).toHaveLength(5);
    expect(r1.totalShortage).toBe(0);
    expect(sortByCode(r1.lines).map((l) => [l.code, l.consumed, l.status])).toEqual([
      ["bolts_m5", 1, "applied"],
      ["box_m", 1, "applied"],
      ["card_thanks", 1, "applied"],
      ["instruction_fender", 1, "applied"],
      ["sticker_logo", 1, "applied"],
    ]);
    expect({ box: await stockOf("box_m"), bolts: await stockOf("bolts_m5"), sticker: await stockOf("sticker_logo"), card: await stockOf("card_thanks") }).toEqual({
      box: before.box - 1,
      bolts: before.bolts - 1,
      sticker: before.sticker - 1,
      card: before.card - 1,
    });
    const moves = await env.handle.db.select().from(inventoryMovements).where(eq(inventoryMovements.packingId, packingId));
    expect(moves.every((m) => m.type === "material_consume" && m.orderId === orderId && m.onHandDelta === -1)).toBe(true);
    expect(moves.map((m) => m.idempotencyKey).sort()).toEqual(
      ["bolts_m5", "box_m", "card_thanks", "instruction_fender", "sticker_logo"].map((code) => `material:${packingId}:${ids[code]}`).sort(),
    );

    const count = await movementCount(env.handle.db);
    const r2 = await env.handle.db.transaction((tx) => consumeMaterialsForPacking(tx, ACTOR, { packingId, orderId, boxMaterialId: ids.box_m! }));
    expect(r2.alreadyConsumed).toBe(true);
    expect(r2.applied).toEqual([]);
    expect(r2.lines.every((l) => l.status === "duplicate" && l.consumed === 0)).toBe(true);
    expect(await movementCount(env.handle.db)).toBe(count);
    expect(await stockOf("box_m")).toBe(before.box - 1);
  });

  it("without a box only kit materials are consumed; an order without matching templates consumes nothing", async () => {
    const { orderId, packingId } = await newPacking("#1001");
    const r = await env.handle.db.transaction((tx) => consumeMaterialsForPacking(tx, ACTOR, { packingId, orderId, boxMaterialId: null }));
    expect(sortByCode(r.lines).map((l) => l.code)).toEqual(["card_thanks", "sticker_logo"]);
    await env.handle.db.update(kitTemplates).set({ active: false });
    const other = await newPacking("#1003");
    const none = await env.handle.db.transaction((tx) => consumeMaterialsForPacking(tx, ACTOR, { packingId: other.packingId, orderId: other.orderId, boxMaterialId: null }));
    expect(none).toEqual({ alreadyConsumed: false, lines: [], applied: [], totalShortage: 0 });
    await env.handle.db.update(kitTemplates).set({ active: true });
  });

  it("shortage: strict by default (nothing written, caller transaction usable); allowShortage consumes what is there", async () => {
    // Списати всі коробки L.
    const left = await stockOf("box_l");
    if (left > 0) await applyMaterialStock(env.ctx(OWNER), { operationId: uuid(), operation: "writeoff", lines: [{ materialId: ids.box_l!, quantity: left }] });
    const { orderId, packingId } = await newPacking("#1007");
    const count = await movementCount(env.handle.db);
    const sticker = await stockOf("sticker_logo");
    const strict = await env.handle.db.transaction(async (tx) => {
      const err = await consumeMaterialsForPacking(tx, ACTOR, { packingId, orderId, boxMaterialId: ids.box_l! }).catch((e: unknown) => e);
      // Транзакція викликача придатна.
      const [row] = await tx.select({ id: orderPacking.id }).from(orderPacking).where(and(eq(orderPacking.id, packingId)));
      return { err, row };
    });
    expect(strict.err).toMatchObject({ code: "packaging.error.consumeInsufficient", params: { code: "box_l", current: 0, required: 1 } });
    expect(strict.row?.id).toBe(packingId);
    expect(await movementCount(env.handle.db)).toBe(count);

    const lenient = await env.handle.db.transaction((tx) =>
      consumeMaterialsForPacking(tx, ACTOR, { packingId, orderId, boxMaterialId: ids.box_l! }, { allowShortage: true }),
    );
    expect(lenient.totalShortage).toBe(1);
    expect(lenient.lines.find((l) => l.code === "box_l")).toMatchObject({ consumed: 0, shortage: 1, status: "shortage", onHandBefore: 0 });
    expect(lenient.lines.find((l) => l.code === "sticker_logo")).toMatchObject({ consumed: 1, status: "applied" });
    expect(await stockOf("box_l")).toBe(0);
    expect(await stockOf("sticker_logo")).toBe(sticker - 1);
  });

  it("parallel repeats of the same confirmation consume once; the others report alreadyConsumed (no false shortage)", async () => {
    // Регресія: перевірка повтору йшла до блокувань → паралельні повтори падали з consumeInsufficient.
    // На справжньому PostgreSQL (TEST_DATABASE_URL) транзакції йдуть паралельно; PGlite їх серіалізує.
    await applyMaterialStock(env.ctx(OWNER), { operationId: uuid(), operation: "count", lines: [{ materialId: ids.box_m!, quantity: 1 }] });
    const { orderId, packingId } = await newPacking("#1001");
    const plan = await planPackingMaterials(env.handle.db, orderId, ids.box_m!);
    const sticker = await stockOf("sticker_logo");
    const settled = await Promise.allSettled(
      Array.from({ length: 6 }, () => env.handle.db.transaction((tx) => consumeMaterialsForPacking(tx, ACTOR, { packingId, orderId, boxMaterialId: ids.box_m! }))),
    );
    const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected.map((r) => String((r.reason as { code?: string })?.code ?? r.reason))).toEqual([]);
    const results = settled.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof consumeMaterialsForPacking>>>).value);
    expect(results.filter((r) => !r.alreadyConsumed)).toHaveLength(1);
    expect(results.filter((r) => r.alreadyConsumed)).toHaveLength(5);
    expect(results.find((r) => !r.alreadyConsumed)!.applied).toHaveLength(plan.length);
    expect(await stockOf("box_m")).toBe(0);
    expect(await stockOf("sticker_logo")).toBe(sticker - 1);
    const moves = await env.handle.db.select().from(inventoryMovements).where(eq(inventoryMovements.packingId, packingId));
    expect(moves).toHaveLength(plan.length);
    await applyMaterialStock(env.ctx(OWNER), { operationId: uuid(), operation: "count", lines: [{ materialId: ids.box_m!, quantity: 25 }] });
  });

  it("the packing must exist and belong to the order (nothing is written otherwise)", async () => {
    const { orderId, packingId } = await newPacking("#1001");
    const other = await env.orderId("#1012");
    const count = await movementCount(env.handle.db);
    const run = (input: { packingId: string; orderId: string }) =>
      env.handle.db.transaction((tx) => consumeMaterialsForPacking(tx, ACTOR, { ...input, boxMaterialId: ids.box_m! })).catch((e: unknown) => e);
    expect(await run({ packingId, orderId: other })).toMatchObject({ code: "packaging.error.packingOrderMismatch" });
    expect(await run({ packingId: uuid(), orderId })).toMatchObject({ code: "error.notFound", params: { entity: "packing" } });
    expect(await run({ packingId: "not-a-uuid", orderId })).toMatchObject({ code: "error.notFound" });
    expect(await movementCount(env.handle.db)).toBe(count);
    // Верхній регістр id замовлення — те саме замовлення.
    const ok = await env.handle.db.transaction((tx) => consumeMaterialsForPacking(tx, ACTOR, { packingId, orderId: orderId.toUpperCase(), boxMaterialId: null }));
    expect(ok.alreadyConsumed).toBe(false);
  });

  it("an inactive (manually chosen) box is consumed without opening stock alerts for it", async () => {
    const { id: oldBox } = await createMaterial(env.ctx(OWNER), { code: "box_retired", name: "Стара коробка", kind: "box", unit: "pcs", active: true });
    await applyMaterialStock(env.ctx(OWNER), { operationId: uuid(), operation: "receive", lines: [{ materialId: oldBox, quantity: 1 }] });
    const [si] = await env.handle.db.select().from(stockItems).where(eq(stockItems.materialId, oldBox));
    const openAlerts = async () =>
      (await env.handle.db.select().from(stockAlerts).where(and(eq(stockAlerts.stockItemId, si!.id), eq(stockAlerts.status, "open")))).map((a) => a.kind);
    expect(await openAlerts()).toEqual(["low_stock"]);
    await setMaterialsActive(env.ctx(OWNER), [oldBox], false);
    expect(await openAlerts()).toEqual([]);
    const { orderId, packingId } = await newPacking("#1001");
    const r = await env.handle.db.transaction((tx) => consumeMaterialsForPacking(tx, ACTOR, { packingId, orderId, boxMaterialId: oldBox }));
    expect(r.lines.find((l) => l.isBox)).toMatchObject({ code: "box_retired", consumed: 1, status: "applied" });
    expect((await balance(env.handle.db, si!.id)).onHand).toBe(0);
    expect(await openAlerts()).toEqual([]);
  });
});
