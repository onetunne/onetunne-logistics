import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { inventoryMovements, packagingMaterials, productionBatchLines, productionBatches, productionReceipts } from "~/db/schema";
import { inventoryKeys } from "~/modules/inventory/keys";
import { applyMovements, ensureStockItemForVariant } from "~/modules/inventory/ledger.server";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import { applyMaterialStock } from "~/modules/packaging/materials.server";
import { createBatch, receiveProduction, startProduction } from "~/modules/production/batches.server";
import { kyivDate } from "~/modules/production/calc";
import { getBatchDetail } from "~/modules/production/queries.server";
import { maskFreeTextNote } from "~/modules/privacy/notes";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";
import { insertProduct } from "./helpers";

/**
 * Персональні дані у вільному тексті приміток (security-2): примітки рухів (будь-який викликач applyMovements —
 * склад, матеріали, причини браку з виробництва) і примітки надходжень з виробництва зберігаються замаскованими.
 * Дані вигадані. PGlite або TEST_DATABASE_URL.
 */
const PHONE = "+380 67 000 00 00";
const EMAIL = "someone@example.com";

let env: TestEnv;
let variantId: string;
const uuid = () => globalThis.crypto.randomUUID();

beforeAll(async () => {
  env = await createTestEnv();
  const p = await insertProduct(env.handle.db, "Тест маскування", [{ sku: "MASK-1", color: "Чорний" }]);
  variantId = p.variantIds[0]!;
});

afterAll(async () => {
  await env.close();
});

const movementNotes = async (where: ReturnType<typeof eq>) =>
  (await env.handle.db.select({ note: inventoryMovements.note }).from(inventoryMovements).where(where)).map((r) => r.note);

describe("maskFreeTextNote", () => {
  it("masks phones, emails, cards and IBANs; normalizes whitespace; idempotent; empty → null", () => {
    const masked = maskFreeTextNote(`  supplier ${PHONE}\n ${EMAIL}  `);
    expect(masked).toBe("supplier [phone] [email]");
    expect(maskFreeTextNote(masked)).toBe(masked);
    expect(maskFreeTextNote("картка 4111 1111 1111 1111")).toBe("картка [card]");
    expect(maskFreeTextNote("   ")).toBeNull();
    expect(maskFreeTextNote(null)).toBeNull();
    expect(maskFreeTextNote("Накладна виробника 17")).toBe("Накладна виробника 17");
    expect(maskFreeTextNote("x".repeat(600))).toHaveLength(500);
  });

  it("masks BEFORE truncating: PII crossing the length limit is never left half-visible (N1)", () => {
    // Сценарій з перевірки: 488 «x» + email → раніше зберігалося «… ivan.petren»; 490 «x» + телефон → «+380 67 1».
    expect(maskFreeTextNote(`${"x".repeat(488)} ivan.petrenko@example.com`)).toBe(`${"x".repeat(488)} [email]`);
    expect(maskFreeTextNote(`${"x".repeat(490)} +380 67 123 45 67`)).toBe(`${"x".repeat(490)} [phone]`);
    // Будь-яке зміщення біля межі: лишається наповнювач і, можливо, обрізаний заповнювач («[ema»), але не дані.
    const pii = ["ivan.petrenko@example.com", "+380 67 123 45 67", "067 - 123 - 45 - 67", "4111 1111 1111 1111", "DE89 3704 0044 0532 0130 00"];
    for (const value of pii) {
      for (let k = 470; k < 500; k++) {
        const out = maskFreeTextNote(`${"y".repeat(k)} ${value}`, 500)!;
        expect(out.length, `${value} @${k}`).toBeLessThanOrEqual(500);
        expect(out, `${value} @${k}`).toMatch(/^y+(?: \[[a-z]*\]?)?$/);
      }
    }
    // Ідемпотентно й на межі (обрізаний заповнювач не змінюється вдруге).
    const cut = maskFreeTextNote(`${"y".repeat(495)} ivan.petrenko@example.com`);
    expect(cut).toBe(`${"y".repeat(495)} [ema`);
    expect(maskFreeTextNote(cut)).toBe(cut);
    // Дуже довгий текст: маскується лише потрібне вікно, результат — у межах maxLength.
    expect(maskFreeTextNote(`${"a".repeat(200_000)}@`, 500)).toBe("a".repeat(500));
  });

  it("masks phones written with spaced hyphens or Unicode dashes; a phone glued to another number is not left open (N5)", () => {
    for (const phone of ["067 - 123 - 45 - 67", "067–123–45–67", "067 — 123 — 45 — 67", "067 − 123 − 45 − 67", "+38 067 ‑ 123 ‑ 45 ‑ 67"]) {
      expect(maskFreeTextNote(`note ${phone} end`), phone).toBe("note [phone] end");
    }
    // Телефон через « - » поруч із номером документа зливається в одну групу 16+ цифр — теж приховано.
    expect(maskFreeTextNote("Тел. 067-123-45-67 - 12345678")).toBe("Тел. [number]");
    // Дати, час і короткі діапазони з рисками лишаються читабельними.
    for (const text of ["27.11.2026 – 28.11.2026", "2026-11-27 - 2026-12-01", "10:30 – 12:00", "5 - 10 шт", "100 – 200 грн", "Накладна 17 — 3 шт"]) {
      expect(maskFreeTextNote(text), text).toBe(text);
    }
  });
});

