/**
 * Етап 6, WP9: коди перевізників, що означають можливе повернення (docs/stage6-design.md §11, §12.2 «Логістика»).
 * Підказки — лише ПРИ ЧИТАННІ (код відстеження етапу 3 не змінюється: Нова пошта відображає ці коди як `exception`,
 * статусу `returned` вона не дає). Ключ першого рівня — код перевізника (`shipments.carrier_code`): новий перевізник
 * додає свій рядок. Чисті функції — без БД; їх використовують розділ «Повернення» (WP9) і вкладка «Логістика» (WP8).
 */
import type { RETURN_KINDS, RETURN_REASON_CODES } from "~/domain/finance";

/** Що каже перевізник (i18n `returns.signal.<код>`). */
export const CARRIER_RETURN_SIGNALS = ["return_ordered", "refused", "return_uncleared", "return_preparing"] as const;
export type CarrierReturnSignal = (typeof CARRIER_RETURN_SIGNALS)[number];

/**
 * Коди статусів перевізника → сигнал повернення. nova_post — офіційні коди Nova Post API v1.0 (102 «Returns (sender
 * ordered a return)», 103 «Refusal of shipment», 131 «Return of uncleared cargo», 132 «Preparing for return»; див.
 * integrations/carriers/nova-post/tracking-codes.ts); test — код вигаданого тестового перевізника (демо).
 */
export const CARRIER_RETURN_CODES = {
  nova_post: {
    "102": "return_ordered",
    "103": "refused",
    "131": "return_uncleared",
    "132": "return_preparing",
  },
  test: { "TEST-RETURN": "return_ordered" },
} as const satisfies Record<string, Record<string, CarrierReturnSignal>>;

/** Вид випадку, який пропонує сигнал (кнопка «Відкрити»): відмова отримувача — `refused`, решта — повернення перевізником. */
export const SIGNAL_CASE_KIND: Readonly<Record<CarrierReturnSignal, (typeof RETURN_KINDS)[number]>> = {
  return_ordered: "carrier_return",
  refused: "refused",
  return_uncleared: "carrier_return",
  return_preparing: "carrier_return",
};

/** Причина, яку пропонує сигнал (власні коди причин, D-7). */
export const SIGNAL_REASON: Readonly<Record<CarrierReturnSignal, (typeof RETURN_REASON_CODES)[number]>> = {
  return_ordered: "unknown",
  refused: "refused_delivery",
  return_uncleared: "customs_refused",
  return_preparing: "unknown",
};

/** Сигнал повернення для коду статусу перевізника; невідомий перевізник або код → null. */
export function carrierReturnSignal(carrierCode: string | null | undefined, statusCode: string | null | undefined): CarrierReturnSignal | null {
  if (!carrierCode || !statusCode) return null;
  if (!Object.prototype.hasOwnProperty.call(CARRIER_RETURN_CODES, carrierCode)) return null;
  const codes = CARRIER_RETURN_CODES[carrierCode as keyof typeof CARRIER_RETURN_CODES] as Readonly<Record<string, CarrierReturnSignal>>;
  const code = statusCode.trim();
  return Object.prototype.hasOwnProperty.call(codes, code) ? codes[code]! : null;
}

/** Пари (перевізник, коди) для SQL-умов. */
export function carrierReturnCodeList(): Array<{
  carrierCode: string;
  codes: string[];
}> {
  return Object.entries(CARRIER_RETURN_CODES).map(([carrierCode, codes]) => ({
    carrierCode,
    codes: Object.keys(codes),
  }));
}
