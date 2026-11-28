/**
 * Етап 6, WP6: правила комісій шлюзів — чисті функції (docs/stage6-design.md §8.1, §4 «Комісії»). Рядки правил
 * НЕЗМІННІ: зміна закриває поточне правило (`applies_to` = день перед новим) і додає нове (fee-rules.server.ts).
 *
 * Прогноз комісії замовлення (для WP4 syncOrderFinance): `percent_bp` від бази (сума SUCCESS SALE/CAPTURE; у демо — сума
 * замовлення) + фіксована частина в її валюті — окремо для видів `payment` (платіжна система) і `platform` (комісія
 * Shopify за сторонній шлюз; ставка тарифу НЕДОКУМЕНТОВАНА — лише введена власником, жодних вшитих ставок).
 * Правило «Без комісії» → `zero_confirmed` (не прогноз 0). Немає правила → «немає даних» (null), НІКОЛИ не 0 (F4).
 */
import { FEE_RULE_KINDS } from "~/domain/finance";
import { assertSupportedCurrency, mulDivHalfAwayFromZero, toMinorForCurrency } from "~/lib/decimal";
import { fromMinor } from "~/lib/money";

export type FeeRuleKind = (typeof FEE_RULE_KINDS)[number];

export interface FeeRuleLike {
  id: string;
  gateway: string;
  kind: FeeRuleKind;
  percentBp: number;
  fixedAmount: string | null;
  fixedCurrency: string | null;
  noFees: boolean;
  appliesFrom: string;
  appliesTo: string | null;
}

export const FEE_GATEWAY_MAX = 120;
/** Найбільший відсоток правила (100 %). */
export const FEE_MAX_BP = 10_000;

/** Відсоток з форми («3,49», «3.49 %», «0») → базисні пункти (349); не більше 2 знаків, 0…100; інакше null. */
export function parsePercentToBp(input: string | null | undefined): number | null {
  const raw = (input ?? "").replace(/[\s  %]/g, "").replace(",", ".");
  if (raw === "") return 0;
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(raw);
  if (!m) return null;
  const bp = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return bp <= FEE_MAX_BP ? bp : null;
}

/** Базисні пункти → десятковий рядок відсотка («349» → «3.49»). */
export function bpToPercent(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const frac = String(bp % 100).padStart(2, "0");
  return `${whole}.${frac}`;
}

/** Назва шлюзу як у Shopify (точна, з урахуванням регістру): обрізані пробіли, без керівних символів. */
export function normalizeGateway(input: string | null | undefined): string | null {
  const g = (input ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!g || g.length > FEE_GATEWAY_MAX) return null;
  return g;
}

export function ruleApplies(rule: Pick<FeeRuleLike, "gateway" | "appliesFrom" | "appliesTo">, gateway: string, date: string): boolean {
  return rule.gateway === gateway && rule.appliesFrom <= date && (rule.appliesTo === null || date <= rule.appliesTo);
}

/** Чинне правило виду на дату (найпізніший applies_from серед застосовних). */
export function applicableRule<T extends FeeRuleLike>(rules: readonly T[], gateway: string, kind: FeeRuleKind, date: string): T | null {
  let best: T | null = null;
  for (const r of rules) {
    if (r.kind !== kind || !ruleApplies(r, gateway, date)) continue;
    if (!best || r.appliesFrom > best.appliesFrom) best = r;
  }
  return best;
}

export interface FeeForecastLine {
  kind: FeeRuleKind;
  ruleId: string;
  /** Десятковий рядок ≥ 0 (витрата; знак запису — у викликача). */
  amount: string;
  currency: string;
}

export type FeeForecast =
  /** Жодного чинного правила — «немає даних» (no_fee_data), не 0. */
  | { state: "none" }
  /** Усі чинні правила «Без комісії». */
  | { state: "zero_confirmed"; ruleIds: string[] }
  /** Прогноз: рядки за видом і валютою (фіксована частина може бути в іншій валюті). */
  | { state: "forecast"; lines: FeeForecastLine[]; ruleIds: string[] };

