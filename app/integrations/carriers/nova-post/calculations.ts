/**
 * Розрахунок вартості доставки: POST /shipments/calculations (Nova Post API v1.0).
 * Метод лише розраховує вартість і строк — відправлення НЕ створюється.
 * Одиниці (за документацією): вага — грами (точність 10 г), габарити — міліметри.
 */
export interface CalculationInput {
  senderCountry: string;
  senderCity?: string | null;
  senderPostCode?: string | null;
  senderDivisionNumber?: string | null;
  recipientCountry: string;
  recipientCity?: string | null;
  recipientPostCode?: string | null;
  parcels: Array<{ weightGrams: number; lengthMm: number; widthMm: number; heightMm: number; insuranceCost?: number }>;
  payerType?: "Sender" | "Recipient";
  deliveryTypes?: Array<"standard" | "economy" | "express">;
}

const clean = <T extends Record<string, unknown>>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== "")) as Partial<T>;

export function buildCalculationRequest(input: CalculationInput) {
  return clean({
    payerType: input.payerType ?? "Sender",
    deliveryTypes: input.deliveryTypes,
    sender: clean({
      countryCode: input.senderCountry,
      divisionNumber: input.senderDivisionNumber ?? undefined,
      addressParts: clean({ city: input.senderCity ?? undefined, postCode: input.senderPostCode ?? undefined }),
    }),
    recipient: clean({
      countryCode: input.recipientCountry,
      addressParts: clean({ city: input.recipientCity ?? undefined, postCode: input.recipientPostCode ?? undefined }),
    }),
    parcels: input.parcels.map((p, i) => ({
      rowNumber: i + 1,
      cargoCategory: "parcel",
      // Документація: точність 10 г, менші значення округлюються вниз — округлюємо вгору самі, щоб не занижувати вагу.
      actualWeight: Math.ceil(p.weightGrams / 10) * 10,
      length: Math.round(p.lengthMm),
      width: Math.round(p.widthMm),
      height: Math.round(p.heightMm),
      ...(p.insuranceCost ? { insuranceCost: p.insuranceCost } : {}),
    })),
  });
}

export interface CalculationService {
  serviceType?: string;
  serviceName?: string;
  serviceCode?: string;
  cost?: number;
  price?: number;
  deliveryType?: string;
  deliveryTypeName?: string;
}

export interface CalculationResponse {
  scheduledDeliveryDate?: string | null;
  services?: CalculationService[];
}

/** Підсумок для журналу/UI без персональних даних. */
export function summarizeCalculation(r: CalculationResponse | null) {
  const services = r?.services ?? [];
  const byType = new Map<string, number>();
  for (const s of services) {
    const key = s.deliveryType ?? "default";
    byType.set(key, (byType.get(key) ?? 0) + (typeof s.cost === "number" ? s.cost : 0));
  }
  return {
    services: services.length,
    totals: Object.fromEntries(byType),
    scheduledDeliveryDate: r?.scheduledDeliveryDate ?? null,
  };
}
