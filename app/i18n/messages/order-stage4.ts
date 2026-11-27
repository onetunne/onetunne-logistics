import type { MessageModule } from "../types";

/**
 * Етап 4 (сторінка замовлення): «Переоформити накладну» (скасування + нове покоління),
 * «Скасувати й виправити дані», стан передачі підтверджених змін у Shopify і повторне надсилання,
 * підказка, коли дані змінено в Shopify після створення накладної.
 * Правило формулювань: накладна ≠ відправлення; реальну накладну скасовують у перевізника.
 */
const messages: MessageModule = {
  uk: {
    // --- Зміна накладної (картка «Накладна») ---
    "order.reissue.section": "Змінити накладну",
    "order.reissue.sectionHelp":
      "Посилку ще не передано перевізнику, тож накладну можна замінити. Обидві дії скасовують поточну накладну.",
    "order.reissue.button": "Переоформити накладну",
    "order.reissue.title": "Переоформити накладну {number}?",
    "order.reissue.bodyLive":
      "Накладну {number} буде СКАСОВАНО у перевізника {carrier} — це реальна накладна, її номер більше не діятиме. Одразу після цього застосунок повторно перевірить дані й створить нову накладну з новим номером.",
    "order.reissue.bodyTest":
      "Тестову накладну {number} буде скасовано (реальному перевізнику нічого не надсилається). Одразу після цього застосунок повторно перевірить дані й створить нову тестову накладну з новим номером.",
    "order.reissue.bodyManual":
      "Ручну прив’язку номера {number} буде знято; у перевізника нічого не скасовується — за потреби скасуйте накладну в його кабінеті. Потім застосунок створить нову накладну через API.",
    "order.reissue.dataNote":
      "Нова накладна міститиме поточні дані застосунку. Якщо її створення буде заблоковано (наприклад, проблеми з даними), стара накладна все одно залишиться скасованою — замовлення повернеться до «Очікує перевірки».",
    "order.reissue.labelsNote": "Надруковані документи старої накладної більше не використовуйте.",
    "order.reissue.confirm": "Так, переоформити",
    "order.reissue.unavailable.status": "Переоформлення доступне лише для статусів «Накладна створена» та «Очікує комплектації».",
    "order.reissue.unavailable.permission": "Переоформити накладну може лише користувач із правом створювати й керувати накладними.",

    "order.correct.button": "Скасувати й виправити дані",
    "order.correct.title": "Скасувати накладну {number} для виправлення даних?",
    "order.correct.bodyLive":
      "Накладну {number} буде СКАСОВАНО у перевізника {carrier} — це реальна накладна, її номер більше не діятиме.",
    "order.correct.bodyTest": "Тестову накладну {number} буде скасовано (реальному перевізнику нічого не надсилається).",
    "order.correct.bodyManual":
      "Ручну прив’язку номера {number} буде знято; у перевізника нічого не скасовується — за потреби скасуйте накладну в його кабінеті.",
    "order.correct.next":
      "Нову накладну НЕ буде створено автоматично: замовлення повернеться до «Очікує перевірки», ви зможете виправити дані, а потім створити нову накладну.",
    "order.correct.confirm": "Так, скасувати й виправити",

    // --- Результати дій ---
    "order.reissue.result.reissued": "Накладну переоформлено: {old} скасовано, створено нову накладну {number}.",
    "order.reissue.result.recovered":
      "Накладну переоформлено: {old} скасовано; відповідь перевізника не надійшла, але звірка знайшла нову накладну {number}. Дубліката не створено.",
    "order.reissue.result.cancelledOnly": "Стару накладну {old} СКАСОВАНО, але нову не створено.",
    "order.reissue.result.fixAndCreate":
      "Замовлення повернулося до «Очікує перевірки». Усуньте причину й створіть нову накладну на цій сторінці.",
    "order.reissue.result.unknownNext": "Не створюйте накладну повторно, доки не з’ясовано результат (див. картку «Накладна»).",
    "order.reissue.result.notStarted": "Нічого не змінено: нову накладну зараз створити неможливо, тому стару накладну не скасовано.",
    "order.reissue.result.concurrent":
      "Цю накладну вже переоформлює інший запит — повторно нічого не створено (захист від дублікатів). Оновіть сторінку.",
    "order.correct.result": "Накладну скасовано. Виправте дані замовлення, потім створіть нову накладну.",

    // --- Підказка: дані змінено в Shopify після створення накладної ---
    "order.shopifyChanged.title": "Дані змінено в Shopify після створення накладної",
    "order.shopifyChanged.body":
      "У Shopify змінено: {fields}. Накладна містить дані застосунку, тому ці зміни в неї не потрапили й автоматично не застосовуються.",
    "order.shopifyChanged.how":
      "Щоб застосувати правильні дані, накладну потрібно переоформити: «Скасувати й виправити дані» → внесіть правильні значення у формі адреси → створіть нову накладну. «Переоформити накладну» одразу створює нову накладну з поточними даними застосунку (без змін із Shopify).",
    "order.shopifyChanged.shipped": "Посилку вже передано перевізнику — накладну переоформити неможливо. Узгодьте зміни з перевізником.",

    // --- Стан передачі виправлених даних у Shopify ---
    "order.shopifySync.title": "Синхронізація з Shopify",
    "order.shopifySync.label": "Виправлені контакти й адреса в Shopify",
    "order.shopifySync.state.demo": "Демо: у Shopify нічого не надсилається.",
    "order.shopifySync.state.not_linked": "Замовлення не пов’язане з Shopify — передавати нікуди.",
    "order.shopifySync.state.none": "Підтверджених змін контактів чи адреси немає — передавати нічого.",
    "order.shopifySync.state.queued": "У черзі на передачу в Shopify ({time}).",
    "order.shopifySync.state.retrying": "Попередня спроба не вдалася; повтор заплановано автоматично ({time}).",
    "order.shopifySync.state.synced": "Shopify прийняв поточні дані ({time}).",
    "order.shopifySync.state.failed": "Shopify не прийняв зміни.",
    "order.shopifySync.state.not_sent": "Зміни від {time} ще не передано в Shopify.",
    "order.shopifySync.state.not_sentHelp":
      "Зазвичай причина — дані з помилками перевірки (їх у Shopify не надсилаємо). Виправте помилки або надішліть повторно.",
    "order.shopifySync.shopifyMessage": "Відповідь Shopify: {message}",
    "order.shopifySync.fieldMessage": "{field}: {message}",
    "order.shopifySync.lastError": "Остання помилка: {message}",
    "order.shopifySync.countryNotShipped": "Країни {country} немає в зонах доставки магазину Shopify.",
    "order.shopifySync.resend": "Повторно надіслати в Shopify",
    "order.shopifySync.resendHelp":
      "Надсилає поточні підтверджені контакти й адресу (одне завдання в черзі; повторне натискання не створює дубліката).",
    "order.shopifySync.resendDemoHelp": "У демо кнопка лише пояснює поведінку: у Shopify нічого не надсилається.",
    "order.shopifySync.result.queued": "Передачу в Shopify поставлено в чергу (повтор не дублює вже очікуване завдання).",
    "order.shopifySync.result.demo": "Демо: у Shopify нічого не надіслано. У робочій версії зміни буде поставлено в чергу на передачу.",
    "order.shopifySync.result.not_linked": "Замовлення не пов’язане з Shopify — нічого не надіслано.",
    "order.shopifySync.result.invalid_data": "Не надіслано: спершу виправте поля з помилками перевірки (адреса/контакти).",
    "order.shopifySync.result.not_implemented": "Передача в Shopify у цьому середовищі не налаштована — нічого не надіслано.",
    "order.shopifySync.result.synced": "Shopify оновлено.",
    "order.shopifySync.result.failed": "Не вдалося поставити передачу в чергу. Спробуйте пізніше.",

    // --- Історія накладної ---
    "order.event.reissued": "Накладну переоформлено — створено нове покоління",
    "order.event.reissue_blocked": "Переоформлення: стару накладну скасовано, нову не створено",
    "order.event.cancel_refused": "Перевізник не скасував накладну — вона лишається активною",
    "order.event.cancel_conflict_handed_over": "Скасування: посилку вже передано перевізнику — потрібна перевірка",

    // --- Перелік накладних ---
    "waybills.reissued": "Покоління {generation}",
    "waybills.reissued.hint": "Замовлення переоформлювали: попередні накладні скасовано, ця — нове покоління з новим номером.",

    // --- Помилки сервісів ---
    "waybill.reissueNotAllowed": "Переоформлення недоступне для замовлення зі статусом «{status}».",
    "waybill.cancelFailed":
      "Не вдалося отримати відповідь перевізника на скасування — накладна залишається активною. Перевірте її в кабінеті перевізника й повторіть пізніше.",
  },
  en: {
    "order.reissue.section": "Change the waybill",
    "order.reissue.sectionHelp":
      "The parcel has not been handed to the carrier yet, so the waybill can be replaced. Both actions cancel the current waybill.",
    "order.reissue.button": "Re-issue waybill",
    "order.reissue.title": "Re-issue waybill {number}?",
    "order.reissue.bodyLive":
      "Waybill {number} will be CANCELLED with the carrier {carrier} — it is a real waybill and its number will stop working. Right after that the app re-validates the data and creates a new waybill with a new number.",
    "order.reissue.bodyTest":
      "Test waybill {number} will be cancelled (nothing is sent to a real carrier). Right after that the app re-validates the data and creates a new test waybill with a new number.",
    "order.reissue.bodyManual":
      "The manual link of number {number} will be removed; nothing is cancelled at the carrier — cancel it in the carrier's portal if needed. Then the app creates a new waybill via the API.",
    "order.reissue.dataNote":
      "The new waybill uses the current app data. If its creation is blocked (e.g. data problems), the old waybill still stays cancelled — the order returns to “Awaiting review”.",
    "order.reissue.labelsNote": "Do not use printed documents of the old waybill any more.",
    "order.reissue.confirm": "Yes, re-issue",
    "order.reissue.unavailable.status": "Re-issuing is only available in “Waybill created” and “Awaiting picking”.",
    "order.reissue.unavailable.permission": "Only a user allowed to create and manage waybills can re-issue a waybill.",

    "order.correct.button": "Cancel and correct data",
    "order.correct.title": "Cancel waybill {number} to correct the data?",
    "order.correct.bodyLive": "Waybill {number} will be CANCELLED with the carrier {carrier} — it is a real waybill and its number will stop working.",
    "order.correct.bodyTest": "Test waybill {number} will be cancelled (nothing is sent to a real carrier).",
    "order.correct.bodyManual":
      "The manual link of number {number} will be removed; nothing is cancelled at the carrier — cancel it in the carrier's portal if needed.",
    "order.correct.next":
      "No new waybill is created automatically: the order returns to “Awaiting review”, you can correct the data and then create a new waybill.",
    "order.correct.confirm": "Yes, cancel and correct",

    "order.reissue.result.reissued": "Waybill re-issued: {old} cancelled, new waybill {number} created.",
    "order.reissue.result.recovered":
      "Waybill re-issued: {old} cancelled; the carrier did not respond, but reconciliation found the new waybill {number}. No duplicate was created.",
    "order.reissue.result.cancelledOnly": "The old waybill {old} IS CANCELLED, but no new waybill was created.",
    "order.reissue.result.fixAndCreate": "The order is back in “Awaiting review”. Resolve the cause and create a new waybill on this page.",
    "order.reissue.result.unknownNext": "Do not create the waybill again until the outcome is clarified (see the “Waybill” card).",
    "order.reissue.result.notStarted": "Nothing changed: a new waybill cannot be created right now, so the old waybill was not cancelled.",
    "order.reissue.result.concurrent":
      "Another request is already re-issuing this waybill — nothing was created again (duplicate protection). Refresh the page.",
    "order.correct.result": "Waybill cancelled. Correct the order data, then create a new waybill.",

    "order.shopifyChanged.title": "Data changed in Shopify after the waybill was created",
    "order.shopifyChanged.body":
      "Changed in Shopify: {fields}. The waybill contains the app's data, so these changes are not in it and are not applied automatically.",
    "order.shopifyChanged.how":
      "To apply the correct data, the waybill has to be re-issued: “Cancel and correct data” → enter the correct values in the address form → create a new waybill. “Re-issue waybill” immediately creates a new waybill from the current app data (without the Shopify changes).",
    "order.shopifyChanged.shipped": "The parcel has already been handed to the carrier — the waybill cannot be re-issued. Agree the changes with the carrier.",

    "order.shopifySync.title": "Shopify sync",
    "order.shopifySync.label": "Corrected contacts and address in Shopify",
    "order.shopifySync.state.demo": "Demo: nothing is sent to Shopify.",
    "order.shopifySync.state.not_linked": "The order is not linked to Shopify — there is nowhere to send changes.",
    "order.shopifySync.state.none": "No confirmed contact or address changes — nothing to send.",
    "order.shopifySync.state.queued": "Queued for sending to Shopify ({time}).",
    "order.shopifySync.state.retrying": "The previous attempt failed; a retry is scheduled automatically ({time}).",
    "order.shopifySync.state.synced": "Shopify accepted the current data ({time}).",
    "order.shopifySync.state.failed": "Shopify did not accept the changes.",
    "order.shopifySync.state.not_sent": "Changes from {time} have not been sent to Shopify yet.",
    "order.shopifySync.state.not_sentHelp":
      "Usually the reason is data with validation errors (it is not sent to Shopify). Fix the errors or send again.",
    "order.shopifySync.shopifyMessage": "Shopify's response: {message}",
    "order.shopifySync.fieldMessage": "{field}: {message}",
    "order.shopifySync.lastError": "Last error: {message}",
    "order.shopifySync.countryNotShipped": "{country} is not in the Shopify store's shipping zones.",
    "order.shopifySync.resend": "Send to Shopify again",
    "order.shopifySync.resendHelp":
      "Sends the current confirmed contacts and address (one queued job; pressing again does not create a duplicate).",
    "order.shopifySync.resendDemoHelp": "In the demo the button only explains the behaviour: nothing is sent to Shopify.",
    "order.shopifySync.result.queued": "Sending to Shopify was queued (a repeat does not duplicate an already queued job).",
    "order.shopifySync.result.demo": "Demo: nothing was sent to Shopify. In production the changes would be queued for sending.",
    "order.shopifySync.result.not_linked": "The order is not linked to Shopify — nothing was sent.",
    "order.shopifySync.result.invalid_data": "Not sent: first fix the fields with validation errors (address/contacts).",
    "order.shopifySync.result.not_implemented": "Sending to Shopify is not configured in this environment — nothing was sent.",
    "order.shopifySync.result.synced": "Shopify updated.",
    "order.shopifySync.result.failed": "Could not queue the sending. Try again later.",

    "order.event.reissued": "Waybill re-issued — a new generation was created",
    "order.event.reissue_blocked": "Re-issue: the old waybill was cancelled, no new one was created",
    "order.event.cancel_refused": "The carrier did not cancel the waybill — it remains active",
    "order.event.cancel_conflict_handed_over": "Cancellation: the parcel was already handed to the carrier — check required",

    "waybills.reissued": "Generation {generation}",
    "waybills.reissued.hint": "The order was re-issued: previous waybills were cancelled, this one is a new generation with a new number.",

    "waybill.reissueNotAllowed": "Re-issuing is not available for an order in “{status}”.",
    "waybill.cancelFailed":
      "No response from the carrier to the cancellation — the waybill remains active. Check it in the carrier's portal and retry later.",
  },
};

export default messages;
