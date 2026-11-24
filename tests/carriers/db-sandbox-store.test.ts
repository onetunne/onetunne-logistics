import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { openPglite, type DatabaseHandle } from "~/db/client.server";
import { sandboxCarrierShipments } from "~/db/schema";
import {
  DbSandboxStore,
  SandboxWaybillConflictError,
  TestCarrierAdapter,
  deriveTestWaybillNumber,
  type CreateShipmentRequest,
  type SandboxPayload,
} from "~/integrations/carriers";

const payload: SandboxPayload = {
  orderNumber: "#DEMO-2001",
  parcelCount: 1,
  itemCount: 3,
  chargeableWeightGrams: 1200,
  destinationCountry: "DE",
};

// Вигадані дані.
function makeRequest(reference: string): CreateShipmentRequest {
  return {
    reference,
    orderNumber: "#DEMO-2002",
    sender: {
      name: "Demo Sender",
      company: null,
      phone: "+15555550199",
      email: null,
      address: { countryCode: "UA", city: "Sampleville", postalCode: null, province: null, address1: "1 Example St", address2: null },
    },
    recipient: {
      name: "Test Recipient",
      company: null,
      phone: "+15555550100",
      email: null,
      address: { countryCode: "DE", city: "Testburg", postalCode: "00000", province: null, address1: "2 Fictional Way", address2: null },
    },
    parcels: [
      {
        packageCode: "box_l",
        lengthCm: 40,
        widthCm: 30,
        heightCm: 20,
        actualWeightGrams: 1000,
        volumetricWeightGrams: 4800,
        chargeableWeightGrams: 4800,
      },
    ],
    customsItems: [
      {
        sku: null,
        description: "Ceramic mug",
        hsCode: "691200",
        countryOfOrigin: "UA",
        quantity: 1,
        unitValue: { amount: "12.00", currency: "EUR" },
        weightGrams: 350,
      },
    ],
    declaredValue: { amount: "12.00", currency: "EUR" },
  };
}

