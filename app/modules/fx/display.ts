/**
 * Етап 6, WP1: показ курсу (десятковий рядок до 10 знаків) без перетворення на float. Роздільники — ті самі, що в
 * app/lib/format.ts (uk «49,4942», «1 234,5»; en «49.4942», «1,234.5»): курс — не сума, тож formatMoney не підходить,
 * а formatDecimal приймає number (курс за одиницю VND 0,0017505 і подібні мають лишатися точними).
 */
import type { Locale } from "~/i18n/types";
import { groupDigits } from "~/lib/money";

const RATE_RE = /^(-)?(\d+)(?:\.(\d+))?$/;

/** «49.494200» → «49,4942» (uk) / «49.4942» (en); некоректне/відсутнє → «—». Зайві нулі в кінці дробу прибираються. */
export function formatRate(value: string | null | undefined, locale: Locale): string {
  const m = RATE_RE.exec((value ?? "").trim());
  if (!m) return "—";
  const int = m[2]!.replace(/^0+(?=\d)/, "");
  const frac = (m[3] ?? "").replace(/0+$/, "");
  const uk = locale === "uk";
  const body = `${groupDigits(int, uk ? " " : ",")}${frac ? `${uk ? "," : "."}${frac}` : ""}`;
  return m[1] && /[1-9]/.test(body) ? `-${body}` : body;
}