/** Відсоток від суми в сотих частках з округленням (половина від нуля) до цілих одиниць валюти. */
export function percentOfAmountMinor(baseMinor: bigint, bp: number, currency: string): bigint {
  const step = assertSupportedCurrency(currency) === 0 ? 100n : 1n;
  return mulDivHalfAwayFromZero(baseMinor / step, BigInt(bp), 10_000n) * step;
}

/**
 * Прогноз комісії замовлення за правилами шлюзу на дату (дата оплати). base — сума, від якої береться відсоток (у
 * валюті бази); null — бази немає (тоді лише фіксована частина, якщо відсоток 0, інакше рядок не рахується → «немає»).
 */
export function feeForecast(
  rules: readonly FeeRuleLike[],
  input: { gateway: string; date: string; base: { amount: string; currency: string } | null },
): FeeForecast {
  const lines: FeeForecastLine[] = [];
  const ruleIds: string[] = [];
  let applicable = 0;
  let zero = 0;
  let unknown = false;
  for (const kind of FEE_RULE_KINDS) {
    const rule = applicableRule(rules, input.gateway, kind, input.date);
    if (!rule) continue;
    applicable++;
    ruleIds.push(rule.id);
    if (rule.noFees) {
      zero++;
      continue;
    }
    const byCurrency = new Map<string, bigint>();
    if (rule.percentBp > 0) {
      if (!input.base) {
        unknown = true;
        continue;
      }
      const baseMinor = toMinorForCurrency(input.base.amount, input.base.currency);
      byCurrency.set(input.base.currency, percentOfAmountMinor(baseMinor, rule.percentBp, input.base.currency));
    }
    if (rule.fixedAmount !== null && rule.fixedCurrency !== null) {
      const fixed = toMinorForCurrency(rule.fixedAmount, rule.fixedCurrency);
      byCurrency.set(rule.fixedCurrency, (byCurrency.get(rule.fixedCurrency) ?? 0n) + fixed);
    }
    for (const [currency, minor] of [...byCurrency].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      lines.push({ kind, ruleId: rule.id, amount: fromMinor(minor), currency });
    }
  }
  if (applicable === 0 || unknown) return { state: "none" };
  if (zero === applicable) return { state: "zero_confirmed", ruleIds };
  return { state: "forecast", lines, ruleIds };
}

export interface FeeRuleInputShape {
  gateway: string | null;
  kind: string;
  percentBp: number | null;
  fixedMinor: bigint | null;
  fixedCurrency: string | null;
  noFees: boolean;
}

/** Код помилки (financeExpenses.error.*) або null. */
export function feeRuleShapeError(s: FeeRuleInputShape): string | null {
  if (!s.gateway) return "financeExpenses.error.gatewayRequired";
  if (!(FEE_RULE_KINDS as readonly string[]).includes(s.kind)) return "financeExpenses.error.feeKindInvalid";
  if (s.percentBp === null) return "financeExpenses.error.percentInvalid";
  if ((s.fixedMinor === null) !== (s.fixedCurrency === null)) return "financeExpenses.error.fixedInvalid";
  if (s.fixedMinor !== null && s.fixedMinor < 0n) return "financeExpenses.error.fixedInvalid";
  if (s.noFees) {
    if (s.percentBp !== 0 || (s.fixedMinor !== null && s.fixedMinor !== 0n)) return "financeExpenses.error.noFeesWithAmounts";
    return null;
  }
  // Правило «0 % без фіксованої частини» — не прогноз; для нуля є «Без комісії» (zero_confirmed).
  if (s.percentBp === 0 && (s.fixedMinor === null || s.fixedMinor === 0n)) return "financeExpenses.error.feeRuleEmpty";
  return null;
}
