import { describe, expect, it } from "vitest";
import {
  allocateItemWeights,
  amountToMinor,
  buildCreateShipmentBody,
  buildPrintQuery,
  buildTrackingSnapshots,
  clientOrderMatches,
  convertMoney,
  documentFileName,
  looksLikePdf,
  mapCalculationToQuotes,
  mapNovaPostErrorField,
  parseNovaPostErrors,
  type NovaPostShipmentSettings,
} from "~/integrations/carriers/nova-post/mapping";
import {
  mapNovaPostTrackingCode,
  NOVA_POST_DOCUMENTED_TRACKING_CODES,
  NOVA_POST_TRACKING_CODES,
} from "~/integrations/carriers/nova-post/tracking-codes";
import { CarrierError, type CreateShipmentRequest, type TrackingStatus } from "~/integrations/carriers/types";

// Лише вигадані тестові дані (без реальних персональних даних).
function sampleRequest(overrides: Partial<CreateShipmentRequest> = {}): CreateShipmentRequest {
  return {
    reference: "OT-1001-1",
    orderNumber: "#1001",
    sender: {
      name: "Test Sender",
      company: "Test Shop LLC",
      phone: "+380501234567",
      email: "shop@example.test",
      address: { countryCode: "UA", city: "Kyiv", postalCode: "01001", province: null, address1: "Test street 1", address2: null },
      branchCode: "32521/1",
      taxId: "12345678",
      eori: "UA123456789",
      ioss: "IM1234567890",
    },
    recipient: {
      name: "Test Recipient",
      company: null,
      phone: "+491511234567",
      email: "recipient@example.test",
      address: {
        countryCode: "DE",
        city: "Berlin",
        postalCode: "10178",
        province: null,
        address1: "Teststrasse 5",
        address2: "Apt 3",
        street: "Teststrasse",
        building: "5",
      },
      registrationAddress: {
        countryCode: "DE",
        city: "Hamburg",
        postalCode: "20095",
        province: null,
        address1: "Testweg 7",
        address2: null,
        street: "Testweg",
        building: "7",
      },
    },
    parcels: [
      { packageCode: "mailer_m", lengthCm: 35, widthCm: 25, heightCm: 8, actualWeightGrams: 473, volumetricWeightGrams: 1400, chargeableWeightGrams: 1400 },
    ],
    customsItems: [
      {
        sku: "SKU-1",
        description: "Cotton T-shirt",
        descriptionLocal: "Футболка бавовняна",
        hsCode: "6109100010",
        countryOfOrigin: "UA",
        quantity: 2,
        unitValue: { amount: "24.90", currency: "EUR" },
        weightGrams: 150,
        material: "Cotton",
        materialLocal: "Бавовна",
      },
      {
        sku: null,
        description: "Cap",
        hsCode: "6505003000",
        countryOfOrigin: "ua",
        quantity: 1,
        unitValue: { amount: "15.00", currency: "EUR" },
        weightGrams: 100,
        producerAndModel: null,
      },
    ],
    declaredValue: { amount: "64.80", currency: "EUR" },
    customs: {
      invoiceNumber: "1001",
      invoiceDate: "2026-11-26",
      invoiceType: "commercial",
      incoterm: "DAP",
      exportReason: "sale",
      totalValue: { amount: "64.80", currency: "EUR" },
    },
    ...overrides,
  };
}

const SETTINGS: NovaPostShipmentSettings = { payerType: "Sender", payerContractNumber: "", deliveryType: "" };

function rejection(fn: () => unknown): CarrierError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CarrierError);
    return e as CarrierError;
  }
  throw new Error("expected CarrierError");
}

