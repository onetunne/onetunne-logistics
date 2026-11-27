/**
 * Коди статусів відстеження Nova Post API v1.0 → наш TrackingStatus (чиста таблиця).
 *
 * Джерело: GET /shipments/tracking (FullTracking) — опис `currentStatus[].statusCode` і `historyOnlineTracking[].code`
 * (58 кодів, однаковий перелік у BasicTracking). Документація: «будуйте логіку на числових code/statusCode, а не на назвах».
 *
 * Тлумачення, яких документація прямо не дає (NOT DOCUMENTED на кешованих сторінках):
 * - 9/10/11 («Closed…») → delivered: окремого коду «Доставлено/Отримано» немає; у класичному API Нової пошти
 *   ці коди означають «Відправлення отримано» (10/11 — ще й грошовий переказ).
 * - 7/8/110/135/149 (у відділенні/поштоматі/на зберіганні) → out_for_delivery: окремого «очікує в пункті видачі» в нашій моделі немає.
 * - Жоден код не означає остаточного «повернуто відправнику», тому "returned" (фінальний стан) не призначається:
 *   повернення/відмова/переадресація (102–106, 131, 132) → exception (потребує уваги менеджера).
 * - 121 («Sent to destination city after customs») → in_transit, а не customs: митне оформлення вже завершене.
 * - 999 («Undetermined») і будь-який невідомий код → unknown.
 */
import type { TrackingStatus } from "../types";

export const NOVA_POST_TRACKING_CODES: Readonly<Record<string, TrackingStatus>> = Object.freeze({
  "1": "created", // Ready to send
  "2": "cancelled", // Deleted
  "4": "accepted", // Accepted for sending
  "5": "in_transit", // Sent from the Sender's Division
  "6": "in_transit", // Arrived in the city of the Recipient
  "7": "out_for_delivery", // Arrived (at the Division)
  "8": "out_for_delivery", // Arrived (at the Postomat)
  "9": "delivered", // Closed
  "10": "delivered", // Closed, money transfer sent to the Sender
  "11": "delivered", // Closed, the sender has received the money transfer
  "13": "in_transit", // Arrival at the transit sorting center
  "16": "in_transit", // Departure from the transit sorting center
  "17": "in_transit", // ArrivalTransitWarehouse (currently not used)
  "19": "in_transit", // DepartureFromTransitWarehouse (currently not used)
  "30": "customs", // Arrived at customs terminal
  "31": "customs", // Departed from customs terminal
  "80": "in_transit", // Departed from the airport by aircraft
  "81": "in_transit", // Arrived at the destination airport
  "99": "exception", // Delivery to Postomat is impossible
  "101": "out_for_delivery", // Uploaded to the courier for delivery to the address
  "102": "exception", // Returns (sender ordered a return)
  "103": "exception", // Refusal of shipment
  "104": "exception", // Redirecting
  "105": "exception", // Utilization
  "106": "exception", // Received and created return shipment of Documents
  "110": "out_for_delivery", // Transferred to temporary storage
  "111": "failed_attempt", // Failed delivery attempt (targeted delivery)
  "112": "failed_attempt", // Delivery date postponed (targeted delivery)
  "113": "exception", // Storage period expired (Postomat)
  "114": "customs", // Awaiting customs clearance
  "115": "customs", // Arrived at customs terminal
  "116": "exception", // Broker refusal — under resolution
  "117": "lost", // Cargo not found or lost (customs)
  "118": "exception", // Forbidden content — delivery impossible (customs)
  "119": "customs", // Customs clearance in progress
  "120": "customs", // Customs clearance completed
  "121": "in_transit", // Sent to destination city after customs
  "122": "customs", // Preparing for transfer to customs
  "123": "exception", // Awaiting information from the recipient
  "125": "customs", // Preparing for transfer to customs
  "126": "customs", // Preparing for transfer to customs
  "127": "customs", // Customs declaration data verification in progress
  "128": "customs", // Processing accompanying documents prior to customs
  "130": "exception", // Import prohibited by customs
  "131": "exception", // Return of uncleared cargo
  "132": "exception", // Preparing for return
  "133": "exception", // Client communication regarding a customs comment
  "134": "customs", // Handed over to the customs broker
  "135": "out_for_delivery", // Placed in Storage Area
  "138": "exception", // Delay due to incorrect recipient information
  "141": "exception", // Storage period expired
  "144": "exception", // Storage period expired
  "149": "out_for_delivery", // In storage
  "155": "exception", // Transferred for disposal
  "197": "customs", // Processing customs documents
  "198": "customs", // Cargo inspection by customs
  "199": "customs", // Shipment requires customs clearance
  "999": "unknown", // Undetermined
});

/** Усі документовані коди (для перевірки повноти таблиці). */
export const NOVA_POST_DOCUMENTED_TRACKING_CODES: readonly string[] = Object.freeze(Object.keys(NOVA_POST_TRACKING_CODES));

/** Код статусу Nova Post → TrackingStatus; невідомий/порожній код → "unknown". */
export function mapNovaPostTrackingCode(code: string | number | null | undefined): TrackingStatus {
  if (code === null || code === undefined) return "unknown";
  const key = String(code).trim();
  return Object.prototype.hasOwnProperty.call(NOVA_POST_TRACKING_CODES, key) ? NOVA_POST_TRACKING_CODES[key]! : "unknown";
}
