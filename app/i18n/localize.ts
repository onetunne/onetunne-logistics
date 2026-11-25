import { isOrderStatus } from "~/domain/order-status";
import { hasKey, type TFunction, type TranslateParams } from "./index";

/** Службовий код (напр. confirmed_not_created) → зрозумілий текст; невідомий текст залишається як є. */
export function localizeCode(value: string, t: TFunction): string {
  const key = `order.code.${value}`;
  return hasKey(key) ? t(key) : value;
}

/**
 * Локалізує параметри повідомлень сервісів: статус замовлення, службові коди перевізника,
 * перелік полів відправника. Так у інтерфейсі не з'являються сирі ідентифікатори.
 */
export function localizeParams(params: TranslateParams | undefined | null, t: TFunction): TranslateParams | undefined {
  if (!params) return undefined;
  const out: TranslateParams = { ...params };
  if (typeof out.status === "string" && isOrderStatus(out.status)) out.status = t(`status.${out.status}`);
  if (typeof out.message === "string") out.message = localizeCode(out.message, t);
  if (typeof out.fields === "string") {
    out.fields = out.fields
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean)
      .map((f) => (hasKey(`order.waybill.shipperField.${f}`) ? t(`order.waybill.shipperField.${f}`) : f))
      .join(", ");
  }
  return out;
}