describe("POST /shipments body mapping", () => {
  it("maps a UA → DE shipment: units, enums, invoice, weights summing to parcel weight", () => {
    const body = buildCreateShipmentBody(sampleRequest(), SETTINGS);
    expect(body).toStrictEqual({
      status: "ReadyToShip",
      clientOrder: "OT-1001-1",
      note: "#1001",
      payerType: "Sender",
      parcels: [
        {
          rowNumber: 1,
          cargoCategory: "parcel",
          parcelDescription: "Cotton T-shirt, Cap",
          insuranceCost: 64.8,
          insuranceCurrencyCode: "EUR",
          length: 350,
          width: 250,
          height: 80,
          actualWeight: 480,
        },
      ],
      sender: {
        name: "Test Sender",
        phone: "+380501234567",
        email: "shop@example.test",
        companyName: "Test Shop LLC",
        companyTin: "12345678",
        eoriCode: "UA123456789",
        ioss: "IM1234567890",
        countryCode: "UA",
        divisionNumber: "32521/1",
      },
      recipient: {
        name: "Test Recipient",
        phone: "+491511234567",
        email: "recipient@example.test",
        countryCode: "DE",
        addressParts: { city: "Berlin", street: "Teststrasse", building: "5", postCode: "10178", note: "Apt 3" },
        registrationAddressRecipient: { city: "Hamburg", street: "Testweg", zipCode: "20095", building: "7" },
      },
      invoice: {
        customerNumber: "1001",
        customerCreatedAt: "2026-11-26T00:00:00.000000Z",
        type: "Invoice",
        incoterm: "DAP",
        exportReason: "Selling",
        cost: 64.8,
        currency: "EUR",
        payerFeesCustoms: "Recipient",
        items: [
          {
            customerId: "SKU-1",
            hsCode: "6109100010",
            name: "Футболка бавовняна",
            nameEng: "Cotton T-shirt",
            material: "Бавовна",
            materialEng: "Cotton",
            madeInCountryCode: "UA",
            actualWeight: 360,
            measurementCode: "pieces",
            amount: 2,
            cost: 24.9,
          },
          {
            hsCode: "6505003000",
            name: "Cap",
            nameEng: "Cap",
            madeInCountryCode: "UA",
            actualWeight: 120,
            measurementCode: "pieces",
            amount: 1,
            cost: 15,
          },
        ],
      },
    });
    const itemsWeight = body.invoice!.items.reduce((s, i) => s + i.actualWeight, 0);
    expect(itemsWeight).toBe(body.parcels[0]!.actualWeight);
  });

  it("maps incoterm/invoice type/export reason enums", () => {
    const reasons = { sale: "Selling", personal: "ForPersonalPurposes", repair: "Repair", return: "Return", other: "Other" } as const;
    for (const [ours, theirs] of Object.entries(reasons)) {
      const req = sampleRequest();
      req.customs = { ...req.customs!, exportReason: ours as keyof typeof reasons, incoterm: "DDP", invoiceType: "proforma" };
      const inv = buildCreateShipmentBody(req, SETTINGS).invoice!;
      expect(inv.exportReason).toBe(theirs);
      expect(inv.incoterm).toBe("DDP");
      expect(inv.payerFeesCustoms).toBe("Sender");
      expect(inv.type).toBe("ProformaInvoice");
    }
  });

  it("non-EU destination: no payerFeesCustoms (UA-EU only) and no IOSS; region from province", () => {
    const req = sampleRequest();
    req.recipient = {
      ...req.recipient,
      address: { countryCode: "US", city: "Austin", postalCode: "73301", province: "TX", address1: "1 Test Ave", address2: null, street: "Test Ave", building: "1" },
      registrationAddress: null,
    };
    const body = buildCreateShipmentBody(req, SETTINGS);
    expect(body.invoice).not.toHaveProperty("payerFeesCustoms");
    expect(body.sender).not.toHaveProperty("ioss");
    expect(body.recipient.addressParts).toStrictEqual({ city: "Austin", region: "TX", street: "Test Ave", building: "1", postCode: "73301" });
    // Не ЄС-країна з особливими вимогами → без адреси реєстрації.
    expect(body.recipient).not.toHaveProperty("registrationAddressRecipient");
  });

  it("IOSS only for EUR value up to 150", () => {
    const over = sampleRequest();
    over.customs = { ...over.customs!, totalValue: { amount: "150.01", currency: "EUR" } };
    expect(buildCreateShipmentBody(over, SETTINGS).sender).not.toHaveProperty("ioss");
    const usd = sampleRequest();
    usd.customs = { ...usd.customs!, totalValue: { amount: "10.00", currency: "USD" } };
    usd.customsItems = usd.customsItems.map((i) => ({ ...i, unitValue: { ...i.unitValue, currency: "USD" } }));
    expect(buildCreateShipmentBody(usd, SETTINGS).sender).not.toHaveProperty("ioss");
    const exact = sampleRequest();
    exact.customs = { ...exact.customs!, totalValue: { amount: "150.00", currency: "EUR" } };
    expect(buildCreateShipmentBody(exact, SETTINGS).sender.ioss).toBe("IM1234567890");
  });

  it("sender without branch → addressParts from the sender address; empty optional fields are omitted", () => {
    const req = sampleRequest();
    req.sender = {
      ...req.sender,
      branchCode: "",
      company: null,
      taxId: null,
      eori: "",
      ioss: null,
      address: { ...req.sender.address, street: "Test street", building: "1" },
    };
    const body = buildCreateShipmentBody(req, SETTINGS);
    expect(body.sender).toStrictEqual({
      name: "Test Sender",
      phone: "+380501234567",
      email: "shop@example.test",
      countryCode: "UA",
      addressParts: { city: "Kyiv", street: "Test street", building: "1", postCode: "01001" },
    });
    expect(body).not.toHaveProperty("payerContractNumber");
    expect(body).not.toHaveProperty("deliveryType");
  });

  it("deliveryType: request serviceCode → settings → omitted; contract number passed when set", () => {
    expect(buildCreateShipmentBody(sampleRequest({ serviceCode: "express" }), { ...SETTINGS, deliveryType: "economy" }).deliveryType).toBe("express");
    expect(buildCreateShipmentBody(sampleRequest({ serviceCode: " Express " }), SETTINGS).deliveryType).toBe("express");
    expect(buildCreateShipmentBody(sampleRequest({ serviceCode: null }), { ...SETTINGS, deliveryType: "economy" }).deliveryType).toBe("economy");
    const body = buildCreateShipmentBody(sampleRequest(), { payerType: "ThirdPerson", payerContractNumber: " 12345678 ", deliveryType: "" });
    expect(body.payerType).toBe("ThirdPerson");
    expect(body.payerContractNumber).toBe("12345678");
  });

  it("multiple parcels: declared value split exactly, weights summed for the invoice", () => {
    const req = sampleRequest({ declaredValue: { amount: "10.01", currency: "EUR" } });
    req.parcels = [req.parcels[0]!, { ...req.parcels[0]!, actualWeightGrams: 1000 }, { ...req.parcels[0]!, actualWeightGrams: 15 }];
    const body = buildCreateShipmentBody(req, SETTINGS);
    expect(body.parcels.map((p) => p.insuranceCost)).toEqual([3.34, 3.34, 3.33]);
    expect(body.parcels.map((p) => p.rowNumber)).toEqual([1, 2, 3]);
    expect(body.parcels.map((p) => p.actualWeight)).toEqual([480, 1000, 20]);
    expect(body.invoice!.items.reduce((s, i) => s + i.actualWeight, 0)).toBe(1500);
  });

  it("parcel description is a generated summary trimmed to 255 characters", () => {
    const req = sampleRequest();
    req.customsItems = Array.from({ length: 30 }, (_, i) => ({ ...req.customsItems[0]!, description: `Long product description number ${i}` }));
    const body = buildCreateShipmentBody(req, SETTINGS);
    expect([...body.parcels[0]!.parcelDescription].length).toBe(255);
  });
});

