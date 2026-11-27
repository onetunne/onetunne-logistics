import type { MessageModule } from "../types";

/**
 * Головна сторінка: показники, швидкі дії, автоматизація, проблеми, останні накладні, стан інтеграцій.
 * Ключі dashboard.automation.pausedTitle / pausedBody також використовує глобальний банер у app/components/layout.tsx.
 */
const messages: MessageModule = {
  uk: {
    "dashboard.subtitle": "Етап 1: оплачене замовлення → перевірка даних → виправлення проблем → накладна (це ще не відправлення).",

    // Показники
    "dashboard.kpi.title": "Замовлення за статусами",
    "dashboard.kpi.paid.label": "Нові оплачені",
    "dashboard.kpi.paid.hint": "Ще не перевірені",
    "dashboard.kpi.needs_correction.label": "Потребують виправлення",
    "dashboard.kpi.needs_correction.hint": "Є помилки в даних",
    "dashboard.kpi.awaiting_review.label": "Готові до накладної",
    "dashboard.kpi.awaiting_review.hint": "Перевірку пройдено",
    "dashboard.kpi.waybill_created.label": "Накладну створено",
    "dashboard.kpi.waybill_created.hint": "Ще не передано перевізнику",
    "dashboard.kpi.linkLabel": "{label}: {count}. Відкрити список замовлень",

    // Підсумок проблем
    "dashboard.problems.summary.title": "Проблеми потребують уваги",
    "dashboard.problems.summary.some":
      "Відкритих проблем: {total} (помилок: {errors}, попереджень: {warnings}). Замовлень із проблемами: {orders}.",
    "dashboard.problems.summary.none": "Відкритих проблем немає.",
    "dashboard.problems.openAll": "Відкрити «Проблеми»",

    // Швидкі дії
    "dashboard.quick.title": "Швидкі дії",
    "dashboard.quick.validateAll.button": "Перевірити всі оплачені",
    "dashboard.quick.validateAll.help":
      "Нових оплачених замовлень: {count}. Перевірка шукає помилки в адресі, контактах і митних даних товарів.",
    "dashboard.quick.validateAll.none": "Нових оплачених замовлень немає — перевіряти нічого.",
    "dashboard.quick.validateAll.limit": "За один запуск перевіряється не більше {limit} замовлень — решту перевірте повторним запуском.",
    "dashboard.quick.validateAll.confirmTitle": "Перевірити оплачені замовлення?",
    "dashboard.quick.validateAll.confirmCount": "Буде перевірено оплачених замовлень: {count}.",
    "dashboard.quick.validateAll.confirmFixes":
      "Автоматично застосовуються лише однозначні виправлення формату (зайві пробіли, регістр коду країни, формат телефону чи індексу); кожне записується в історію замовлення.",
    "dashboard.quick.validateAll.confirmIssues":
      "Неоднозначні дані не змінюються — вони з’являться в «Проблемах» для ручного виправлення. Накладні не створюються.",
    "dashboard.quick.validateAll.confirm": "Перевірити",
    "dashboard.quick.simulate.modeHint": "Поточний режим автоматизації: «{mode}».",
    "dashboard.quick.simulate.pausedHint": "Автоматизацію призупинено — нове замовлення не буде оброблено автоматично.",

    // Результати дій
    "dashboard.result.validateAll.outcome": "Готові до накладної: {ready}. Потребують виправлення: {blocked}. Автовиправлень: {fixes}.",
    "dashboard.simulate.skipped.manual_mode": "Ручний режим: автоматизація нічого не виконувала — перевірте замовлення вручну.",
    "dashboard.simulate.skipped.global_pause": "Автоматизацію призупинено: замовлення не оброблялося автоматично.",
    "dashboard.simulate.skipped.order_paused": "Автоматизацію для цього замовлення призупинено: автоматичної обробки не було.",
    "dashboard.simulate.validated.blocking":
      "Автоматична перевірка даних: автовиправлень — {fixes}, проблем — {issues}. Замовлення потребує виправлення, накладну не створено.",
    "dashboard.simulate.validated.semi":
      "Автоматична перевірка даних: автовиправлень — {fixes}, проблем — {issues}. Напівавтоматичний режим: накладну створює менеджер.",
    "dashboard.simulate.validated.auto": "Автоматична перевірка даних: автовиправлень — {fixes}, проблем — {issues}.",
    "dashboard.simulate.waybill.created": "Автоматично створено тестову накладну {waybill}. Посилку ще не передано перевізнику.",
    "dashboard.simulate.waybill.existing": "Накладна {waybill} вже існувала — дубліката не створено.",
    "dashboard.simulate.waybill.recovered": "Відповідь перевізника не надійшла, але звірка знайшла накладну {waybill}. Дубліката не створено.",
    "dashboard.simulate.automationFailed":
      "Замовлення додано, але автоматична обробка завершилася помилкою. Відкрийте замовлення й перевірте його вручну.",

    // Автоматизація
    "dashboard.automation.title": "Автоматизація",
    "dashboard.automation.modeLabel": "Режим",
    "dashboard.automation.mode.manual": "Ручний",
    "dashboard.automation.mode.semi": "Напівавтоматичний",
    "dashboard.automation.mode.auto": "Автоматичний",
    "dashboard.automation.modeHelp.manual": "Нічого не виконується автоматично: перевірку й накладні запускає менеджер.",
    "dashboard.automation.modeHelp.semi":
      "Нові оплачені замовлення перевіряються автоматично з однозначними виправленнями формату; накладні створює менеджер.",
    "dashboard.automation.modeHelp.auto":
      "Нові оплачені замовлення перевіряються автоматично; якщо проблем немає — накладна створюється автоматично.",
    "dashboard.automation.pauseLabel": "Глобальна пауза",
    "dashboard.automation.pause.on": "Увімкнено",
    "dashboard.automation.pause.off": "Вимкнено",
    "dashboard.automation.pausedTitle": "Автоматизацію призупинено",
    "dashboard.automation.pausedBody":
      "Нові замовлення не перевіряються, і накладні не створюються автоматично. Ручні дії доступні. Відновити автоматизацію може власник на головній сторінці.",
    "dashboard.automation.pauseButton": "Призупинити автоматизацію",
    "dashboard.automation.resumeButton": "Відновити автоматизацію",
    "dashboard.automation.pauseConfirmTitle": "Призупинити автоматизацію?",
    "dashboard.automation.pauseConfirmMessage":
      "Для всіх нових замовлень зупиняться автоматична перевірка даних і автоматичне створення накладних — до відновлення. Ручні дії менеджерів залишаються доступними. Режим «{mode}» збережеться.",
    "dashboard.automation.pauseConfirm": "Призупинити",
    "dashboard.automation.resumeConfirmTitle": "Відновити автоматизацію?",
    "dashboard.automation.resumeConfirmMessage":
      "Нові оплачені замовлення знову оброблятимуться в режимі «{mode}». Замовлення, що надійшли під час паузи, автоматично не обробляються — перевірте їх кнопкою «Перевірити всі оплачені».",
    "dashboard.automation.resumeConfirm": "Відновити",
    "dashboard.automation.ownerOnly": "Змінювати режим і вмикати паузу може лише власник.",
    "dashboard.automation.changeMode": "Змінити режим у налаштуваннях",
    "dashboard.automation.result.paused": "Автоматизацію призупинено для всіх замовлень.",
    "dashboard.automation.result.resumed": "Автоматизацію відновлено.",
    "dashboard.automation.result.unchanged": "Стан автоматизації вже був таким — змін не внесено.",

    // Проблеми
    "dashboard.problems.description": "Показано {shown} з {total}, спершу найдавніші.",
    "dashboard.problems.viewAll": "Усі проблеми",
    "dashboard.problems.col.problem": "Проблема",
    "dashboard.problems.col.order": "Замовлення",
    "dashboard.problems.col.detected": "Виявлено",
    "dashboard.problems.empty.title": "Відкритих проблем немає",
    "dashboard.problems.empty.description": "Нові проблеми з’являться тут після перевірки даних замовлень.",

    // Останні накладні
    "dashboard.waybills.title": "Останні накладні",
    "dashboard.waybills.description": "Накладна — це ще не відправлення: посилку передають перевізнику окремо.",
    "dashboard.waybills.viewAll": "Усі накладні",
    "dashboard.waybills.col.waybill": "Накладна",
    "dashboard.waybills.col.status": "Статус",
    "dashboard.waybills.col.order": "Замовлення",
    "dashboard.waybills.col.created": "Створено",
    "dashboard.waybills.noNumber": "Номера ще немає, референс:",
    "dashboard.waybills.empty.title": "Накладних ще немає",
    "dashboard.waybills.empty.description": "Накладну можна створити для замовлення зі статусом «Очікує перевірки».",

    // Інтеграції
    "dashboard.integrations.title": "Стан інтеграцій",
    "dashboard.integrations.description": "Лише фактичний стан — без імітації підключень.",
    "dashboard.integrations.shopify": "Shopify",
    "dashboard.integrations.shopify.demo": "Не підключено: демо-режим. Підключення й синхронізація даних — етап 2.",
    "dashboard.integrations.shopify.production": "Підключено через Shopify Admin. Синхронізація даних — етап 2.",
    "dashboard.integrations.carrier": "Перевізник",
    "dashboard.integrations.carrier.test":
      "Тестовий перевізник (sandbox): накладні лише тестові, справжнім перевізникам нічого не надсилається.",
    "dashboard.integrations.carrier.pending": "{carrier}: очікуємо документацію API та ключі (етап 3).",
    "dashboard.integrations.carrier.ready": "{carrier}: підключено.",
    "dashboard.integrations.carrier.none": "Перевізника не налаштовано.",
    "dashboard.integrations.assistant.planned": "Заплановано на етап 7.",
    "dashboard.integrations.telegram": "Telegram",
    "dashboard.integrations.telegram.planned": "Сповіщення в Telegram — заплановано на етап 8.",
    "dashboard.integrations.status.connected": "Підключено",
    "dashboard.integrations.status.notConnected": "Не підключено",
    "dashboard.integrations.status.waiting": "Очікує",
    // Етап 5 на головній (дозволи: склад/виробництво — warehouse.view, пакування — packing.perform)
    "dashboard.stage5.title": "Склад, пакування й виробництво",
    "dashboard.stage5.alerts.title": "Попередження складу",
    "dashboard.stage5.alerts.none": "Відкритих попереджень немає.",
    "dashboard.stage5.alerts.noneProducts": "Попереджень щодо товарів немає.",
    "dashboard.stage5.alerts.materials": "Пакувальні матеріали: {count}",
    "dashboard.stage5.alerts.open": "Відкрити залишки",
    "dashboard.stage5.packing.title": "Черга пакування",
    "dashboard.stage5.packing.hint": "Замовлення з накладною, які ще не запаковано",
    "dashboard.stage5.packing.open": "Відкрити чергу",
    "dashboard.stage5.production.title": "Виробництво",
    "dashboard.stage5.production.active": "Активних партій (ще не отримано повністю)",
    "dashboard.stage5.production.overdue": "Прострочено: {count}",
    "dashboard.stage5.production.dueSoon": "Готовність у найближчі {days} дн.: {count}",
    "dashboard.stage5.production.open": "Відкрити партії",
    "dashboard.stage5.recommendations.title": "Нові партії",
    "dashboard.stage5.recommendations.hint": "Прогноз за швидкістю продажів і терміном виробництва (позиції з відкритим обліком).",
    "dashboard.stage5.recommendations.atRisk": "Під ризиком закінчення",
    "dashboard.stage5.recommendations.needBatch": "Потребують нової партії",
    "dashboard.stage5.recommendations.outOfStock": "Уже немає в наявності: {count}",
    "dashboard.stage5.recommendations.units":
      "Рекомендовано виготовити: {units, plural, one {# одиницю} few {# одиниці} many {# одиниць} other {# одиниці}}",
    "dashboard.stage5.recommendations.none": "Ризиків закінчення й рекомендацій нових партій немає.",
    "dashboard.stage5.recommendations.open": "Відкрити аналітику",
  },
  en: {
    "dashboard.subtitle": "Stage 1: paid order → data check → fix problems → waybill (not yet a shipment).",

    "dashboard.kpi.title": "Orders by status",
    "dashboard.kpi.paid.label": "New paid",
    "dashboard.kpi.paid.hint": "Not checked yet",
    "dashboard.kpi.needs_correction.label": "Need correction",
    "dashboard.kpi.needs_correction.hint": "Data has errors",
    "dashboard.kpi.awaiting_review.label": "Ready for waybill",
    "dashboard.kpi.awaiting_review.hint": "Check passed",
    "dashboard.kpi.waybill_created.label": "Waybill created",
    "dashboard.kpi.waybill_created.hint": "Not handed to the carrier yet",
    "dashboard.kpi.linkLabel": "{label}: {count}. Open the order list",

    "dashboard.problems.summary.title": "Problems need attention",
    "dashboard.problems.summary.some":
      "Open problems: {total} (errors: {errors}, warnings: {warnings}). Orders with problems: {orders}.",
    "dashboard.problems.summary.none": "No open problems.",
    "dashboard.problems.openAll": "Open Problems",

    "dashboard.quick.title": "Quick actions",
    "dashboard.quick.validateAll.button": "Check all paid",
    "dashboard.quick.validateAll.help":
      "New paid orders: {count}. The check looks for errors in the address, contacts and product customs data.",
    "dashboard.quick.validateAll.none": "There are no new paid orders — nothing to check.",
    "dashboard.quick.validateAll.limit": "One run checks at most {limit} orders — run it again for the rest.",
    "dashboard.quick.validateAll.confirmTitle": "Check paid orders?",
    "dashboard.quick.validateAll.confirmCount": "Paid orders to be checked: {count}.",
    "dashboard.quick.validateAll.confirmFixes":
      "Only unambiguous format fixes are applied automatically (extra spaces, country code case, phone or postal code format); each one is recorded in the order history.",
    "dashboard.quick.validateAll.confirmIssues":
      "Ambiguous data is not changed — it will appear in Problems for manual correction. No waybills are created.",
    "dashboard.quick.validateAll.confirm": "Check",
    "dashboard.quick.simulate.modeHint": "Current automation mode: “{mode}”.",
    "dashboard.quick.simulate.pausedHint": "Automation is paused — the new order will not be processed automatically.",

    "dashboard.result.validateAll.outcome": "Ready for waybill: {ready}. Need correction: {blocked}. Auto-fixes: {fixes}.",
    "dashboard.simulate.skipped.manual_mode": "Manual mode: automation did nothing — check the order manually.",
    "dashboard.simulate.skipped.global_pause": "Automation is paused: the order was not processed automatically.",
    "dashboard.simulate.skipped.order_paused": "Automation is paused for this order: it was not processed automatically.",
    "dashboard.simulate.validated.blocking":
      "Automatic data check: auto-fixes — {fixes}, problems — {issues}. The order needs correction; no waybill was created.",
    "dashboard.simulate.validated.semi":
      "Automatic data check: auto-fixes — {fixes}, problems — {issues}. Semi-automatic mode: a manager creates the waybill.",
    "dashboard.simulate.validated.auto": "Automatic data check: auto-fixes — {fixes}, problems — {issues}.",
    "dashboard.simulate.waybill.created": "Test waybill {waybill} was created automatically. The parcel has not been handed to the carrier yet.",
    "dashboard.simulate.waybill.existing": "Waybill {waybill} already existed — no duplicate was created.",
    "dashboard.simulate.waybill.recovered": "The carrier did not respond, but reconciliation found waybill {waybill}. No duplicate was created.",
    "dashboard.simulate.automationFailed":
      "The order was added, but automatic processing failed. Open the order and check it manually.",

    "dashboard.automation.title": "Automation",
    "dashboard.automation.modeLabel": "Mode",
    "dashboard.automation.mode.manual": "Manual",
    "dashboard.automation.mode.semi": "Semi-automatic",
    "dashboard.automation.mode.auto": "Automatic",
    "dashboard.automation.modeHelp.manual": "Nothing runs automatically: a manager starts checks and waybills.",
    "dashboard.automation.modeHelp.semi":
      "New paid orders are checked automatically with unambiguous format fixes; a manager creates waybills.",
    "dashboard.automation.modeHelp.auto":
      "New paid orders are checked automatically; if there are no problems, the waybill is created automatically.",
    "dashboard.automation.pauseLabel": "Global pause",
    "dashboard.automation.pause.on": "On",
    "dashboard.automation.pause.off": "Off",
    "dashboard.automation.pausedTitle": "Automation is paused",
    "dashboard.automation.pausedBody":
      "New orders are not checked and waybills are not created automatically. Manual actions are available. The owner can resume automation on the home page.",
    "dashboard.automation.pauseButton": "Pause automation",
    "dashboard.automation.resumeButton": "Resume automation",
    "dashboard.automation.pauseConfirmTitle": "Pause automation?",
    "dashboard.automation.pauseConfirmMessage":
      "Automatic data checks and automatic waybill creation will stop for all new orders until resumed. Manual actions remain available. The “{mode}” mode is kept.",
    "dashboard.automation.pauseConfirm": "Pause",
    "dashboard.automation.resumeConfirmTitle": "Resume automation?",
    "dashboard.automation.resumeConfirmMessage":
      "New paid orders will again be processed in “{mode}” mode. Orders received during the pause are not processed automatically — check them with “Check all paid”.",
    "dashboard.automation.resumeConfirm": "Resume",
    "dashboard.automation.ownerOnly": "Only the owner can change the mode or pause automation.",
    "dashboard.automation.changeMode": "Change mode in settings",
    "dashboard.automation.result.paused": "Automation paused for all orders.",
    "dashboard.automation.result.resumed": "Automation resumed.",
    "dashboard.automation.result.unchanged": "Automation was already in this state — nothing changed.",

    "dashboard.problems.description": "Showing {shown} of {total}, oldest first.",
    "dashboard.problems.viewAll": "All problems",
    "dashboard.problems.col.problem": "Problem",
    "dashboard.problems.col.order": "Order",
    "dashboard.problems.col.detected": "Detected",
    "dashboard.problems.empty.title": "No open problems",
    "dashboard.problems.empty.description": "New problems will appear here after order data is checked.",

    "dashboard.waybills.title": "Recent waybills",
    "dashboard.waybills.description": "A waybill is not a shipment yet: the parcel is handed to the carrier separately.",
    "dashboard.waybills.viewAll": "All waybills",
    "dashboard.waybills.col.waybill": "Waybill",
    "dashboard.waybills.col.status": "Status",
    "dashboard.waybills.col.order": "Order",
    "dashboard.waybills.col.created": "Created",
    "dashboard.waybills.noNumber": "No number yet, reference:",
    "dashboard.waybills.empty.title": "No waybills yet",
    "dashboard.waybills.empty.description": "A waybill can be created for an order in “Awaiting review”.",

    "dashboard.integrations.title": "Integrations status",
    "dashboard.integrations.description": "Actual state only — no simulated connections.",
    "dashboard.integrations.shopify": "Shopify",
    "dashboard.integrations.shopify.demo": "Not connected: demo mode. Connection and data sync — stage 2.",
    "dashboard.integrations.shopify.production": "Connected via Shopify Admin. Data sync — stage 2.",
    "dashboard.integrations.carrier": "Carrier",
    "dashboard.integrations.carrier.test": "Test carrier (sandbox): waybills are test-only, nothing is sent to real carriers.",
    "dashboard.integrations.carrier.pending": "{carrier}: awaiting API documentation and keys (stage 3).",
    "dashboard.integrations.carrier.ready": "{carrier}: connected.",
    "dashboard.integrations.carrier.none": "No carrier is configured.",
    "dashboard.integrations.assistant.planned": "Planned for stage 7.",
    "dashboard.integrations.telegram": "Telegram",
    "dashboard.integrations.telegram.planned": "Telegram notifications — planned for stage 8.",
    "dashboard.integrations.status.connected": "Connected",
    "dashboard.integrations.status.notConnected": "Not connected",
    "dashboard.integrations.status.waiting": "Pending",
    // Stage 5 on the dashboard (permissions: warehouse/production — warehouse.view, packing — packing.perform)
    "dashboard.stage5.title": "Warehouse, packing and production",
    "dashboard.stage5.alerts.title": "Warehouse alerts",
    "dashboard.stage5.alerts.none": "No open alerts.",
    "dashboard.stage5.alerts.noneProducts": "No product alerts.",
    "dashboard.stage5.alerts.materials": "Packaging materials: {count}",
    "dashboard.stage5.alerts.open": "Open stock",
    "dashboard.stage5.packing.title": "Packing queue",
    "dashboard.stage5.packing.hint": "Orders with a waybill that are not packed yet",
    "dashboard.stage5.packing.open": "Open the queue",
    "dashboard.stage5.production.title": "Production",
    "dashboard.stage5.production.active": "Active batches (not fully received)",
    "dashboard.stage5.production.overdue": "Overdue: {count}",
    "dashboard.stage5.production.dueSoon": "Ready within {days, plural, one {# day} other {# days}}: {count}",
    "dashboard.stage5.production.open": "Open batches",
    "dashboard.stage5.recommendations.title": "Next batches",
    "dashboard.stage5.recommendations.hint": "Forecast from sales velocity and production lead time (items with opened tracking).",
    "dashboard.stage5.recommendations.atRisk": "At risk of running out",
    "dashboard.stage5.recommendations.needBatch": "Need a new batch",
    "dashboard.stage5.recommendations.outOfStock": "Already out of stock: {count}",
    "dashboard.stage5.recommendations.units": "Recommended to produce: {units, plural, one {# unit} other {# units}}",
    "dashboard.stage5.recommendations.none": "No stock-out risks or new batch recommendations.",
    "dashboard.stage5.recommendations.open": "Open analytics",
  },
};

export default messages;
