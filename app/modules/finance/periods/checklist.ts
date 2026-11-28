/**
 * Етап 6, WP6: чек-лист закриття місяця — чисте правило (docs/stage6-design.md §3.4, §2.7).
 * ■ блокує (`PERIOD_CHECKLIST.blocking`): усі замовлення, визнані в місяці, — `final`; усі записи місяця мають курс для
 *   КОЖНОЇ валюти показу (`finance.displayCurrencies`, не лише валюти звітності).
 * ▲ попереджає: відкриті розбіжності, замовлення «Потребує перевірки», одиниці без собівартості на складі, прогнози
 *   упаковки поряд із загальною сумою упаковки за місяць (§10.3).
 * ☐ підтвердження власника: реклама, комісії платіжних систем, Shopify (тариф, застосунки), зарплати, оренда й послуги,
 *   податки компанії («внесено» / «податків за місяць немає»), інші витрати; «Упаковку замовлень, не пакованих у
 *   застосунку, обліковано загальною сумою» — лише за потреби (є загальна сума упаковки за місяць).
 * Закрити можна лише повністю минулий місяць без жодного ■. Право на «Чистий прибуток» — закритий місяць із усіма ☐.
 * Підтвердження ☐ — твердження власника про записи місяця: воно перевіряється не лише під час збереження, а й КОЖНОГО
 * обчислення чек-листа (зокрема під час закриття). Підтвердження, яке більше не узгоджується з журналом («внесено», а
 * записів і витрат місяця цієї категорії вже немає; «за місяць немає», а вони з'явилися), — стан `stale`
 * («Застаріло — підтвердьте знову»): не дає права на «Чистий прибуток» (§2.7, §3.4).
 */
import { PERIOD_CHECKLIST, PERIOD_CONFIRM_VALUES, type FinanceCategory, type PeriodChecklistItem } from "~/domain/finance";

export type BlockingItem = (typeof PERIOD_CHECKLIST.blocking)[number];
export type WarningItem = (typeof PERIOD_CHECKLIST.warning)[number];
export type ConfirmItem = (typeof PERIOD_CHECKLIST.confirm)[number];
export type ConfirmValue = (typeof PERIOD_CONFIRM_VALUES)[number];

export const CONFIRM_ITEMS: readonly ConfirmItem[] = PERIOD_CHECKLIST.confirm;

/** Категорії журналу, які підтверджує пункт ☐ (лічильник записів місяця і перевірка «внесено» / «немає»). */
export const CONFIRM_ITEM_CATEGORIES: Readonly<Record<ConfirmItem, readonly FinanceCategory[]>> = {
  advertising: ["advertising"],
  payment_fees: ["payment_fees"],
  platform_fees: ["platform_fees"],
  salaries: ["salaries"],
  rent_services: ["rent", "services"],
  taxes_company: ["taxes_company"],
  other_expenses: ["other_expense", "bank_fees"],
  packaging_total_accounted: ["packaging_unlinked", "packaging"],
};

/** Дозволені значення пункту: «внесено» / «за місяць немає»; для упаковки — «обліковано» / «не потрібно». */
export function allowedConfirmValues(item: ConfirmItem): readonly ConfirmValue[] {
  return item === "packaging_total_accounted" ? ["entered", "not_needed"] : ["entered", "none_this_month"];
}

export function isConfirmItem(value: string): value is ConfirmItem {
  return (CONFIRM_ITEMS as readonly string[]).includes(value);
}

export function isConfirmValue(value: string): value is ConfirmValue {
  return (PERIOD_CONFIRM_VALUES as readonly string[]).includes(value);
}

/** Факти місяця для чек-листа (лише кількості — без грошей). */
export interface ChecklistFacts {
  /** Місяць повністю минув (Київ). */
  fullyPast: boolean;
  ordersRecognized: number;
  /** Визнані в місяці, але не `final` (попередні, неповні, без стану). */
  ordersNotFinal: number;
  entries: number;
  /** Записи місяця без курсу — за кожною валютою показу. */
  entriesWithoutRate: Readonly<Record<string, number>>;
  openDiscrepancies: number;
  criticalDiscrepancies: number;
  ordersNeedReview: number;
  unknownCostUnits: number;
  /** Записи «загальної суми упаковки» місяця: packaging_unlinked або упаковка без замовлення. */
  packagingTotals: number;
  /** Замовлення місяця з прогнозом упаковки (за шаблоном). */
  ordersWithPackagingForecast: number;
  /** Діючі записи місяця за пунктами ☐ (recognized_on у місяці). */
  entriesByConfirmItem: Readonly<Partial<Record<ConfirmItem, number>>>;
  /**
   * Діючі ручні витрати періоду (без замовлення), датовані місяцем (дата або період послуги перетинає місяць), за
   * пунктами ☐: сума за березень, частки якої визнано в квітні, — теж «внесено» для березня (§10.3). Для упаковки — 0
   * (пункт стосується лише загальних сум у журналі місяця).
   */
  expensesByConfirmItem?: Readonly<Partial<Record<ConfirmItem, number>>>;
  confirmations: Readonly<Partial<Record<ConfirmItem, ConfirmValue>>>;
}

