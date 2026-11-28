/**
 * Золоті випадки етапу 6 (§20.1) як дані для WP12b: вхідні факти й очікувані значення G1–G19. Самоперевірка моделі
 * на цих числах — ../reference-golden.test.ts. Очікування G1, G1b, G2, G8–G12 для фактів замовлень зібрано в
 * ORDER_EXPECTED нижче (числа §20.1; «похідне» — пораховано незалежно).
 */
export * from "./rates";
export * from "./orders";
export * from "./journals";
export * from "./shipping";
export * from "./costing";
export * from "./misc";

/** Очікування золотих випадків рівня замовлення (UAH, якщо не сказано інше). */
export const ORDER_EXPECTED = {
  G1: {
    octoberBeforeImport: { turnover: "6256.50", A: "5674.50", B: "582.00", grossProfit: "5206.50", profitFact: null, profitFactOrders: 0, orders: 1, profitForecast: "3902.11" },
    octoberAfterImport: { profitFact: "3882.11", state: "final", amountVsForecast: false },
    november: { profitFact: "-1576.40", D: "-2196.00", cogsReturn: "400.00", partner: "219.60" },
    allTime: { profitFact: "2305.71", netRevenue: "4060.50", orderMargin: "56.8", periodMargin: "56.8" },
    card: {
      state: "preliminary",
      productsNet: "72.00",
      productsSold: "117.00",
      productsReturned: "-45.00",
      beforeDiscounts: "130.00",
      discounts: "-13.00",
      shippingPaid: "12.00",
      cogsNet: "-650.00",
      cogsWrittenOff: "-1050.00",
      cogsReturns: "400.00",
      packaging: "-21.00",
      shippingForecast: "-520.00",
      fees: "-4.04",
      partnerNet: "-7.20",
      partnerAccrued: "-11.70",
      partnerAdjustments: "4.50",
      profitForecast: "2325.71",
      margin: "57.3",
      paid: { received: "129.00", refunded: "45.00", net: "84.00" },
    },
    eur: { cogsA: "-16.49", cogsB: "-5.15", packaging: "-0.43", shipping: "-11.13", octoberAfterImport: "80.06", octoberTotalConvertedOnce: "80.04", octoberBeforeImport: "80.47", shippingForecast: "-10.72", november: "-32.30", cogsReturn: "8.20", allTime: "47.76", margin: "56.9" },
    partner: { accrual: "11.70", adjustment: "-4.50", net: "7.20", holdUntil: "2026-11-04", stateOn0411: "accrued_hold", stateOn0511: "payable", payableOn0511: "7.20" },
  },
  G1b: { paymentDatePolicy: { revenue: "4800.00", fxOn: "2026-10-01" }, recognitionDatePolicy: { revenue: "4850.00", fxOn: "2026-10-05" }, cogs: { recognizedOn: "2026-10-05", fxOn: "2026-10-05" } },
  G2: { salesProduct: "50.00", taxProduct: "9.50", salesShipping: "8.40", taxShipping: "1.60", paid: "69.50", turnover: "58.40", partnerBase: "50.00", partnerCommission: "5.00", reconcileFailures: [] as string[] },
  G8: { state: "incomplete", missing: ["cogs", "fees"], cardProfit: null, profitFact: null, profitForecast: null, notCountedOrders: 1, turnoverEur: "80.00" },
  G8b: { table: "preliminary", nothing: "incomplete", ownerMark: "final" },
  G10: { chargebackLoss: "-129.00", chargebackFee: "-15.00", recognizedOn: "2026-11-12", partnerCancellation: "11.70", partnerNet: "0.00", overlapFlag: "chargeback_refund_overlap" },
  G10b: {
    default: { loss: ["-41.59", "-7.91"], partnerAdjustment: "4.16", partnerNet: "0.84" },
    vat: { loss: "-41.59", taxMemoReversal: "-7.91" },
    cancel: { partnerNet: "0.00" },
  },
  G10c: { refundAdjustment: "-129.00", partnerBase: "0.00", partnerNet: "0.00" },
  G12: { placedOn: "2026-10-31", recognizedOn: "2026-11-02", refundOn: "2026-11-05" },
} as const;

/** Перелік золотих випадків (для звіту покриття WP12b). */
export const GOLDEN_CASE_IDS = ["G1", "G1b", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G8b", "G9", "G10", "G10b", "G10c", "G11", "G11b", "G12", "G13", "G14", "G14b", "G15", "G16", "G17", "G18", "G19"] as const;
