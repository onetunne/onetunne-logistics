/**
 * Сховище «віддаленої сторони» тестового перевізника (sandbox).
 *
 * Імітує базу перевізника: дозволяє перевірити звірку після збою (пошук за reference)
 * і ідемпотентність на боці перевізника (повторне створення з тим самим reference
 * повертає вже створене відправлення).
 *
 * Payload МІНІМІЗОВАНИЙ: жодних імен, телефонів чи адрес — лише технічні дані.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { sandboxCarrierShipments } from "~/db/schema";

/** Мінімізовані дані запиту, які «зберігає» тестовий перевізник (без персональних даних). */
export interface SandboxPayload {
  orderNumber: string;
  parcelCount: number;
  /** Загальна кількість одиниць товару (сума quantity митних позицій). */
  itemCount: number;
  /** Сума оплачуваної ваги всіх місць, г. */
  chargeableWeightGrams: number;
  destinationCountry: string;
}

export interface SandboxRecord {
  id: string;
  reference: string;
  waybillNumber: string;
  cancelled: boolean;
  createdAt: Date;
}

export interface SandboxInsert {
  reference: string;
  waybillNumber: string;
  payload: SandboxPayload;
}

/** Номер накладної вже зайнятий відправленням з ІНШИМ reference. */
export class SandboxWaybillConflictError extends Error {
  constructor(readonly waybillNumber: string) {
    super(`Sandbox waybill number already in use: ${waybillNumber}`);
    this.name = "SandboxWaybillConflictError";
  }
}

export interface SandboxStore {
  findByReference(reference: string): Promise<SandboxRecord | null>;
  findByWaybill(waybillNumber: string): Promise<SandboxRecord | null>;
  /**
   * Ідемпотентна вставка: якщо reference вже існує — повертає наявний запис з inserted=false.
   * Безпечна для конкурентних викликів. Якщо waybillNumber зайнятий іншим reference —
   * кидає SandboxWaybillConflictError (адаптер підбирає наступний номер).
   */
  insert(rec: SandboxInsert): Promise<{ record: SandboxRecord; inserted: boolean }>;
  /** true — запис існує і тепер скасований (ідемпотентно); false — накладну не знайдено. */
  markCancelled(waybillNumber: string): Promise<boolean>;
}

type SandboxRow = typeof sandboxCarrierShipments.$inferSelect;

function toRecord(row: SandboxRow): SandboxRecord {
  return {
    id: row.id,
    reference: row.reference,
    waybillNumber: row.waybillNumber,
    cancelled: row.cancelled,
    createdAt: row.createdAt,
  };
}

/** Реалізація на PostgreSQL / PGlite (таблиця sandbox_carrier_shipments). */
export class DbSandboxStore implements SandboxStore {
  constructor(private readonly db: DbOrTx) {}

  async findByReference(reference: string): Promise<SandboxRecord | null> {
    const rows = await this.db
      .select()
      .from(sandboxCarrierShipments)
      .where(eq(sandboxCarrierShipments.reference, reference))
      .limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async findByWaybill(waybillNumber: string): Promise<SandboxRecord | null> {
    const rows = await this.db
      .select()
      .from(sandboxCarrierShipments)
      .where(eq(sandboxCarrierShipments.waybillNumber, waybillNumber))
      .limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async insert(rec: SandboxInsert): Promise<{ record: SandboxRecord; inserted: boolean }> {
    // INSERT ... ON CONFLICT DO NOTHING без цільового індексу: арбітрами є ОБИДВА унікальні
    // обмеження (reference і waybill_number). Так конкурентна вставка того самого reference
    // (з тим самим похідним номером) не дає помилки unique violation по waybill_number
    // і не перериває зовнішню транзакцію (DbOrTx). Далі — select за reference.
    const inserted = await this.db
      .insert(sandboxCarrierShipments)
      .values({ reference: rec.reference, waybillNumber: rec.waybillNumber, payload: rec.payload })
      .onConflictDoNothing()
      .returning();
    const row = inserted[0];
    if (row) return { record: toRecord(row), inserted: true };

    const existing = await this.findByReference(rec.reference);
    if (existing) return { record: existing, inserted: false };
    // Конфлікт не по reference → номер накладної зайнятий іншим відправленням.
    throw new SandboxWaybillConflictError(rec.waybillNumber);
  }

  async markCancelled(waybillNumber: string): Promise<boolean> {
    const rows = await this.db
      .update(sandboxCarrierShipments)
      .set({ cancelled: true })
      .where(eq(sandboxCarrierShipments.waybillNumber, waybillNumber))
      .returning({ id: sandboxCarrierShipments.id });
    return rows.length > 0;
  }
}

interface MemoryRow extends SandboxRecord {
  payload: SandboxPayload;
}

/** Реалізація в пам'яті — для unit-тестів. Операції синхронні всередині, тому атомарні. */
export class MemorySandboxStore implements SandboxStore {
  private readonly byReference = new Map<string, MemoryRow>();
  private readonly referenceByWaybill = new Map<string, string>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** Кількість збережених записів (для тестів). */
  get size(): number {
    return this.byReference.size;
  }

  /** Збережений payload (для перевірки мінімізації в тестах). */
  payloadOf(reference: string): SandboxPayload | undefined {
    const row = this.byReference.get(reference);
    return row ? { ...row.payload } : undefined;
  }

  async findByReference(reference: string): Promise<SandboxRecord | null> {
    const row = this.byReference.get(reference);
    return row ? copyRecord(row) : null;
  }

  async findByWaybill(waybillNumber: string): Promise<SandboxRecord | null> {
    const reference = this.referenceByWaybill.get(waybillNumber);
    return reference === undefined ? null : this.findByReference(reference);
  }

  async insert(rec: SandboxInsert): Promise<{ record: SandboxRecord; inserted: boolean }> {
    const existing = this.byReference.get(rec.reference);
    if (existing) return { record: copyRecord(existing), inserted: false };
    if (this.referenceByWaybill.has(rec.waybillNumber)) throw new SandboxWaybillConflictError(rec.waybillNumber);

    const row: MemoryRow = {
      id: randomUUID(),
      reference: rec.reference,
      waybillNumber: rec.waybillNumber,
      cancelled: false,
      createdAt: this.now(),
      payload: { ...rec.payload },
    };
    this.byReference.set(row.reference, row);
    this.referenceByWaybill.set(row.waybillNumber, row.reference);
    return { record: copyRecord(row), inserted: true };
  }

  async markCancelled(waybillNumber: string): Promise<boolean> {
    const reference = this.referenceByWaybill.get(waybillNumber);
    const row = reference === undefined ? undefined : this.byReference.get(reference);
    if (!row) return false;
    row.cancelled = true;
    return true;
  }
}

function copyRecord(row: SandboxRecord): SandboxRecord {
  return {
    id: row.id,
    reference: row.reference,
    waybillNumber: row.waybillNumber,
    cancelled: row.cancelled,
    createdAt: new Date(row.createdAt.getTime()),
  };
}
