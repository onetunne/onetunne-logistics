/**
 * Етап 6, WP9: групи категорій журналу для сум розділу «Повернення» (§11) — чисті константи (сторінки імпортують їх і
 * в коді компонента; суми рахує лише amounts.server.ts / stats.server.ts під requireFinance).
 */
import type { FinanceCategory } from "~/domain/finance";

export const RETURN_MONEY_GROUPS = {
  refunds: ["refund_product", "refund_shipping", "refund_other", "refund_adjustment", "refund_unknown"],
  returnShipping: ["return_shipping_cost"],
  returnHandling: ["return_handling"],
  cogsReturn: ["cogs_return"],
  retainedFees: ["payment_fees", "platform_fees"],
} as const satisfies Record<string, readonly FinanceCategory[]>;
export type ReturnMoneyGroup = keyof typeof RETURN_MONEY_GROUPS;
export const RETURN_MONEY_GROUP_KEYS = Object.keys(RETURN_MONEY_GROUPS) as ReturnMoneyGroup[];

/**
 * Групи, які можна віднести до конкретного випадку (attribution.ts entryCase). Утримані збори (комісії транзакцій
 * замовлення) випадку не належать — лише блок «За замовленням».
 */
export const CASE_MONEY_GROUP_KEYS = ["refunds", "returnShipping", "returnHandling", "cogsReturn"] as const satisfies readonly ReturnMoneyGroup[];
export type CaseMoneyGroup = (typeof CASE_MONEY_GROUP_KEYS)[number];

/** Витрати на повернення (§11): зворотна доставка + обробка. */
export const RETURN_COST_CATEGORIES: readonly FinanceCategory[] = [...RETURN_MONEY_GROUPS.returnShipping, ...RETURN_MONEY_GROUPS.returnHandling];