describe("DbSandboxStore (PGlite)", () => {
  let handle: DatabaseHandle;
  let store: DbSandboxStore;

  beforeAll(async () => {
    handle = await openPglite();
    store = new DbSandboxStore(handle.db);
  });

  afterAll(async () => {
    await handle?.close();
  });

  beforeEach(async () => {
    await handle.db.delete(sandboxCarrierShipments);
  });

  const countByReference = async (reference: string) => {
    const rows = await handle.db
      .select({ n: sql<number>`count(*)::int` })
      .from(sandboxCarrierShipments)
      .where(eq(sandboxCarrierShipments.reference, reference));
    return rows[0]?.n ?? 0;
  };

  it("inserts and finds by reference / waybill", async () => {
    const { record, inserted } = await store.insert({ reference: "ref-a", waybillNumber: "TEST0000000001", payload });
    expect(inserted).toBe(true);
    expect(record).toMatchObject({ reference: "ref-a", waybillNumber: "TEST0000000001", cancelled: false });
    expect(record.createdAt).toBeInstanceOf(Date);
    expect(record.id).toMatch(/^[0-9a-f-]{36}$/);

    await expect(store.findByReference("ref-a")).resolves.toEqual(record);
    await expect(store.findByWaybill("TEST0000000001")).resolves.toEqual(record);
    await expect(store.findByReference("missing")).resolves.toBeNull();
    await expect(store.findByWaybill("TEST0000000999")).resolves.toBeNull();
  });

  it("returns the existing record with inserted=false for a repeated reference", async () => {
    const first = await store.insert({ reference: "ref-b", waybillNumber: "TEST0000000002", payload });
    const second = await store.insert({ reference: "ref-b", waybillNumber: "TEST0000000002", payload });
    expect(second.inserted).toBe(false);
    expect(second.record).toEqual(first.record);
    expect(await countByReference("ref-b")).toBe(1);
  });

  it("concurrent inserts with the same reference produce exactly one row", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.insert({ reference: "ref-c", waybillNumber: "TEST0000000003", payload })),
    );
    expect(results.filter((r) => r.inserted)).toHaveLength(1);
    expect(new Set(results.map((r) => r.record.id)).size).toBe(1);
    expect(await countByReference("ref-c")).toBe(1);
  });

  it("concurrent adapter creates with the same reference produce one row and one waybill", async () => {
    const adapter = new TestCarrierAdapter({ store, getSimulation: () => "none" });
    const req = makeRequest("ref-d");
    const results = await Promise.all(Array.from({ length: 8 }, () => adapter.createShipment(req)));
    expect(new Set(results.map((r) => r.waybillNumber))).toEqual(new Set([deriveTestWaybillNumber("ref-d")]));
    expect(await countByReference("ref-d")).toBe(1);
  });

  it("throws SandboxWaybillConflictError when the waybill belongs to another reference", async () => {
    await store.insert({ reference: "ref-e1", waybillNumber: "TEST0000000005", payload });
    await expect(store.insert({ reference: "ref-e2", waybillNumber: "TEST0000000005", payload })).rejects.toBeInstanceOf(
      SandboxWaybillConflictError,
    );
    await expect(store.findByReference("ref-e2")).resolves.toBeNull();
  });

  it("conflicts do not abort an enclosing transaction", async () => {
    await handle.db.transaction(async (tx) => {
      const txStore = new DbSandboxStore(tx);
      await txStore.insert({ reference: "ref-f", waybillNumber: "TEST0000000006", payload });
      const again = await txStore.insert({ reference: "ref-f", waybillNumber: "TEST0000000006", payload });
      expect(again.inserted).toBe(false);
      await expect(txStore.insert({ reference: "ref-f2", waybillNumber: "TEST0000000006", payload })).rejects.toBeInstanceOf(
        SandboxWaybillConflictError,
      );
      // Транзакція жива — наступний запит виконується.
      await expect(txStore.findByReference("ref-f")).resolves.not.toBeNull();
    });
    expect(await countByReference("ref-f")).toBe(1);
  });

  it("markCancelled is idempotent and returns false for unknown waybills", async () => {
    await store.insert({ reference: "ref-g", waybillNumber: "TEST0000000007", payload });
    await expect(store.markCancelled("TEST0000000007")).resolves.toBe(true);
    await expect(store.markCancelled("TEST0000000007")).resolves.toBe(true);
    await expect(store.findByWaybill("TEST0000000007")).resolves.toMatchObject({ cancelled: true });
    await expect(store.markCancelled("TEST0000000777")).resolves.toBe(false);
  });

  it("adapter stores a minimized payload without personal data", async () => {
    const adapter = new TestCarrierAdapter({ store, getSimulation: () => "none" });
    await adapter.createShipment(makeRequest("ref-h"));
    const rows = await handle.db
      .select({ payload: sandboxCarrierShipments.payload })
      .from(sandboxCarrierShipments)
      .where(eq(sandboxCarrierShipments.reference, "ref-h"));
    expect(rows[0]?.payload).toEqual({
      orderNumber: "#DEMO-2002",
      parcelCount: 1,
      itemCount: 1,
      chargeableWeightGrams: 4800,
      destinationCountry: "DE",
    });
    const json = JSON.stringify(rows[0]?.payload);
    for (const pii of ["Test Recipient", "Demo Sender", "+15555550100", "Fictional", "Testburg"]) {
      expect(json).not.toContain(pii);
    }
  });

  it("fail_after_create leaves a row that reference lookup finds", async () => {
    const adapter = new TestCarrierAdapter({ store, getSimulation: () => "fail_after_create" });
    await expect(adapter.createShipment(makeRequest("ref-i"))).rejects.toMatchObject({ kind: "unknown_outcome" });
    const lookup = await adapter.findShipmentByReference("ref-i");
    expect(lookup).toMatchObject({ found: true, cancelled: false });
  });
});
