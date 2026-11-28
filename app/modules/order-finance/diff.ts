/**
 * Етап 6, WP4: різниця «бажані записи замовлення − діючі» (F2, F6) — ЧИСТА функція. syncOrderFinance проводить лише
 * різницю: діючий запис, що відповідає бажаному факту, лишається (дата визнання, раз установлена, не рухається;
 * зміна налаштування чи ручної собівартості НІКОЛИ не змінює проведений запис); інший — сторнується (дата й fx_on
 * оригіналу, ядро reverseEntry); бажаний факт без діючого запису — проводиться (repostEntries: базовий ключ або нове
 * покоління `:g<n>`, якщо попереднє сторновано — тестове замовлення при перемиканні includeTestOrders).
 *
 * Ідентичність факту — базовий ключ без покоління; для версійованих родин (`cb:<id>:<частина>:v<n>`,
 * `confirm:<orderId>:v<n>:<частина>`) — без версії: нова версія спору з тими самими сумами не створює сторно/повтору.
 * Порівнюються категорія, валюта, замовлення й (крім «заморожених» родин) сума; для родин, дата яких залежить від
 * обробки замовлення (оцінки складу, рахунки перевізника: визнане ↔ виключене), — ще й економічна дата (original_on).
 * Заморожені родини: `stdcogs:` (кількість і ручна собівартість на дату визнання) і `inv:` (сума з ПДВ / без ПДВ —
 * налаштування vatPayer діє лише на нові записи).
 * Дати, які редагує власник: chargeback (`cb:`) — ще й original_on і fx_on (дата рішення, §8.2 R2): перенесення дати
 * рішення — сторно старих записів + нові датою й курсом нової дати (F2); нова версія з тими самими сумами й датами — без
 * змін. Рахунки (`inv:`) — ще й `is_late_completion` (детермінований: імпорт документа ↔ момент визнання; R5 — без
 * позначки): перемикання includeTestOrders (виключене R5 ↔ враховане R3) переводить запис, навіть коли дата послуги
 * збігається з датою визнання (§2.5, §3.3).
 */
import { toMinorForCurrency } from "~/lib/decimal";
import type { EntryInput } from "~/modules/finance/core/entries.server";

export interface ActiveEntry {
  id: string;
  idempotencyKey: string;
  category: string;
  amount: string;
  currency: string;
  orderId: string | null;
  originalOn: string;
  fxOn: string;
  /** finance_entries.is_late_completion (R3); порівнюється лише для `inv:`. */
  isLateCompletion?: boolean;
}

const GENERATION_RE = /:g[1-9]\d*$/;

/** Базовий ключ (без суфікса покоління). */
export function baseKeyOf(key: string): string {
  return key.replace(GENERATION_RE, "");
}

/** Ідентичність факту для порівняння (версійовані родини — без версії). */
export function factIdentity(baseKey: string): string {
  if (baseKey.startsWith("cb:")) return baseKey.replace(/:v\d+$/, "");
  if (baseKey.startsWith("confirm:")) return baseKey.replace(/:v\d+:/, ":");
  if (baseKey.startsWith("stdcogs:")) return baseKey.replace(/:v\d+$/, "");
  return baseKey;
}

type Family = "frozen" | "dated" | "plain";

export function familyOf(baseKey: string): Family {
  if (baseKey.startsWith("stdcogs:")) return "frozen";
  if (baseKey.startsWith("inv:") || baseKey.startsWith("cogs:") || baseKey.startsWith("val:") || baseKey.startsWith("valc:")) return "dated";
  return "plain";
}

function sameFact(a: ActiveEntry, d: EntryInput): boolean {
  const base = baseKeyOf(a.idempotencyKey);
  if (factIdentity(base) !== factIdentity(d.idempotencyKey)) return false;
  if (a.category !== d.category || a.currency !== d.currency || (a.orderId ?? null) !== (d.orderId ?? null)) return false;
  const family = familyOf(base);
  // inv: — сума заморожена (ПДВ за налаштуванням на момент проведення), але дата залежить від обробки замовлення.
  const amountMatters = family === "plain" || (family === "dated" && !base.startsWith("inv:"));
  if (amountMatters && toMinorForCurrency(a.amount, a.currency) !== toMinorForCurrency(d.amount, d.currency)) return false;
  if (family === "dated" && a.originalOn !== (d.originalOn ?? d.recognizedOn)) return false;
  // Дата рішення спору — редагована власником (R2): інша дата / курс — інший факт.
  if (base.startsWith("cb:") && (a.originalOn !== (d.originalOn ?? d.recognizedOn) || a.fxOn !== d.fxOn)) return false;
  if (base.startsWith("inv:") && (a.isLateCompletion ?? false) !== (d.isLateCompletion ?? false)) return false;
  return true;
}

export interface EntryDiff {
  /** Діючі записи, що відповідають бажаним (лишаються). */
  keep: string[];
  /** Діючі записи без відповідника — сторно. */
  reverse: string[];
  /** Бажані факти без діючого запису — проведення (базові ключі). */
  post: EntryInput[];
}

/** Різниця (детермінований порядок: діючі — за порядком на вході, бажані — за ключем). */
export function diffEntries(desired: readonly EntryInput[], active: readonly ActiveEntry[]): EntryDiff {
  const satisfied = new Set<number>();
  const keep: string[] = [];
  const reverse: string[] = [];
  for (const a of active) {
    const i = desired.findIndex((d, idx) => !satisfied.has(idx) && sameFact(a, d));
    if (i >= 0) {
      satisfied.add(i);
      keep.push(a.id);
    } else reverse.push(a.id);
  }
  const post = desired.filter((_d, idx) => !satisfied.has(idx)).sort((x, y) => (x.idempotencyKey < y.idempotencyKey ? -1 : x.idempotencyKey > y.idempotencyKey ? 1 : 0));
  return { keep, reverse, post };
}
