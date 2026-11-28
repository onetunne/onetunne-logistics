/**
 * Еталонна модель (WP12a): доставка — статистика за накладними (§7.7), заморожений прогноз (§7.1), нормалізація
 * номерів і правила розбіжностей імпорту (§7.4–§7.6).
 */
import { abs, cents, divRound, mulDiv, percent1, rAdd, rational, R_ZERO, str, type Cents, type Rational } from "./money";
import { addDays } from "./dates";
import { convert, type ConvertContext } from "./fx";
import type { ChargeType, ForecastBasis } from "./order-posting";

// ---------------------------------------------------------------------------------------------------------------
// Нормалізація номерів (§7.4)
// ---------------------------------------------------------------------------------------------------------------

export type WaybillClass = "ua14" | "eu" | "test" | "unrecognized";

export function normalizeWaybill(raw: string | number): { ok: true; norm: string; cls: WaybillClass } | { ok: false; error: "invalid_number" } {
  let norm: string;
  if (typeof raw === "number") {
    if (!Number.isSafeInteger(raw) || raw < 0) return { ok: false, error: "invalid_number" };
    norm = String(raw);
  } else {
    norm = raw.normalize("NFKC").trim().replace(/[\s ]+/g, "").toUpperCase();
    if (/^\d+(?:[.,]\d+)?E[+-]?\d+$/i.test(norm) || /^\d+[.,]\d+$/.test(norm)) return { ok: false, error: "invalid_number" };
  }
  if (norm.length === 0) return { ok: false, error: "invalid_number" };
  const cls: WaybillClass = /^\d{14}$/.test(norm) ? "ua14" : /^[A-Z]{4}\d{10}$/.test(norm) ? "eu" : /^TEST\d{10}$/.test(norm) ? "test" : "unrecognized";
  return { ok: true, norm, cls };
}

// ---------------------------------------------------------------------------------------------------------------
// Правила розбіжностей (§7.5)
// ---------------------------------------------------------------------------------------------------------------

export interface VarianceSettings {
  percent: number;
  /** Мінімальна сума в UAH (сотими), уже сконвертована до валюти порівняння. */
  minAmount: Cents;
  weightPercent: number;
  weightMinGrams: number;
  lossMinAmount: Cents;
}

export const DEFAULT_VARIANCE: VarianceSettings = { percent: 15, minAmount: 5000n, weightPercent: 10, weightMinGrams: 100, lossMinAmount: 5000n };

/** amount_vs_forecast: |факт − заморожений прогноз| > max(percent % прогнозу, minAmount). */
export function amountVsForecast(actual: Cents, forecast: Cents, s: VarianceSettings = DEFAULT_VARIANCE): boolean {
  const pct = mulDiv(abs(forecast), BigInt(s.percent), 100n);
  const threshold = pct > s.minAmount ? pct : s.minAmount;
  return abs(actual - forecast) > threshold;
}

/** weight_mismatch: платна вага з рахунку − вага відправлення > max(weightPercent %, weightMinGrams). */
export function weightMismatch(chargedGrams: number, shipmentGrams: number, s: VarianceSettings = DEFAULT_VARIANCE): boolean {
  const pct = (shipmentGrams * s.weightPercent) / 100;
  return chargedGrams - shipmentGrams > Math.max(pct, s.weightMinGrams);
}

/** shipping_loss: фактична доставка − сплачена покупцем (обидві сконвертовані) > lossMinAmount. */
export function shippingLoss(actual: Cents, paidByCustomer: Cents, s: VarianceSettings = DEFAULT_VARIANCE): { loss: Cents; flagged: boolean } {
  const loss = actual - paidByCustomer;
  return { loss, flagged: loss > s.lossMinAmount };
}

export interface ImportLine {
  number: string;
  service: string;
  amount: string;
  currency: string;
}

const tupleKey = (l: ImportLine) => `${l.number}\u0000${l.service.toLowerCase()}\u0000${l.amount}\u0000${l.currency}`;