describe("POST /shipments validation (never truncates personal data)", () => {
  it("values longer than documented limits → rejected with our field, without echoing the value", () => {
    const req = sampleRequest();
    const longName = "N".repeat(101);
    req.recipient = {
      ...req.recipient,
      name: longName,
      address: {
        ...req.recipient.address,
        address1: `${"S".repeat(101)} 5`,
        street: "S".repeat(101),
        city: "C".repeat(101),
        postalCode: "12345678901",
        address2: "A".repeat(101),
      },
    };
    const err = rejection(() => buildCreateShipmentBody(req, SETTINGS));
    expect(err.kind).toBe("rejected");
    expect(err.details.map((d) => [d.carrierCode, d.field])).toEqual([
      ["recipient.name", "order"],
      ["recipient.addressParts.city", "shipping.city"],
      ["recipient.addressParts.street", "shipping.address1"],
      ["recipient.addressParts.postCode", "shipping.postalCode"],
      ["recipient.addressParts.note", "shipping.address2"],
    ]);
    expect(err.message).not.toContain(longName);
    expect(err.message).toContain("longer than 100 characters");
  });

  it("sender limits map to shipper settings fields", () => {
    const req = sampleRequest();
    req.sender = { ...req.sender, name: "x".repeat(101), taxId: "1".repeat(21), eori: "AB", ioss: "IM12345678901" };
    const err = rejection(() => buildCreateShipmentBody(req, SETTINGS));
    expect(err.details.map((d) => d.field)).toEqual(["shipper.contactName", "shipper.taxId", "shipper.eori", "shipper.ioss"]);
  });

  it("characters are counted as code points (Cyrillic 100 chars is fine)", () => {
    const req = sampleRequest();
    req.recipient = { ...req.recipient, name: "Ж".repeat(100) };
    expect(buildCreateShipmentBody(req, SETTINGS).recipient.name).toHaveLength(100);
  });

  it("customs data required for an international destination", () => {
    const err = rejection(() => buildCreateShipmentBody(sampleRequest({ customs: null }), SETTINGS));
    expect(err.kind).toBe("rejected");
    expect(err.message).toContain("customs data required");
    const noItems = rejection(() => buildCreateShipmentBody(sampleRequest({ customsItems: [] }), SETTINGS));
    expect(noItems.details[0]!.carrierCode).toBe("invoice.items");
  });

  it("domestic shipment (same country) has no invoice; email and registration address not required", () => {
    const req = sampleRequest({ customs: null });
    req.recipient = { ...req.recipient, email: null, registrationAddress: null, address: { ...req.recipient.address, countryCode: "UA" } };
    const body = buildCreateShipmentBody(req, SETTINGS);
    expect(body).not.toHaveProperty("invoice");
    expect(body.recipient).not.toHaveProperty("email");
    expect(body.recipient).not.toHaveProperty("registrationAddressRecipient");
  });

  it("address delivery: building must be separate (never address1 in two fields), postCode required", () => {
    const req = sampleRequest();
    req.recipient = { ...req.recipient, address: { ...req.recipient.address, street: null, building: null, postalCode: null } };
    const err = rejection(() => buildCreateShipmentBody(req, SETTINGS));
    expect(err.details.map((d) => [d.carrierCode, d.field])).toEqual([
      ["recipient.addressParts.building", "shipping.address1"],
      ["recipient.addressParts.postCode", "shipping.postalCode"],
    ]);
    expect(err.details[0]!.message).toContain("separate field");
    // Відправник з адреси (без відділення) — те саме, поле налаштувань відправника.
    const sender = sampleRequest();
    sender.sender = { ...sender.sender, branchCode: null };
    expect(rejection(() => buildCreateShipmentBody(sender, SETTINGS)).details.map((d) => [d.carrierCode, d.field])).toEqual([
      ["sender.addressParts.building", "shipper.address1"],
    ]);
    // Відділення одержувача → addressParts не потрібні взагалі.
    const branch = sampleRequest();
    branch.recipient = { ...branch.recipient, branchCode: "1234/5", address: { ...branch.recipient.address, street: null, building: null, postalCode: null } };
    const body = buildCreateShipmentBody(branch, SETTINGS);
    expect(body.recipient.divisionNumber).toBe("1234/5");
    expect(body.recipient).not.toHaveProperty("addressParts");
  });

  it("region required when sender or recipient is US/IE/CA (US: two-letter state code)", () => {
    const us = sampleRequest();
    us.recipient = {
      ...us.recipient,
      registrationAddress: null,
      address: { countryCode: "US", city: "Austin", postalCode: "73301", province: null, address1: "1 Test Ave", address2: null, street: "Test Ave", building: "1" },
    };
    expect(rejection(() => buildCreateShipmentBody(us, SETTINGS)).details.map((d) => [d.carrierCode, d.field])).toEqual([
      ["recipient.addressParts.region", "shipping.province"],
    ]);
    us.recipient.address.province = "Texas";
    expect(rejection(() => buildCreateShipmentBody(us, SETTINGS)).details[0]!.message).toContain("invalid format");
    us.recipient.address.province = "TX";
    // Відправник з адреси до США: region відправника теж обов'язковий.
    us.sender = { ...us.sender, branchCode: null, address: { ...us.sender.address, street: "Test street", building: "1" } };
    expect(rejection(() => buildCreateShipmentBody(us, SETTINGS)).details.map((d) => d.carrierCode)).toEqual(["sender.addressParts.region"]);
    // Ірландія: регіон обов'язковий, але формат не перевіряється.
    const ie = sampleRequest();
    ie.recipient = { ...ie.recipient, registrationAddress: null, address: { ...ie.recipient.address, countryCode: "IE", province: "Co. Dublin" } };
    expect(buildCreateShipmentBody(ie, SETTINGS).recipient.addressParts!.region).toBe("Co. Dublin");
    // Інші країни — region необов'язковий.
    expect(buildCreateShipmentBody(sampleRequest(), SETTINGS).recipient.addressParts).not.toHaveProperty("region");
  });

  it("email required for both parties on an international shipment", () => {
    const req = sampleRequest();
    req.recipient = { ...req.recipient, email: " " };
    req.sender = { ...req.sender, email: null };
    expect(rejection(() => buildCreateShipmentBody(req, SETTINGS)).details.map((d) => [d.carrierCode, d.field])).toEqual([
      ["sender.email", "shipper.email"],
      ["recipient.email", "email"],
    ]);
  });

  it("DE/SK/HU/FR: registration address required; never substituted with the delivery address", () => {
    for (const country of ["DE", "SK", "HU", "FR"]) {
      const req = sampleRequest();
      req.recipient = { ...req.recipient, registrationAddress: undefined, address: { ...req.recipient.address, countryCode: country } };
      const err = rejection(() => buildCreateShipmentBody(req, SETTINGS));
      expect(err.details.map((d) => d.carrierCode), country).toEqual(["recipient.registrationAddressRecipient"]);
      expect(err.details[0]!.field).toBeUndefined();
    }
    const pl = sampleRequest();
    pl.recipient = { ...pl.recipient, registrationAddress: null, address: { ...pl.recipient.address, countryCode: "PL" } };
    expect(buildCreateShipmentBody(pl, SETTINGS).recipient).not.toHaveProperty("registrationAddressRecipient");
    // Неповна адреса реєстрації → помилки полів (zipCode, не postCode).
    const partial = sampleRequest();
    partial.recipient = { ...partial.recipient, registrationAddress: { ...partial.recipient.registrationAddress!, postalCode: null, building: null } };
    expect(rejection(() => buildCreateShipmentBody(partial, SETTINGS)).details.map((d) => d.carrierCode)).toEqual([
      "recipient.registrationAddressRecipient.zipCode",
      "recipient.registrationAddressRecipient.building",
    ]);
  });

  it("deliveryType: only documented values are sent (never a calculation UUID)", () => {
    const fromSettings = rejection(() => buildCreateShipmentBody(sampleRequest(), { ...SETTINGS, deliveryType: "4f6e-uuid" }));
    expect(fromSettings.details.map((d) => [d.carrierCode, d.field])).toEqual([["deliveryType", "novaPost.deliveryType"]]);
    const fromRequest = rejection(() => buildCreateShipmentBody(sampleRequest({ serviceCode: "0b6e2c1a-1111-4222-8333-444455556666" }), SETTINGS));
    expect(fromRequest.details.map((d) => d.carrierCode)).toEqual(["serviceCode"]);
  });

  it("hsCode: digits only, 8–10 digits (exactly 10 for MD/CA), kg-only codes rejected", () => {
    const dotted = sampleRequest();
    dotted.customsItems = [{ ...dotted.customsItems[0]!, hsCode: "6109.10.00" }];
    expect(buildCreateShipmentBody(dotted, SETTINGS).invoice!.items[0]!.hsCode).toBe("61091000");

    const short = sampleRequest();
    short.customsItems = [{ ...short.customsItems[0]!, hsCode: "610910" }];
    expect(rejection(() => buildCreateShipmentBody(short, SETTINGS)).details.map((d) => [d.carrierCode, d.message])).toEqual([
      ["invoice.items.0.hsCode", "invoice.items.0.hsCode: HS code must have 8 to 10 digits (UKT ZED)"],
    ]);

    const canada = sampleRequest();
    canada.recipient = { ...canada.recipient, registrationAddress: null, address: { ...canada.recipient.address, countryCode: "CA", province: "ON" } };
    canada.customsItems = [{ ...canada.customsItems[0]!, hsCode: "61091000" }];
    expect(rejection(() => buildCreateShipmentBody(canada, SETTINGS)).details[0]!.message).toContain("exactly 10 digits");
    canada.customsItems = [{ ...canada.customsItems[0]!, hsCode: "6109100010" }];
    expect(buildCreateShipmentBody(canada, SETTINGS).invoice!.items[0]!.hsCode).toBe("6109100010");

    for (const code of ["2106909800", "6309000010"]) {
      const kg = sampleRequest();
      kg.customsItems = [{ ...kg.customsItems[0]!, hsCode: code }];
      expect(rejection(() => buildCreateShipmentBody(kg, SETTINGS)).details[0]!.message, code).toContain("kilograms");
    }
  });

  it("ThirdPerson without contract, long reference, missing phone, missing dimensions, zero value → rejected", () => {
    expect(rejection(() => buildCreateShipmentBody(sampleRequest(), { ...SETTINGS, payerType: "ThirdPerson" })).details[0]!.field).toBe(
      "novaPost.payerContractNumber",
    );
    expect(rejection(() => buildCreateShipmentBody(sampleRequest({ reference: "R".repeat(51) }), SETTINGS)).details[0]!.carrierCode).toBe("clientOrder");
    const noPhone = sampleRequest();
    noPhone.recipient = { ...noPhone.recipient, phone: " " };
    expect(rejection(() => buildCreateShipmentBody(noPhone, SETTINGS)).details[0]!.field).toBe("shipping.phone");
    const noDims = sampleRequest();
    noDims.parcels = [{ ...noDims.parcels[0]!, lengthCm: null }];
    expect(rejection(() => buildCreateShipmentBody(noDims, SETTINGS)).details[0]!.carrierCode).toBe("parcels.0.length");
    expect(rejection(() => buildCreateShipmentBody(sampleRequest({ declaredValue: { amount: "0.00", currency: "EUR" } }), SETTINGS)).details[0]!.carrierCode).toBe(
      "parcels.insuranceCost",
    );
  });

  it("customs items must use the invoice currency and a valid invoice date", () => {
    const req = sampleRequest();
    req.customsItems = [{ ...req.customsItems[0]!, unitValue: { amount: "24.90", currency: "USD" } }];
    req.customs = { ...req.customs!, invoiceDate: "26.11.2026" };
    const err = rejection(() => buildCreateShipmentBody(req, SETTINGS));
    expect(err.details.map((d) => d.carrierCode)).toEqual(["invoice.items.0.cost", "invoice.customerCreatedAt"]);
  });
});

