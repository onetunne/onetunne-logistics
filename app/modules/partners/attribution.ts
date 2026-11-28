/**
 * Етап 6, WP7: атрибуція замовлення партнеру (docs/stage6-design.md §9.2). ЧИСТА функція.
 *
 * Вхід — УСІ коди знижок замовлення (`Order.discountCodes`, не фільтр пошуку `discount_code`, що бачить лише перший)
 * і реферальний код (`customerJourneySummary.lastVisit.referralCode`) — лише коли `ready = true`. Правила:
 * - пріоритет: код знижки > реферальний; враховуються лише коди, дійсні на ДАТУ ЗАМОВЛЕННЯ (Київ), активні, активних
 *   партнерів;
 * - коди знижок двох РІЗНИХ партнерів → `ambiguous` (розбіжність partner_attribution_ambiguous «Оберіть партнера»,
 *   складник «Немає даних»); кілька кодів одного партнера → цей партнер, код — перший у порядку Shopify;
 * - тестові замовлення (без includeTestOrders) не атрибутуються;
 * - ставка — на дату замовлення (`rateOn`): ставка коду > ставка партнера; до першої ставки — початкова ставка
 *   партнера (вона діє «з початку»); фіксується в атрибуції разом із днями утримання.
 * Ручні рішення власника (source = owner) цією функцією не змінюються — їх не перезаписує sync.server.ts.
 */
import type { PartnerCodeSource } from "./types";
import { isCodeValidOn, normalizeCode, normalizeOrderCodes } from "./codes";

export interface CandidateCode {
  id: string;
  partnerId: string;
  source: PartnerCodeSource;
  codeNorm: string;
  validFrom: string | null;
  validTo: string | null;
}

export interface AttributionInput {
  /** Order.discountCodes (усі, у порядку Shopify). */
  discountCodes: readonly string[];
  /** Реферальний код (лише з ready = true); null — немає / ще невідомий. */
  referralCode: string | null;
  /** Дата замовлення (Київ). */
  placedOn: string;
  /** Тестове замовлення, яке не враховується (Order.test і вимкнено includeTestOrders). */
  excludedTest: boolean;
  /** Активні коди активних партнерів (будь-яка дійсність — фільтр за датою тут). */
  codes: readonly CandidateCode[];
}

export type AttributionDecision =
  | { status: "none"; reason: "no_code" | "test_order" }
  | { status: "attributed"; partnerId: string; codeId: string; source: PartnerCodeSource }
  | { status: "ambiguous"; partnerIds: string[]; codeIds: string[]; source: PartnerCodeSource };

export function resolveAttribution(input: AttributionInput): AttributionDecision {
  if (input.excludedTest) return { status: "none", reason: "test_order" };
  const valid = input.codes.filter((c) => isCodeValidOn(c, input.placedOn));
  const orderCodes = normalizeOrderCodes(input.discountCodes);
  const matched: CandidateCode[] = [];
  for (const norm of orderCodes) {
    for (const c of valid) if (c.source === "discount_code" && c.codeNorm === norm && !matched.includes(c)) matched.push(c);
  }
  if (matched.length > 0) return decide(matched, "discount_code");
  const ref = normalizeCode(input.referralCode);
  if (ref) {
    const refs = valid.filter((c) => c.source === "referral" && c.codeNorm === ref);
    if (refs.length > 0) return decide(refs, "referral");
  }
  return { status: "none", reason: "no_code" };
}

function decide(matched: readonly CandidateCode[], source: PartnerCodeSource): AttributionDecision {
  const partnerIds = [...new Set(matched.map((c) => c.partnerId))];
  if (partnerIds.length === 1) return { status: "attributed", partnerId: partnerIds[0]!, codeId: matched[0]!.id, source };
  return { status: "ambiguous", partnerIds: [...partnerIds].sort(), codeIds: matched.map((c) => c.id), source };
}

export interface RateRow {
  codeId: string | null;
  rateBp: number;
  effectiveFrom: string;
}

/**
 * Ставка на дату (§9.1): найпізніша ставка коду з effective_from ≤ дата; інакше найпізніша ставка партнера
 * (code_id null) з effective_from ≤ дата; інакше найраніша ставка партнера (початкова діє «з початку»); інакше null.
 */
export function rateOn(rates: readonly RateRow[], codeId: string | null, date: string): number | null {
  const latest = (rows: readonly RateRow[]) =>
    rows.filter((r) => r.effectiveFrom <= date).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : a.effectiveFrom > b.effectiveFrom ? -1 : 0))[0] ?? null;
  if (codeId) {
    const own = latest(rates.filter((r) => r.codeId === codeId));
    if (own) return own.rateBp;
  }
  const partnerRates = rates.filter((r) => r.codeId === null);
  const effective = latest(partnerRates);
  if (effective) return effective.rateBp;
  const earliest = [...partnerRates].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0))[0];
  return earliest ? earliest.rateBp : null;
}
