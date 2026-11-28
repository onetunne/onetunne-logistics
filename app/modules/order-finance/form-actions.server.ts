/**
 * Етап 6, WP4: ОДИН диспетчер фінансових дій картки замовлення (docs/stage6-design.md §17.7, §18.4). Сторінка
 * замовлення передає сюди форми з `intent`, що починається з `finance.` (isOrderFinanceIntent). Перший рядок —
 * requireFinance(ctx, "manage") (дозвіл finance.manage + роль owner): працівник і підроблений актор отримують помилку
 * доступу, нічого не записано. Кожна дія — сервіс керування (actions.server.ts) або сервіс пакета-власника (WP6 витрата
 * замовлення, WP7 атрибуція, WP3 повторне читання фактів).
 */
import { DomainError } from "~/lib/errors";
import { createExpense } from "~/modules/expenses/expenses.server";
import { requestOrderFinanceResync } from "~/modules/finance-sync/facts-view.server";
import { requireFinance } from "~/modules/finance/core/access.server";
import { setOrderAttribution } from "~/modules/partners/partners.server";
import { formString } from "~/server/http.server";
import type { ServiceContext } from "~/server/types";
import type { ActionResult } from "~/components/action-banner";
import {
  addOrderExternalWaybill,
  clearConfirmedAmounts,
  confirmOrderAmounts,
  recalculateOrderFinance,
  saveOrderChargeback,
  setOrderFinanceFlag,
} from "./actions.server";
import { isFlagOverride } from "./overrides";

/** Префікс фінансових дій картки замовлення. */
export const ORDER_FINANCE_INTENT_PREFIX = "finance.";

export function isOrderFinanceIntent(intent: string): boolean {
  return intent.startsWith(ORDER_FINANCE_INTENT_PREFIX);
}

function versionOf(form: FormData): number | null {
  const raw = formString(form, "financeVersion");
  if (!/^\d{1,9}$/.test(raw)) return null;
  return Number(raw);
}

/**
 * Виконує фінансову дію картки замовлення. Помилки повертає викликачу як виняток (сторінка перетворює їх
 * toActionError), успіх — ActionResult з ключами financeOrders.result.*.
 */
export async function handleOrderFinanceAction(ctx: ServiceContext, orderId: string, form: FormData): Promise<ActionResult> {
  requireFinance(ctx, "manage");
  const intent = formString(form, "intent");
  switch (intent) {
    case "finance.flag": {
      const flag = formString(form, "flag");
      if (!isFlagOverride(flag)) throw new DomainError("financeOrders.error.invalidFlag", 400);
      const active = formString(form, "active") === "1";
      const r = await setOrderFinanceFlag(ctx, { orderId, flag, active, reason: formString(form, "reason"), expectedVersion: versionOf(form) });
      return { ok: true, message: r.changed ? (active ? "financeOrders.result.flagSet" : "financeOrders.result.flagUnset") : "financeOrders.result.unchanged", tone: r.changed ? "success" : "info" };
    }
    case "finance.confirmAmounts": {
      await confirmOrderAmounts(ctx, { orderId, products: formString(form, "products"), shipping: formString(form, "shipping"), reason: formString(form, "reason"), expectedVersion: versionOf(form) });
      return { ok: true, message: "financeOrders.result.amountsConfirmed" };
    }
    case "finance.clearAmounts": {
      const r = await clearConfirmedAmounts(ctx, { orderId, reason: formString(form, "reason"), expectedVersion: versionOf(form) });
      return { ok: true, message: r.changed ? "financeOrders.result.amountsCleared" : "financeOrders.result.unchanged", tone: r.changed ? "success" : "info" };
    }
    case "finance.chargeback": {
      const r = await saveOrderChargeback(ctx, {
        orderId,
        disputeId: formString(form, "disputeId") || null,
        operationId: formString(form, "operationId"),
        amount: formString(form, "amount") || null,
        recovered: formString(form, "recovered") || null,
        currency: formString(form, "currency"),
        fee: formString(form, "fee") || null,
        feeCurrency: formString(form, "feeCurrency") || null,
        outcome: formString(form, "outcome") || null,
        decidedOn: formString(form, "decidedOn") || null,
        vatReducible: form.has("vatReducible"),
        fullPartnerCancellation: form.has("fullPartnerCancellation"),
        expectedVersion: (() => {
          const raw = formString(form, "disputeVersion");
          return /^\d{1,9}$/.test(raw) ? Number(raw) : null;
        })(),
        reason: formString(form, "reason") || null,
      });
      return { ok: true, message: r.created ? "financeOrders.result.chargebackCreated" : "financeOrders.result.chargebackSaved" };
    }
    case "finance.externalWaybill": {
      const r = await addOrderExternalWaybill(ctx, { orderId, number: formString(form, "number"), carrierCode: formString(form, "carrierCode") || null });
      if (r.ownShipment > 0) return { ok: true, message: "financeOrders.result.waybillOwn", tone: "info" };
      return { ok: true, message: r.inserted > 0 ? "financeOrders.result.waybillAdded" : "financeOrders.result.waybillExists", tone: r.inserted > 0 ? "success" : "info" };
    }
    case "finance.shippingCost": {
      // Ручна вартість доставки — витрата замовлення (WP6, категорія shipping_cost із замовленням): проводить WP6,
      // складник доставки стає «Факт (вручну)» після синхронізації замовлення.
      const r = await createExpense(ctx, {
        operationId: formString(form, "operationId"),
        category: formString(form, "category") === "duties_paid" ? "duties_paid" : "shipping_cost",
        amount: formString(form, "amount"),
        currency: formString(form, "currency"),
        dateMode: "single",
        expenseDate: formString(form, "date"),
        description: formString(form, "description") || null,
        order: orderId,
      });
      await recalculateOrderFinance(ctx, orderId);
      return { ok: true, message: r.duplicate ? "financeOrders.result.unchanged" : "financeOrders.result.shippingCostSaved", tone: r.duplicate ? "info" : "success" };
    }
    case "finance.partner": {
      const mode = formString(form, "mode") === "auto" ? "auto" : "manual";
      const partnerId = formString(form, "partnerId");
      const r = await setOrderAttribution(ctx, { orderId, mode, partnerId: mode === "manual" && partnerId ? partnerId : null, reason: formString(form, "reason") });
      return { ok: true, message: r.status === "attributed" ? "financeOrders.result.partnerSet" : r.status === "auto" ? "financeOrders.result.partnerAuto" : "financeOrders.result.partnerRemoved" };
    }
    case "finance.recalculate": {
      await recalculateOrderFinance(ctx, orderId);
      return { ok: true, message: "financeOrders.result.recalculated" };
    }
    case "finance.resyncShopify": {
      const r = await requestOrderFinanceResync(ctx, orderId);
      return { ok: true, message: `financeOrders.result.resync.${r.status}`, tone: r.status === "queued" ? "success" : "info" };
    }
    default:
      return { ok: false, error: "error.generic" };
  }
}