describe("notes are masked once in the ledger and on production receipts", () => {
  it("applyMovements masks any caller's note", async () => {
    const stockItemId = await ensureStockItemForVariant(env.handle.db, variantId);
    const warehouse = await getDefaultWarehouse(env.handle.db);
    const key = inventoryKeys.manual(uuid());
    await env.handle.db.transaction((tx) =>
      applyMovements(tx, STAFF, [
        { warehouseId: warehouse.id, stockItemId, type: "receipt_manual", idempotencyKey: key, onHandDelta: 1, reason: "other", note: `call ${PHONE}` },
      ]),
    );
    expect(await movementNotes(eq(inventoryMovements.idempotencyKey, key))).toEqual(["call [phone]"]);
  });

  it("material stock notes are masked", async () => {
    const [m] = await env.handle.db.select().from(packagingMaterials).limit(1);
    const operationId = uuid();
    await applyMaterialStock(env.ctx(STAFF), {
      operationId,
      operation: "receive",
      lines: [{ materialId: m!.id, quantity: 5 }],
      note: `supplier ${PHONE} ${EMAIL}`,
    });
    expect(await movementNotes(eq(inventoryMovements.idempotencyKey, `manual:${operationId}:${m!.id}`))).toEqual(["supplier [phone] [email]"]);
  });

  it("production receipt note and defect reasons are masked (also on the batch page)", async () => {
    const { batchId } = await createBatch(env.ctx(OWNER), {
      title: "Маскування",
      plannedReadyDate: "2030-01-15",
      manufacturer: null,
      notes: null,
      lines: [{ variantId, quantity: 5 }],
    });
    const [b] = await env.handle.db.select().from(productionBatches).where(eq(productionBatches.id, batchId));
    await startProduction(env.ctx(OWNER), batchId, b!.version);
    const [line] = await env.handle.db.select().from(productionBatchLines).where(eq(productionBatchLines.batchId, batchId));
    const lineId = line!.id;
    const r = await receiveProduction(env.ctx(STAFF), batchId, {
      idempotencyKey: uuid(),
      lines: [{ batchLineId: lineId, good: 1, defective: 1, defectReason: `customer ${PHONE}` }],
      note: `driver ${EMAIL}`,
    });
    const [receipt] = await env.handle.db.select().from(productionReceipts).where(eq(productionReceipts.id, r.receiptId));
    expect(receipt!.note).toBe("driver [email]");
    expect(await movementNotes(eq(inventoryMovements.productionBatchId, batchId))).toContain("customer [phone]");
    const after = JSON.stringify(await getBatchDetail(env.handle.db, batchId, { today: kyivDate(new Date()) }));
    expect(after).not.toContain(EMAIL);
    expect(after).not.toContain("000 00 00");
  });
});