/** duplicate_in_file: індекси рядків, що повторюють попередній (номер, послуга, сума, валюта). */
export function duplicatesInFile(lines: readonly ImportLine[]): number[] {
  const seen = new Set<string>();
  const out: number[] = [];
  lines.forEach((l, i) => {
    const k = tupleKey(l);
    if (seen.has(k)) out.push(i);
    seen.add(k);
  });
  return out;
}

/** similar_document: ≥ 50 % рядків нового документа мають той самий кортеж в іншому активному документі. */
export function similarDocument(newLines: readonly ImportLine[], otherDoc: readonly ImportLine[]): boolean {
  if (newLines.length === 0) return false;
  const other = new Set(otherDoc.map(tupleKey));
  const same = newLines.filter((l) => other.has(tupleKey(l))).length;
  return same * 2 >= newLines.length;
}

/** invoice_total_mismatch: контрольний підсумок − Σ рядків (null — збігається). */
export function invoiceTotalMismatch(lineAmounts: readonly string[], controlTotal: string): string | null {
  const d = cents(controlTotal) - lineAmounts.reduce((a, x) => a + cents(x), 0n);
  return d === 0n ? null : str(d);
}

// ---------------------------------------------------------------------------------------------------------------
// Заморожений прогноз доставки (§4, §7.1)
// ---------------------------------------------------------------------------------------------------------------

export interface HistoricalWaybill {
  country: string;
  /** Дата визнання замовлення накладної. */
  recognizedOn: string;
  /** Фактична вартість у валюті звітності (сотими) або null — факту немає. */
  actual: Cents | null;
}

/** Середня фактична до країни за вікно (≥ minSamples накладних з фактом) — основа country_average; інакше null. */
export function countryAverage(history: readonly HistoricalWaybill[], country: string, onDate: string, opts = { historyDays: 90, minSamples: 3 }): Cents | null {
  const from = addDays(onDate, -opts.historyDays);
  const xs = history.filter((h) => h.country === country && h.actual !== null && h.recognizedOn >= from && h.recognizedOn < onDate);
  if (xs.length < opts.minSamples) return null;
  return divRound(xs.reduce((a, h) => a + h.actual!, 0n), BigInt(xs.length));
}

/** Перша доступна основа: carrier_reported → country_average → owner_table → none (сума null). */
export function chooseFrozenForecast(input: {
  carrierReported?: { amount: string; currency: string } | null;
  countryAverage?: { amount: string; currency: string } | null;
  ownerTable?: { amount: string; currency: string } | null;
}): { basis: ForecastBasis; amount: string | null; currency: string | null } {
  if (input.carrierReported) return { basis: "carrier_reported", ...input.carrierReported };
  if (input.countryAverage) return { basis: "country_average", ...input.countryAverage };
  if (input.ownerTable) return { basis: "owner_table", ...input.ownerTable };
  return { basis: "none", amount: null, currency: null };
}

// ---------------------------------------------------------------------------------------------------------------
// Статистика доставки (§7.7): одиниця — накладна
// ---------------------------------------------------------------------------------------------------------------

export interface StatWaybill {
  id: string;
  orderId: string;
  source: "app" | "external";
  country: string;
  chargeableWeightGrams?: number | null;
  /** Дата визнання замовлення (період статистики). */
  recognizedOn: string;
  forecast: { basis: ForecastBasis; amount: string | null; currency: string; fxOn: string } | null;
  lines: Array<{ chargeType: ChargeType; amount: string; currency: string; fxOn: string }>;
}

const COST_TYPES: ReadonlySet<ChargeType> = new Set(["delivery", "additional_service", "insurance", "other", "credit"]);

export interface ShippingStats {
  waybills: number;
  withActual: number;
  averageCost: string | null;
  totalCost: string;
  returns: string;
  storage: string;
  customsDuty: string;
  byCountry: Record<string, { waybills: number; withActual: number; averageCost: string | null; perKg: string | null; averageForecast: string | null }>;
  forecastVsActual: {
    count: number;
    forecast: string;
    actual: string;
    delta: string;
    meanAbsDeltaPct: string | null;
    overThreshold: number;
    byBasis: Partial<Record<ForecastBasis, { count: number; delta: string }>>;
  };
  unconverted: number;
}

