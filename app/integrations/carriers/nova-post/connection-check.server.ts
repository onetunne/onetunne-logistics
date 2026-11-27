/**
 * Перевірка підключення Nova Post API v1.0 з інтерфейсу (власник) — ЛИШЕ читання, накладні НЕ створюються:
 * 1) отримання JWT за ключем;
 * 2) розрахунок вартості зразкової посилки без договору і з договором/реквізитами (порівняння цін і знижок);
 * 3) перелік останніх відправлень кабінету (GET /shipments, limit 5) — лише валюта договору (currencyCode) і кількість.
 * Мета — підтвердити валюту сум і застосування договірних тарифів ДО використання вартості в Checkout.
 * Результат не містить ключа, JWT і персональних даних (адреси зразка — вигадані, з відправлень беремо лише валюту).
 */
import { CarrierError } from "../types";
import { buildCalculationRequest, type CalculationInput } from "./calculations";
import { NovaPostClient, type FetchLike } from "./client.server";

export interface CheckServiceRow {
  deliveryType: string | null;
  name: string | null;
  cost: number | null;
  price: number | null;
  discount: number | null;
}

export interface CheckCalculation {
  label: "base" | "contract";
  ok: boolean;
  status: number | null;
  error: string | null;
  services: CheckServiceRow[];
  /** Усі поля відповіді, назва яких містить "currency" (шлях → значення). */
  currencyFields: Record<string, string>;
  /** Назви полів верхнього рівня та послуги — щоб бачити, чи є в відповіді валюта. */
  responseKeys: string[];
}

export interface NovaPostConnectionCheck {
  endpointHost: string;
  authorized: boolean;
  authError: string | null;
  calculations: CheckCalculation[];
  shipments: { ok: boolean; status: number | null; total: number | null; currencyCodes: string[]; error: string | null };
  checkedAt: string;
}

export interface ConnectionCheckInput {
  apiKey: string;
  baseUrl: string;
  sender: { countryCode: string; city: string; postalCode: string; divisionNumber: string; companyTin: string; companyName: string };
  payerType: "Sender" | "Recipient" | "ThirdPerson";
  payerContractNumber: string;
  fetch?: FetchLike;
  now?: () => Date;
}

const SAMPLE_RECIPIENT = { recipientCountry: "DE", recipientCity: "Berlin", recipientPostCode: "10178" } as const;
// Оголошена вартість зразка — 1000 грн (валюта країни відправника, як вимагає документація).
const SAMPLE_PARCEL = { weightGrams: 500, lengthMm: 300, widthMm: 200, heightMm: 100, insuranceCost: 1000 };

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function collectCurrencyFields(value: unknown, path: string, out: Record<string, string>, depth = 0) {
  if (depth > 5 || value === null || typeof value !== "object") return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const p = path ? `${path}.${k}` : k;
    if (/currency/i.test(k) && (typeof v === "string" || typeof v === "number")) out[p] = String(v).slice(0, 10);
    else collectCurrencyFields(v, Array.isArray(value) ? path : p, out, depth + 1);
  }
}

function errorText(e: unknown): string {
  return e instanceof CarrierError ? `${e.kind}: ${e.message}`.slice(0, 300) : "error";
}

export async function checkNovaPostConnection(input: ConnectionCheckInput): Promise<NovaPostConnectionCheck> {
  const client = new NovaPostClient({ apiKey: input.apiKey, baseUrl: input.baseUrl, fetch: input.fetch });
  const result: NovaPostConnectionCheck = {
    endpointHost: new URL(input.baseUrl).host,
    authorized: false,
    authError: null,
    calculations: [],
    shipments: { ok: false, status: null, total: null, currencyCodes: [], error: null },
    checkedAt: (input.now?.() ?? new Date()).toISOString(),
  };
  try {
    await client.authorize(true);
    result.authorized = true;
  } catch (e) {
    result.authError = errorText(e);
    return result;
  }

  const s = input.sender;
  const base: CalculationInput = {
    senderCountry: s.countryCode || "UA",
    senderCity: s.divisionNumber ? null : s.city || "Київ",
    senderPostCode: s.divisionNumber ? null : s.postalCode || "01001",
    senderDivisionNumber: s.divisionNumber || null,
    ...SAMPLE_RECIPIENT,
    parcels: [SAMPLE_PARCEL],
    payerType: "Sender",
  };
  const variants: Array<[CheckCalculation["label"], CalculationInput]> = [["base", base]];
  if (input.payerContractNumber || s.companyTin) {
    variants.push([
      "contract",
      {
        ...base,
        payerType: input.payerType,
        payerContractNumber: input.payerContractNumber || null,
        senderCompanyTin: s.companyTin || null,
        senderCompanyName: s.companyName || null,
      },
    ]);
  }
  for (const [label, calc] of variants) {
    const row: CheckCalculation = { label, ok: false, status: null, error: null, services: [], currencyFields: {}, responseKeys: [] };
    try {
      const res = await client.request<Record<string, unknown>>("POST", "/shipments/calculations", buildCalculationRequest(calc));
      row.status = res.status;
      if (res.body) {
        row.ok = true;
        const services = Array.isArray(res.body.services) ? (res.body.services as Record<string, unknown>[]) : [];
        row.services = services.map((sv) => ({
          deliveryType: typeof sv.deliveryTypeName === "string" ? sv.deliveryTypeName : null,
          name: typeof sv.serviceName === "string" ? sv.serviceName.slice(0, 80) : null,
          cost: num(sv.cost),
          price: num(sv.price),
          discount: num(sv.discount),
        }));
        collectCurrencyFields(res.body, "", row.currencyFields);
        row.responseKeys = [...new Set([...Object.keys(res.body), ...services.flatMap((sv) => Object.keys(sv).map((k) => `services.${k}`))])].sort();
      } else {
        row.error = (res.errorText ?? "").slice(0, 300);
      }
    } catch (e) {
      row.error = errorText(e);
    }
    result.calculations.push(row);
  }

  try {
    const res = await client.request<{ total?: unknown; items?: Array<Record<string, unknown>> }>("GET", "/shipments", undefined, {
      query: { limit: "5", page: "1" },
    });
    result.shipments.status = res.status;
    if (res.body) {
      result.shipments.ok = true;
      result.shipments.total = num(res.body.total);
      const codes = (res.body.items ?? []).map((i) => (typeof i.currencyCode === "string" ? i.currencyCode.slice(0, 3) : null));
      result.shipments.currencyCodes = [...new Set(codes.filter((c): c is string => Boolean(c)))];
    } else {
      result.shipments.error = (res.errorText ?? "").slice(0, 300);
    }
  } catch (e) {
    result.shipments.error = errorText(e);
  }
  return result;
}
