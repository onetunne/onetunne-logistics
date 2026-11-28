/**
 * Етап 6: доступ до фінансів (docs/stage6-design.md §14.1, F8). requireFinance(ctx, "view" | "manage") = дозвіл
 * (finance.view / finance.manage) + роль owner. Викликається в КОЖНІЙ функції сервісів читання й керування фінансами
 * (loaders, actions, експорт, команди, інструменти ШІ) — не лише в loader. Підроблений актор із дозволом, але роллю
 * staff, відхиляється.
 *
 * Внутрішні функції проведення (перелік — INTERNAL_POSTING_FUNCTIONS у contracts.ts) актора НЕ перевіряють: їх
 * запускають дії працівників (накладна, передача, пакування, надходження, закриття партії); вони пишуть лише
 * posted_by і не повертають грошей. Імпортувати їх у app/pages/**, app/routes/**, команди й інструменти ШІ заборонено
 * (тест-сканер tests/stage6/core/access-scanner.test.ts).
 */
import { can, ForbiddenError, type Actor, type Permission } from "~/domain/permissions";

export type FinanceAccessLevel = "view" | "manage";

export const FINANCE_PERMISSION: Readonly<Record<FinanceAccessLevel, Permission>> = {
  view: "finance.view",
  manage: "finance.manage",
};

/** Чи має актор доступ до фінансів рівня level (дозвіл + роль owner). */
export function canFinance(actor: Actor, level: FinanceAccessLevel): boolean {
  return actor.role === "owner" && can(actor, FINANCE_PERMISSION[level]);
}

/** Сервіс: ForbiddenError (403), якщо немає дозволу або роль не owner. */
export function requireFinance(ctx: { actor: Actor }, level: FinanceAccessLevel): void {
  if (!canFinance(ctx.actor, level)) throw new ForbiddenError(FINANCE_PERMISSION[level]);
}

/**
 * Loader/action сторінки: 403-відповідь (без переадресації — нічого не розкриває) замість ForbiddenError.
 */
export function requireFinanceOr403(ctx: { actor: Actor }, level: FinanceAccessLevel): void {
  if (!canFinance(ctx.actor, level)) throw new Response("Forbidden", { status: 403 });
}

/**
 * Поле фінансів для спільних сторінок (картка замовлення, головна, повернення): значення лише з finance.view і роллю
 * owner, інакше null (не порожнє — §14.2).
 */
export async function financeFieldOrNull<T>(ctx: { actor: Actor }, load: () => Promise<T>): Promise<T | null> {
  return canFinance(ctx.actor, "view") ? load() : null;
}
