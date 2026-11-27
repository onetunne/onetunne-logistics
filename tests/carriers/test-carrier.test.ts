import { describe, expect, it, vi } from "vitest";
import {
  CarrierError,
  MemorySandboxStore,
  TestCarrierAdapter,
  deriveTestWaybillNumber,
  type CarrierErrorKind,
  type CreateShipmentRequest,
} from "~/integrations/carriers";
import type { TestCarrierSimulation } from "~/modules/settings/schema";

// Вигадані дані (номери 555-01xx зарезервовані як фіктивні).
function makeRequest(overrides: Partial<CreateShipmentRequest> = {}): CreateShipmentRequest {
  return {
    reference: "shp-demo-0001-g1",
    orderNumber: "#DEMO-1001",
    sender: {
      name: "Demo Sender",
      company: "Demo Company",
      phone: "+15555550199",
      email: null,
      address: {
        countryCode: "UA",
        city: "Sampleville",
        postalCode: "00000",
        province: null,
        address1: "1 Example Street",
        address2: null,
      },
    },
    recipient: {
      name: "Test Recipient",
      company: null,
      phone: "+15555550100",
      email: "recipient@example.com",
      address: {
        countryCode: "US",
        city: "Testtown",
        postalCode: "00001",
        province: "XX",
        address1: "42 Fictional Avenue",
        address2: "Apt 0",
      },
    },
    parcels: [
      {
        packageCode: "mailer_m",
        lengthCm: 35,
        widthCm: 25,
        heightCm: 8,
        actualWeightGrams: 870,
        volumetricWeightGrams: 1400,
        chargeableWeightGrams: 1400,
      },
    ],
    customsItems: [
      {
        sku: "DEMO-TEE-M",
        description: "Cotton T-shirt",
        hsCode: "610910",
        countryOfOrigin: "UA",
        quantity: 2,
        unitValue: { amount: "25.00", currency: "USD" },
        weightGrams: 400,
      },
    ],
    declaredValue: { amount: "50.00", currency: "USD" },
    serviceCode: null,
    ...overrides,
  };
}

function setup(simulation: TestCarrierSimulation = "none") {
  const store = new MemorySandboxStore();
  const state = { simulation };
  const adapter = new TestCarrierAdapter({ store, getSimulation: () => state.simulation });
  return { store, state, adapter };
}

