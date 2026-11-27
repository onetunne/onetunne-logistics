import type { MessageModule } from "../types";

/** Етап 5: синхронізація залишків із Shopify (сторінка «Склад → Shopify», дії, результати фонових завдань). */
const messages: MessageModule = {
  uk: {
    "inventorySync.title": "Залишки й Shopify",
    "inventorySync.subtitle": "Передача змін складу в Shopify, звірка залишків і розбіжності",
    "inventorySync.demo":
      "Демо працює без Shopify: передача й звірка недоступні, дії на цій сторінці відхиляються. У робочому застосунку тут видно стан синхронізації й розбіжності з Shopify.",

    "inventorySync.banner.missingWrite":
      "Немає дозволу write_inventory: застосунок не може змінювати залишки в Shopify. Інструкція — docs/shopify-test-server.md, «Етап 5».",
    "inventorySync.banner.pushOff":
      "Передача змін складу в Shopify вимкнена (так за замовчуванням). Надходження, брак і коригування не змінюють залишок у Shopify. Увімкнути може власник: Налаштування → Склад.",
    "inventorySync.banner.notInitialized": "Облік складу ще не запущено: звіряються лише товари, відкриті в обліку (Склад → «Ініціалізувати облік»).",
    "inventorySync.banner.chooseLocation":
      "Не обрано локацію Shopify для складу. У магазині кілька локацій (або їх не вдалося прочитати) — оберіть локацію нижче. До вибору передача й звірка не виконуються.",
    "inventorySync.banner.confirmLocation": "Локацію Shopify обрано автоматично (вона в магазині єдина). Перевірте й підтвердьте її нижче.",
    "inventorySync.banner.autoApplyPaused":
      "Обрано автоматичне прийняття змін із Shopify, але воно не діє: передачу змін складу в Shopify вимкнено або немає дозволу write_inventory. Без передачі Shopify не знає про надходження, брак і коригування складу, і автоприйняття скасувало б їх — тому всі різниці йдуть на розгляд власника.",

    "inventorySync.overview.title": "Стан синхронізації",
    "inventorySync.overview.shop": "Магазин",
    "inventorySync.overview.scopes": "Дозволи",
    "inventorySync.overview.granted": "надано",
    "inventorySync.overview.missing": "немає",
    "inventorySync.overview.pushMode": "Передача змін складу в Shopify",
    "inventorySync.overview.pushMode.off": "Вимкнено",
    "inventorySync.overview.pushMode.deltas": "Увімкнено (зміни надсилаються дельтою)",
    "inventorySync.overview.settingsHint": "Змінює власник: Налаштування → Склад",
    "inventorySync.overview.externalMode": "Зміни, зроблені в Shopify",
    "inventorySync.overview.externalMode.review": "На розгляд власника (розбіжність)",
    "inventorySync.overview.externalMode.apply": "Приймати автоматично, якщо різниця не має інших пояснень",
    "inventorySync.overview.location": "Локація Shopify",
    "inventorySync.overview.locationConfirmed": "підтверджено {date}",
    "inventorySync.overview.locationAuto": "обрано автоматично — підтвердьте",
    "inventorySync.overview.locationUnconfirmed": "не підтверджено",
    "inventorySync.overview.locationNone": "Не обрано",
    "inventorySync.overview.pending": "Очікують передачі",
    "inventorySync.overview.oldestPending": "найстаріша зміна {date}",
    "inventorySync.overview.failed": "Невдалі передачі",
    "inventorySync.overview.lastPush": "Остання передача",
    "inventorySync.overview.lastPushSummary": "надіслано {pushed}, помилок {failed}",
    "inventorySync.overview.lastReconcile": "Остання повна звірка",
    "inventorySync.overview.lastReconcileSummary":
      "Перевірено {checked}: збігається {match}, розбіжностей {conflicts}, прийнято автоматично {autoApplied}, закрито {closed}, пропущено {skipped}",
    "inventorySync.overview.lastReconcileNever": "Ще не виконувалася",
    "inventorySync.overview.nextReconcile": "Наступна планова звірка",
    "inventorySync.overview.nextReconcileNone": "Не заплановано",
    "inventorySync.overview.nextReconcileHint":
      "Кожні 6 год застосунок сам звіряє залишки з Shopify (лише читання), якщо облік складу запущено. Розбіжності обробляються за правилом «Зміни залишку, зроблені в Shopify» з налаштувань складу.",
    "inventorySync.overview.queue": "У черзі",
    "inventorySync.overview.queuedPush": "передача",
    "inventorySync.overview.queuedReconcile": "звірок: {count}",
    // Демо: Shopify не підключено — стан передачі/звірки не діє (налаштування показуються лише як обрані).
    "inventorySync.overview.demo.push": "Демо: Shopify не підключено — нічого не надсилається",
    "inventorySync.overview.demo.external": "Демо: Shopify не підключено — змін залишку з Shopify немає, нічого не приймається",
    "inventorySync.overview.demo.setting": "Обрано в налаштуваннях: «{value}». Діятиме лише в робочому застосунку з підключеним Shopify.",
    "inventorySync.overview.demo.nextReconcile": "Демо: Shopify не підключено — планова звірка не виконується",
    "inventorySync.overview.demo.pending": "Зміни з позначкою «Очікує надсилання»",
    "inventorySync.overview.demo.pendingHint":
      "Не будуть надіслані: у демо Shopify не підключено. Позначка лишилася з демо-даних, створених раніше; її прибирає «Скинути демо-дані» (Налаштування → Демо-дані).",
    "inventorySync.overview.demo.queue": "У демо завдання синхронізації з Shopify не виконуються.",

    "inventorySync.action.reconcileAll": "Звірити все",
    "inventorySync.action.reconcileAll.title": "Звірити всі товари з Shopify?",
    "inventorySync.action.reconcileAll.message":
      "Застосунок прочитає залишки всіх відкритих товарів у Shopify й порівняє з «доступно» складу. Залишки не змінюються: нові розбіжності з'являться в списку нижче. Звірка йде у фоні кілька хвилин.",
    "inventorySync.action.pushNow": "Надіслати зміни зараз",
    "inventorySync.action.skipPending": "Обробити очікувані зміни",
    "inventorySync.action.skipPending.title": "Позначити очікувані зміни як не передані?",
    "inventorySync.action.skipPending.message":
      "Передачу в Shopify вимкнено або немає дозволу write_inventory, тож {count} змін(и) не буде надіслано: їх позначить «не передано», і вони більше не блокуватимуть звірку. Shopify їх не отримає — після звірки розбіжності можна розв'язати вручну.",
    "inventorySync.action.reconcileItem": "Звірити",
    "inventorySync.action.accept": "Прийняти Shopify",
    "inventorySync.action.accept.title": "Прийняти значення Shopify?",
    "inventorySync.action.accept.message":
      "Фактичний залишок складу зміниться на {diff} шт. — склад вважатиме правильним значення Shopify. Зміна запишеться в історію руху.",
    "inventorySync.action.accept.warning":
      "Є невдалі передачі, частково виконані/повернені замовлення або зміни товарів у Shopify, ще не застосовані в застосунку — перевірте, чи справді змінився фактичний залишок.",
    "inventorySync.action.accept.unsentWarning":
      "Склад має зміни на {delta} шт., яких Shopify не отримав (надходження, брак, коригування, повернення). Прийняття значення Shopify їх скасує. Якщо ці зміни правильні — оберіть «Надіслати склад» (повернення, які Shopify поповнить сам, воно не надсилає).",
    "inventorySync.action.accept.awaitingWarning":
      "Склад оприбуткував {count} шт. повернень покупця, які Shopify ще має поповнити сам (відшкодування з поверненням на склад у Shopify ще не оформлено). Прийняття значення Shopify зараз скасує їх на складі — зачекайте, поки Shopify їх поповнить.",
    "inventorySync.action.accept.otherStatesWarning":
      "У Shopify {count} шт. позначено як недоступні (брак, резерв, контроль якості) — фізично вони на складі. Якщо це брак, позначте брак на складі замість прийняття: прийняття зменшить фактичний залишок.",
    "inventorySync.action.reservationWarning":
      "Склад резервує на {count} шт. більше, ніж закріпив Shopify (замовлення змінено, скасовано або виконано в Shopify, а в застосунку — ще ні). Спершу перевірте такі замовлення («Проблеми»).",
    "inventorySync.action.explainedKept":
      "Ще {count} шт. різниці пояснюють замовлення, які Shopify закріпив, а склад не резервує (неоплачені, ще не синхронізовані) — їх не змінюємо: різниця зникне, коли замовлення оплатять або скасують.",
    "inventorySync.action.pushApp": "Надіслати склад",
    "inventorySync.action.pushApp.title": "Надіслати значення складу в Shopify?",
    "inventorySync.action.pushApp.message":
      "Залишок «доступно» в Shopify зміниться на {delta} шт. (з {shopify} на {to}). Якщо в Shopify значення вже інше, зміна не застосується — застосунок звірить товар заново.",
    "inventorySync.action.pushApp.warning":
      "Є частково виконані/повернені замовлення або зміни товарів у Shopify, ще не застосовані в застосунку — розподіл одиниць неточний, перевірте значення в Shopify після надсилання.",
    "inventorySync.action.pushApp.noScope": "«Надіслати склад» недоступно: немає дозволу write_inventory.",
    "inventorySync.action.pushApp.otherStates":
      "«Надіслати склад» недоступно: уся різниця — {count} шт., які Shopify тримає в станах «брак», «резерв», «безпечний запас» або «контроль якості» (вони вже у фактичному залишку Shopify, тож надсилання додало б їх удруге). Брак — позначте брак на складі; резерв і безпечний запас Shopify тримає свідомо (різниця лишається, доки їх не звільнять у Shopify); контроль якості — завершіть його в Shopify. Потім звірте товар.",
    "inventorySync.action.pushApp.onlyReturns":
      "Без позначки нижче нічого не буде надіслано: решта різниці — повернення, які Shopify поповнить сам.",
    "inventorySync.action.pushApp.heldOtherStates":
      "Не надсилається {count} шт.: Shopify тримає їх у станах «брак», «резерв», «безпечний запас» або «контроль якості» — вони вже у фактичному залишку Shopify. Після надсилання фактичний залишок Shopify дорівнюватиме складу, а різниця «доступно» на ці одиниці лишиться.",
    "inventorySync.action.pushApp.heldAwaiting":
      "Не надсилається {count} шт.: це повернення покупця, оприбутковані складом, які Shopify поповнить сам, коли повернення буде відшкодовано з поверненням на склад. Надіслані зараз, вони після поповнення порахувалися б у Shopify двічі.",
    "inventorySync.action.pushApp.includeReturns":
      "Shopify не поповнить ці повернення (відшкодовано без повернення на склад або не оформлено в Shopify) — надіслати й їх ({count} шт.)",
    "inventorySync.action.dismiss": "Відхилити",
    "inventorySync.action.dismiss.note": "Причина (обов'язково)",
    "inventorySync.action.dismiss.submit": "Відхилити розбіжність",
    "inventorySync.action.dismiss.pushPending":
      "Результат «Надіслати склад» ще не підтверджено. Відхилення не скасовує запит: Shopify міг застосувати його пізніше, тому до 24 год від спроби нові різниці цього товару автоматично не прийматимуться.",

    "inventorySync.location.unavailable": "Не вдалося прочитати локації Shopify. Оновіть сторінку пізніше.",
    "inventorySync.location.title": "Локація Shopify складу",
    "inventorySync.location.help":
      "Зміни складу надсилаються й звіряються лише в цій локації Shopify. Оберіть локацію, де фізично лежить товар «Основного складу».",
    "inventorySync.location.label": "Локація",
    "inventorySync.location.placeholder": "Оберіть локацію",
    "inventorySync.location.confirmTitle": "Зберегти локацію?",
    "inventorySync.location.confirmMessage":
      "Подальші зміни складу надсилатимуться в цю локацію, і звірка порівнюватиме залишки саме в ній.",
    "inventorySync.location.save": "Зберегти й підтвердити",
    "inventorySync.location.confirmCurrent": "Підтвердити поточну",

    "inventorySync.failures.title": "Невдалі передачі",
    "inventorySync.failures.help":
      "Ці зміни, імовірно, не дійшли до Shopify. Застосунок звіряє такі товари: якщо значення різняться, з'явиться розбіжність — оберіть «Надіслати склад».",
    "inventorySync.failure.idempotency_window": "Не надіслано протягом 23 год — потрібна звірка",
    "inventorySync.failure.shopify": "Shopify відхилив зміну",

    "inventorySync.col.product": "Товар",
    "inventorySync.col.change": "Зміна",
    "inventorySync.col.type": "Операція",
    "inventorySync.col.error": "Причина",
    "inventorySync.col.date": "Дата",
    "inventorySync.col.app": "Склад (доступно)",
    "inventorySync.col.shopify": "Shopify (доступно)",
    "inventorySync.col.diff": "Різниця",
    "inventorySync.col.unexplained": "непояснено {count}",
    "inventorySync.col.explanation": "Пояснення",
    "inventorySync.col.observed": "Звірено",
    "inventorySync.col.actions": "Дії",

    "inventorySync.conflicts.title": "Розбіжності з Shopify",
    "inventorySync.conflicts.help":
      "Різниця = Shopify «доступно» − «доступно» складу (фактично − резерв). Значення не перезаписуються мовчки: оберіть, яке правильне.",
    "inventorySync.conflicts.empty": "Відкритих розбіжностей немає.",
    "inventorySync.conflicts.emptyOther": "Немає розбіжностей за цими умовами.",
    "inventorySync.conflicts.single": "Показано одну розбіжність (за посиланням з історії залишків Shopify).",
    "inventorySync.conflicts.showAll": "Показати всі розбіжності",
    "inventorySync.tabs.label": "Розбіжності за станом",
    "inventorySync.tab.open": "Відкриті",
    "inventorySync.tab.resolved": "Розв'язані",
    "inventorySync.tab.all": "Усі",
    "inventorySync.filters.search": "Товар, SKU або штрихкод",
    "inventorySync.filters.searchPlaceholder": "Напр. OT-PH",
    "inventorySync.filters.model": "Модель",
    "inventorySync.filters.allModels": "Усі моделі",
    "inventorySync.filters.color": "Колір",
    "inventorySync.filters.allColors": "Усі кольори",

    "inventorySync.bulk.label": "Масові дії з розбіжностями",
    "inventorySync.bulk.hint": "Позначте розбіжності, щоб прийняти значення Shopify для кількох товарів.",
    "inventorySync.bulk.title": "Прийняти значення Shopify для вибраних?",
    "inventorySync.bulk.confirm": "Прийняти",
    "inventorySync.bulk.count": "Розбіжностей: {count}; сумарна зміна фактичного залишку: {units} шт.",
    "inventorySync.bulk.skipped": "Без звірки (буде пропущено): {count}",
    "inventorySync.bulk.help": "Розбіжності, де склад змінився після звірки, буде пропущено й звірено заново.",
    "inventorySync.bulk.explained":
      "У {count} розбіжн. частину різниці пояснюють замовлення, закріплені в Shopify, — її не змінюємо (у сумі вище не враховано).",
    "inventorySync.bulk.warning":
      "У {count} розбіжн. є невдалі передачі або частково виконані/повернені замовлення — перевірте їх окремо перед прийняттям.",
    "inventorySync.bulk.button": "Прийняти Shopify для вибраних",
    "inventorySync.bulk.select": "Вибрати {title}",

    "inventorySync.why.openedWithHistory":
      "Під час запуску обліку на складі вже були внутрішні зміни — перевірте, чи не внесено їх у Shopify вручну. Натисніть «Звірити».",
    "inventorySync.why.needsReconcile": "Потрібна свіжа звірка з Shopify, щоб обрати дію.",
    "inventorySync.why.committed": "Shopify закріпив {count} шт. під замовлення, яких застосунок не резервує (неоплачені, чернетки)",
    "inventorySync.why.failedPushes": "Невдалих передач: {count} (разом {delta} шт.) — Shopify їх, імовірно, не отримав",
    "inventorySync.why.inFlight": "Передано перевізнику, але ще не виконано в Shopify: {count} шт.",
    "inventorySync.why.otherStates": "У Shopify {count} шт. позначено як недоступні (брак, резерв, безпечний запас, контроль якості)",
    "inventorySync.why.uncertain": "Є частково виконані замовлення — перевірте вручну",
    "inventorySync.why.linesPending":
      "Shopify змінив товари у відкритому замовленні, а застосунок ще не застосував ці зміни (напр., є накладна) — резерв застарів, перевірте вручну",
    "inventorySync.why.autoBlocked": "Автоприйняття не виконано: фактичний залишок став би від'ємним",
    "inventorySync.why.unsent":
      "Склад має {count} змін(и), яких Shopify не отримав (разом {delta} шт.): передачу вимкнено, немає дозволу, зміни до запуску обліку, відхилені невдалі передачі або повернення покупця, які Shopify поповнює сам. «Прийняти Shopify» їх скасує. «Надіслати склад» донесе до Shopify усе, крім повернень, що чекають поповнення в Shopify",
    "inventorySync.why.reservationExcess":
      "Склад резервує на {count} шт. більше, ніж закріпив Shopify: замовлення змінено/скасовано/виконано в Shopify, а в застосунку — ще ні (див. «Проблеми»)",
    "inventorySync.why.returnsPending":
      "Повернено/відшкодовано після відправлення {count} шт., яких склад ще не оприбуткував як придатні (повернення не надійшло або товар пошкоджений) — Shopify міг уже поповнити «доступно» сам. Якщо повернення вже оприбутковано й надіслано в Shopify кнопкою «Надіслати склад», Shopify порахував його двічі — оберіть «Надіслати склад»",
    "inventorySync.why.returnsAwaiting":
      "Склад оприбуткував {count} шт. повернень покупця, які Shopify ще має поповнити сам (відшкодування з поверненням на склад у Shopify ще немає). Різниця зникне, коли Shopify їх поповнить; «Надіслати склад» їх не надсилає",
    "inventorySync.why.pushPending":
      "Результат «Надіслати склад» від {date} ще не підтверджено — повторіть «Надіслати склад» (повтор безпечний) або звірте товар",
    "inventorySync.why.autoSkipped": "Не прийнято автоматично: різницю може пояснювати інше (див. вище) — потрібне рішення власника",
    "inventorySync.why.external": "Імовірно, залишок змінили в Shopify вручну або іншим застосунком",

    "inventorySync.conflictStatus.open": "Відкрита",
    "inventorySync.conflictStatus.accepted_shopify": "Прийнято Shopify",
    "inventorySync.conflictStatus.pushed_app": "Надіслано склад",
    "inventorySync.conflictStatus.dismissed": "Закрито",
    "inventorySync.resolution.accepted_shopify": "Власник прийняв значення Shopify",
    "inventorySync.resolution.pushed_app": "Значення складу надіслано в Shopify",
    "inventorySync.resolution.dismissed": "Відхилено власником",
    "inventorySync.resolution.auto_resolved": "Закрито звіркою: значення збігаються",
    "inventorySync.resolution.auto_applied": "Прийнято автоматично (налаштування)",

    "inventorySync.outcome.match": "Залишки збігаються.",
    "inventorySync.outcome.explained": "Різниця пояснюється замовленнями (закріпленими в Shopify або ще не оновленими на складі) — розбіжності немає.",
    "inventorySync.outcome.opened": "Знайдено розбіжність — вона в списку нижче.",
    "inventorySync.outcome.updated": "Розбіжність оновлено свіжими даними.",
    "inventorySync.outcome.auto_applied": "Значення Shopify прийнято автоматично.",
    "inventorySync.outcome.closed": "Значення збігаються — розбіжність закрито.",
    "inventorySync.outcome.skipped_pending": "Є зміни, ще не передані в Shopify, — звірку відкладено.",
    "inventorySync.outcome.skipped_busy": "Залишок змінився під час звірки — звірку відкладено.",
    "inventorySync.outcome.not_stocked": "Товар не ведеться в обраній локації Shopify.",
    "inventorySync.outcome.untracked": "Shopify не відстежує залишок цього товару.",
    "inventorySync.outcome.missing": "Товар не знайдено в Shopify.",
    "inventorySync.outcome.not_opened": "Товар ще не відкрито в обліку складу.",

    "inventorySync.result.accepted": "Значення Shopify прийнято: фактичний залишок змінено на {diff} шт.",
    "inventorySync.result.already": "Цю розбіжність уже розв'язано.",
    "inventorySync.result.stale": "Залишок змінився після звірки — розбіжність звірено заново. Перевірте нові значення.",
    "inventorySync.result.needs_reconcile": "Розбіжність звірено з Shopify. Перевірте значення й оберіть дію.",
    "inventorySync.result.pushed": "Значення складу надіслано в Shopify (зміна {delta} шт.).",
    "inventorySync.result.pushedHeld":
      "Значення складу надіслано в Shopify (зміна {delta} шт.). Не надіслано {held} шт. — пояснення в розбіжності після звірки.",
    "inventorySync.result.inProgress": "Shopify ще обробляє попередній запит. Спробуйте за хвилину — повтор безпечний.",
    "inventorySync.result.unknown": "Не вдалося підтвердити відповідь Shopify. Спробуйте ще раз — повтор не змінить залишок двічі.",
    "inventorySync.result.push_pending":
      "Результат попереднього «Надіслати склад» ще невідомий, тому «Прийняти Shopify» зараз недоступне (інакше застосувалися б обидві зміни). Повторіть «Надіслати склад» або натисніть «Звірити» за кілька хвилин.",
    "inventorySync.result.resolved_concurrently":
      "Значення складу надіслано в Shopify (зміна {delta} шт.), але розбіжність тим часом закрито іншою дією. Звірте товар, щоб перевірити значення.",
    "inventorySync.result.dismissed": "Розбіжність відхилено.",
    "inventorySync.result.bulkAccepted":
      "Прийнято: {accepted} (разом {units} шт.). Звірено заново: {stale}. Уже розв'язано: {already}. Очікують результату «Надіслати склад»: {pending}. Помилок: {failed}.",
    "inventorySync.result.reconciledItem": "Товар звірено з Shopify.",
    "inventorySync.result.reconcileQueued": "Повну звірку поставлено в чергу. Результат з'явиться тут за кілька хвилин.",
    "inventorySync.result.reconcileAlreadyQueued": "Повна звірка вже в черзі.",
    "inventorySync.result.pushQueued": "Передачу змін у Shopify поставлено в чергу.",
    "inventorySync.result.pendingWillBeSkipped": "Очікувані зміни буде позначено «не передано» (передачу вимкнено або немає дозволу).",
    "inventorySync.result.locationSet": "Локацію «{name}» збережено й підтверджено.",
    "inventorySync.result.locationConfirmed": "Локацію підтверджено.",

    "inventorySync.demoUnavailable": "Недоступно в демо: немає підключення до Shopify.",
    "inventorySync.conflictResolved": "Розбіжність уже розв'язано іншою дією. Оновіть сторінку.",
    "inventorySync.missingWriteScope": "Немає дозволу write_inventory — зміни залишків у Shopify недоступні.",
    "inventorySync.missingReadScope": "Немає дозволу read_inventory — звірка недоступна.",
    "inventorySync.nothingSelected": "Не вибрано жодної розбіжності.",
    "inventorySync.tooMany": "Забагато розбіжностей за раз (максимум {max}).",
    "inventorySync.noteRequired": "Вкажіть причину.",
    "inventorySync.noteTooLong": "Причина задовга (максимум {max} символів).",
    "inventorySync.locationInvalid": "Цієї локації немає серед активних локацій магазину.",
    "inventorySync.locationMissing": "Локацію ще не обрано.",
    "inventorySync.reconcileUnavailable": "Звірка неможлива: немає локації, дозволу або зв'язку товару з Shopify.",
    "inventorySync.pushFailed": "Shopify відхилив зміну ({code}). Розбіжність лишається відкритою.",
    "inventorySync.pushOtherStates":
      "Не надіслано: уся різниця — {count} шт., які Shopify тримає в станах «брак», «резерв», «безпечний запас» або «контроль якості». Брак — позначте на складі; резерв, безпечний запас і контроль якості змінюються в Shopify. Потім звірте товар.",
    "inventorySync.pushAwaitingReturns":
      "Не надіслано: {count} шт. — повернення, які Shopify поповнить сам. Якщо Shopify їх не поповнить, позначте «Shopify не поповнить ці повернення» й надішліть ще раз.",
  },
  en: {
    "inventorySync.title": "Stock and Shopify",
    "inventorySync.subtitle": "Sending warehouse changes to Shopify, stock reconciliation and discrepancies",
    "inventorySync.demo":
      "The demo runs without Shopify: sending and reconciliation are unavailable and actions on this page are refused. In the live app this page shows the sync state and discrepancies with Shopify.",

    "inventorySync.banner.missingWrite":
      "The write_inventory permission is missing: the app cannot change stock in Shopify. See docs/shopify-test-server.md, “Stage 5”.",
    "inventorySync.banner.pushOff":
      "Sending warehouse changes to Shopify is off (the default). Receipts, defects and adjustments do not change stock in Shopify. The owner can enable it in Settings → Warehouse.",
    "inventorySync.banner.notInitialized": "Warehouse accounting is not started yet: only products opened in accounting are reconciled (Warehouse → “Initialize accounting”).",
    "inventorySync.banner.chooseLocation":
      "No Shopify location is selected for the warehouse. The store has several locations (or they could not be read) — choose one below. Until then nothing is sent or reconciled.",
    "inventorySync.banner.confirmLocation": "The Shopify location was selected automatically (it is the only one in the store). Check and confirm it below.",
    "inventorySync.banner.autoApplyPaused":
      "Automatic acceptance of Shopify changes is selected but not in effect: sending warehouse changes to Shopify is off or the write_inventory permission is missing. Without sending, Shopify does not know about warehouse receipts, defects and adjustments, and automatic acceptance would cancel them — so every difference goes to owner review.",

    "inventorySync.overview.title": "Sync status",
    "inventorySync.overview.shop": "Store",
    "inventorySync.overview.scopes": "Permissions",
    "inventorySync.overview.granted": "granted",
    "inventorySync.overview.missing": "missing",
    "inventorySync.overview.pushMode": "Sending warehouse changes to Shopify",
    "inventorySync.overview.pushMode.off": "Off",
    "inventorySync.overview.pushMode.deltas": "On (changes are sent as deltas)",
    "inventorySync.overview.settingsHint": "Changed by the owner: Settings → Warehouse",
    "inventorySync.overview.externalMode": "Changes made in Shopify",
    "inventorySync.overview.externalMode.review": "Owner review (discrepancy)",
    "inventorySync.overview.externalMode.apply": "Accept automatically when nothing else explains the difference",
    "inventorySync.overview.location": "Shopify location",
    "inventorySync.overview.locationConfirmed": "confirmed {date}",
    "inventorySync.overview.locationAuto": "selected automatically — please confirm",
    "inventorySync.overview.locationUnconfirmed": "not confirmed",
    "inventorySync.overview.locationNone": "Not selected",
    "inventorySync.overview.pending": "Waiting to be sent",
    "inventorySync.overview.oldestPending": "oldest change {date}",
    "inventorySync.overview.failed": "Failed sends",
    "inventorySync.overview.lastPush": "Last send",
    "inventorySync.overview.lastPushSummary": "sent {pushed}, errors {failed}",
    "inventorySync.overview.lastReconcile": "Last full reconciliation",
    "inventorySync.overview.lastReconcileSummary":
      "Checked {checked}: matching {match}, discrepancies {conflicts}, accepted automatically {autoApplied}, closed {closed}, skipped {skipped}",
    "inventorySync.overview.lastReconcileNever": "Not run yet",
    "inventorySync.overview.nextReconcile": "Next scheduled reconciliation",
    "inventorySync.overview.nextReconcileNone": "Not scheduled",
    "inventorySync.overview.nextReconcileHint":
      "Every 6 hours the app compares stock with Shopify on its own (read-only) once warehouse accounting is started. Differences follow the “Stock changes made in Shopify” rule in the warehouse settings.",
    "inventorySync.overview.queue": "Queued",
    "inventorySync.overview.queuedPush": "sending",
    "inventorySync.overview.queuedReconcile": "reconciliations: {count}",
    "inventorySync.overview.demo.push": "Demo: Shopify is not connected — nothing is sent",
    "inventorySync.overview.demo.external": "Demo: Shopify is not connected — there are no stock changes from Shopify, nothing is accepted",
    "inventorySync.overview.demo.setting": "Selected in the settings: «{value}». It takes effect only in the live app with Shopify connected.",
    "inventorySync.overview.demo.nextReconcile": "Demo: Shopify is not connected — no scheduled reconciliation runs",
    "inventorySync.overview.demo.pending": "Changes marked «Waiting to send»",
    "inventorySync.overview.demo.pendingHint":
      "They will not be sent: Shopify is not connected in the demo. The mark is left over from demo data created earlier; «Reset demo data» (Settings → Demo data) removes it.",
    "inventorySync.overview.demo.queue": "In the demo, Shopify sync jobs do not run.",

    "inventorySync.action.reconcileAll": "Reconcile all",
    "inventorySync.action.reconcileAll.title": "Reconcile all products with Shopify?",
    "inventorySync.action.reconcileAll.message":
      "The app reads the stock of every opened product in Shopify and compares it with the warehouse “available”. Stock is not changed: new discrepancies appear in the list below. It runs in the background for a few minutes.",
    "inventorySync.action.pushNow": "Send changes now",
    "inventorySync.action.skipPending": "Process pending changes",
    "inventorySync.action.skipPending.title": "Mark pending changes as not sent?",
    "inventorySync.action.skipPending.message":
      "Sending to Shopify is off or the write_inventory permission is missing, so {count} change(s) will not be sent: they are marked “not sent” and no longer block reconciliation. Shopify will not get them — after reconciliation, resolve the discrepancies manually.",
    "inventorySync.action.reconcileItem": "Reconcile",
    "inventorySync.action.accept": "Accept Shopify",
    "inventorySync.action.accept.title": "Accept the Shopify value?",
    "inventorySync.action.accept.message":
      "Warehouse on-hand stock changes by {diff} pcs — the warehouse treats the Shopify value as correct. The change is recorded in the movement history.",
    "inventorySync.action.accept.warning":
      "There are failed sends, partially fulfilled/returned orders or Shopify item changes the app has not applied yet — check that the physical stock really changed.",
    "inventorySync.action.accept.unsentWarning":
      "The warehouse has changes of {delta} pcs that Shopify did not receive (receipts, defects, adjustments, returns). Accepting the Shopify value cancels them. If these changes are correct, choose “Send warehouse” (it does not send returns that Shopify restocks itself).",
    "inventorySync.action.accept.awaitingWarning":
      "The warehouse received {count} pcs of customer returns that Shopify still has to restock itself (the refund with restock is not in Shopify yet). Accepting the Shopify value now cancels them in the warehouse — wait until Shopify restocks them.",
    "inventorySync.action.accept.otherStatesWarning":
      "Shopify marks {count} pcs as unavailable (damaged, reserved, quality control) — they are physically in the warehouse. If they are defective, record a defect in the warehouse instead: accepting reduces on-hand stock.",
    "inventorySync.action.reservationWarning":
      "The warehouse reserves {count} pcs more than Shopify holds (an order was edited, cancelled or fulfilled in Shopify but not yet in the app). Check those orders first (“Problems”).",
    "inventorySync.action.explainedKept":
      "Another {count} pcs of the difference are orders Shopify holds but the warehouse does not reserve (unpaid, not yet synced) — they are not changed: that part disappears once the orders are paid or cancelled.",
    "inventorySync.action.pushApp": "Send warehouse",
    "inventorySync.action.pushApp.title": "Send the warehouse value to Shopify?",
    "inventorySync.action.pushApp.message":
      "Shopify “available” changes by {delta} pcs (from {shopify} to {to}). If the value in Shopify has already changed, nothing is applied and the app reconciles the product again.",
    "inventorySync.action.pushApp.warning":
      "There are partially fulfilled/returned orders or Shopify item changes the app has not applied yet — the split of units is uncertain, check the value in Shopify after sending.",
    "inventorySync.action.pushApp.noScope": "“Send warehouse” is unavailable: the write_inventory permission is missing.",
    "inventorySync.action.pushApp.otherStates":
      "“Send warehouse” is unavailable: the whole difference is {count} pcs that Shopify keeps as “damaged”, “reserved”, “safety stock” or “quality control” (they are already in Shopify's on-hand stock, so sending would add them a second time). Damaged — record a defect in the warehouse; reserved and safety stock are held by Shopify on purpose (the difference stays until they are released in Shopify); quality control — finish it in Shopify. Then reconcile the product.",
    "inventorySync.action.pushApp.onlyReturns":
      "Without the option below nothing is sent: the rest of the difference is returns that Shopify restocks itself.",
    "inventorySync.action.pushApp.heldOtherStates":
      "{count} pcs are not sent: Shopify keeps them as “damaged”, “reserved”, “safety stock” or “quality control” — they are already in Shopify's on-hand stock. After sending, Shopify's on-hand stock equals the warehouse, and the “available” difference for these units remains.",
    "inventorySync.action.pushApp.heldAwaiting":
      "{count} pcs are not sent: these are customer returns received by the warehouse that Shopify restocks itself once the return is refunded with restock. Sent now, they would be counted twice in Shopify after the restock.",
    "inventorySync.action.pushApp.includeReturns":
      "Shopify will not restock these returns (refunded without restock or not handled in Shopify) — send them too ({count} pcs)",
    "inventorySync.action.dismiss": "Dismiss",
    "inventorySync.action.dismiss.note": "Reason (required)",
    "inventorySync.action.dismiss.submit": "Dismiss discrepancy",
    "inventorySync.action.dismiss.pushPending":
      "The result of “Send warehouse” is not confirmed yet. Dismissing does not cancel the request: Shopify may still apply it, so for 24 hours after the attempt new differences of this product are not accepted automatically.",

    "inventorySync.location.unavailable": "Could not read Shopify locations. Refresh the page later.",
    "inventorySync.location.title": "Warehouse Shopify location",
    "inventorySync.location.help":
      "Warehouse changes are sent to and reconciled with this Shopify location only. Choose the location where the “Main warehouse” stock physically is.",
    "inventorySync.location.label": "Location",
    "inventorySync.location.placeholder": "Choose a location",
    "inventorySync.location.confirmTitle": "Save the location?",
    "inventorySync.location.confirmMessage": "Future warehouse changes will be sent to this location and reconciliation will compare stock there.",
    "inventorySync.location.save": "Save and confirm",
    "inventorySync.location.confirmCurrent": "Confirm current",

    "inventorySync.failures.title": "Failed sends",
    "inventorySync.failures.help":
      "These changes probably did not reach Shopify. The app reconciles such products: if the values differ, a discrepancy appears — choose “Send warehouse”.",
    "inventorySync.failure.idempotency_window": "Not sent within 23 h — reconciliation needed",
    "inventorySync.failure.shopify": "Shopify rejected the change",

    "inventorySync.col.product": "Product",
    "inventorySync.col.change": "Change",
    "inventorySync.col.type": "Operation",
    "inventorySync.col.error": "Reason",
    "inventorySync.col.date": "Date",
    "inventorySync.col.app": "Warehouse (available)",
    "inventorySync.col.shopify": "Shopify (available)",
    "inventorySync.col.diff": "Difference",
    "inventorySync.col.unexplained": "unexplained {count}",
    "inventorySync.col.explanation": "Explanation",
    "inventorySync.col.observed": "Reconciled",
    "inventorySync.col.actions": "Actions",

    "inventorySync.conflicts.title": "Discrepancies with Shopify",
    "inventorySync.conflicts.help":
      "Difference = Shopify “available” − warehouse “available” (on hand − reserved). Values are never overwritten silently: choose which one is right.",
    "inventorySync.conflicts.empty": "No open discrepancies.",
    "inventorySync.conflicts.emptyOther": "No discrepancies match these filters.",
    "inventorySync.conflicts.single": "Showing one discrepancy (from a link in the Shopify inventory history).",
    "inventorySync.conflicts.showAll": "Show all discrepancies",
    "inventorySync.tabs.label": "Discrepancies by state",
    "inventorySync.tab.open": "Open",
    "inventorySync.tab.resolved": "Resolved",
    "inventorySync.tab.all": "All",
    "inventorySync.filters.search": "Product, SKU or barcode",
    "inventorySync.filters.searchPlaceholder": "E.g. OT-PH",
    "inventorySync.filters.model": "Model",
    "inventorySync.filters.allModels": "All models",
    "inventorySync.filters.color": "Colour",
    "inventorySync.filters.allColors": "All colours",

    "inventorySync.bulk.label": "Bulk actions on discrepancies",
    "inventorySync.bulk.hint": "Select discrepancies to accept the Shopify value for several products.",
    "inventorySync.bulk.title": "Accept the Shopify value for the selected?",
    "inventorySync.bulk.confirm": "Accept",
    "inventorySync.bulk.count": "Discrepancies: {count}; total on-hand change: {units} pcs.",
    "inventorySync.bulk.skipped": "Without reconciliation (will be skipped): {count}",
    "inventorySync.bulk.help": "Discrepancies whose warehouse stock changed after reconciliation are skipped and reconciled again.",
    "inventorySync.bulk.explained":
      "In {count} discrepancies part of the difference is orders held in Shopify — that part is not changed (not included in the total above).",
    "inventorySync.bulk.warning":
      "{count} discrepancies have failed sends or partially fulfilled/returned orders — check them individually before accepting.",
    "inventorySync.bulk.button": "Accept Shopify for selected",
    "inventorySync.bulk.select": "Select {title}",

    "inventorySync.why.openedWithHistory":
      "When accounting was started the warehouse already had internal changes — check they were not also entered in Shopify manually. Press “Reconcile”.",
    "inventorySync.why.needsReconcile": "A fresh reconciliation with Shopify is needed before choosing an action.",
    "inventorySync.why.committed": "Shopify holds {count} pcs for orders the app does not reserve (unpaid, drafts)",
    "inventorySync.why.failedPushes": "Failed sends: {count} (total {delta} pcs) — Shopify probably did not get them",
    "inventorySync.why.inFlight": "Handed to the carrier but not yet fulfilled in Shopify: {count} pcs",
    "inventorySync.why.otherStates": "{count} pcs are marked unavailable in Shopify (damaged, reserved, safety stock, quality control)",
    "inventorySync.why.uncertain": "There are partially fulfilled orders — check manually",
    "inventorySync.why.linesPending":
      "Shopify changed the items of an open order and the app has not applied the change yet (e.g. it has a waybill) — the reservation is out of date, check manually",
    "inventorySync.why.autoBlocked": "Not accepted automatically: on-hand stock would become negative",
    "inventorySync.why.unsent":
      "The warehouse has {count} change(s) Shopify did not receive (total {delta} pcs): sending is off, the permission is missing, changes before accounting was started, dismissed failed sends or customer returns that Shopify restocks itself. “Accept Shopify” cancels them. “Send warehouse” delivers everything except returns waiting for Shopify's restock",
    "inventorySync.why.reservationExcess":
      "The warehouse reserves {count} pcs more than Shopify holds: an order was edited/cancelled/fulfilled in Shopify but not yet in the app (see “Problems”)",
    "inventorySync.why.returnsPending":
      "{count} pcs were returned/refunded after shipping but the warehouse has not received them as sellable (the return has not arrived or the item is damaged) — Shopify may already have restocked them as available. If the return was already received and sent to Shopify with “Send warehouse”, Shopify counted it twice — choose “Send warehouse”",
    "inventorySync.why.returnsAwaiting":
      "The warehouse received {count} pcs of customer returns that Shopify still has to restock itself (no refund with restock in Shopify yet). The difference disappears once Shopify restocks them; “Send warehouse” does not send them",
    "inventorySync.why.pushPending":
      "The result of “Send warehouse” at {date} is not confirmed yet — retry “Send warehouse” (retrying is safe) or reconcile the product",
    "inventorySync.why.autoSkipped": "Not accepted automatically: something else may explain the difference (see above) — the owner decides",
    "inventorySync.why.external": "Stock was probably changed in Shopify manually or by another app",

    "inventorySync.conflictStatus.open": "Open",
    "inventorySync.conflictStatus.accepted_shopify": "Shopify accepted",
    "inventorySync.conflictStatus.pushed_app": "Warehouse sent",
    "inventorySync.conflictStatus.dismissed": "Closed",
    "inventorySync.resolution.accepted_shopify": "The owner accepted the Shopify value",
    "inventorySync.resolution.pushed_app": "The warehouse value was sent to Shopify",
    "inventorySync.resolution.dismissed": "Dismissed by the owner",
    "inventorySync.resolution.auto_resolved": "Closed by reconciliation: values match",
    "inventorySync.resolution.auto_applied": "Accepted automatically (setting)",

    "inventorySync.outcome.match": "Stock matches.",
    "inventorySync.outcome.explained": "The difference is explained by orders (held in Shopify or not yet updated in the warehouse) — no discrepancy.",
    "inventorySync.outcome.opened": "A discrepancy was found — it is in the list below.",
    "inventorySync.outcome.updated": "The discrepancy was updated with fresh data.",
    "inventorySync.outcome.auto_applied": "The Shopify value was accepted automatically.",
    "inventorySync.outcome.closed": "Values match — the discrepancy was closed.",
    "inventorySync.outcome.skipped_pending": "There are changes not yet sent to Shopify — reconciliation postponed.",
    "inventorySync.outcome.skipped_busy": "Stock changed during reconciliation — reconciliation postponed.",
    "inventorySync.outcome.not_stocked": "The product is not stocked at the selected Shopify location.",
    "inventorySync.outcome.untracked": "Shopify does not track stock for this product.",
    "inventorySync.outcome.missing": "The product was not found in Shopify.",
    "inventorySync.outcome.not_opened": "The product is not opened in warehouse accounting yet.",

    "inventorySync.result.accepted": "Shopify value accepted: on-hand stock changed by {diff} pcs.",
    "inventorySync.result.already": "This discrepancy is already resolved.",
    "inventorySync.result.stale": "Stock changed after reconciliation — the discrepancy was reconciled again. Check the new values.",
    "inventorySync.result.needs_reconcile": "The discrepancy was reconciled with Shopify. Check the values and choose an action.",
    "inventorySync.result.pushed": "Warehouse value sent to Shopify (change {delta} pcs).",
    "inventorySync.result.pushedHeld":
      "Warehouse value sent to Shopify (change {delta} pcs). {held} pcs were not sent — see the discrepancy after reconciliation.",
    "inventorySync.result.inProgress": "Shopify is still processing the previous request. Try again in a minute — retrying is safe.",
    "inventorySync.result.unknown": "Could not confirm Shopify's response. Try again — a retry will not change stock twice.",
    "inventorySync.result.push_pending":
      "The result of the previous “Send warehouse” is still unknown, so “Accept Shopify” is unavailable now (otherwise both changes would apply). Retry “Send warehouse” or press “Reconcile” in a few minutes.",
    "inventorySync.result.resolved_concurrently":
      "The warehouse value was sent to Shopify (change {delta} pcs), but the discrepancy was closed by another action meanwhile. Reconcile the product to check the values.",
    "inventorySync.result.dismissed": "Discrepancy dismissed.",
    "inventorySync.result.bulkAccepted":
      "Accepted: {accepted} (total {units} pcs). Reconciled again: {stale}. Already resolved: {already}. Waiting for “Send warehouse” result: {pending}. Errors: {failed}.",
    "inventorySync.result.reconciledItem": "Product reconciled with Shopify.",
    "inventorySync.result.reconcileQueued": "Full reconciliation queued. The result appears here in a few minutes.",
    "inventorySync.result.reconcileAlreadyQueued": "A full reconciliation is already queued.",
    "inventorySync.result.pushQueued": "Sending changes to Shopify is queued.",
    "inventorySync.result.pendingWillBeSkipped": "Pending changes will be marked “not sent” (sending is off or the permission is missing).",
    "inventorySync.result.locationSet": "Location “{name}” saved and confirmed.",
    "inventorySync.result.locationConfirmed": "Location confirmed.",

    "inventorySync.demoUnavailable": "Not available in the demo: there is no Shopify connection.",
    "inventorySync.conflictResolved": "The discrepancy was already resolved by another action. Refresh the page.",
    "inventorySync.missingWriteScope": "The write_inventory permission is missing — changing stock in Shopify is unavailable.",
    "inventorySync.missingReadScope": "The read_inventory permission is missing — reconciliation is unavailable.",
    "inventorySync.nothingSelected": "No discrepancy selected.",
    "inventorySync.tooMany": "Too many discrepancies at once (maximum {max}).",
    "inventorySync.noteRequired": "Enter a reason.",
    "inventorySync.noteTooLong": "The reason is too long (maximum {max} characters).",
    "inventorySync.locationInvalid": "This location is not among the store's active locations.",
    "inventorySync.locationMissing": "No location selected yet.",
    "inventorySync.reconcileUnavailable": "Reconciliation is not possible: no location, permission or link of the product to Shopify.",
    "inventorySync.pushFailed": "Shopify rejected the change ({code}). The discrepancy stays open.",
    "inventorySync.pushOtherStates":
      "Not sent: the whole difference is {count} pcs that Shopify keeps as “damaged”, “reserved”, “safety stock” or “quality control”. Damaged — record a defect in the warehouse; reserved, safety stock and quality control are changed in Shopify. Then reconcile the product.",
    "inventorySync.pushAwaitingReturns":
      "Not sent: {count} pcs are returns that Shopify restocks itself. If Shopify will not restock them, tick “Shopify will not restock these returns” and send again.",
  },
};

export default messages;
