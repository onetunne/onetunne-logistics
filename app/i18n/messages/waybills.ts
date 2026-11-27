import type { MessageModule } from "../types";

/**
 * Розділ «Накладні»: пояснення етапу, перевізники та їхні можливості, підсумок за станом, таблиця накладних.
 * Стани накладної — shipmentStatus.* (common.ts), статуси замовлення — status.* (common.ts).
 */
const messages: MessageModule = {
  uk: {
    "waybills.subtitle": "Накладні перевізників за замовленнями. Створена накладна — це ще не відправлення.",

    // Пояснення етапу
    "waybills.info.title": "Етап 1: лише тестові накладні",
    "waybills.info.titleProduction": "Етап 1: робочого перевізника ще не підключено",
    "waybills.info.demo":
      "У демо накладні створює тестовий перевізник (sandbox). Це тестові накладні: перевізнику нічого не надсилається, посилки фактично не відправляються.",
    "waybills.info.production":
      "Робочого перевізника ще не підключено, тому накладні тут поки не створюються. Тестовий перевізник у робочій версії недоступний.",
    "waybills.info.notShipped":
      "Створена накладна — ще не відправлення: статус «Передано перевізнику» з’являється лише після фактичної передачі посилки.",
    "waybills.info.stage3":
      "Етикетку перевізника (PDF) і комерційний інвойс друкують з картки замовлення; етикетки кількох замовлень одним PDF, пакувальні листи й інвойси — у розділі «Комплектація». Змінити дані створеної накладної — «Переоформити накладну» на картці замовлення (стару буде скасовано, створено нову).",
    "waybills.info.novaGlobal": "Nova Global підключимо після отримання офіційної документації API та ключів.",

    // Перевізники
    "waybills.carriers.title": "Перевізники",
    "waybills.carriers.description": "Підключені інтеграції та їхні можливості.",
    "waybills.carriers.default": "За замовчуванням",
    "waybills.carriers.mode.live": "Робочий режим",
    "waybills.carriers.notConfigured": "Не налаштовано",
    "waybills.carriers.notConfiguredHelp":
      "Очікує офіційну документацію API та ключі (етап 3). Накладні через цього перевізника поки не створюються.",
    "waybills.carriers.available": "Доступно",
    "waybills.carriers.unavailable": "Недоступно",
    "waybills.carriers.none": "Перевізників не підключено.",
    "waybills.carriers.novaPending":
      "Nova Global у демо не підключається: інтеграцію буде реалізовано на етапі 3, після отримання офіційної документації API та ключів.",
    "waybills.carrierName.test": "Тестовий перевізник (sandbox)",
    "waybills.capability.createShipment": "Створення накладних",
    "waybills.capability.cancelShipment": "Скасування",
    "waybills.capability.findByReference": "Пошук за референсом",
    "waybills.capability.rates": "Тарифи",
    "waybills.capability.tracking": "Відстеження",
    "waybills.capability.documents": "Документи PDF",

    // Підсумок за станом
    "waybills.summary.title": "Накладні за станом",
    "waybills.summary.partial": "Підсумок за останніми {count} накладними.",
    "waybills.summary.hint.creating": "Запит до перевізника виконується",
    "waybills.summary.hint.created": "Підтверджено перевізником",
    "waybills.summary.hint.unknown": "Потрібна звірка або ручний розгляд",
    "waybills.summary.hint.failed": "Перевізник не створив накладну",
    "waybills.summary.hint.cancelled": "Скасовано до передачі перевізнику",
    "waybills.unknown.title": "Є накладні з невідомим результатом",
    "waybills.unknown.body":
      "Накладних з невідомим результатом: {count}. Повторне створення заблоковано, щоб не з’явився дублікат. Перевірте їх у кабінеті перевізника та вирішіть у розділі «Проблеми».",
    "waybills.unknown.action": "Відкрити «Проблеми»",

    // Таблиця
    "waybills.table.title": "Усі накладні",
    "waybills.table.caption": "Накладні",
    "waybills.col.waybill": "Накладна",
    "waybills.col.status": "Стан накладної",
    "waybills.col.order": "Замовлення",
    "waybills.col.orderStatus": "Статус замовлення",
    "waybills.col.destination": "Країна",
    "waybills.col.carrier": "Перевізник",
    "waybills.col.weight": "Розрахункова вага",
    "waybills.col.value": "Оголошена вартість",
    "waybills.col.attempts": "Спроб",
    "waybills.col.created": "Створено",
    "waybills.noNumber": "Номера ще немає, референс:",
    "waybills.limit": "Показано останні {limit} накладних.",
    "waybills.empty.title": "Накладних ще немає",
    "waybills.empty.description":
      "Накладну створюють на сторінці замовлення або масово у списку замовлень — після успішної перевірки даних.",
    "waybills.empty.toOrders": "До замовлень",
  },
  en: {
    "waybills.subtitle": "Carrier waybills by order. A created waybill does not mean the parcel has shipped.",

    "waybills.info.title": "Stage 1: test waybills only",
    "waybills.info.titleProduction": "Stage 1: no live carrier connected yet",
    "waybills.info.demo":
      "In the demo, waybills are created by a test carrier (sandbox). These are test waybills: nothing is sent to a carrier and no parcels actually ship.",
    "waybills.info.production":
      "No live carrier is connected yet, so waybills are not created here for now. The test carrier is not available in the live app.",
    "waybills.info.notShipped":
      "A created waybill is not a shipment: the “Handed to carrier” status appears only after the parcel is actually handed over.",
    "waybills.info.stage3":
      "Print the carrier label (PDF) and the commercial invoice from the order page; labels of several orders in one PDF, packing slips and invoices are in Picking. To change a created waybill, use “Re-issue waybill” on the order page (the old one is cancelled and a new one created).",
    "waybills.info.novaGlobal": "Nova Global will be connected once the official API documentation and keys are received.",

    "waybills.carriers.title": "Carriers",
    "waybills.carriers.description": "Connected integrations and their capabilities.",
    "waybills.carriers.default": "Default",
    "waybills.carriers.mode.live": "Live mode",
    "waybills.carriers.notConfigured": "Not configured",
    "waybills.carriers.notConfiguredHelp":
      "Awaiting the official API documentation and keys (stage 3). No waybills can be created with this carrier yet.",
    "waybills.carriers.available": "Available",
    "waybills.carriers.unavailable": "Not available",
    "waybills.carriers.none": "No carriers are connected.",
    "waybills.carriers.novaPending":
      "Nova Global is not connected in the demo: the integration will be built in stage 3, after the official API documentation and keys are received.",
    "waybills.carrierName.test": "Test carrier (sandbox)",
    "waybills.capability.createShipment": "Create waybills",
    "waybills.capability.cancelShipment": "Cancel",
    "waybills.capability.findByReference": "Lookup by reference",
    "waybills.capability.rates": "Rates",
    "waybills.capability.tracking": "Tracking",
    "waybills.capability.documents": "PDF documents",

    "waybills.summary.title": "Waybills by state",
    "waybills.summary.partial": "Summary of the latest {count} waybills.",
    "waybills.summary.hint.creating": "Carrier request in progress",
    "waybills.summary.hint.created": "Confirmed by the carrier",
    "waybills.summary.hint.unknown": "Needs reconciliation or manual review",
    "waybills.summary.hint.failed": "The carrier did not create the waybill",
    "waybills.summary.hint.cancelled": "Cancelled before handover to the carrier",
    "waybills.unknown.title": "Some waybills have an unknown result",
    "waybills.unknown.body":
      "Waybills with an unknown result: {count}. Re-creation is blocked to avoid a duplicate. Check them in the carrier's portal and resolve them in Problems.",
    "waybills.unknown.action": "Open Problems",

    "waybills.table.title": "All waybills",
    "waybills.table.caption": "Waybills",
    "waybills.col.waybill": "Waybill",
    "waybills.col.status": "Waybill state",
    "waybills.col.order": "Order",
    "waybills.col.orderStatus": "Order status",
    "waybills.col.destination": "Country",
    "waybills.col.carrier": "Carrier",
    "waybills.col.weight": "Chargeable weight",
    "waybills.col.value": "Declared value",
    "waybills.col.attempts": "Attempts",
    "waybills.col.created": "Created",
    "waybills.noNumber": "No number yet, reference:",
    "waybills.limit": "Showing the latest {limit} waybills.",
    "waybills.empty.title": "No waybills yet",
    "waybills.empty.description":
      "Waybills are created on the order page or in bulk from the order list — after the data check passes.",
    "waybills.empty.toOrders": "Go to orders",
  },
};

export default messages;
