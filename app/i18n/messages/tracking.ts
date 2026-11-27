import type { MessageModule } from "../types";

/**
 * Етап 3: відстеження посилок, фактична передача перевізнику, документи перевізника (PDF),
 * комерційний інвойс для друку, передача трек-номера в Shopify.
 * Правило формулювань: до фактичної передачі посилку не називаємо «відправленою».
 */
const messages: MessageModule = {
  uk: {
    // --- Статуси відстеження (TrackingStatus) ---
    "tracking.status.none": "Ще не перевірявся",
    "tracking.status.created": "Створено, ще не передано",
    "tracking.status.accepted": "Прийнято перевізником",
    "tracking.status.in_transit": "У дорозі",
    "tracking.status.customs": "Митне оформлення",
    "tracking.status.out_for_delivery": "Доставляється отримувачу",
    "tracking.status.delivered": "Доставлено",
    "tracking.status.failed_attempt": "Невдала спроба доставки",
    "tracking.status.returned": "Повернення",
    "tracking.status.lost": "Втрачено",
    "tracking.status.exception": "Проблема у перевізника",
    "tracking.status.cancelled": "Скасовано у перевізника",
    "tracking.status.unknown": "Невідомий статус",

    // --- Блок «Відстеження» в картці накладної ---
    "tracking.section.title": "Відстеження",
    "tracking.field.status": "Статус відстеження",
    "tracking.field.carrierStatus": "Статус перевізника",
    "tracking.field.carrierStatusValue": "{text} (код {code})",
    "tracking.field.statusAt": "Час статусу",
    "tracking.field.lastChecked": "Остання перевірка",
    "tracking.field.handedOver": "Передано перевізнику",
    "tracking.field.delivered": "Доставлено",
    "tracking.notChecked": "Ще не перевірялося",
    "tracking.notYet": "Ще ні",
    "tracking.unsupported": "Перевізник не підтримує відстеження через API.",
    "tracking.unsupportedManual": "Після фактичної передачі посилки позначте це вручну кнопкою «Передано перевізнику».",
    "tracking.refresh.button": "Оновити статус",
    "tracking.refresh.help": "Статус перевіряється періодично, якщо відстеження увімкнено в налаштуваннях. Можна оновити й вручну.",
    "tracking.events.title": "Події перевізника",
    "tracking.events.empty": "Подій від перевізника ще немає.",
    "tracking.event.code": "код {code}",

    // --- Фактична передача перевізнику ---
    "tracking.handover.button": "Передано перевізнику",
    "tracking.handover.help": "Натискайте лише після того, як посилку фізично передали перевізнику.",
    "tracking.handover.title": "Посилку фізично передано перевізнику?",
    "tracking.handover.body":
      "Підтверджуйте лише після фактичної передачі посилки у відділенні або кур’єру. Замовлення отримає статус «Передано перевізнику»; після цього скасувати накладну тут уже не можна.",
    "tracking.handover.shopify": "Трек-номер буде передано в Shopify (виконання замовлення).",
    "tracking.handover.shopifyDisabled": "Передачу трек-номера в Shopify вимкнено в налаштуваннях — у Shopify нічого не надсилається.",
    "tracking.handover.notShopify": "Замовлення не з Shopify — у Shopify нічого не надсилається.",
    "tracking.handover.confirm": "Так, посилку передано",
    "tracking.handover.source.manual": "підтвердив менеджер",
    "tracking.handover.source.tracking": "за даними перевізника",
    "tracking.deleted.title": "Перевізник повідомляє: накладну видалено",
    "tracking.deleted.body":
      "Не передавайте посилку з цією накладною — позначити передачу перевізнику неможливо. Перевірте накладну в кабінеті перевізника; якщо її справді видалено — скасуйте накладну в застосунку та створіть нову.",

    // --- Трек-номер у Shopify ---
    "tracking.shopify.label": "Трек-номер у Shopify",
    "tracking.shopify.sent": "Передано {time}",
    "tracking.shopify.pending": "Очікує передачі (у черзі)",
    "tracking.shopify.afterHandover": "Буде передано після фактичної передачі посилки перевізнику",
    "tracking.shopify.disabled": "Вимкнено в налаштуваннях",
    "tracking.shopify.notApplicable": "Не застосовується — замовлення не з Shopify",
    "tracking.shopify.outcome.created": "створено виконання в Shopify",
    "tracking.shopify.outcome.already_recorded": "вже було зафіксовано раніше",
    "tracking.shopify.outcome.found_existing": "знайдено наявне виконання в Shopify",
    "tracking.shopify.outcome.already_fulfilled_in_shopify": "замовлення вже виконано в Shopify",
    "tracking.shopify.outcome.not_ready": "Shopify ще не готовий до виконання замовлення",
    "tracking.shopify.outcome.not_linked": "замовлення не пов’язане з Shopify",

    // --- Документи ---
    "tracking.documents.title": "Документи",
    "tracking.documents.kind.label": "Етикетка (маркування)",
    "tracking.documents.kind.invoice": "Комерційний інвойс перевізника",
    "tracking.documents.kind.customs_declaration": "Митна декларація",
    "tracking.documents.help": "PDF перевізника відкриється в новій вкладці.",
    "tracking.documents.none":
      "Документи перевізника недоступні для цієї накладної (тестовий перевізник, ручна прив’язка або перевізник не видає документи через API).",
    "tracking.documents.appInvoice": "Комерційний інвойс для друку",
    "tracking.documents.error.title": "Не вдалося отримати документ",
    "tracking.documents.error.notAvailable": "Цей документ недоступний для накладної.",
    "tracking.documents.error.notFound": "Документ або накладну не знайдено. Оновіть сторінку.",
    "tracking.documents.error.forbidden": "Недостатньо прав для отримання документа.",
    "tracking.documents.error.session": "Сесія завершилася. Оновіть сторінку й спробуйте ще раз.",
    "tracking.documents.error.rejected": "Перевізник відмовив у видачі документа.",
    "tracking.documents.error.unavailable": "Перевізник зараз недоступний. Спробуйте пізніше.",
    "tracking.documents.error.auth": "Перевізник не прийняв ключ API — власнику варто перевірити ключ у налаштуваннях.",
    "tracking.documents.error.notConfigured": "Інтеграцію з перевізником не налаштовано.",
    "tracking.documents.error.network": "Немає зв’язку із сервером. Перевірте з’єднання й спробуйте ще раз.",
    "tracking.documents.error.generic": "Не вдалося отримати документ. Спробуйте ще раз.",

    // --- Накладна недоступна (перевізник за замовчуванням не створює накладних) ---
    "tracking.waybill.novaPostDisabled.title": "{carrier}: створення реальних накладних вимкнено",
    "tracking.waybill.novaPostDisabled.body": "Нові накладні не створюються — перевізнику нічого не надсилається.",
    "tracking.waybill.novaPostDisabled.owner":
      "Власник вмикає створення змінною середовища NOVA_POST_SHIPMENTS_ENABLED=true на Render (Environment) з перезапуском сервісу — лише після рішення створювати реальні накладні.",

    // --- Результати дій ---
    "tracking.result.updated": "Статус відстеження оновлено.",
    "tracking.result.unchanged": "Статус відстеження не змінився.",
    "tracking.result.handedOverByCarrier": "Перевізник підтвердив прийняття посилки — статус замовлення оновлено.",
    "tracking.result.handedOver": "Позначено: посилку фактично передано перевізнику.",
    "tracking.result.shopifyQueued": "Трек-номер буде передано в Shopify.",

    // --- Помилки сервісів (коди DomainError) ---
    "tracking.notSupported": "Перевізник не підтримує відстеження через API.",
    "tracking.carrierUnavailable": "Перевізник зараз недоступний — статус не оновлено. Спробуйте пізніше.",
    "shipment.alreadyHandedOver": "Посилку вже передано перевізнику.",
    "shipment.deletedAtCarrier": "Перевізник повідомляє, що накладну видалено, — передачу не позначено. Скасуйте накладну й створіть нову.",
    "waybill.notActive": "Накладна неактивна (скасована або ще не створена).",
    "document.notAvailable": "Документ недоступний для цієї накладної.",

    // --- Історія замовлення ---
    "order.event.tracking_status": "Оновлено статус відстеження",
    "order.event.handed_over": "Посилку передано перевізнику",
    "order.event.shopify_fulfilled": "Трек-номер передано в Shopify",
    "order.history.resolution.tracking_recovered": "Доставка відновилася за даними перевізника",
    "order.history.resolution.shopify_fulfilled": "Трек-номер передано в Shopify",

    // --- Комерційний інвойс (сторінка для друку) ---
    "tracking.invoice.title": "Комерційний інвойс {number}",
    "tracking.invoice.subtitle": "Замовлення {order} · формат A4",
    "tracking.invoice.print": "Друкувати",
    "tracking.invoice.scrollHint": "Таблиця ширша за екран — прокрутіть →",
    "tracking.invoice.back": "До замовлення",
    "tracking.invoice.note":
      "Підписи полів у документі — англійською: інвойс читає митниця країни призначення. Друкується лише сам документ.",
    "tracking.invoice.noWaybill": "Номер накладної з’явиться в інвойсі після створення накладної.",
    "tracking.invoice.missing.title": "Бракує митних даних",
    "tracking.invoice.missing.body": "Інвойс неповний — митниця може затримати посилку. Заповніть дані товарів:",
    "tracking.invoice.missing.line": "Позиція {position} ({item}): {fields}",
    "tracking.invoice.missing.action": "Відкрити замовлення",

    // --- Перелік накладних ---
    "tracking.col.tracking": "Відстеження",
  },
  en: {
    "tracking.status.none": "Not checked yet",
    "tracking.status.created": "Created, not handed over yet",
    "tracking.status.accepted": "Accepted by carrier",
    "tracking.status.in_transit": "In transit",
    "tracking.status.customs": "Customs clearance",
    "tracking.status.out_for_delivery": "Out for delivery",
    "tracking.status.delivered": "Delivered",
    "tracking.status.failed_attempt": "Delivery attempt failed",
    "tracking.status.returned": "Returned",
    "tracking.status.lost": "Lost",
    "tracking.status.exception": "Carrier exception",
    "tracking.status.cancelled": "Cancelled at carrier",
    "tracking.status.unknown": "Unknown status",

    "tracking.section.title": "Tracking",
    "tracking.field.status": "Tracking status",
    "tracking.field.carrierStatus": "Carrier status",
    "tracking.field.carrierStatusValue": "{text} (code {code})",
    "tracking.field.statusAt": "Status time",
    "tracking.field.lastChecked": "Last checked",
    "tracking.field.handedOver": "Handed to carrier",
    "tracking.field.delivered": "Delivered",
    "tracking.notChecked": "Not checked yet",
    "tracking.notYet": "Not yet",
    "tracking.unsupported": "The carrier does not support tracking via API.",
    "tracking.unsupportedManual": "After the parcel is actually handed over, mark it manually with “Handed to carrier”.",
    "tracking.refresh.button": "Refresh status",
    "tracking.refresh.help": "The status is checked periodically when tracking is enabled in settings. You can also refresh it manually.",
    "tracking.events.title": "Carrier events",
    "tracking.events.empty": "No carrier events yet.",
    "tracking.event.code": "code {code}",

    "tracking.handover.button": "Handed to carrier",
    "tracking.handover.help": "Press only after the parcel has physically been handed to the carrier.",
    "tracking.handover.title": "Has the parcel physically been handed to the carrier?",
    "tracking.handover.body":
      "Confirm only after the parcel has actually been handed over at a branch or to a courier. The order gets the “Handed to carrier” status; after that the waybill can no longer be cancelled here.",
    "tracking.handover.shopify": "The tracking number will be sent to Shopify (order fulfillment).",
    "tracking.handover.shopifyDisabled": "Sending tracking numbers to Shopify is disabled in settings — nothing is sent to Shopify.",
    "tracking.handover.notShopify": "Not a Shopify order — nothing is sent to Shopify.",
    "tracking.handover.confirm": "Yes, parcel handed over",
    "tracking.handover.source.manual": "confirmed by a manager",
    "tracking.handover.source.tracking": "according to the carrier",
    "tracking.deleted.title": "The carrier reports this waybill as deleted",
    "tracking.deleted.body":
      "Do not hand over the parcel with this waybill — marking it as handed to the carrier is not possible. Check the waybill in the carrier portal; if it was really deleted, cancel the waybill in the app and create a new one.",

    "tracking.shopify.label": "Tracking number in Shopify",
    "tracking.shopify.sent": "Sent {time}",
    "tracking.shopify.pending": "Pending (queued)",
    "tracking.shopify.afterHandover": "Will be sent after the parcel is actually handed to the carrier",
    "tracking.shopify.disabled": "Disabled in settings",
    "tracking.shopify.notApplicable": "Not applicable — not a Shopify order",
    "tracking.shopify.outcome.created": "fulfillment created in Shopify",
    "tracking.shopify.outcome.already_recorded": "already recorded earlier",
    "tracking.shopify.outcome.found_existing": "existing fulfillment found in Shopify",
    "tracking.shopify.outcome.already_fulfilled_in_shopify": "the order is already fulfilled in Shopify",
    "tracking.shopify.outcome.not_ready": "Shopify is not ready to fulfill the order yet",
    "tracking.shopify.outcome.not_linked": "the order is not linked to Shopify",

    "tracking.documents.title": "Documents",
    "tracking.documents.kind.label": "Label (marking)",
    "tracking.documents.kind.invoice": "Carrier commercial invoice",
    "tracking.documents.kind.customs_declaration": "Customs declaration",
    "tracking.documents.help": "The carrier PDF opens in a new tab.",
    "tracking.documents.none":
      "Carrier documents are not available for this waybill (test carrier, manual link, or the carrier does not provide documents via API).",
    "tracking.documents.appInvoice": "Printable commercial invoice",
    "tracking.documents.error.title": "Could not get the document",
    "tracking.documents.error.notAvailable": "This document is not available for the waybill.",
    "tracking.documents.error.notFound": "Document or waybill not found. Refresh the page.",
    "tracking.documents.error.forbidden": "You don't have permission to get this document.",
    "tracking.documents.error.session": "The session has ended. Refresh the page and try again.",
    "tracking.documents.error.rejected": "The carrier refused to provide the document.",
    "tracking.documents.error.unavailable": "The carrier is unavailable right now. Try again later.",
    "tracking.documents.error.auth": "The carrier did not accept the API key — the owner should check the key in settings.",
    "tracking.documents.error.notConfigured": "The carrier integration is not configured.",
    "tracking.documents.error.network": "No connection to the server. Check the connection and try again.",
    "tracking.documents.error.generic": "Could not get the document. Please try again.",

    "tracking.waybill.novaPostDisabled.title": "{carrier}: creating real waybills is disabled",
    "tracking.waybill.novaPostDisabled.body": "No new waybills are created — nothing is sent to the carrier.",
    "tracking.waybill.novaPostDisabled.owner":
      "The owner enables it with the environment variable NOVA_POST_SHIPMENTS_ENABLED=true on Render (Environment) and a service restart — only after deciding to create real waybills.",

    "tracking.result.updated": "Tracking status updated.",
    "tracking.result.unchanged": "Tracking status has not changed.",
    "tracking.result.handedOverByCarrier": "The carrier confirmed accepting the parcel — the order status was updated.",
    "tracking.result.handedOver": "Marked: the parcel has actually been handed to the carrier.",
    "tracking.result.shopifyQueued": "The tracking number will be sent to Shopify.",

    "tracking.notSupported": "The carrier does not support tracking via API.",
    "tracking.carrierUnavailable": "The carrier is unavailable right now — the status was not updated. Try again later.",
    "shipment.alreadyHandedOver": "The parcel has already been handed to the carrier.",
    "shipment.deletedAtCarrier": "The carrier reports this waybill as deleted — the handover was not recorded. Cancel the waybill and create a new one.",
    "waybill.notActive": "The waybill is not active (cancelled or not created yet).",
    "document.notAvailable": "The document is not available for this waybill.",

    "order.event.tracking_status": "Tracking status updated",
    "order.event.handed_over": "Parcel handed to carrier",
    "order.event.shopify_fulfilled": "Tracking number sent to Shopify",
    "order.history.resolution.tracking_recovered": "Delivery recovered according to the carrier",
    "order.history.resolution.shopify_fulfilled": "Tracking number sent to Shopify",

    "tracking.invoice.title": "Commercial invoice {number}",
    "tracking.invoice.subtitle": "Order {order} · A4 format",
    "tracking.invoice.print": "Print",
    "tracking.invoice.scrollHint": "The table is wider than the screen — scroll →",
    "tracking.invoice.back": "Back to order",
    "tracking.invoice.note":
      "Field labels in the document are in English because customs in the destination country read the invoice. Only the document itself is printed.",
    "tracking.invoice.noWaybill": "The waybill number appears on the invoice after the waybill is created.",
    "tracking.invoice.missing.title": "Customs data missing",
    "tracking.invoice.missing.body": "The invoice is incomplete — customs may hold the parcel. Fill in the product data:",
    "tracking.invoice.missing.line": "Item {position} ({item}): {fields}",
    "tracking.invoice.missing.action": "Open order",

    "tracking.col.tracking": "Tracking",
  },
};

export default messages;
