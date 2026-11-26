/** Етап 3: комерційний інвойс / митні позиції (чистий модуль, без вигадування даних). */
import { describe, expect, it } from "vitest";
import {
  buildCommercialInvoice,
  invoiceNumberFor,
  kyivDate,
  toCustomsDeclaration,
  toCustomsItems,
  transactionUnitValues,
  withSentCustomsData,
} from "~/modules/customs/invoice";
import { DEFAULT_SETTINGS } from "~/modules/settings/schema";

const order = {
  orderNumber: "#1042",
  currency: "EUR",
  shippingPaid: "12.50",
  email: "buyer@example.com",
  shipFirstName: "Anna",
  shipLastName: "Test",
  shipCompany: null,
  shipAddress1: "Hauptstr. 1",
  shipAddress2: null,
  shipCity: "Berlin",
  shipProvince: null,
  shipPostalCode: "10115",
  shipCountryCode: "DE",
  shipPhone: "+4915112345678",
};

const settings = {
  shipper: { ...DEFAULT_SETTINGS.shipper, companyName: "ONE TUNNE", contactName: "Owner", taxId: "12345678", eori: "UA123456", ioss: "IM1234567890" },
  customs: { incoterm: "DAP" as const, exportReason: "sale" as const, invoiceType: "commercial" as const, recipientRegistrationAddress: "none" as const },
};

