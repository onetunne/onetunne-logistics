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
  /** Регіон/штат одержувача (для США — дволітерний код штату, за документацією). */
  recipientRegion?: string | null;
  /**
   * insuranceCost — оголошена вартість посилки для страхування у валюті країни відправника (для UA — гривні).
   * Обов'язкове поле: API повертає 422 "parcels.0.insuranceCost field is required" (перевірено на робочому API 2026-11-26).
   */
  parcels: Array<{ weightGrams: number; lengthMm: number; widthMm: number; heightMm: number; insuranceCost: number }>;
  payerType?: "Sender" | "Recipient" | "ThirdPerson";
  /**
   * Номер договору платника. Документація: обов'язковий для ThirdPerson у Європі/з Європи в Україну,
   * «для відправлень з України не обов'язковий». Вплив на тариф не документований — передаємо, якщо задано.
   */
  payerContractNumber?: string | null;
  /**
   * ЄДРПОУ/ІПН і назва компанії відправника. Документація: якщо платник — відправник-юрособа,
   * ці поля застосовують індивідуальну знижку контрагента.
   */
  senderCompanyTin?: string | null;
  senderCompanyName?: string | null;
  deliveryTypes?: Array<"standard" | "economy" | "express">;
  /** Дані інвойсу для розрахунку мита (необов'язково). */
  invoice?: {
    incoterm: "DAP" | "DDP";
    currency: string;
    cost: number;
    payerFeesCustoms?: "Sender" | "Recipient";
    items?: Array<{ hsCode: string; amount: number; cost: number }>;
  };
}

const clean = <T extends Record<string, unknown>>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== "")) as Partial<T>;

export function buildCalculationRequest(input: CalculationInput) {
  return clean({
    payerType: input.payerType ?? "Sender",
    payerContractNumber: input.payerContractNumber ?? undefined,
    deliveryTypes: input.deliveryTypes,
    invoice: input.invoice ? clean(input.invoice) : undefined,
    sender: clean({
      companyTin: input.senderCompanyTin ?? undefined,
      companyName: input.senderCompanyName ?? undefined,
      countryCode: input.senderCountry,
      divisionNumber: input.senderDivisionNumber ?? undefined,
      addressParts: clean({ city: input.senderCity ?? undefined, postCode: input.senderPostCode ?? undefined }),
    }),
    recipient: clean({
      countryCode: input.recipientCountry,
      addressParts: clean({
        city: input.recipientCity ?? undefined,
        region: input.recipientRegion ?? undefined,
        postCode: input.recipientPostCode ?? undefined,
      }),
    }),
    parcels: input.parcels.map((p, i) => ({
      rowNumber: i + 1,
      cargoCategory: "parcel",
      // Документація: точність 10 г, менші значення округлюються вниз — округлюємо вгору самі, щоб не занижувати вагу.
      actualWeight: Math.ceil(p.weightGrams / 10) * 10,
      length: Math.round(p.lengthMm),
      width: Math.round(p.widthMm),
      height: Math.round(p.heightMm),
      insuranceCost: p.insuranceCost,
    })),
  });
}

export interface CalculationService {
  serviceType?: string;
  serviceName?: string;
  serviceCode?: string;
  cost?: number;
  price?: number;
  discount?: number;
  deliveryType?: string;
  deliveryTypeName?: string;
  /** Оцінка мит, якщо їх сплачує одержувач / відправник (за наявності інвойсу). */
  recipientPayerFeesCustomsCost?: number;
  senderPayerFeesCustomsCost?: number;
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
    // deliveryType у відповіді — ідентифікатор (UUID); для людини зрозуміліша назва тарифу.
    const key = s.deliveryTypeName ?? s.serviceName ?? s.deliveryType ?? "default";
    byType.set(key, (byType.get(key) ?? 0) + (typeof s.cost === "number" ? s.cost : 0));
  }
  return {
    services: services.length,
    totals: Object.fromEntries(byType),
    scheduledDeliveryDate: r?.scheduledDeliveryDate ?? null,
  };
}