export type ChecklistStatus = "ok" | "blocked" | "warning" | "confirmed" | "pending" | "stale" | "not_needed";

export interface ChecklistItemResult {
  item: PeriodChecklistItem;
  kind: "blocking" | "warning" | "confirm";
  status: ChecklistStatus;
  /** Головна кількість пункту (замовлення / записи / розбіжності / одиниці). */
  count: number;
  value: ConfirmValue | null;
  /** Лише stale: код невідповідності (financeExpenses.error.*). */
  staleReason?: string;
  /** Уточнення (напр. записи без курсу за валютою; критичні розбіжності). */
  details: Record<string, number>;
}

export interface ChecklistResult {
  items: ChecklistItemResult[];
  blockingFailures: number;
  warnings: number;
  pendingConfirmations: number;
  /** Підтверджень, що більше не узгоджуються з журналом (stale). */
  staleConfirmations: number;
  /** Чи потрібен пункт упаковки (є загальна сума упаковки за місяць). */
  packagingNeeded: boolean;
  /** Можна закрити: місяць минув і жодного ■. */
  canClose: boolean;
  /** Усі ☐ підтверджено й узгоджені з журналом (з закриттям дає право на «Чистий прибуток»). */
  allConfirmed: boolean;
}

export function evaluateChecklist(f: ChecklistFacts): ChecklistResult {
  const items: ChecklistItemResult[] = [];
  const missingRates = Object.values(f.entriesWithoutRate).reduce((a, b) => a + b, 0);
  items.push({
    item: "orders_final",
    kind: "blocking",
    status: f.ordersNotFinal > 0 ? "blocked" : "ok",
    count: f.ordersNotFinal,
    value: null,
    details: { recognized: f.ordersRecognized },
  });
  items.push({
    item: "rates_for_display_currencies",
    kind: "blocking",
    status: missingRates > 0 ? "blocked" : "ok",
    count: missingRates,
    value: null,
    details: { ...f.entriesWithoutRate, entries: f.entries },
  });
  const warn = (item: WarningItem, count: number, details: Record<string, number> = {}) =>
    items.push({ item, kind: "warning", status: count > 0 ? "warning" : "ok", count, value: null, details });
  warn("open_discrepancies", f.openDiscrepancies, { critical: f.criticalDiscrepancies });
  warn("orders_need_review", f.ordersNeedReview);
  warn("unknown_cost_units", f.unknownCostUnits);
  const packagingNeeded = f.packagingTotals > 0;
  const packagingConfirmed = f.confirmations.packaging_total_accounted === "entered";
  warn("packaging_forecast_with_total", packagingNeeded && !packagingConfirmed ? f.ordersWithPackagingForecast : 0, { totals: f.packagingTotals });
  for (const item of CONFIRM_ITEMS) {
    const value = f.confirmations[item] ?? null;
    const count = f.entriesByConfirmItem[item] ?? 0;
    const expenses = f.expensesByConfirmItem?.[item] ?? 0;
    const details: Record<string, number> = expenses > 0 ? { expenses } : {};
    if (item === "packaging_total_accounted" && !packagingNeeded && value !== "entered") {
      items.push({ item, kind: "confirm", status: "not_needed", count, value, details });
      continue;
    }
    if (!value) {
      items.push({ item, kind: "confirm", status: "pending", count, value, details });
      continue;
    }
    const err = confirmationError(item, value, count + expenses);
    items.push(
      err
        ? { item, kind: "confirm", status: "stale", count, value, details, staleReason: err }
        : { item, kind: "confirm", status: "confirmed", count, value, details },
    );
  }
  const blockingFailures = items.filter((i) => i.status === "blocked").length;
  const warnings = items.filter((i) => i.status === "warning").length;
  const pendingConfirmations = items.filter((i) => i.status === "pending").length;
  const staleConfirmations = items.filter((i) => i.status === "stale").length;
  return {
    items,
    blockingFailures,
    warnings,
    pendingConfirmations,
    staleConfirmations,
    packagingNeeded,
    canClose: f.fullyPast && blockingFailures === 0,
    allConfirmed: pendingConfirmations === 0 && staleConfirmations === 0,
  };
}

/**
 * Чи узгоджене підтвердження з фактами місяця: «внесено» — є діючі записи або витрати періоду пункту; «за місяць
 * немає» — немає ні записів, ні витрат; «не потрібно» (упаковка) — завжди. records — записи + витрати місяця пункту.
 * Повертає код помилки (financeExpenses.error.*) або null.
 */
export function confirmationError(item: ConfirmItem, value: ConfirmValue, records: number): string | null {
  if (!allowedConfirmValues(item).includes(value)) return "financeExpenses.error.confirmValueInvalid";
  if (value === "entered" && records === 0) return "financeExpenses.error.confirmEnteredWithoutEntries";
  if (value === "none_this_month" && records > 0) return "financeExpenses.error.confirmNoneWithEntries";
  return null;
}

/** Плаский вигляд чек-листа для finance_change_log (код → значення / кількість; застаріле підтвердження — «stale»). */
export function checklistForLog(result: ChecklistResult): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const i of result.items) out[i.item] = i.kind === "confirm" ? (i.status === "stale" ? "stale" : i.value) : i.count;
  return out;
}