async function expectCarrierError(promise: Promise<unknown>, kind: CarrierErrorKind): Promise<CarrierError> {
  const err = await promise.then(
    () => {
      throw new Error("expected CarrierError");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CarrierError);
  const ce = err as CarrierError;
  expect(ce.kind).toBe(kind);
  expect(ce.carrier).toBe("test");
  return ce;
}

describe("TestCarrierAdapter metadata", () => {
  it("declares code, mode and capabilities", () => {
    const { adapter } = setup();
    expect(adapter.code).toBe("test");
    expect(adapter.displayName).toBe("Test carrier (sandbox)");
    expect(adapter.mode).toBe("test");
    expect(adapter.capabilities).toEqual({
      rates: false,
      availability: false,
      createShipment: true,
      updateShipment: false,
      cancelShipment: true,
      documents: true,
      tracking: false,
      returns: false,
      findByReference: true,
      referenceLookupAuthoritative: true,
      documentKinds: ["label"],
    });
  });
});

describe("TestCarrierAdapter.getDocument (sample TEST label)", () => {
  it("returns a one-page A6 PDF marked TEST for an active test waybill, with no personal data", async () => {
    const { adapter } = setup();
    const created = await adapter.createShipment(makeRequest());
    const doc = await adapter.getDocument({ carrierShipmentId: created.carrierShipmentId, waybillNumber: created.waybillNumber }, "label");
    expect(doc).toMatchObject({ kind: "label", format: "pdf", contentType: "application/pdf", fileName: `test-label-${created.waybillNumber}.pdf` });
    const { PDFDocument } = await import("pdf-lib");
    const pdf = await PDFDocument.load(doc.content);
    expect(pdf.getPageCount()).toBe(1);
    expect(pdf.getTitle()).toBe(`TEST LABEL ${created.waybillNumber}`);
    // Стандартний шрифт без стиснення потоків не гарантований — перевіряємо, що в документі немає імен/телефонів/адрес запиту.
    const raw = Buffer.from(doc.content).toString("latin1");
    for (const pd of ["Demo Sender", "+15555550199", "1 Example Street", "Sampleville"]) expect(raw).not.toContain(pd);
  });

  it("refuses other document kinds, unknown and cancelled waybills; respects an aborted signal", async () => {
    const { adapter } = setup();
    const created = await adapter.createShipment(makeRequest({ reference: "shp-demo-0002-g1" }));
    const ref = { carrierShipmentId: created.carrierShipmentId, waybillNumber: created.waybillNumber };
    await expect(adapter.getDocument(ref, "invoice")).rejects.toMatchObject({ kind: "not_supported" });
    await expect(adapter.getDocument({ carrierShipmentId: null, waybillNumber: "TEST0000000000" }, "label")).rejects.toMatchObject({ kind: "rejected" });
    const ac = new AbortController();
    ac.abort();
    await expect(adapter.getDocument(ref, "label", { signal: ac.signal })).rejects.toMatchObject({ kind: "unavailable" });
    await adapter.cancelShipment(created.waybillNumber);
    await expect(adapter.getDocument(ref, "label")).rejects.toMatchObject({ kind: "rejected" });
  });
});

describe("TestCarrierAdapter.createShipment", () => {
  it("creates a shipment with a deterministic TEST waybill", async () => {
    const { adapter, store } = setup();
    const req = makeRequest();
    const created = await adapter.createShipment(req);

    expect(created.waybillNumber).toMatch(/^TEST\d{10}$/);
    expect(created.waybillNumber).toBe(deriveTestWaybillNumber(req.reference));
    expect(created.trackingNumber).toBe(created.waybillNumber);
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(store.size).toBe(1);

    const rec = await store.findByReference(req.reference);
    expect(created.carrierShipmentId).toBe(rec?.id);
  });

  it("stores only a minimized payload (no names, phones, addresses)", async () => {
    const { adapter, store } = setup();
    const req = makeRequest();
    await adapter.createShipment(req);

    const payload = store.payloadOf(req.reference);
    expect(payload).toEqual({
      orderNumber: "#DEMO-1001",
      parcelCount: 1,
      itemCount: 2,
      chargeableWeightGrams: 1400,
      destinationCountry: "US",
    });
    const json = JSON.stringify(payload);
    for (const pii of ["Test Recipient", "Demo Sender", "+15555550100", "Fictional Avenue", "Testtown", "example.com"]) {
      expect(json).not.toContain(pii);
    }
  });

  it("is idempotent by reference: second create returns the same shipment without inserting", async () => {
    const { adapter, store } = setup();
    const req = makeRequest();
    const first = await adapter.createShipment(req);

    const insertSpy = vi.spyOn(store, "insert");
    const second = await adapter.createShipment(req);

    expect(second).toEqual(first);
    expect(insertSpy).not.toHaveBeenCalled();
    expect(store.size).toBe(1);
  });

  it("concurrent creates with the same reference produce one shipment", async () => {
    const { adapter, store } = setup();
    const req = makeRequest();
    const results = await Promise.all(Array.from({ length: 5 }, () => adapter.createShipment(req)));
    expect(new Set(results.map((r) => r.waybillNumber)).size).toBe(1);
    expect(new Set(results.map((r) => r.carrierShipmentId)).size).toBe(1);
    expect(store.size).toBe(1);
  });

  it("supports an async simulation provider", async () => {
    const store = new MemorySandboxStore();
    const adapter = new TestCarrierAdapter({ store, getSimulation: async (): Promise<TestCarrierSimulation> => "none" });
    await expect(adapter.createShipment(makeRequest())).resolves.toMatchObject({ waybillNumber: expect.stringMatching(/^TEST/) });
  });

  it("maps a failing simulation provider to unavailable without creating", async () => {
    const store = new MemorySandboxStore();
    const adapter = new TestCarrierAdapter({
      store,
      getSimulation: () => {
        throw new Error("settings db down");
      },
    });
    await expectCarrierError(adapter.createShipment(makeRequest()), "unavailable");
    expect(store.size).toBe(0);
  });

  it("throws unavailable when the signal is already aborted", async () => {
    const { adapter, store } = setup();
    const ac = new AbortController();
    ac.abort();
    await expectCarrierError(adapter.createShipment(makeRequest(), { signal: ac.signal }), "unavailable");
    await expectCarrierError(adapter.findShipmentByReference("x", { signal: ac.signal }), "unavailable");
    await expectCarrierError(adapter.cancelShipment("TEST0000000000", { signal: ac.signal }), "unavailable");
    expect(store.size).toBe(0);
  });
});

describe("TestCarrierAdapter simulations", () => {
  it("reject → rejected, nothing created", async () => {
    const { adapter, store } = setup("reject");
    const err = await expectCarrierError(adapter.createShipment(makeRequest()), "rejected");
    expect(err.message).toBe("simulated_rejection");
    expect(err.outcomeUnknown).toBe(false);
    expect(store.size).toBe(0);
  });

  it("unavailable → unavailable, nothing created", async () => {
    const { adapter, store } = setup("unavailable");
    await expectCarrierError(adapter.createShipment(makeRequest()), "unavailable");
    expect(store.size).toBe(0);
  });

  it("timeout_before_create → unknown_outcome; lookup then says not found (authoritative)", async () => {
    const { adapter, store } = setup("timeout_before_create");
    const req = makeRequest();
    const err = await expectCarrierError(adapter.createShipment(req), "unknown_outcome");
    expect(err.outcomeUnknown).toBe(true);
    expect(store.size).toBe(0);
    await expect(adapter.findShipmentByReference(req.reference)).resolves.toEqual({
      found: false,
      authoritative: true,
    });
  });

  it("fail_after_create → unknown_outcome; lookup then finds the shipment; retry is idempotent", async () => {
    const { adapter, store, state } = setup("fail_after_create");
    const req = makeRequest();
    await expectCarrierError(adapter.createShipment(req), "unknown_outcome");
    expect(store.size).toBe(1);

    const lookup = await adapter.findShipmentByReference(req.reference);
    expect(lookup.found).toBe(true);
    if (!lookup.found) throw new Error("unreachable");
    expect(lookup.cancelled).toBe(false);
    expect(lookup.shipment.waybillNumber).toBe(deriveTestWaybillNumber(req.reference));

    // Повтор у тому ж режимі не створює другий запис.
    await expectCarrierError(adapter.createShipment(req), "unknown_outcome");
    expect(store.size).toBe(1);

    state.simulation = "none";
    const created = await adapter.createShipment(req);
    expect(created).toEqual(lookup.shipment);
    expect(store.size).toBe(1);
  });

  it("none → created", async () => {
    const { adapter } = setup("none");
    await expect(adapter.createShipment(makeRequest())).resolves.toMatchObject({ waybillNumber: expect.stringMatching(/^TEST\d{10}$/) });
  });
});

describe("TestCarrierAdapter request validation", () => {
  it("rejects invalid recipient/sender fields with mapped field paths", async () => {
    const { adapter, store } = setup();
    const base = makeRequest();
    const req = makeRequest({
      recipient: {
        ...base.recipient,
        name: " ",
        phone: "0501234567",
        address: { ...base.recipient.address, city: "", address1: "  ", countryCode: "" },
      },
      sender: {
        ...base.sender,
        name: "",
        phone: "",
        address: { ...base.sender.address, city: "", address1: "", countryCode: "" },
      },
    });
    const err = await expectCarrierError(adapter.createShipment(req), "rejected");
    const fields = err.details.map((d) => d.field).filter(Boolean);
    expect(fields).toEqual(
      expect.arrayContaining([
        "shipping.phone",
        "shipping.city",
        "shipping.address1",
        "shipping.countryCode",
        "shipper.contactName",
        "shipper.phone",
        "shipper.city",
        "shipper.address1",
        "shipper.countryCode",
      ]),
    );
    expect(err.details.find((d) => d.field === "shipping.phone")?.carrierCode).toBe("INVALID_PHONE");
    // Ім'я одержувача — без однозначного поля.
    expect(err.details.some((d) => d.field === undefined && d.message.includes("recipient.name"))).toBe(true);
    expect(store.size).toBe(0);
  });

  it.each(["+0123456789", "+12345", "+1234567890123456", "+38 050 123 45 67", "380501234567"])(
    "rejects phone %s",
    async (phone) => {
      const { adapter } = setup();
      const base = makeRequest();
      const err = await expectCarrierError(
        adapter.createShipment(makeRequest({ recipient: { ...base.recipient, phone } })),
        "rejected",
      );
      expect(err.details).toEqual([expect.objectContaining({ field: "shipping.phone" })]);
    },
  );

  it("rejects bad parcels and customs items", async () => {
    const { adapter } = setup();
    const base = makeRequest();
    const item = base.customsItems[0]!;
    const parcel = base.parcels[0]!;

    const noParcels = await expectCarrierError(adapter.createShipment(makeRequest({ parcels: [] })), "rejected");
    expect(noParcels.details.map((d) => d.carrierCode)).toEqual(["NO_PARCELS"]);

    const zeroWeight = await expectCarrierError(
      adapter.createShipment(makeRequest({ parcels: [{ ...parcel, chargeableWeightGrams: 0 }] })),
      "rejected",
    );
    expect(zeroWeight.details.map((d) => d.carrierCode)).toEqual(["INVALID_WEIGHT"]);

    const noItems = await expectCarrierError(adapter.createShipment(makeRequest({ customsItems: [] })), "rejected");
    expect(noItems.details.map((d) => d.carrierCode)).toEqual(["NO_CUSTOMS_ITEMS"]);

    const badItem = await expectCarrierError(
      adapter.createShipment(
        makeRequest({ customsItems: [{ ...item, hsCode: "6109.10", countryOfOrigin: "ua", quantity: 0 }] }),
      ),
      "rejected",
    );
    expect(badItem.details.map((d) => d.carrierCode)).toEqual(["INVALID_HS_CODE", "INVALID_ORIGIN", "INVALID_QUANTITY"]);
  });

  it("accepts 6..10 digit HS codes", async () => {
    const { adapter } = setup();
    const item = makeRequest().customsItems[0]!;
    await expect(
      adapter.createShipment(makeRequest({ customsItems: [{ ...item, hsCode: "6109100010" }] })),
    ).resolves.toBeDefined();
  });

  it("validates before applying the simulation", async () => {
    const { adapter } = setup("unavailable");
    await expectCarrierError(adapter.createShipment(makeRequest({ parcels: [] })), "rejected");
  });
});

describe("TestCarrierAdapter.cancelShipment", () => {
  it("cancels idempotently and lookup reports cancelled", async () => {
    const { adapter } = setup();
    const req = makeRequest();
    const created = await adapter.createShipment(req);

    await expect(adapter.cancelShipment(created.waybillNumber)).resolves.toEqual({ cancelled: true });
    await expect(adapter.cancelShipment(created.waybillNumber)).resolves.toEqual({ cancelled: true });

    const lookup = await adapter.findShipmentByReference(req.reference);
    expect(lookup).toMatchObject({ found: true, cancelled: true });
  });

  it("rejects cancelling an unknown waybill", async () => {
    const { adapter } = setup();
    await expectCarrierError(adapter.cancelShipment("TEST9999999999"), "rejected");
  });

  it("does not return a cancelled shipment as newly created for a reused reference", async () => {
    const { adapter, store } = setup();
    const req = makeRequest();
    const created = await adapter.createShipment(req);
    await adapter.cancelShipment(created.waybillNumber);

    const err = await expectCarrierError(adapter.createShipment(req), "rejected");
    expect(err.details[0]?.carrierCode).toBe("REFERENCE_CANCELLED");
    expect(store.size).toBe(1);
  });
});

describe("waybill numbers", () => {
  it("are deterministic per reference and attempt", () => {
    const a = deriveTestWaybillNumber("shp-demo-0001-g1");
    expect(a).toMatch(/^TEST\d{10}$/);
    expect(deriveTestWaybillNumber("shp-demo-0001-g1")).toBe(a);
    expect(deriveTestWaybillNumber("shp-demo-0001-g1", 0)).toBe(a);
    expect(deriveTestWaybillNumber("shp-demo-0001-g2")).not.toBe(a);
    expect(deriveTestWaybillNumber("shp-demo-0001-g1", 1)).not.toBe(a);
    expect(deriveTestWaybillNumber("shp-demo-0001-g1", 1)).toMatch(/^TEST\d{10}$/);
  });

  it("are identical across independent adapters/stores", async () => {
    const one = setup();
    const two = setup();
    const req = makeRequest({ reference: "shp-demo-0042-g1" });
    const a = await one.adapter.createShipment(req);
    const b = await two.adapter.createShipment(req);
    expect(a.waybillNumber).toBe(b.waybillNumber);
    expect(a.carrierShipmentId).not.toBe(b.carrierShipmentId);
  });

  it("skip numbers already used by a different reference", async () => {
    const { adapter, store } = setup();
    const reference = "shp-demo-0007-g1";
    // Займаємо перші два кандидати іншими reference.
    await store.insert({
      reference: "other-1",
      waybillNumber: deriveTestWaybillNumber(reference, 0),
      payload: { orderNumber: "#X", parcelCount: 1, itemCount: 1, chargeableWeightGrams: 1, destinationCountry: "US" },
    });
    await store.insert({
      reference: "other-2",
      waybillNumber: deriveTestWaybillNumber(reference, 1),
      payload: { orderNumber: "#Y", parcelCount: 1, itemCount: 1, chargeableWeightGrams: 1, destinationCountry: "US" },
    });

    const created = await adapter.createShipment(makeRequest({ reference }));
    expect(created.waybillNumber).toBe(deriveTestWaybillNumber(reference, 2));
    expect(store.size).toBe(3);

    // Повтор — той самий номер, без нового запису.
    const again = await adapter.createShipment(makeRequest({ reference }));
    expect(again.waybillNumber).toBe(created.waybillNumber);
    expect(store.size).toBe(3);
  });

  it("retries the next number when insert races with a different reference", async () => {
    const { adapter, store } = setup();
    const reference = "shp-demo-0008-g1";
    const realInsert = store.insert.bind(store);
    let first = true;
    vi.spyOn(store, "insert").mockImplementation(async (rec) => {
      if (first) {
        first = false;
        // Інший reference «встигає» зайняти номер між перевіркою і вставкою.
        await realInsert({ ...rec, reference: "racer" });
      }
      return realInsert(rec);
    });

    const created = await adapter.createShipment(makeRequest({ reference }));
    expect(created.waybillNumber).toBe(deriveTestWaybillNumber(reference, 1));
    expect(store.size).toBe(2);
  });

  it("maps an unexpected storage failure during insert to unknown_outcome", async () => {
    const { adapter, store } = setup();
    vi.spyOn(store, "insert").mockRejectedValue(new Error("connection reset"));
    await expectCarrierError(adapter.createShipment(makeRequest()), "unknown_outcome");
  });
});
