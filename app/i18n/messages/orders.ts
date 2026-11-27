import type { MessageModule } from "../types";

/**
 * Список замовлень (app/pages/orders.tsx): вкладки, фільтри, таблиця, масові дії.
 * Статуси — common.ts (status.*), результати масових дій — results.ts (result.bulk.*).
 */
const messages: MessageModule = {
  uk: {
    "orders.subtitle": "Оплачені замовлення: перевірка даних і створення накладних.",
    "orders.tabs.label": "Фільтр замовлень за статусом",
    "orders.tabs.problems": "З проблемами",

    "orders.filters.searchPlaceholder": "Номер замовлення, клієнт, місто або email",
    "orders.filters.country": "Країна доставки",
    "orders.filters.allCountries": "Усі країни",
    "orders.filters.status": "Статус",
    "orders.filters.allStatuses": "Усі статуси",
    "orders.filters.problemsOnly": "Лише з проблемами",
    "orders.filters.titleActive": "Фільтри · активних: {count}",

    "orders.table.caption": "Список замовлень",
    "orders.col.order": "Замовлення",
    "orders.col.date": "Дата",
    "orders.col.customer": "Клієнт",
    "orders.col.destination": "Доставка",
    "orders.col.items": "Товарів",
    "orders.col.total": "Сума",
    "orders.col.status": "Статус",
    "orders.col.problems": "Проблеми",
    "orders.col.waybill": "Накладна",
    "orders.problems.errors": "Помилок: {count}",
    "orders.problems.warnings": "Попереджень: {count}",
    "orders.automationPaused": "Автоматизацію призупинено",
    "orders.demoOrder": "Вигадане демо-замовлення",
    "orders.list.range": "Показано {from}–{to} з {total}",

    "orders.bulk.label": "Масові дії з вибраними замовленнями",
    "orders.bulk.hint": "Позначте замовлення в таблиці, щоб виконати масову дію.",
    "orders.bulk.noneSelected": "Не вибрано жодного замовлення.",
    "orders.bulk.validate.button": "Перевірити дані вибраних",
    "orders.bulk.validate.title": "Перевірити дані вибраних замовлень?",
    "orders.bulk.validate.count": "Буде перевірено замовлень: {count}.",
    "orders.bulk.validate.fixes":
      "Автоматично виправляються лише однозначні помилки формату: зайві пробіли, регістр коду країни, формат телефону та поштового індексу. Кожну зміну записано в історію замовлення.",
    "orders.bulk.validate.ambiguous": "Неоднозначні випадки не змінюються — їх буде додано до розділу «Проблеми» для вашого рішення.",
    "orders.bulk.validate.scope":
      "Перевірити можна лише замовлення без накладної (статуси «Оплачено», «Очікує перевірки», «Потребує виправлення»). Інші вибрані замовлення буде пропущено.",
    "orders.bulk.validate.confirm": "Перевірити",
    "orders.bulk.waybills.button.test": "Створити тестові накладні",
    "orders.bulk.waybills.button.live": "Створити накладні",
    "orders.bulk.waybills.title.test": "Створити тестові накладні?",
    "orders.bulk.waybills.title.live": "Створити накладні?",
    "orders.bulk.waybills.count": "Вибрано замовлень: {count}.",
    "orders.bulk.waybills.scope":
      "Накладні створюються лише для вибраних замовлень зі статусом «Очікує перевірки» без проблем з даними. Інші замовлення буде пропущено.",
    "orders.bulk.waybills.noDuplicates": "Наявні накладні ніколи не дублюються: якщо накладна вже є, нову не створюємо.",
    "orders.bulk.waybills.notShipped":
      "Накладна — ще не відправлення: статус «Передано перевізнику» з’явиться лише після фактичної передачі посилки.",
    "orders.bulk.waybills.testNote": "Це тестові накладні тестового перевізника — реальним перевізникам нічого не надсилається.",
    "orders.bulk.waybills.confirm": "Створити",

    "orders.bulk.validated.fixes": "Автовиправлень формату: {fixes}.",
    "orders.bulk.validated.needsCorrection": "Потребують виправлення: {needsCorrection} — деталі в розділі «Проблеми».",
    "orders.bulk.validated.skipped": "Частину замовлень не перевірено: перевірка доступна лише до створення накладної.",
    "orders.bulk.waybills.testCreated": "Створені накладні — тестові: реальним перевізникам нічого не надіслано.",
    "orders.bulk.waybills.notEligible":
      "Не підходять для накладної: {notEligible} — потрібен статус «Очікує перевірки» без проблем з даними.",
    "orders.bulk.waybills.setup": "Не створено через налаштування: {setup} — перевірте дані відправника та підключення перевізника.",
    "orders.bulk.waybills.inProgress": "Ще створюються: {inProgress} — оновіть сторінку за кілька секунд.",
    "orders.bulk.waybills.rejected": "Відхилено перевізником: {rejected} — виправте дані на сторінці замовлення та повторіть.",
    "orders.bulk.waybills.notCreated": "Перевізник не створив: {notCreated} — можна безпечно повторити.",
    "orders.bulk.waybills.unknown":
      "Результат невідомий: {unknown} — ці замовлення передано на ручний розгляд (розділ «Проблеми»), автоматизацію призупинено.",
    "orders.bulk.waybills.errors": "Не вдалося обробити: {errors} — спробуйте ще раз.",

    "orders.empty.title": "Замовлень ще немає",
    "orders.empty.demo": "Імітуйте нове оплачене замовлення на головній сторінці — воно з’явиться тут.",
    "orders.empty.production": "Оплачені замовлення з Shopify з’являться тут після підключення синхронізації (етап 2).",
    "orders.empty.toDashboard": "На головну",
    "orders.empty.filtered.title": "Нічого не знайдено",
    "orders.empty.filtered.description": "Немає замовлень, що відповідають умовам пошуку. Змініть фільтри або скиньте їх.",
    "orders.empty.resetFilters": "Скинути фільтри",
  },
  en: {
    "orders.subtitle": "Paid orders: data checks and waybill creation.",
    "orders.tabs.label": "Filter orders by status",
    "orders.tabs.problems": "With problems",

    "orders.filters.searchPlaceholder": "Order number, customer, city or email",
    "orders.filters.country": "Destination country",
    "orders.filters.allCountries": "All countries",
    "orders.filters.status": "Status",
    "orders.filters.allStatuses": "All statuses",
    "orders.filters.problemsOnly": "Only with problems",
    "orders.filters.titleActive": "Filters · active: {count}",

    "orders.table.caption": "Order list",
    "orders.col.order": "Order",
    "orders.col.date": "Date",
    "orders.col.customer": "Customer",
    "orders.col.destination": "Destination",
    "orders.col.items": "Items",
    "orders.col.total": "Total",
    "orders.col.status": "Status",
    "orders.col.problems": "Problems",
    "orders.col.waybill": "Waybill",
    "orders.problems.errors": "Errors: {count}",
    "orders.problems.warnings": "Warnings: {count}",
    "orders.automationPaused": "Automation paused",
    "orders.demoOrder": "Fictional demo order",
    "orders.list.range": "Showing {from}–{to} of {total}",

    "orders.bulk.label": "Bulk actions for selected orders",
    "orders.bulk.hint": "Select orders in the table to run a bulk action.",
    "orders.bulk.noneSelected": "No orders selected.",
    "orders.bulk.validate.button": "Check selected orders",
    "orders.bulk.validate.title": "Check data of the selected orders?",
    "orders.bulk.validate.count": "Orders to be checked: {count}.",
    "orders.bulk.validate.fixes":
      "Only unambiguous format errors are fixed automatically: extra spaces, country code case, phone and postal code format. Every change is recorded in the order history.",
    "orders.bulk.validate.ambiguous": "Ambiguous cases are not changed — they are added to Problems for your decision.",
    "orders.bulk.validate.scope":
      "Only orders without a waybill can be checked (statuses “Paid”, “Awaiting review”, “Needs correction”). Other selected orders are skipped.",
    "orders.bulk.validate.confirm": "Check",
    "orders.bulk.waybills.button.test": "Create test waybills",
    "orders.bulk.waybills.button.live": "Create waybills",
    "orders.bulk.waybills.title.test": "Create test waybills?",
    "orders.bulk.waybills.title.live": "Create waybills?",
    "orders.bulk.waybills.count": "Selected orders: {count}.",
    "orders.bulk.waybills.scope":
      "Waybills are created only for selected orders in “Awaiting review” without data problems. Other orders are skipped.",
    "orders.bulk.waybills.noDuplicates": "Existing waybills are never duplicated: if an order already has one, no new waybill is created.",
    "orders.bulk.waybills.notShipped":
      "A waybill is not a shipment yet: the “Handed to carrier” status appears only after the parcel is actually handed over.",
    "orders.bulk.waybills.testNote": "These are test waybills from the test carrier — nothing is sent to real carriers.",
    "orders.bulk.waybills.confirm": "Create",

    "orders.bulk.validated.fixes": "Format auto-fixes: {fixes}.",
    "orders.bulk.validated.needsCorrection": "Need correction: {needsCorrection} — see Problems for details.",
    "orders.bulk.validated.skipped": "Some orders were not checked: checking is available only before a waybill is created.",
    "orders.bulk.waybills.testCreated": "The created waybills are test waybills: nothing was sent to real carriers.",
    "orders.bulk.waybills.notEligible":
      "Not eligible for a waybill: {notEligible} — the order must be in “Awaiting review” without data problems.",
    "orders.bulk.waybills.setup": "Not created because of settings: {setup} — check the sender details and the carrier connection.",
    "orders.bulk.waybills.inProgress": "Still being created: {inProgress} — refresh the page in a few seconds.",
    "orders.bulk.waybills.rejected": "Rejected by the carrier: {rejected} — fix the data on the order page and retry.",
    "orders.bulk.waybills.notCreated": "Not created by the carrier: {notCreated} — it is safe to retry.",
    "orders.bulk.waybills.unknown":
      "Outcome unknown: {unknown} — these orders were sent to manual review (Problems) and their automation paused.",
    "orders.bulk.waybills.errors": "Could not be processed: {errors} — try again.",

    "orders.empty.title": "No orders yet",
    "orders.empty.demo": "Simulate a new paid order on the home page — it will appear here.",
    "orders.empty.production": "Paid orders from Shopify will appear here once sync is connected (stage 2).",
    "orders.empty.toDashboard": "Go to home",
    "orders.empty.filtered.title": "No orders found",
    "orders.empty.filtered.description": "No orders match your search. Change the filters or reset them.",
    "orders.empty.resetFilters": "Reset filters",
  },
};

export default messages;
