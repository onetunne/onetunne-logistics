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
      "Нова накладна міститиме поточні дані застосунку. Якщо її створення буде заблоковано (наприклад, проблеми з даними), стара накладна все одно залишиться скасованою — замовлення повернеться до перевірки даних («Очікує перевірки» або «Потребує виправлення»).",
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
      "Статус замовлення зараз — «{orderStatus}». Усуньте причину й створіть нову накладну на цій сторінці.",
    "order.reissue.result.unknownNext": "Не створюйте накладну повторно, доки не з’ясовано результат (див. картку «Накладна»).",
    "order.reissue.result.notStarted": "Нічого не змінено: нову накладну зараз створити неможливо, тому стару накладну не скасовано.",
    "order.reissue.result.concurrent":
      "Цю накладну вже переоформлює інший запит — повторно нічого не створено (захист від дублікатів). Оновіть сторінку.",
    "order.correct.result": "Виправте дані замовлення, потім створіть нову накладну.",
    "order.reissue.result.validationIssues": "Проблеми з даними: {issues}.",
    "order.reissue.result.correctInstead":
      "Поки накладна активна, дані замовлення не редагуються: скористайтеся «Скасувати й виправити дані», виправте дані, потім створіть нову накладну.",
    "order.reissue.result.createError":
      "Під час створення нової накладної сталася помилка (код {code}). Оновіть сторінку й перевірте картку «Накладна»: якщо нової накладної немає — створіть її ще раз (дубліката не буде).",
    "order.issues.closeChecked": "Перевірено в кабінеті перевізника — закрити",
    "order.issues.next.CARRIER_CANCEL_UNKNOWN":
      "Що робити: перевірте накладну в кабінеті перевізника. Скасовано — повторіть скасування в застосунку; не скасовано — накладна чинна. Потім закрийте проблему.",
    "order.issues.next.CARRIER_CANCEL_CONFLICT":
      "Що робити: зв’яжіться з перевізником щодо посилки (накладну в нього скасовано). Після вирішення закрийте проблему.",

    // --- Підказка: дані змінено в Shopify після створення накладної ---
    "order.shopifyChanged.title": "Дані змінено в Shopify після створення накладної",
    "order.shopifyChanged.body":
      "У Shopify змінено: {fields}. Накладна містить дані застосунку, тому ці зміни в неї не потрапили й автоматично не застосовуються.",
    "order.shopifyChanged.how":
      "Щоб застосувати правильні контакти чи адресу, накладну потрібно переоформити: «Скасувати й виправити дані» → внесіть правильні значення у формі адреси → створіть нову накладну. «Переоформити накладну» одразу створює нову накладну з поточними даними застосунку (без змін із Shopify).",
    "order.shopifyChanged.shipped": "Посилку вже передано перевізнику — накладну переоформити неможливо. Узгодьте зміни з перевізником.",
    "order.shopifyChanged.howLines":
      "Позиції (кількість, повернені чи видалені товари) у застосунку не редагуються: їх застосовує повторне читання замовлення з Shopify. Натисніть «Скасувати й виправити дані» — застосунок одразу поставить читання в чергу й оновить позиції та резерв складу, — потім створіть нову накладну. «Переоформити накладну» недоступне, доки позиції не оновлено.",

    // --- Етап 5: неперенесені зміни позицій із Shopify ---
    "order.shopifyLines.title": "Позиції змінено в Shopify — застосунок їх ще не застосував",
    "order.shopifyLines.bodyActive":
      "Після створення накладної в Shopify змінили позиції замовлення. Накладна, пакування й резерв складу досі за старими позиціями, тому переоформлення й ручна передача перевізнику заблоковані. Скасуйте накладну («Скасувати й виправити дані») — застосунок перечитає замовлення з Shopify.",
    "order.shopifyLines.bodyNoWaybill":
      "Застосунок чекає на повторне читання замовлення з Shopify, щоб оновити позиції й резерв складу. До того нову накладну не створити. Зазвичай це займає до хвилини; якщо стан не змінюється — поставте читання ще раз.",
    "order.shopifyLines.resyncButton": "Прочитати замовлення з Shopify ще раз",
    "order.shopifyLines.resyncQueued": "Застосунок перечитає замовлення з Shopify й оновить позиції та резерв складу (зазвичай до хвилини). Після цього створіть нову накладну.",
    "order.shopifyLines.resync.queued": "Повторне читання замовлення з Shopify поставлено в чергу.",
    "order.shopifyLines.resync.not_shopify": "Замовлення не пов’язане з Shopify — читати нічого.",
    "order.shopifyLines.resync.no_shop": "Застосунок не встановлено в магазині Shopify — читання не поставлено.",
    "order.shopifyLines.resync.demo": "Демо: замовлення з Shopify не читаються.",
    "order.shopifyLines.handoverOwner":
      "Увага: Shopify змінив позиції після створення накладної, а застосунок їх не застосував. Склад спише товари за позиціями застосунку (тим, що запаковано). Підтверджуйте, лише якщо посилку вже фактично передано.",
    "order.shopifyLines.handoverBlocked":
      "Ручну передачу перевізнику заблоковано: Shopify змінив позиції після створення накладної. Скасуйте накладну й створіть нову з актуальними позиціями; якщо посилку вже передано — зверніться до власника.",
    "shipment.shopifyLinesPending":
      "Shopify змінив позиції замовлення після створення накладної, а застосунок їх ще не застосував. Скасуйте накладну (застосунок перечитає замовлення) і створіть нову; якщо посилку вже передано — підтвердити може лише власник.",

    // --- Етап 5: виконано в Shopify поза застосунком ---
    "order.shippedOutside.title": "Замовлення виконано в Shopify поза застосунком",
    "order.shippedOutside.body":
      "Shopify показує замовлення виконаним, а накладної застосунку немає. Нову накладну не створити — це було б повторне відправлення. Якщо товари справді відправлено (інший перевізник, самовивіз), підтвердьте «Відправлено поза застосунком».",
    "order.shippedOutside.bodyPartial":
      "Shopify показує замовлення частково виконаним, а накладної застосунку немає. Накладну в застосунку не створити: пакування й накладна містили б і вже відправлені товари. Відправте решту поза застосунком і підтвердьте «Відправлено поза застосунком», коли всі товари покинуть склад.",
    "order.shippedOutside.button": "Відправлено поза застосунком",
    "order.shippedOutside.help": "Склад спише зарезервовані товари один раз; перевізнику й у Shopify нічого не надсилається.",
    "order.shippedOutside.confirmTitle": "Позначити замовлення відправленим поза застосунком?",
    "order.shippedOutside.confirm": "Так, відправлено",
    "order.shippedOutside.confirmBody":
      "Підтвердьте, лише якщо ВСІ товари замовлення фізично покинули склад без накладної застосунку. Статус стане «Передано перевізнику»; накладна не створюється, у Shopify нічого не змінюється (замовлення там уже виконане).",
    "order.shippedOutside.confirmStock": "Зарезервовані товари буде списано зі складу (один раз).",
    "order.shippedOutside.result.done": "Замовлення позначено відправленим поза застосунком; резерв складу списано.",
    "order.shippedOutside.result.already": "Замовлення вже відправлено — нічого не змінено.",
    "order.shippedOutside.notFulfilledInShopify":
      "Shopify не показує це замовлення виконаним — позначити відправленим поза застосунком не можна (інакше склад застосунку й Shopify розійдуться).",
    "order.shippedOutside.activeWaybill":
      "У замовлення є накладна застосунку: підтвердьте передачу перевізнику в картці накладної або спершу скасуйте накладну.",
    "order.shopifyFulfillment.nonShippingOnly.title": "Shopify виконав лише позиції без доставки",
    "order.shopifyFulfillment.nonShippingOnly.body":
      "Shopify позначив замовлення частково виконаним, бо виконав позиції, що не потребують доставки (наприклад, цифрову подарункову картку — Shopify зазвичай виконує її автоматично). Фізичні товари ще не відправлено: накладну, пакування й передачу перевізнику робить застосунок, як зазвичай.",
    "order.shippedOutside.shopifyLinesPending":
      "Shopify змінив позиції замовлення (кількість, повернення або видалення), а застосунок їх ще не застосував. Спершу натисніть «Прочитати замовлення з Shopify ще раз» і дочекайтеся оновлення позицій — інакше склад списав би застарілі кількості й розійшовся з Shopify.",
    "order.shippedOutside.linesPending":
      "«Відправлено поза застосунком» стане доступним після повторного читання замовлення з Shopify: позиції змінено в Shopify, а застосунок їх ще не застосував (склад списав би застарілі кількості).",

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
      "Не вдалося отримати відповідь перевізника на скасування — у застосунку накладна залишається активною, але перевізник міг її скасувати. Перевірте в кабінеті перевізника, чи скасовано накладну (див. розділ «Проблеми»), і за потреби повторіть.",
    "waybill.cancelledButHandedOver":
      "Перевізник СКАСУВАВ накладну {number}, але посилку тим часом позначено переданою перевізнику. Накладна в застосунку лишається активною, проте в перевізника вона вже не діє — терміново зв’яжіться з перевізником (див. розділ «Проблеми»).",
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
      "The new waybill uses the current app data. If its creation is blocked (e.g. data problems), the old waybill still stays cancelled — the order goes back to the data check (“Awaiting review” or “Needs correction”).",
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
    "order.reissue.result.fixAndCreate": "The order status is now “{orderStatus}”. Resolve the cause and create a new waybill on this page.",
    "order.reissue.result.unknownNext": "Do not create the waybill again until the outcome is clarified (see the “Waybill” card).",
    "order.reissue.result.notStarted": "Nothing changed: a new waybill cannot be created right now, so the old waybill was not cancelled.",
    "order.reissue.result.concurrent":
      "Another request is already re-issuing this waybill — nothing was created again (duplicate protection). Refresh the page.",
    "order.correct.result": "Correct the order data, then create a new waybill.",
    "order.reissue.result.validationIssues": "Data problems: {issues}.",
    "order.reissue.result.correctInstead":
      "While the waybill is active, the order data cannot be edited: use “Cancel and correct data”, fix the data, then create a new waybill.",
    "order.reissue.result.createError":
      "Creating the new waybill failed with an error (code {code}). Reload the page and check the “Waybill” card: if there is no new waybill, create it again (no duplicate will be created).",
    "order.issues.closeChecked": "Checked in the carrier portal — close",
    "order.issues.next.CARRIER_CANCEL_UNKNOWN":
      "Next step: check the waybill in the carrier portal. Cancelled — retry the cancellation in the app; not cancelled — the waybill is still valid. Then close the problem.",
    "order.issues.next.CARRIER_CANCEL_CONFLICT":
      "Next step: contact the carrier about the parcel (the waybill is cancelled there). Close the problem once resolved.",

    "order.shopifyChanged.title": "Data changed in Shopify after the waybill was created",
    "order.shopifyChanged.body":
      "Changed in Shopify: {fields}. The waybill contains the app's data, so these changes are not in it and are not applied automatically.",
    "order.shopifyChanged.how":
      "To apply the correct contacts or address, the waybill has to be re-issued: “Cancel and correct data” → enter the correct values in the address form → create a new waybill. “Re-issue waybill” immediately creates a new waybill from the current app data (without the Shopify changes).",
    "order.shopifyChanged.shipped": "The parcel has already been handed to the carrier — the waybill cannot be re-issued. Agree the changes with the carrier.",
    "order.shopifyChanged.howLines":
      "Items (quantities, refunded or removed products) cannot be edited in the app: a fresh read of the order from Shopify applies them. Press “Cancel and correct data” — the app queues the read right away and updates the items and the stock reservation — then create a new waybill. “Re-issue waybill” is unavailable until the items are updated.",

    "order.shopifyLines.title": "Items changed in Shopify — not applied in the app yet",
    "order.shopifyLines.bodyActive":
      "After the waybill was created, the order items were changed in Shopify. The waybill, packing and stock reservation still use the old items, so re-issuing and manual handover to the carrier are blocked. Cancel the waybill (“Cancel and correct data”) — the app re-reads the order from Shopify.",
    "order.shopifyLines.bodyNoWaybill":
      "The app is waiting for a fresh read of the order from Shopify to update the items and the stock reservation. Until then a new waybill cannot be created. This usually takes up to a minute; if nothing changes, queue the read again.",
    "order.shopifyLines.resyncButton": "Read the order from Shopify again",
    "order.shopifyLines.resyncQueued": "The app will re-read the order from Shopify and update the items and stock reservation (usually within a minute). Then create a new waybill.",
    "order.shopifyLines.resync.queued": "A fresh read of the order from Shopify has been queued.",
    "order.shopifyLines.resync.not_shopify": "The order is not linked to Shopify — nothing to read.",
    "order.shopifyLines.resync.no_shop": "The app is not installed in a Shopify store — the read was not queued.",
    "order.shopifyLines.resync.demo": "Demo: orders are not read from Shopify.",
    "order.shopifyLines.handoverOwner":
      "Warning: Shopify changed the items after the waybill was created and the app has not applied them. Stock will be written off by the app's items (what was packed). Confirm only if the parcel has actually been handed over.",
    "order.shopifyLines.handoverBlocked":
      "Manual handover is blocked: Shopify changed the items after the waybill was created. Cancel the waybill and create a new one with the current items; if the parcel has already been handed over, ask the owner.",
    "shipment.shopifyLinesPending":
      "Shopify changed the order items after the waybill was created and the app has not applied them yet. Cancel the waybill (the app re-reads the order) and create a new one; if the parcel has already been handed over, only the owner can confirm.",

    "order.shippedOutside.title": "Order fulfilled in Shopify outside the app",
    "order.shippedOutside.body":
      "Shopify shows the order as fulfilled, but there is no app waybill. A new waybill cannot be created — it would ship the order twice. If the goods were really shipped (another carrier, pickup), confirm “Shipped outside the app”.",
    "order.shippedOutside.bodyPartial":
      "Shopify shows the order as partially fulfilled, but there is no app waybill. A waybill cannot be created in the app: packing and the waybill would also include items already shipped. Ship the rest outside the app and confirm “Shipped outside the app” once all items have left the warehouse.",
    "order.shippedOutside.button": "Shipped outside the app",
    "order.shippedOutside.help": "Reserved stock is written off once; nothing is sent to the carrier or Shopify.",
    "order.shippedOutside.confirmTitle": "Mark the order as shipped outside the app?",
    "order.shippedOutside.confirm": "Yes, shipped",
    "order.shippedOutside.confirmBody":
      "Confirm only if ALL items of the order have physically left the warehouse without an app waybill. The status becomes “Handed to carrier”; no waybill is created and nothing changes in Shopify (the order is already fulfilled there).",
    "order.shippedOutside.confirmStock": "Reserved items will be written off the stock (once).",
    "order.shippedOutside.result.done": "The order is marked as shipped outside the app; the stock reservation was written off.",
    "order.shippedOutside.result.already": "The order has already been shipped — nothing changed.",
    "order.shippedOutside.notFulfilledInShopify":
      "Shopify does not show this order as fulfilled — it cannot be marked as shipped outside the app (the app's and Shopify's stock would diverge).",
    "order.shippedOutside.activeWaybill":
      "The order has an app waybill: confirm the handover to the carrier in the waybill card or cancel the waybill first.",
    "order.shopifyFulfillment.nonShippingOnly.title": "Shopify fulfilled only items without shipping",
    "order.shopifyFulfillment.nonShippingOnly.body":
      "Shopify marked the order as partially fulfilled because it fulfilled items that need no shipping (for example a digital gift card — Shopify usually fulfils it automatically). The physical goods have not been shipped yet: the app creates the waybill, packing and carrier handover as usual.",
    "order.shippedOutside.shopifyLinesPending":
      "Shopify changed the order items (quantity, refund or removal) and the app has not applied them yet. First press “Read the order from Shopify again” and wait for the items to update — otherwise the stock would write off outdated quantities and diverge from Shopify.",
    "order.shippedOutside.linesPending":
      "“Shipped outside the app” becomes available after a fresh read of the order from Shopify: the items were changed in Shopify and the app has not applied them yet (the stock would write off outdated quantities).",

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
      "No response from the carrier to the cancellation — the waybill remains active in the app, but the carrier may have cancelled it. Check in the carrier's portal whether it was cancelled (see “Problems”) and retry if needed.",
    "waybill.cancelledButHandedOver":
      "The carrier CANCELLED waybill {number}, but meanwhile the parcel was marked as handed to the carrier. The waybill stays active in the app, but it is no longer valid at the carrier — contact the carrier urgently (see “Problems”).",
  },
};

export default messages;