describe("commercial invoice", () => {
  it("builds lines, totals and customs declaration with exact money", () => {
    const inv = buildCommercialInvoice({
      order,
      settings,
      issuedAt: new Date("2026-11-25T23:30:00Z"), // у Києві вже 26.11
      items: [
        {
          title: "Scooter mirror",
          sku: "M-1",
          quantity: 3,
          unitPrice: "19.99",
          currency: "EUR",
          variant: { sku: "M-1", weightGrams: 120, hsCode: "8714.10", countryOfOrigin: "ua", customsDescription: "Scooter mirror", customsDescriptionLocal: "Дзеркало для самоката", material: "Plastic" },
        },
        {
          title: "Phone holder",
          sku: null,
          quantity: 1,
          unitPrice: "0.10",
          currency: "EUR",
          variant: { sku: null, weightGrams: null, hsCode: null, countryOfOrigin: null, customsDescription: null },
        },
      ],
    });
    expect(inv.number).toBe("INV-1042");
    expect(inv.date).toBe("2026-11-26");
    expect(inv.goodsTotal).toBe("60.07");
    expect(inv.shippingCharge).toBe("12.50");
    expect(inv.total).toBe("72.57");
    expect(inv.totalWeightGrams).toBe(360);
    expect(inv.lines[0]).toMatchObject({ hsCode: "871410", countryOfOrigin: "UA", lineValue: "59.97", lineWeightGrams: 360 });
    expect(inv.seller).toMatchObject({ taxId: "12345678", eori: "UA123456", ioss: "IM1234567890" });
    expect(inv.buyer.ioss).toBeNull();
    // Відсутні дані не вигадуються — позначаються.
    expect(inv.missing).toEqual([
      { position: 2, field: "hsCode" },
      { position: 2, field: "countryOfOrigin" },
      { position: 2, field: "customsDescription" },
      { position: 2, field: "weight" },
    ]);
    expect(toCustomsDeclaration(inv)).toEqual({
      invoiceNumber: "INV-1042",
      invoiceDate: "2026-11-26",
      invoiceType: "commercial",
      incoterm: "DAP",
      exportReason: "sale",
      totalValue: { amount: "60.07", currency: "EUR" },
    });
    const items = toCustomsItems(inv);
    expect(items[0]).toMatchObject({ description: "Scooter mirror", descriptionLocal: "Дзеркало для самоката", weightGrams: 120, quantity: 3, material: "Plastic" });
    expect(items[1]).toMatchObject({ hsCode: "", countryOfOrigin: "", weightGrams: 0 });
  });

  it("helpers", () => {
    expect(invoiceNumberFor("#10 42/Б")).toBe("INV-1042");
    expect(kyivDate(new Date("2026-06-30T21:30:00Z"))).toBe("2026-07-01");
  });

  it("declares the transaction value after discounts (order subtotal), not the pre-discount price", () => {
    const variant = { sku: "B-1", weightGrams: 250, hsCode: "420292", countryOfOrigin: "UA", customsDescription: "Textile bag" };
    // €160 товарів зі знижкою 20 % → клієнт сплатив €128 (subtotalPriceSet).
    const inv = buildCommercialInvoice({
      order: { ...order, subtotal: "128.00" },
      settings,
      issuedAt: new Date("2026-11-25T10:00:00Z"),
      items: [
        { title: "Bag", sku: "B-1", quantity: 2, unitPrice: "50.00", currency: "EUR", variant },
        { title: "Light", sku: "L-1", quantity: 1, unitPrice: "60.00", currency: "EUR", variant: { ...variant, sku: "L-1" } },
      ],
    });
    expect(inv.lines.map((l) => [l.unitValue, l.lineValue])).toEqual([
      ["40.00", "80.00"],
      ["48.00", "48.00"],
    ]);
    expect(inv.goodsTotal).toBe("128.00");
    expect(toCustomsDeclaration(inv).totalValue).toEqual({ amount: "128.00", currency: "EUR" });
    expect(toCustomsItems(inv)[0]!.unitValue).toEqual({ amount: "40.00", currency: "EUR" });
    // Без знижки (subtotal = сума позицій) або без subtotal — ціни без змін.
    const plain = buildCommercialInvoice({ order: { ...order, subtotal: "60.07" }, settings, issuedAt: new Date(), items: [
      { title: "Mirror", sku: null, quantity: 3, unitPrice: "19.99", currency: "EUR", variant },
      { title: "Holder", sku: null, quantity: 1, unitPrice: "0.10", currency: "EUR", variant },
    ] });
    expect(plain.goodsTotal).toBe("60.07");
  });

  it("allocates an uneven discount exactly (largest remainder) and rounds unit values to cents", () => {
    // Σ = 3 × 10.00 + 1 × 5.00 = 35.00; сплачено 25.00 → знижка 10.00 (8.57 + 1.43).
    expect(transactionUnitValues([{ unitPrice: "10.00", quantity: 3 }, { unitPrice: "5.00", quantity: 1 }], "25.00")).toEqual(["7.14", "3.57"]);
    expect(transactionUnitValues([{ unitPrice: "10.00", quantity: 1 }], null)).toEqual(["10.00"]);
    expect(transactionUnitValues([{ unitPrice: "10.00", quantity: 1 }], "12.00")).toEqual(["10.00"]); // subtotal більший — не знижка
    expect(transactionUnitValues([{ unitPrice: "10.00", quantity: 1 }], "0.00")).toEqual(["0.00"]); // 100 % знижка
    const three = transactionUnitValues([{ unitPrice: "1.00", quantity: 1 }, { unitPrice: "1.00", quantity: 1 }, { unitPrice: "1.00", quantity: 1 }], "2.00");
    expect(three.reduce((a, v) => a + Math.round(Number(v) * 100), 0)).toBe(200);
  });

  it("print copy follows the data sent to the carrier (date, incoterm, HS, values)", () => {
    const items = [
      {
        title: "Scooter mirror",
        sku: "M-1",
        quantity: 2,
        unitPrice: "19.99",
        currency: "EUR",
        variant: { sku: "M-1", weightGrams: 120, hsCode: "871410", countryOfOrigin: "UA", customsDescription: "Scooter mirror" },
      },
    ];
    const current = buildCommercialInvoice({ order, items, settings: { ...settings, customs: { ...settings.customs, incoterm: "DDP" as const } }, issuedAt: new Date("2026-11-25T10:00:00Z") });
    const sentInvoice = buildCommercialInvoice({ order, items, settings, issuedAt: new Date("2026-11-27T10:00:00Z") });
    const sent = { customs: toCustomsDeclaration(sentInvoice), customsItems: toCustomsItems(sentInvoice).map((i) => ({ ...i, hsCode: "87141000" })) };
    const printed = withSentCustomsData(current, sent);
    expect(printed.date).toBe("2026-11-27");
    expect(printed.incoterm).toBe("DAP");
    expect(printed.lines[0]).toMatchObject({ hsCode: "87141000", unitValue: "19.99", lineValue: "39.98", title: "Scooter mirror" });
    expect(printed.goodsTotal).toBe("39.98");
    expect(printed.total).toBe("52.48");
    // Немає знімка (накладної ще немає / старий формат) — поточні дані.
    expect(withSentCustomsData(current, null)).toBe(current);
    expect(withSentCustomsData(current, { customs: null })).toBe(current);
  });
});

