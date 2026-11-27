import type { MessageModule } from "../types";

/**
 * Розділ «Проблеми»: вкладки, швидкі фільтри (категорія, серйозність), компактні фільтри, підсумок, картки замовлень,
 * пропозиції, масові дії, способи вирішення. Категорії — problems.category.<c>, джерела — problems.source.<s>.
 * Назви й пояснення самих проблем — issue.<CODE>.title/help (validation.ts; попередження пакування — packing.ts),
 * назви полів — field.* (validation.ts).
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
    "problems.kpi.errors.label": "Помилки",
    "problems.kpi.warnings.label": "Попередження",
    "problems.kpi.orders.label": "Замовлення з проблемами",

    // Картка замовлення
    "problems.group.noOrder": "Без замовлення",
    "problems.group.count": "Проблем: {count}",
    "problems.openOrder": "Відкрити замовлення",
    "problems.openOrderLabel": "Відкрити замовлення {number}",

    // Проблема
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
    "problems.resolution.shopify_applied": "Зміни з Shopify застосовано в застосунку",
    "problems.resolution.shipped_outside_app": "Підтверджено: відправлено поза застосунком",
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

    // Результати дій
    "problems.result.revalidated.blocking": "Замовлення перевірено повторно: залишилися помилки ({errors}).",
    "problems.result.revalidated.ready": "Замовлення перевірено повторно: помилок немає, статус — «Очікує перевірки».",
    "problems.error.notFound": "Проблему не знайдено — можливо, її вже вирішено. Оновіть сторінку.",

    // Швидкі фільтри (категорії) і компактні фільтри
    "problems.chips.category": "Категорія",
    "problems.category.address": "Адреса",
    "problems.category.phone": "Телефон",
    "problems.category.contact": "Контакти",
    "problems.category.customs": "Товари й митниця",
    "problems.category.carrier": "Перевізник",
    "problems.category.shopify": "Shopify",
    "problems.category.delivery": "Доставка",
    "problems.category.warehouse": "Склад",
    "problems.category.other": "Інше",
    "problems.source.validation": "Перевірка даних",
    "problems.source.carrier": "Перевізник (накладні)",
    "problems.source.shopify": "Синхронізація Shopify",
    "problems.source.tracking": "Відстеження",
    "problems.source.warehouse": "Склад (пакування)",
    "problems.filters.titleActive": "Фільтри · активних: {count}",
    "problems.filters.order": "Номер замовлення",
    "problems.filters.orderPlaceholder": "Напр. 1001",
    "problems.filters.country": "Країна доставки",
    "problems.filters.allCountries": "Усі країни",
    "problems.filters.source": "Джерело проблеми",
    "problems.filters.allSources": "Усі джерела",
    "problems.filters.suggestionOnly": "Лише з запропонованим виправленням",
    "problems.summary": "Знайдено проблем: {issues} у замовленнях: {orders}.",

    // Деталі проблеми
    "problems.issue.fieldValue": "Поле: {field}",
    "problems.issue.detectedAt": "Виявлено {time}",
    "problems.issue.resolvedAtValue": "Вирішено {time}",
    "problems.issue.resolutionValue": "Як вирішено: {resolution}",
    "problems.issue.goToField": "Перейти до поля в замовленні",
    "problems.suggestion.applyValue": "Застосувати: {value}",

    // Масові дії
    "problems.bulk.label": "Масові дії з вибраними замовленнями",
    "problems.bulk.hint": "Позначте замовлення, щоб виконати масову дію.",
    "problems.bulk.selectPage": "Вибрати всі на сторінці ({count})",
    "problems.bulk.selectOrder": "Вибрати {number}",
    "problems.bulk.noneSelected": "Не вибрано жодного замовлення.",
    "problems.bulk.revalidate.button": "Перевірити повторно",
    "problems.bulk.revalidate.title": "Перевірити вибрані замовлення повторно?",
    "problems.bulk.revalidate.count": "Буде перевірено замовлень: {count}.",
    "problems.bulk.revalidate.skipped": "Пропущено буде: {count} — для них уже є накладна або інший статус.",
    "problems.bulk.revalidate.help":
      "Однозначні помилки формату виправляються автоматично з записом в історію. Неоднозначні випадки залишаються тут для вашого рішення.",
    "problems.bulk.revalidate.confirm": "Перевірити",
    "problems.bulk.dismiss.button": "Приховати попередження",
    "problems.bulk.dismiss.title": "Приховати попередження вибраних замовлень?",
    "problems.bulk.dismiss.count": "Буде приховано попереджень: {warnings} у вибраних замовленнях ({orders}).",
    "problems.bulk.dismiss.help":
      "Приховуються лише попередження, показані за поточними фільтрами. Помилки не змінюються — їх потрібно виправити.",
    "problems.bulk.dismiss.confirm": "Приховати",
    "problems.bulk.revalidated": "Перевірено повторно замовлень: {ok}.",
    "problems.bulk.revalidated.blocking": "Залишилися помилки в замовленнях: {blocking} — вони й далі тут.",
    "problems.bulk.revalidated.skipped": "Пропущено (уже є накладна або інший статус): {failed}.",
    "problems.bulk.dismissed": "Приховано попереджень: {dismissed} у замовленнях: {orders}.",
    "problems.bulk.dismissed.failed": "Не вдалося приховати: {failed} — оновіть сторінку й повторіть.",
    "problems.bulk.dismissed.none": "У вибраних замовленнях немає попереджень за поточними фільтрами.",
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

    "problems.kpi.errors.label": "Errors",
    "problems.kpi.warnings.label": "Warnings",
    "problems.kpi.orders.label": "Orders with problems",

    "problems.group.noOrder": "No order",
    "problems.group.count": "Problems: {count}",
    "problems.openOrder": "Open order",
    "problems.openOrderLabel": "Open order {number}",

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
    "problems.resolution.shopify_applied": "Shopify changes applied in the app",
    "problems.resolution.shipped_outside_app": "Confirmed: shipped outside the app",
    "problems.resolution.other": "Resolved",

    "problems.empty.open.title": "No problems",
    "problems.empty.open.description":
      "All checked orders have valid data. New ambiguous cases will appear here automatically.",
    "problems.empty.filtered.title": "No problems of this severity",
    "problems.empty.filtered.description": "Change the filter to see other problems.",
    "problems.empty.resolved.title": "No resolved problems yet",
    "problems.empty.resolved.description": "Problems resolved automatically or by a manager will appear here.",
    "problems.empty.showAll": "Show all",

    "problems.result.revalidated.blocking": "The order was checked again: errors remain ({errors}).",
    "problems.result.revalidated.ready": "The order was checked again: no errors, status is “Awaiting review”.",
    "problems.error.notFound": "Problem not found — it may already be resolved. Refresh the page.",

    "problems.chips.category": "Category",
    "problems.category.address": "Address",
    "problems.category.phone": "Phone",
    "problems.category.contact": "Contacts",
    "problems.category.customs": "Products & customs",
    "problems.category.carrier": "Carrier",
    "problems.category.shopify": "Shopify",
    "problems.category.delivery": "Delivery",
    "problems.category.warehouse": "Warehouse",
    "problems.category.other": "Other",
    "problems.source.validation": "Data check",
    "problems.source.carrier": "Carrier (waybills)",
    "problems.source.shopify": "Shopify sync",
    "problems.source.tracking": "Tracking",
    "problems.source.warehouse": "Warehouse (packing)",
    "problems.filters.titleActive": "Filters · active: {count}",
    "problems.filters.order": "Order number",
    "problems.filters.orderPlaceholder": "E.g. 1001",
    "problems.filters.country": "Destination country",
    "problems.filters.allCountries": "All countries",
    "problems.filters.source": "Problem source",
    "problems.filters.allSources": "All sources",
    "problems.filters.suggestionOnly": "Only with a suggested correction",
    "problems.summary": "Problems found: {issues} in orders: {orders}.",

    "problems.issue.fieldValue": "Field: {field}",
    "problems.issue.detectedAt": "Detected {time}",
    "problems.issue.resolvedAtValue": "Resolved {time}",
    "problems.issue.resolutionValue": "Resolution: {resolution}",
    "problems.issue.goToField": "Go to the field in the order",
    "problems.suggestion.applyValue": "Apply: {value}",

    "problems.bulk.label": "Bulk actions for selected orders",
    "problems.bulk.hint": "Select orders to run a bulk action.",
    "problems.bulk.selectPage": "Select all on this page ({count})",
    "problems.bulk.selectOrder": "Select {number}",
    "problems.bulk.noneSelected": "No orders selected.",
    "problems.bulk.revalidate.button": "Check again",
    "problems.bulk.revalidate.title": "Check the selected orders again?",
    "problems.bulk.revalidate.count": "Orders to be checked: {count}.",
    "problems.bulk.revalidate.skipped": "Will be skipped: {count} — they already have a waybill or another status.",
    "problems.bulk.revalidate.help":
      "Unambiguous format errors are fixed automatically and recorded in the history. Ambiguous cases stay here for your decision.",
    "problems.bulk.revalidate.confirm": "Check",
    "problems.bulk.dismiss.button": "Dismiss warnings",
    "problems.bulk.dismiss.title": "Dismiss warnings of the selected orders?",
    "problems.bulk.dismiss.count": "Warnings to be dismissed: {warnings} in the selected orders ({orders}).",
    "problems.bulk.dismiss.help":
      "Only warnings shown with the current filters are dismissed. Errors are not changed — they must be fixed.",
    "problems.bulk.dismiss.confirm": "Dismiss",
    "problems.bulk.revalidated": "Orders checked again: {ok}.",
    "problems.bulk.revalidated.blocking": "Orders that still have errors: {blocking} — they stay here.",
    "problems.bulk.revalidated.skipped": "Skipped (already has a waybill or another status): {failed}.",
    "problems.bulk.dismissed": "Warnings dismissed: {dismissed} in orders: {orders}.",
    "problems.bulk.dismissed.failed": "Could not dismiss: {failed} — refresh the page and try again.",
    "problems.bulk.dismissed.none": "The selected orders have no warnings matching the current filters.",
  },
};

export default messages;
