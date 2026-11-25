import type { MessageModule } from "../types";

/**
 * Розділ «Проблеми»: вкладки, фільтр серйозності, підсумок, картки замовлень, пропозиції, способи вирішення.
 * Назви й пояснення самих проблем — issue.<CODE>.title/help (validation.ts), назви полів — field.* (validation.ts).
 */
const messages: MessageModule = {
  uk: {
    "problems.subtitle": "Неоднозначні ситуації з поясненням причини та запропонованим рішенням",

    // Вкладки та фільтр
    "problems.tabs.label": "Стан проблем",
    "problems.tabs.open": "Відкриті",
    "problems.tabs.resolved": "Вирішені",
    "problems.filter.label": "Серйозність",
    "problems.filter.errors": "Помилки",
    "problems.filter.warnings": "Попередження",
    "problems.filter.current": "{label} — вибрано",

    // Підсумок відкритих проблем
    "problems.kpi.title": "Відкриті проблеми",
    "problems.kpi.errors.label": "Помилки",
    "problems.kpi.errors.hint": "Блокують створення накладної",
    "problems.kpi.warnings.label": "Попередження",
    "problems.kpi.warnings.hint": "Не блокують, але варто перевірити",
    "problems.kpi.orders.label": "Замовлення з проблемами",
    "problems.kpi.orders.hint": "Мають хоча б одну відкриту проблему",

    // Картка замовлення
    "problems.list.label": "Проблеми за замовленнями",
    "problems.group.noOrder": "Без замовлення",
    "problems.group.count": "Проблем: {count}",
    "problems.openOrder": "Відкрити замовлення",
    "problems.openOrderLabel": "Відкрити замовлення {number}",

    // Проблема
    "problems.issue.field": "Поле",
    "problems.issue.detected": "Виявлено",
    "problems.issue.resolution": "Як вирішено",
    "problems.issue.resolvedAt": "Вирішено",
    "problems.issue.carrierMessage": "Повідомлення перевізника: {message}",
    "problems.issue.fixInOrder": "Виправте дані в замовленні — після збереження перевірка запуститься повторно.",
    "problems.issue.fixProduct":
      "Виправте дані товару (вага, митні дані) — після збереження пов’язані замовлення буде перевірено повторно.",

    // Пропозиції
    "problems.suggestion.single": "Запропоноване виправлення. Застосуйте його, якщо воно правильне:",
    "problems.suggestion.multiple": "Оберіть правильний варіант:",
    "problems.suggestion.apply": "Застосувати варіант {value}",
    "problems.suggestion.note": "Зміна збережеться в історії замовлення, після чого замовлення буде перевірено повторно.",
    "problems.suggestion.locked":
      "Варіант не можна застосувати, бо замовлення має статус «{status}». Відкрийте замовлення, щоб розібратися.",

    // Приховування попередження
    "problems.dismiss.button": "Приховати попередження",
    "problems.dismiss.help": "Попередження не блокує накладну. Якщо все гаразд, його можна приховати.",

    // Способи вирішення
    "problems.resolution.revalidated": "Повторна перевірка більше не виявила проблему",
    "problems.resolution.data_corrected": "Дані виправлено вручну",
    "problems.resolution.suggestion_accepted": "Застосовано запропонований варіант",
    "problems.resolution.dismissed": "Попередження приховано",
    "problems.resolution.created": "Накладну створено",
    "problems.resolution.recovered": "Звірка знайшла створену накладну",
    "problems.resolution.manually_linked": "Накладну прив’язано вручну",
    "problems.resolution.confirmed_not_created": "Підтверджено, що накладну не створено",
    "problems.resolution.found_cancelled": "Звірка: накладна у перевізника скасована",
    "problems.resolution.order_cancelled": "Замовлення скасовано",
    "problems.resolution.shopify_synced": "Зміни успішно передано в Shopify",
    "problems.resolution.other": "Вирішено",

    // Порожні стани та обмеження
    "problems.empty.open.title": "Проблем немає",
    "problems.empty.open.description":
      "Усі перевірені замовлення мають коректні дані. Нові неоднозначні ситуації з’являться тут автоматично.",
    "problems.empty.filtered.title": "Немає проблем такої серйозності",
    "problems.empty.filtered.description": "Змініть фільтр, щоб побачити інші проблеми.",
    "problems.empty.resolved.title": "Вирішених проблем ще немає",
    "problems.empty.resolved.description": "Тут з’являтимуться проблеми, вирішені автоматично або менеджером.",
    "problems.empty.showAll": "Показати всі",
    "problems.limit.open": "Показано перші {limit} відкритих проблем. Вирішіть їх, щоб побачити наступні.",
    "problems.limit.resolved": "Показано останні {limit} вирішених проблем.",

    // Результати дій
    "problems.result.revalidated.blocking": "Замовлення перевірено повторно: залишилися помилки ({errors}).",
    "problems.result.revalidated.ready": "Замовлення перевірено повторно: помилок немає, статус — «Очікує перевірки».",
    "problems.error.notFound": "Проблему не знайдено — можливо, її вже вирішено. Оновіть сторінку.",
  },
  en: {
    "problems.subtitle": "Ambiguous cases with an explanation of the cause and a proposed solution",

    "problems.tabs.label": "Problem state",
    "problems.tabs.open": "Open",
    "problems.tabs.resolved": "Resolved",
    "problems.filter.label": "Severity",
    "problems.filter.errors": "Errors",
    "problems.filter.warnings": "Warnings",
    "problems.filter.current": "{label} — selected",

    "problems.kpi.title": "Open problems",
    "problems.kpi.errors.label": "Errors",
    "problems.kpi.errors.hint": "Block waybill creation",
    "problems.kpi.warnings.label": "Warnings",
    "problems.kpi.warnings.hint": "Not blocking, but worth checking",
    "problems.kpi.orders.label": "Orders with problems",
    "problems.kpi.orders.hint": "Have at least one open problem",

    "problems.list.label": "Problems by order",
    "problems.group.noOrder": "No order",
    "problems.group.count": "Problems: {count}",
    "problems.openOrder": "Open order",
    "problems.openOrderLabel": "Open order {number}",

    "problems.issue.field": "Field",
    "problems.issue.detected": "Detected",
    "problems.issue.resolution": "Resolution",
    "problems.issue.resolvedAt": "Resolved",
    "problems.issue.carrierMessage": "Carrier message: {message}",
    "problems.issue.fixInOrder": "Fix the data in the order — the check runs again after you save.",
    "problems.issue.fixProduct": "Fix the product data (weight, customs data) — related orders are checked again after you save.",

    "problems.suggestion.single": "Suggested correction. Apply it if it is correct:",
    "problems.suggestion.multiple": "Choose the correct option:",
    "problems.suggestion.apply": "Apply option {value}",
    "problems.suggestion.note": "The change is recorded in the order history, then the order is checked again.",
    "problems.suggestion.locked":
      "The option cannot be applied because the order status is “{status}”. Open the order to sort it out.",

    "problems.dismiss.button": "Dismiss warning",
    "problems.dismiss.help": "A warning does not block the waybill. If everything is fine, you can dismiss it.",

    "problems.resolution.revalidated": "A new check no longer found the problem",
    "problems.resolution.data_corrected": "Data corrected manually",
    "problems.resolution.suggestion_accepted": "Suggested option applied",
    "problems.resolution.dismissed": "Warning dismissed",
    "problems.resolution.created": "Waybill created",
    "problems.resolution.recovered": "Reconciliation found the created waybill",
    "problems.resolution.manually_linked": "Waybill linked manually",
    "problems.resolution.confirmed_not_created": "Confirmed that the waybill was not created",
    "problems.resolution.found_cancelled": "Reconciliation: the waybill is cancelled at the carrier",
    "problems.resolution.order_cancelled": "Order cancelled",
    "problems.resolution.shopify_synced": "Changes successfully sent to Shopify",
    "problems.resolution.other": "Resolved",

    "problems.empty.open.title": "No problems",
    "problems.empty.open.description":
      "All checked orders have valid data. New ambiguous cases will appear here automatically.",
    "problems.empty.filtered.title": "No problems of this severity",
    "problems.empty.filtered.description": "Change the filter to see other problems.",
    "problems.empty.resolved.title": "No resolved problems yet",
    "problems.empty.resolved.description": "Problems resolved automatically or by a manager will appear here.",
    "problems.empty.showAll": "Show all",
    "problems.limit.open": "Showing the first {limit} open problems. Resolve them to see the next ones.",
    "problems.limit.resolved": "Showing the latest {limit} resolved problems.",

    "problems.result.revalidated.blocking": "The order was checked again: errors remain ({errors}).",
    "problems.result.revalidated.ready": "The order was checked again: no errors, status is “Awaiting review”.",
    "problems.error.notFound": "Problem not found — it may already be resolved. Refresh the page.",
  },
};

export default messages;
