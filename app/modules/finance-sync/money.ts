/**
 * Етап 6 (WP3): СТРОГИЙ розбір грошей Shopify (docs/stage6-design.md §14.3 п. 5, §16.3, F4). Пошкоджене значення → null
 * (з кодом помилки), НІКОЛИ не "0.00": хелпер етапу 2 `normalizeAmount` підміняє пошкоджене нулем, тому у фінансах заборонений
 * (тест-сканер tests/stage6/core/access-scanner.test.ts). Чисті функції, без float.
 *
 * Правила (сховище numeric(14,2) + char(3), §17):
 * - сума — рядок Decimal Shopify: необов'язковий «-», цифри, необов'язкова крапка з цифрами; без експоненти, пробілів,
 *   ком, «+»; число JSON (не рядок) — пошкоджене (точність уже могла бути втрачена);
 * - не більше 12 цифр цілої частини;
 * - знаки після коми понад 2 допускаються лише нулями ("59.500" → "59.50"); інакше — помилка точності (не округлення);
 * - валюта — ISO 4217 `^[A-Z]{3}$` з 0 або 2 десятковими (§5.1); 3–4 знаки → unsupported_currency; у валюті з 0 знаками
 *   ненульові соті — помилка (не округлення);
 * - "-0.00" → "0.00".
 */
import { currencyMinorDigits } from "~/lib/decimal";

export const MONEY_ERROR_CODES = ["invalid_amount", "amount_precision", "amount_range", "invalid_currency", "unsupported_currency"] as const;
export type MoneyErrorCode = (typeof MONEY_ERROR_CODES)[number];

export interface Money {
  /** Десятковий рядок з рівно 2 знаками після коми (як numeric(14,2)). */
  amount: string;
  currency: string;
}

export type MoneyResult = { ok: true; value: Money } | { ok: false; code: MoneyErrorCode };

const AMOUNT_RE = /^(-)?(\d+)(?:\.(\d+))?$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const MAX_INT_DIGITS = 12;

/** Валюта фінансів: null — пошкоджений код; "unsupported" — 3–4 десяткові. */
export function checkCurrency(value: unknown): { ok: true; currency: string; digits: 0 | 2 } | { ok: false; code: MoneyErrorCode } {
  if (typeof value !== "string" || !CURRENCY_RE.test(value)) return { ok: false, code: "invalid_currency" };
  const digits = currencyMinorDigits(value);
  if (digits !== 0 && digits !== 2) return { ok: false, code: "unsupported_currency" };
  return { ok: true, currency: value, digits };
}

/** Строгий розбір суми (без валюти): десятковий рядок з 2 знаками або код помилки. */
export function parseShopifyAmount(value: unknown, digits: 0 | 2 = 2): { ok: true; amount: string } | { ok: false; code: MoneyErrorCode } {
  if (typeof value !== "string") return { ok: false, code: "invalid_amount" };
  const m = AMOUNT_RE.exec(value);
  if (!m) return { ok: false, code: "invalid_amount" };
  const sign = m[1] ?? "";
  const intRaw = m[2]!;
  const frac = m[3] ?? "";
  const int = intRaw.replace(/^0+(?=\d)/, "");
  if (int.length > MAX_INT_DIGITS) return { ok: false, code: "amount_range" };
  const kept = frac.slice(0, 2).padEnd(2, "0");
  if (/[^0]/.test(frac.slice(2))) return { ok: false, code: "amount_precision" };
  if (digits === 0 && kept !== "00") return { ok: false, code: "amount_precision" };
  const zero = /^0+$/.test(int) && kept === "00";
  return { ok: true, amount: `${sign && !zero ? "-" : ""}${int}.${kept}` };
}

/**
 * Строгий розбір MoneyV2 Shopify ({amount, currencyCode}). Пошкоджене → null-результат з кодом (ніколи "0.00").
 */
export function parseShopifyMoney(value: unknown): MoneyResult {
  if (!value || typeof value !== "object") return { ok: false, code: "invalid_amount" };
  const v = value as { amount?: unknown; currencyCode?: unknown };
  const c = checkCurrency(v.currencyCode);
  if (!c.ok) return c;
  const a = parseShopifyAmount(v.amount, c.digits);
  if (!a.ok) return a;
  return { ok: true, value: { amount: a.amount, currency: c.currency } };
}

/** Те саме, але повертає Money | null (для місць, де достатньо знати «пошкоджено»). */
export function shopifyMoneyOrNull(value: unknown): Money | null {
  const r = parseShopifyMoney(value);
  return r.ok ? r.value : null;
}

/**
 * Курс Shopify (Decimal, напр. settlementCurrencyRate) для numeric(20,10): додатний, ≤ 10 знаків після коми (нулі понад
 * 10 — допускаються), ≤ 10 цифр цілої частини; інакше null (значення довідкове — не округлюється й не вигадується).
 */
export function parseShopifyRate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!m) return null;
  const int = m[1]!.replace(/^0+(?=\d)/, "");
  const frac = m[2] ?? "";
  if (int.length > 10 || /[^0]/.test(frac.slice(10))) return null;
  const kept = frac.slice(0, 10);
  if (/^0+$/.test(int) && /^0*$/.test(kept)) return null;
  return kept ? `${int}.${kept}` : int;
}