describe("invoice item weights", () => {
  it("allocates the parcel weight proportionally in 10 g steps, at least 10 g per item, exact sum", () => {
    expect(allocateItemWeights(480, [300, 100])).toEqual([360, 120]);
    expect(allocateItemWeights(1000, [0, 0, 0])).toEqual([340, 330, 330]);
    expect(allocateItemWeights(20, [5000, 1])).toEqual([10, 10]);
    expect(allocateItemWeights(10, [1, 1])).toBeNull();
    const w = allocateItemWeights(12340, [123, 4567, 89, 1]);
    expect(w!.reduce((a, b) => a + b, 0)).toBe(12340);
    expect(w!.every((x) => x >= 10 && x % 10 === 0)).toBe(true);
  });
});

describe("Nova Post error bodies", () => {
  it("parses the documented {errors: {field: message}} map and maps fields", () => {
    const details = parseNovaPostErrors({
      errors: {
        "recipient.phone": "Phone number must include the country code",
        "recipient.addressParts.city": "validation.condition.recipient_settlement_not_defined",
        "sender.divisionNumber": "validation.exists",
        "parcels.0.insuranceCost": "The parcels.0.insurance cost field must be greater than 0.",
      },
    });
    expect(details).toEqual([
      { field: "shipping.phone", carrierCode: "recipient.phone", message: "Phone number must include the country code" },
      { field: "shipping.city", carrierCode: "recipient.addressParts.city", message: "validation.condition.recipient_settlement_not_defined" },
      { field: "shipper.carrierBranch", carrierCode: "sender.divisionNumber", message: "validation.exists" },
      { carrierCode: "parcels.0.insuranceCost", message: "The parcels.0.insurance cost field must be greater than 0." },
    ]);
  });

  it("parses arrays, generic messages, {message} bodies and raw text defensively", () => {
    expect(parseNovaPostErrors({ errors: { "recipient.name": ["too long", "required"] } }).map((d) => d.field)).toEqual(["order", "order"]);
    expect(parseNovaPostErrors({ errors: [{ field: "sender.ioss", message: "bad" }, "plain"] })).toEqual([
      { field: "shipper.ioss", carrierCode: "sender.ioss", message: "bad" },
      { message: "plain" },
    ]);
    expect(parseNovaPostErrors({ errors: { errorMessage: "shipment_was_deleted" } })).toEqual([{ carrierCode: "errorMessage", message: "shipment_was_deleted" }]);
    expect(parseNovaPostErrors({ errors: { "": "x" } })).toEqual([{ message: "x" }]);
    expect(parseNovaPostErrors({ message: "Invalid request parameters" })).toEqual([{ message: "Invalid request parameters" }]);
    expect(parseNovaPostErrors(null, "Bad Gateway")).toEqual([{ message: "Bad Gateway" }]);
    expect(parseNovaPostErrors(null, null)).toEqual([]);
  });

  it("field mapping covers the documented recipient/sender paths", () => {
    expect(mapNovaPostErrorField("recipient.addressParts.postCode")).toBe("shipping.postalCode");
    expect(mapNovaPostErrorField("recipient.addressParts.street")).toBe("shipping.address1");
    expect(mapNovaPostErrorField("recipient.addressParts.region")).toBe("shipping.province");
    expect(mapNovaPostErrorField("recipient.countryCode")).toBe("shipping.countryCode");
    expect(mapNovaPostErrorField("sender.phone")).toBe("shipper.phone");
    expect(mapNovaPostErrorField("sender.name")).toBe("shipper.contactName");
    expect(mapNovaPostErrorField("sender.companyTin")).toBe("shipper.taxId");
    expect(mapNovaPostErrorField("sender.eoriCode")).toBe("shipper.eori");
    expect(mapNovaPostErrorField("sender.divisionID")).toBe("shipper.carrierBranch");
    expect(mapNovaPostErrorField("invoice.items.0.hsCode")).toBeUndefined();
  });
});

