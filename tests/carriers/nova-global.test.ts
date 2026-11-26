import { describe, expect, it } from "vitest";
import { CarrierError, NovaGlobalAdapter, type CarrierAdapter, type CreateShipmentRequest } from "~/integrations/carriers";

const MESSAGE = "Nova Global Partners API is not configured: partner login/password and company_id from the Nova Global agreement are required";

async function expectNotConfigured(promise: Promise<unknown>): Promise<void> {
  const err = await promise.then(
    () => {
      throw new Error("expected CarrierError");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CarrierError);
  expect(err).toMatchObject({ kind: "not_configured", carrier: "nova_global", message: MESSAGE, details: [] });
  expect((err as CarrierError).outcomeUnknown).toBe(false);
}

describe("NovaGlobalAdapter (placeholder)", () => {
  const adapter: CarrierAdapter = new NovaGlobalAdapter();

  it("declares metadata with every capability disabled", () => {
    expect(adapter.code).toBe("nova_global");
    expect(adapter.displayName).toBe("Nova Global");
    expect(adapter.mode).toBe("live");
    expect(Object.values(adapter.capabilities).every((v) => v === false)).toBe(true);
    expect(Object.keys(adapter.capabilities).sort()).toEqual(
      [
        "rates",
        "availability",
        "createShipment",
        "updateShipment",
        "cancelShipment",
        "documents",
        "tracking",
        "returns",
        "findByReference",
        "referenceLookupAuthoritative",
      ].sort(),
    );
  });

  it("every method rejects with not_configured", async () => {
    await expectNotConfigured(adapter.createShipment({} as CreateShipmentRequest));
    await expectNotConfigured(adapter.findShipmentByReference("ref-1"));
    await expectNotConfigured(adapter.cancelShipment("NG-0000"));
  });

  it("does not expose unconfirmed optional methods", () => {
    expect(adapter.quoteRates).toBeUndefined();
    expect(adapter.checkAvailability).toBeUndefined();
    expect(adapter.getTracking).toBeUndefined();
    expect(adapter.getDocuments).toBeUndefined();
  });
});