/** Статистика за період (за датою визнання замовлення), у валюті звітності; кожен рядок — за своїм fx_on. */
export function shippingStats(waybills: readonly StatWaybill[], o: { from: string; to: string; currency: string; ctx: ConvertContext; variance?: VarianceSettings }): ShippingStats {
  const v = o.variance ?? DEFAULT_VARIANCE;
  let unconverted = 0;
  const cv = (x: { amount: string; currency: string; fxOn: string }): Cents | null => {
    const r = convert(cents(x.amount), x.currency, o.currency, x.fxOn, o.ctx);
    if (r === null) unconverted += 1;
    return r;
  };
  const list = waybills.filter((w) => w.recognizedOn >= o.from && w.recognizedOn <= o.to);
  let total = 0n;
  let withActual = 0;
  let returns = 0n;
  let storage = 0n;
  let duty = 0n;
  const countries = new Map<string, { n: number; a: number; cost: Cents; grams: number; costKg: Cents; fc: Cents; fcn: number }>();
  let fcSum = 0n;
  let acSum = 0n;
  let fvCount = 0;
  let over = 0;
  let absPct: Rational = R_ZERO;
  const byBasis = new Map<ForecastBasis, { count: number; delta: Cents }>();
  for (const w of list) {
    const c = countries.get(w.country) ?? { n: 0, a: 0, cost: 0n, grams: 0, costKg: 0n, fc: 0n, fcn: 0 };
    c.n += 1;
    let cost = 0n;
    let hasCost = false;
    let ok = true;
    for (const l of w.lines) {
      const val = cv(l);
      if (val === null) {
        ok = false;
        continue;
      }
      if (COST_TYPES.has(l.chargeType)) {
        cost += val;
        hasCost = true;
      } else if (l.chargeType === "return_delivery" || l.chargeType === "redirect") returns += val;
      else if (l.chargeType === "storage") storage += val;
      else if (l.chargeType === "customs_duty") duty += val;
    }
    const fc = w.forecast && w.forecast.amount !== null ? cv({ amount: w.forecast.amount, currency: w.forecast.currency, fxOn: w.forecast.fxOn }) : null;
    if (fc !== null) {
      c.fc += fc;
      c.fcn += 1;
    }
    if (hasCost && ok) {
      withActual += 1;
      total += cost;
      c.a += 1;
      c.cost += cost;
      if (w.source === "app" && w.chargeableWeightGrams) {
        c.grams += w.chargeableWeightGrams;
        c.costKg += cost;
      }
      if (fc !== null && w.forecast) {
        fvCount += 1;
        fcSum += fc;
        acSum += cost;
        const d = cost - fc;
        if (fc > 0n) absPct = rAdd(absPct, rational(abs(d), fc));
        if (amountVsForecast(cost, fc, v)) over += 1;
        const b = byBasis.get(w.forecast.basis) ?? { count: 0, delta: 0n };
        b.count += 1;
        b.delta += d;
        byBasis.set(w.forecast.basis, b);
      }
    }
    countries.set(w.country, c);
  }
  const byCountry: ShippingStats["byCountry"] = {};
  for (const [k, c] of [...countries.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    byCountry[k] = {
      waybills: c.n,
      withActual: c.a,
      averageCost: c.a > 0 ? str(divRound(c.cost, BigInt(c.a))) : null,
      perKg: c.grams > 0 ? str(divRound(c.costKg * 1000n, BigInt(c.grams))) : null,
      averageForecast: c.fcn > 0 ? str(divRound(c.fc, BigInt(c.fcn))) : null,
    };
  }
  return {
    waybills: list.length,
    withActual,
    averageCost: withActual > 0 ? str(divRound(total, BigInt(withActual))) : null,
    totalCost: str(total),
    returns: str(returns),
    storage: str(storage),
    customsDuty: str(duty),
    byCountry,
    forecastVsActual: {
      count: fvCount,
      forecast: str(fcSum),
      actual: str(acSum),
      delta: str(acSum - fcSum),
      meanAbsDeltaPct: fvCount > 0 ? percent1(absPct.num, absPct.den * BigInt(fvCount)) : null,
      overThreshold: fvCount > 0 ? over : 0,
      byBasis: Object.fromEntries([...byBasis.entries()].map(([k, b]) => [k, { count: b.count, delta: str(b.delta) }])),
    },
    unconverted,
  };
}

/** «Доставка: сплачено покупцями vs фактично» (§7.7) за замовленнями з фактом: Σ (сплачено − факт). */
export function paidVsActual(orders: ReadonlyArray<{ paid: Cents; actual: Cents | null }>): { orders: number; difference: string } {
  const xs = orders.filter((x) => x.actual !== null);
  return { orders: xs.length, difference: str(xs.reduce((a, x) => a + x.paid - x.actual!, 0n)) };
}

// ---------------------------------------------------------------------------------------------------------------
// Зіставлення рядка рахунку з накладною (§7.4) і пов'язані коди (§7.5)
// ---------------------------------------------------------------------------------------------------------------

export interface MatchCandidate {
  number: string;
  carrier: string;
  orderId: string;
  /** Ідентифікатор накладної (shipments.id / order_external_waybills.id); типово — нормалізований номер. */
  waybillId?: string;
  cancelled?: boolean;
  handedOver?: boolean;
  orderRecognized?: boolean;
  /** Заморожений прогноз накладної (amount_vs_forecast, §7.5). */
  forecast?: { amount: string; currency: string; fxOn: string } | null;
  /** chargeable_weight_grams — лише відправлення застосунку (у зовнішніх ваги немає). */
  weightGrams?: number | null;
}

export type MatchCode = "matched" | "invalid_number" | "unmatched_waybill" | "ambiguous_match" | "carrier_mismatch" | "shipment_cancelled" | "shipment_not_handed_over" | "order_not_recognized";

/** Код зіставлення номера з файлу з накладними застосунку й зовнішніми номерами (точне зіставлення після нормалізації). */
export function matchWaybill(
  raw: string | number,
  carrier: string,
  candidates: readonly MatchCandidate[],
): { code: MatchCode; norm: string | null; orderId: string | null; candidate: MatchCandidate | null } {
  const n = normalizeWaybill(raw);
  if (!n.ok) return { code: "invalid_number", norm: null, orderId: null, candidate: null };
  const same = candidates.filter((c) => {
    const cn = normalizeWaybill(c.number);
    return cn.ok && cn.norm === n.norm;
  });
  const mine = same.filter((c) => c.carrier === carrier);
  if (mine.length === 0) return { code: same.length > 0 ? "carrier_mismatch" : "unmatched_waybill", norm: n.norm, orderId: null, candidate: null };
  const orders = [...new Set(mine.map((c) => c.orderId))];
  if (orders.length > 1) return { code: "ambiguous_match", norm: n.norm, orderId: null, candidate: null };
  const c = mine[0]!;
  if (c.cancelled) return { code: "shipment_cancelled", norm: n.norm, orderId: c.orderId, candidate: c };
  if (c.orderRecognized === false) return { code: "order_not_recognized", norm: n.norm, orderId: c.orderId, candidate: c };
  if (c.handedOver === false) return { code: "shipment_not_handed_over", norm: n.norm, orderId: c.orderId, candidate: c };
  return { code: "matched", norm: n.norm, orderId: c.orderId, candidate: c };
}

/** manual_cost_exists: ручна вартість доставки / ручне мито замовлення + рядок delivery / customs_duty з рахунку. */
export function manualCostExists(manual: { shipping?: boolean; duties?: boolean }, chargeType: ChargeType): boolean {
  return (chargeType === "delivery" && Boolean(manual.shipping)) || (chargeType === "customs_duty" && Boolean(manual.duties));
}