describe("print parameters", () => {
  it("maps document kinds and enforces one number per marking request", () => {
    expect(buildPrintQuery("label", ["20450000000001"])).toEqual({ "numbers[]": ["20450000000001"], type: "marking", printSizeType: "size_100_100" });
    expect(buildPrintQuery("invoice", ["1", "2"])).toEqual({ "numbers[]": ["1", "2"], type: "invoice", printSizeType: "size_A4" });
    expect(buildPrintQuery("customs_declaration", ["1"])).toMatchObject({ type: "international", printSizeType: "size_A4" });
    expect(() => buildPrintQuery("label", ["1", "2"])).toThrow(/exactly one/);
    expect(() => buildPrintQuery("label", [" "])).toThrow(CarrierError);
    expect(documentFileName("customs_declaration", "2045 0000/01")).toBe("customs-declaration-2045000001.pdf");
    expect(looksLikePdf(null, new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBe(true);
    expect(looksLikePdf("application/json", new TextEncoder().encode("{}"))).toBe(false);
  });
});

describe("tracking status codes", () => {
  const EXPECTED: Record<TrackingStatus, string[]> = {
    created: ["1"],
    cancelled: ["2"],
    accepted: ["4"],
    in_transit: ["5", "6", "13", "16", "17", "19", "80", "81", "121"],
    out_for_delivery: ["7", "8", "101", "110", "135", "149"],
    delivered: ["9", "10", "11"],
    customs: ["30", "31", "114", "115", "119", "120", "122", "125", "126", "127", "128", "134", "197", "198", "199"],
    failed_attempt: ["111", "112"],
    lost: ["117"],
    exception: ["99", "102", "103", "104", "105", "106", "113", "116", "118", "123", "130", "131", "132", "133", "138", "141", "144", "155"],
    returned: [],
    unknown: ["999"],
  };

  it("maps every documented code (58) exactly once", () => {
    const all = Object.values(EXPECTED).flat();
    expect(all).toHaveLength(58);
    expect(new Set(all).size).toBe(58);
    expect([...NOVA_POST_DOCUMENTED_TRACKING_CODES].sort()).toEqual([...all].sort());
    for (const [status, codes] of Object.entries(EXPECTED)) {
      for (const code of codes) {
        expect(mapNovaPostTrackingCode(code), `code ${code}`).toBe(status);
        expect(NOVA_POST_TRACKING_CODES[code]).toBe(status);
      }
    }
  });

  it("accepts numeric codes and maps unknown/empty codes to unknown", () => {
    expect(mapNovaPostTrackingCode(9)).toBe("delivered");
    expect(mapNovaPostTrackingCode(" 4 ")).toBe("accepted");
    for (const c of ["3", "12", "1000", "", "abc", null, undefined, "toString", "__proto__"]) expect(mapNovaPostTrackingCode(c)).toBe("unknown");
  });

  it("builds snapshots: Future events dropped, ascending order, location, unknown numbers skipped", () => {
    const snaps = buildTrackingSnapshots(
      {
        currentStatus: [{ number: "20450000000001", statusCode: "7", status: "Arrived (at the Division)", statusDate: "2026-11-25T08:00:00Z" }],
        historyOnlineTracking: [
          // countryCode у записі — країна ВІДПРАВНИКА (документація), тому в місце події не потрапляє.
          { number: "20450000000001", date: "2026-11-25T08:00:00Z", code: "7", event: "ArrivalRecipientWarehouse", eventStatus: "Now", settlementName: "Berlin", divisionName: "Test branch 1", countryCode: "UA" },
          { number: "20450000000001", date: "2026-11-20 10:00:00", code: "1", event: "CreateID", eventStatus: "Passed", settlementName: "Kyiv", countryCode: "UA" },
          { number: "20450000000001", date: "2026-11-27T10:00:00Z", code: "9", event: "ReceivedWarehouseFuture", eventStatus: "Future" },
          { number: "20450000000001", date: null, code: "4", eventStatus: "Passed" },
        ],
      },
      ["20450000000001", "20450000000099"],
    );
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({ waybillNumber: "20450000000001", status: "out_for_delivery", carrierStatusCode: "7", carrierStatusText: "Arrived (at the Division)" });
    expect(snaps[0]!.events.map((e) => [e.code, e.status, e.location, e.description])).toEqual([
      ["1", "created", "Kyiv", "CreateID"],
      ["7", "out_for_delivery", "Berlin, Test branch 1", "ArrivalRecipientWarehouse"],
    ]);
    // Дата без зони трактується як UTC (документація: ISO 8601, UTC).
    expect(snaps[0]!.events[0]!.occurredAt.toISOString()).toBe("2026-11-20T10:00:00.000Z");
  });
});

describe("rates mapping", () => {
  it("one quote per tariff: sums cost rows, uses documented tariff name as service code, settings currency", () => {
    const quotes = mapCalculationToQuotes(
      {
        scheduledDeliveryDate: "2026-12-03T00:00:00.000000Z",
        services: [
          { deliveryType: "uuid-standard", deliveryTypeName: "standard", serviceName: "Delivery", cost: 410.5, price: 450, recipientPayerFeesCustomsCost: 12.3 },
          { deliveryType: "uuid-standard", deliveryTypeName: "standard", serviceName: "Insurance", cost: 0.1, recipientPayerFeesCustomsCost: 12.3 },
          { deliveryType: "uuid-express", deliveryTypeName: "express", cost: "799.995" },
          { deliveryType: "uuid-other", deliveryTypeName: "special", cost: null },
        ],
      },
      { tariffCurrency: "UAH", incoterm: "DAP", invoiceSent: true },
    );
    expect(quotes).toEqual([
      {
        serviceCode: "standard",
        serviceName: "standard",
        price: { amount: "410.60", currency: "UAH" },
        minDeliveryDays: null,
        maxDeliveryDays: null,
        estimatedDeliveryDate: "2026-12-03",
        dutiesEstimate: { amount: "12.30", currency: "UAH" },
      },
      {
        serviceCode: "express",
        serviceName: "express",
        price: { amount: "800.00", currency: "UAH" },
        minDeliveryDays: null,
        maxDeliveryDays: null,
        estimatedDeliveryDate: "2026-12-03",
        dutiesEstimate: null,
      },
    ]);
  });

  it("tariffs without a documented deliveryTypeName are skipped (a UUID is never a service code)", () => {
    const res = {
      services: [
        { deliveryType: "uuid-x", deliveryTypeName: "special", cost: 5 },
        { deliveryType: "uuid-y", cost: 6 },
        { deliveryType: "uuid-e", deliveryTypeName: "Economy", cost: 5, senderPayerFeesCustomsCost: 7, recipientPayerFeesCustomsCost: 1 },
      ],
    };
    const quotes = mapCalculationToQuotes(res, { tariffCurrency: "UAH", incoterm: "DDP", invoiceSent: true });
    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toMatchObject({ serviceCode: "economy", dutiesEstimate: { amount: "7.00", currency: "UAH" }, estimatedDeliveryDate: null });
    expect(mapCalculationToQuotes(res, { tariffCurrency: "UAH", incoterm: "DAP", invoiceSent: false })[0]!.dutiesEstimate).toBeNull();
    expect(mapCalculationToQuotes({ services: [{ deliveryType: "uuid-y", cost: 6 }] }, { tariffCurrency: "UAH", incoterm: "DAP", invoiceSent: false })).toEqual([]);
    expect(mapCalculationToQuotes(null, { tariffCurrency: "UAH", incoterm: "DAP", invoiceSent: false })).toEqual([]);
  });

  it("exact money helpers", () => {
    expect(amountToMinor(1.005)).toBe(101n);
    expect(amountToMinor(0.1)).toBe(10n);
    expect(amountToMinor("349.00")).toBe(34900n);
    expect(amountToMinor(-1)).toBeNull();
    expect(amountToMinor("abc")).toBeNull();
    expect(convertMoney({ amount: "10.00", currency: "EUR" }, "UAH", [{ currency: "EUR", rate: "45.123456" }])).toEqual({ amount: "451.24", currency: "UAH" });
    expect(convertMoney({ amount: "10.5", currency: "UAH" }, "UAH")).toEqual({ amount: "10.50", currency: "UAH" });
    expect(convertMoney({ amount: "10.00", currency: "USD" }, "UAH", [{ currency: "EUR", rate: "45" }])).toBeNull();
  });
});

describe("reference matching", () => {
  it("matches exact value or a separated token only", () => {
    expect(clientOrderMatches("OT-1001-1", "OT-1001-1")).toBe(true);
    expect(clientOrderMatches("#1001, OT-1001-1", "OT-1001-1")).toBe(true);
    expect(clientOrderMatches("OT-1001-12", "OT-1001-1")).toBe(false);
    expect(clientOrderMatches(null, "OT-1001-1")).toBe(false);
  });
});
