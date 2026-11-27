import type { MessageModule } from "../types";

/** Сторінка «Налаштування»: автоматизація, відправник, упаковка, тестовий перевізник, інтеграції, демо-дані. */
const messages: MessageModule = {
  uk: {
    "settings.subtitle": "Автоматизація, дані відправника, упаковка та стан інтеграцій",
    "settings.version": "Версія {version}",
    "settings.ownerOnly": "Змінювати ці налаштування може лише власник.",

    // Помилки полів (повідомлення сервера перекладаються тут, а не показуються як є)
    "settings.error.invalid": "Некоректне значення. Перевірте формат і довжину.",
    "settings.error.email": "Введіть коректний email або залиште поле порожнім.",
    "settings.error.countryCode": "Вкажіть код країни з двох латинських літер, напр. UA.",
    "settings.error.defaultPackage": "Оберіть упаковку зі списку.",
    "settings.error.volumetricDivisor": "Введіть ціле число від 1000 до 10000.",
    "settings.error.packages": "Перелік упаковок некоректний. Повідомте розробника.",

    // 1. Автоматизація
    "settings.automation.title": "Автоматизація",
    "settings.automation.description": "Що система робить сама, коли надходить нове оплачене замовлення.",
    "settings.automation.mode": "Режим роботи",
    "settings.automation.mode.manual": "Ручний",
    "settings.automation.mode.semi": "Напівавтоматичний",
    "settings.automation.mode.auto": "Автоматичний",
    "settings.automation.modeHelp.manual": "Усі зовнішні дії підтверджує менеджер. Нічого не виконується автоматично.",
    "settings.automation.modeHelp.semi":
      "Нові оплачені замовлення автоматично проходять перевірку даних, однозначні помилки формату виправляються. Накладні створює менеджер.",
    "settings.automation.modeHelp.auto":
      "Як у напівавтоматичному режимі, а якщо проблем немає — накладна створюється автоматично.",
    "settings.automation.modesTitle": "Як працюють режими",
    "settings.automation.autoNote":
      "Автоматичне створення накладних працює лише з налаштованим перевізником. Якщо результат створення невідомий, замовлення передається на ручний розгляд, а його автоматизація призупиняється.",
    "settings.automation.globalPause": "Глобальна пауза автоматизації",
    "settings.automation.globalPauseHelp":
      "Зупиняє всі автоматичні дії незалежно від режиму. Ручні дії менеджера залишаються доступними.",
    "settings.automation.pausedBanner": "Автоматизацію призупинено: зараз система нічого не виконує автоматично.",

    // 2. Відправник
    "settings.shipper.title": "Відправник",
    "settings.shipper.description": "Ці дані підставляються в запити до перевізника під час створення накладних.",
    "settings.shipper.requiredNote":
      "Поля з позначкою «Потрібно для накладної» обов’язкові для створення накладної. Решту можна залишити порожніми.",
    "settings.shipper.requiredForWaybill": "Потрібно для накладної.",
    "settings.shipper.field.companyName": "Назва компанії",
    "settings.shipper.field.contactName": "Контактна особа",
    "settings.shipper.field.phone": "Телефон",
    "settings.shipper.field.email": "Email",
    "settings.shipper.field.countryCode": "Країна (код ISO)",
    "settings.shipper.field.city": "Місто",
    "settings.shipper.field.postalCode": "Поштовий індекс",
    "settings.shipper.field.address1": "Адреса",
    "settings.shipper.field.address2": "Адреса (рядок 2)",
    "settings.shipper.field.warehouseName": "Склад",
    "settings.shipper.field.carrierBranch": "Відділення/пункт прийому перевізника",
    "settings.shipper.help.phone": "У міжнародному форматі, напр. +380 67 123 4567.",
    "settings.shipper.help.countryCode": "Дві латинські літери, напр. UA.",
    "settings.shipper.help.carrierBranch":
      "Номер відділення Нової пошти, де ви передаєте посилки, напр. 32521/1. Передається перевізнику як відділення відправника.",
    "settings.shipper.missing.title": "Дані відправника неповні",
    "settings.shipper.missing.body": "Накладні не створюватимуться, доки не заповнено: {fields}.",
    "settings.shipper.complete": "Усі поля, потрібні для створення накладних, заповнено.",

    // 3. Упаковка
    "settings.packaging.title": "Упаковка",
    "settings.packaging.description": "Упаковка та дільник об’ємної ваги, за якими розраховується вага в накладних.",
    "settings.packaging.defaultPackage": "Упаковка за замовчуванням",
    "settings.packaging.defaultPackageHelp":
      "Використовується, якщо для замовлення не вибрано коробку: під час пакування коробку обирає працівник або застосунок підбирає її за габаритами й вагою (Склад → Пакувальні матеріали).",
    "settings.packaging.volumetricDivisor": "Дільник об’ємної ваги",
    "settings.packaging.volumetricDivisorHelp":
      "Об’ємна вага = Д × Ш × В (см) / дільник. Оплачувана вага — більша з фактичної та об’ємної.",
    "settings.packaging.divisorUnit": "см³/кг",
    "settings.packaging.packagesTitle": "Доступні упаковки",
    "settings.packaging.packagesReadOnly": "Перелік упаковок поки лише для перегляду.",
    "settings.packaging.col.name": "Упаковка",
    "settings.packaging.col.dimensions": "Розміри (Д × Ш × В)",
    "settings.packaging.col.tare": "Вага тари",
    "settings.packaging.dimensionsValue": "{length} × {width} × {height} см",
    "settings.packaging.isDefault": "За замовчуванням",

    // Склад (етап 5)
    "settings.warehouse.title": "Склад",
    "settings.warehouse.description":
      "Попередження про низькі залишки, параметри рекомендацій виробництва та обмін залишками з Shopify. Змінює лише власник.",
    "settings.warehouse.lowStockThreshold": "Поріг «мало на складі»",
    "settings.warehouse.lowStockThresholdHelp":
      "Попередження, коли доступно для продажу ≤ порогу. Діє для товарів і матеріалів без власного порогу; після збереження попередження переоцінюються.",
    "settings.warehouse.productionLeadDays": "Термін виробництва партії",
    "settings.warehouse.productionLeadDaysHelp": "Скільки днів зазвичай триває виробництво (для рекомендацій наступних партій).",
    "settings.warehouse.targetCoverDays": "Цільовий запас",
    "settings.warehouse.targetCoverDaysHelp": "На скільки днів продажів має вистачати товару після надходження партії.",
    "settings.warehouse.batchRounding": "Округлення кількості партії",
    "settings.warehouse.batchRoundingHelp": "Рекомендована кількість округлюється вгору до кратного цьому числу.",
    "settings.warehouse.unitDays": "дн.",
    "settings.warehouse.unitPieces": "шт.",
    "settings.warehouse.shopifyPush": "Передача змін складу в Shopify",
    "settings.warehouse.shopifyPush.off": "Не передавати (лише звірка)",
    "settings.warehouse.shopifyPush.deltas": "Передавати зміни (надходження, брак, коригування)",
    "settings.warehouse.shopifyPushHelp":
      "Перед увімкненням: «Склад → Звірка з Shopify» → «Звірити все» й розв'яжіть розбіжності. Потрібен дозвіл write_inventory. Зміни, зроблені до увімкнення, не надсилаються. Продажі Shopify рахує сам.",
    "settings.warehouse.pushOnBanner":
      "Передачу змін у Shopify увімкнено: надходження, брак і коригування змінюють «доступно» в Shopify.",
    "settings.warehouse.externalShopifyChanges": "Зміни залишку, зроблені в Shopify",
    "settings.warehouse.externalShopifyChanges.review": "Показувати як розбіжність (рішення власника)",
    "settings.warehouse.externalShopifyChanges.apply": "Приймати автоматично, якщо різниця однозначна",
    "settings.warehouse.externalShopifyChangesHelp":
      "Рекомендовано «Показувати як розбіжність». Автоматичне прийняття діє лише з передачею змін складу в Shopify і дозволом write_inventory, і лише коли різницю нічим іншим не пояснити (немає змін складу, яких Shopify не отримав, невдалих передач, замовлень і повернень, що ще синхронізуються, одиниць у станах «брак/резерв» Shopify).",
    "settings.warehouse.applyWithoutPushWarning":
      "Автоматичне прийняття не діятиме, поки передачу змін складу в Shopify вимкнено: Shopify не знає про надходження, брак і коригування складу, і прийняття його значення скасувало б їх. Усі різниці йтимуть на розгляд власника.",
    "settings.warehouse.allowNegativeOnHand": "Дозволити від'ємний фактичний залишок при прийнятті значення Shopify",
    "settings.warehouse.allowNegativeOnHandHelp":
      "Передача посилки перевізнику списує товар завжди (посилка вже фізично передана). Інші операції ніколи не роблять залишок від'ємним.",
    "settings.warehouse.savedWithAlerts": "Збережено. Попередження переоцінено: відкрито {opened}, закрито {resolved}.",
    "settings.warehouse.error.lowStockThreshold": "Ціле число від 0 до 100000.",
    "settings.warehouse.error.productionLeadDays": "Ціле число від 1 до 365.",
    "settings.warehouse.error.targetCoverDays": "Ціле число від 1 до 730.",
    "settings.warehouse.error.batchRounding": "Ціле число від 1 до 10000.",

    // 4. Тестовий перевізник (лише демо)
    "settings.testCarrier.title": "Тестовий перевізник",
    "settings.testCarrier.description":
      "Лише в демо. Імітує збої перевізника, щоб перевірити захист від дублікатів накладних. Накладні тестові — реальним перевізникам нічого не надсилається.",
    "settings.testCarrier.simulation": "Імітація збою",
    "settings.testCarrier.simulation.none": "Без збоїв",
    "settings.testCarrier.simulation.reject": "Перевізник відхиляє дані",
    "settings.testCarrier.simulation.unavailable": "Перевізник недоступний",
    "settings.testCarrier.simulation.fail_after_create": "Збій після створення накладної",
    "settings.testCarrier.simulation.timeout_before_create": "Тайм-аут до створення накладної",
    "settings.testCarrier.help.none": "Тестова накладна створюється звичайним способом.",
    "settings.testCarrier.help.reject":
      "Перевізник відхиляє запит — накладна не створюється. У розділі «Проблеми» з’являється помилка, замовлення потребує виправлення.",
    "settings.testCarrier.help.unavailable":
      "Запит не доходить до перевізника — накладна точно не створена. Система фіксує проблему, створення можна безпечно повторити.",
    "settings.testCarrier.help.fail_after_create":
      "Перевізник створює накладну, але відповідь втрачається. Система звіряє відправлення за reference, знаходить накладну й прив’язує її — дубліката не створюється.",
    "settings.testCarrier.help.timeout_before_create":
      "Відповідь не надходить, результат невідомий. Система звіряє відправлення за reference, переконується, що накладної немає, і позначає її як не створену — повтор безпечний.",
    "settings.testCarrier.scenariosTitle": "Що відбувається в кожному сценарії",
    "settings.testCarrier.activeWarning":
      "Увімкнено імітацію «{simulation}». Вона діє на всі наступні спроби створити тестову накладну, доки ви не оберете «Без збоїв».",
    "settings.testCarrier.manualReview":
      "Зі справжнім перевізником: якщо результат неможливо перевірити, відправлення передається на ручний розгляд, а автоматизація замовлення призупиняється.",

    // 5. Інтеграції
    "settings.integrations.title": "Інтеграції",
    "settings.integrations.description": "Фактичний стан підключень — без імітації.",
    "settings.integrations.secrets":
      "API-ключі ніколи не показуються в інтерфейсі: вони зберігаються лише у змінних середовища сервера.",
    "settings.integrations.status.connected": "Підключено",
    "settings.integrations.status.notConnected": "Не підключено",
    "settings.integrations.status.notConfigured": "Не налаштовано",
    "settings.integrations.status.default": "За замовчуванням",
    "settings.integrations.shopify": "Shopify",
    "settings.integrations.shopify.demo": "Не підключено — демо-режим. Замовлення вигадані, у Shopify нічого не надсилається.",
    "settings.integrations.shopify.production": "Вбудований застосунок у Shopify Admin. Синхронізація замовлень, товарів і залишків — сторінка «Синхронізація Shopify».",
    "settings.integrations.carrier.test":
      "Лише в демо: створює тестові накладні у вбудованій пісочниці. Реальним перевізникам нічого не надсилається.",
    "settings.integrations.carrier.notConfigured":
      "Не налаштовано: очікуємо офіційну документацію API та ключі (етап 3).",
    "settings.integrations.carrier.ready": "Підключено.",
    "settings.integrations.carrier.capabilities": "Можливості: {list}.",
    "settings.integrations.carrier.noCapabilities": "Можливості: поки жодної.",
    "settings.integrations.carrier.novaGlobalDemo":
      "У демо не використовується. Робоча інтеграція — після отримання офіційної документації API та ключів (етап 3).",
    "settings.integrations.carriers.none": "Перевізників не зареєстровано.",
    "settings.integrations.capability.rates": "розрахунок вартості",
    "settings.integrations.capability.availability": "перевірка доступності",
    "settings.integrations.capability.createShipment": "створення накладних",
    "settings.integrations.capability.updateShipment": "зміна накладних",
    "settings.integrations.capability.cancelShipment": "скасування накладних",
    "settings.integrations.capability.documents": "документи",
    "settings.integrations.capability.tracking": "відстеження",
    "settings.integrations.capability.returns": "повернення",
    "settings.integrations.capability.findByReference": "звірка за reference",
    "settings.integrations.assistant.planned": "Заплановано на етап 7. Ключ не налаштовано, запити до ШІ не надсилаються.",
    "settings.integrations.telegram": "Telegram",
    "settings.integrations.telegram.planned": "Сповіщення в Telegram — етап 8. Нічого не надсилається.",

    // 6. Особисті
    "settings.personal.title": "Особисті налаштування",
    "settings.personal.body":
      "Мову й тему змінюйте у верхній панелі (на телефоні — у меню, у Shopify Admin — унизу сторінки). Вони зберігаються лише у вашому браузері.",

    // 7. Демо-дані
    "settings.demo.title": "Демо-дані",
    "settings.demo.description": "Повертає демо до початкового стану. Реальні дані не зачіпаються.",
    "settings.demo.resetSettings": "Налаштування на цій сторінці також повернуться до демо-значень.",
    "settings.demo.confirm": "Скинути",
  },
  en: {
    "settings.subtitle": "Automation, sender details, packaging and integrations status",
    "settings.version": "Version {version}",
    "settings.ownerOnly": "Only the owner can change these settings.",

    "settings.error.invalid": "Invalid value. Check the format and length.",
    "settings.error.email": "Enter a valid email or leave the field empty.",
    "settings.error.countryCode": "Enter a two-letter country code, e.g. UA.",
    "settings.error.defaultPackage": "Choose a package from the list.",
    "settings.error.volumetricDivisor": "Enter a whole number from 1000 to 10000.",
    "settings.error.packages": "The package list is invalid. Tell the developer.",

    "settings.automation.title": "Automation",
    "settings.automation.description": "What the system does on its own when a new paid order arrives.",
    "settings.automation.mode": "Mode",
    "settings.automation.mode.manual": "Manual",
    "settings.automation.mode.semi": "Semi-automatic",
    "settings.automation.mode.auto": "Automatic",
    "settings.automation.modeHelp.manual": "A manager confirms every external action. Nothing runs automatically.",
    "settings.automation.modeHelp.semi":
      "New paid orders are checked automatically and unambiguous format errors are fixed. A manager creates waybills.",
    "settings.automation.modeHelp.auto": "Same as semi-automatic, and if there are no problems a waybill is created automatically.",
    "settings.automation.modesTitle": "How the modes work",
    "settings.automation.autoNote":
      "Automatic waybill creation works only with a configured carrier. If the creation outcome is unknown, the order goes to manual review and its automation is paused.",
    "settings.automation.globalPause": "Global automation pause",
    "settings.automation.globalPauseHelp":
      "Stops all automatic actions regardless of the mode. Manual actions by managers remain available.",
    "settings.automation.pausedBanner": "Automation is paused: the system does nothing automatically right now.",

    "settings.shipper.title": "Sender",
    "settings.shipper.description": "These details are used in carrier requests when waybills are created.",
    "settings.shipper.requiredNote":
      "Fields marked “Required for waybills” must be filled in to create a waybill. The rest can be left empty.",
    "settings.shipper.requiredForWaybill": "Required for waybills.",
    "settings.shipper.field.companyName": "Company name",
    "settings.shipper.field.contactName": "Contact person",
    "settings.shipper.field.phone": "Phone",
    "settings.shipper.field.email": "Email",
    "settings.shipper.field.countryCode": "Country (ISO code)",
    "settings.shipper.field.city": "City",
    "settings.shipper.field.postalCode": "Postal code",
    "settings.shipper.field.address1": "Address",
    "settings.shipper.field.address2": "Address line 2",
    "settings.shipper.field.warehouseName": "Warehouse",
    "settings.shipper.field.carrierBranch": "Carrier branch / drop-off point",
    "settings.shipper.help.phone": "In international format, e.g. +380 67 123 4567.",
    "settings.shipper.help.countryCode": "Two Latin letters, e.g. UA.",
    "settings.shipper.help.carrierBranch":
      "The Nova Post branch number where you hand over parcels, e.g. 32521/1. Sent to the carrier as the sender branch.",
    "settings.shipper.missing.title": "Sender details are incomplete",
    "settings.shipper.missing.body": "Waybills will not be created until these are filled in: {fields}.",
    "settings.shipper.complete": "All fields required for creating waybills are filled in.",

    "settings.packaging.title": "Packaging",
    "settings.packaging.description": "The package and volumetric divisor used to calculate waybill weights.",
    "settings.packaging.defaultPackage": "Default package",
    "settings.packaging.defaultPackageHelp":
      "Used when no box is chosen for the order: during packing the worker picks a box or the app selects one by dimensions and weight (Warehouse → Packaging materials).",
    "settings.packaging.volumetricDivisor": "Volumetric weight divisor",
    "settings.packaging.volumetricDivisorHelp":
      "Volumetric weight = L × W × H (cm) / divisor. Chargeable weight is the greater of actual and volumetric.",
    "settings.packaging.divisorUnit": "cm³/kg",
    "settings.packaging.packagesTitle": "Available packages",
    "settings.packaging.packagesReadOnly": "The package list is read-only for now.",
    "settings.packaging.col.name": "Package",
    "settings.packaging.col.dimensions": "Dimensions (L × W × H)",
    "settings.packaging.col.tare": "Tare weight",
    "settings.packaging.dimensionsValue": "{length} × {width} × {height} cm",
    "settings.packaging.isDefault": "Default",

    "settings.warehouse.title": "Warehouse",
    "settings.warehouse.description":
      "Low-stock warnings, production recommendation parameters and stock exchange with Shopify. Only the owner can change them.",
    "settings.warehouse.lowStockThreshold": "Low-stock threshold",
    "settings.warehouse.lowStockThresholdHelp":
      "Warns when available for sale ≤ threshold. Applies to products and materials without their own threshold; warnings are re-evaluated after saving.",
    "settings.warehouse.productionLeadDays": "Production lead time",
    "settings.warehouse.productionLeadDaysHelp": "How many days a batch usually takes to produce (for next-batch recommendations).",
    "settings.warehouse.targetCoverDays": "Target stock cover",
    "settings.warehouse.targetCoverDaysHelp": "How many days of sales the stock should cover after a batch arrives.",
    "settings.warehouse.batchRounding": "Batch quantity rounding",
    "settings.warehouse.batchRoundingHelp": "The recommended quantity is rounded up to a multiple of this number.",
    "settings.warehouse.unitDays": "days",
    "settings.warehouse.unitPieces": "pcs",
    "settings.warehouse.shopifyPush": "Send warehouse changes to Shopify",
    "settings.warehouse.shopifyPush.off": "Do not send (reconcile only)",
    "settings.warehouse.shopifyPush.deltas": "Send changes (receipts, defects, adjustments)",
    "settings.warehouse.shopifyPushHelp":
      "Before enabling: «Warehouse → Shopify reconciliation» → «Reconcile all» and resolve the differences. Requires the write_inventory permission. Changes made before enabling are not sent. Shopify counts sales itself.",
    "settings.warehouse.pushOnBanner":
      "Sending changes to Shopify is on: receipts, defects and adjustments change «available» in Shopify.",
    "settings.warehouse.externalShopifyChanges": "Stock changes made in Shopify",
    "settings.warehouse.externalShopifyChanges.review": "Show as a difference (owner decides)",
    "settings.warehouse.externalShopifyChanges.apply": "Accept automatically when the difference is unambiguous",
    "settings.warehouse.externalShopifyChangesHelp":
      "«Show as a difference» is recommended. Automatic acceptance works only while warehouse changes are sent to Shopify with the write_inventory permission, and only when nothing else explains the difference (no warehouse changes Shopify did not receive, no failed sends, no orders or returns still syncing, no units in Shopify «damaged/reserved» states).",
    "settings.warehouse.applyWithoutPushWarning":
      "Automatic acceptance will not work while sending warehouse changes to Shopify is off: Shopify does not know about warehouse receipts, defects and adjustments, and accepting its value would cancel them. Every difference goes to owner review.",
    "settings.warehouse.allowNegativeOnHand": "Allow negative on-hand stock when accepting a Shopify value",
    "settings.warehouse.allowNegativeOnHandHelp":
      "Handing a parcel to the carrier always writes the goods off (the parcel has physically left). Other operations never make stock negative.",
    "settings.warehouse.savedWithAlerts": "Saved. Warnings re-evaluated: {opened} opened, {resolved} resolved.",
    "settings.warehouse.error.lowStockThreshold": "A whole number from 0 to 100000.",
    "settings.warehouse.error.productionLeadDays": "A whole number from 1 to 365.",
    "settings.warehouse.error.targetCoverDays": "A whole number from 1 to 730.",
    "settings.warehouse.error.batchRounding": "A whole number from 1 to 10000.",

    "settings.testCarrier.title": "Test carrier",
    "settings.testCarrier.description":
      "Demo only. Simulates carrier failures to verify duplicate-waybill protection. Waybills are test-only — nothing is sent to real carriers.",
    "settings.testCarrier.simulation": "Failure simulation",
    "settings.testCarrier.simulation.none": "No failures",
    "settings.testCarrier.simulation.reject": "Carrier rejects the data",
    "settings.testCarrier.simulation.unavailable": "Carrier unavailable",
    "settings.testCarrier.simulation.fail_after_create": "Failure after the waybill is created",
    "settings.testCarrier.simulation.timeout_before_create": "Timeout before the waybill is created",
    "settings.testCarrier.help.none": "The test waybill is created normally.",
    "settings.testCarrier.help.reject":
      "The carrier rejects the request — no waybill is created. An error appears in “Problems” and the order needs correction.",
    "settings.testCarrier.help.unavailable":
      "The request never reaches the carrier — the waybill is definitely not created. The system records a problem; creation can be safely retried.",
    "settings.testCarrier.help.fail_after_create":
      "The carrier creates the waybill but the response is lost. The system reconciles the shipment by reference, finds the waybill and links it — no duplicate is created.",
    "settings.testCarrier.help.timeout_before_create":
      "No response arrives and the outcome is unknown. The system reconciles by reference, confirms that no waybill exists and marks it as not created — retrying is safe.",
    "settings.testCarrier.scenariosTitle": "What happens in each scenario",
    "settings.testCarrier.activeWarning":
      "Simulation “{simulation}” is on. It applies to every following attempt to create a test waybill until you choose “No failures”.",
    "settings.testCarrier.manualReview":
      "With a real carrier: if the outcome cannot be verified, the shipment goes to manual review and the order's automation is paused.",

    "settings.integrations.title": "Integrations",
    "settings.integrations.description": "Actual connection state — nothing simulated.",
    "settings.integrations.secrets":
      "API keys are never shown in the interface: they are stored only in the server's environment variables.",
    "settings.integrations.status.connected": "Connected",
    "settings.integrations.status.notConnected": "Not connected",
    "settings.integrations.status.notConfigured": "Not configured",
    "settings.integrations.status.default": "Default",
    "settings.integrations.shopify": "Shopify",
    "settings.integrations.shopify.demo": "Not connected — demo mode. Orders are fictional; nothing is sent to Shopify.",
    "settings.integrations.shopify.production": "Embedded app in Shopify Admin. Order, product and stock sync — see the “Shopify sync” page.",
    "settings.integrations.carrier.test":
      "Demo only: creates test waybills in a built-in sandbox. Nothing is sent to real carriers.",
    "settings.integrations.carrier.notConfigured": "Not configured: awaiting official API documentation and keys (stage 3).",
    "settings.integrations.carrier.ready": "Connected.",
    "settings.integrations.carrier.capabilities": "Capabilities: {list}.",
    "settings.integrations.carrier.noCapabilities": "Capabilities: none yet.",
    "settings.integrations.carrier.novaGlobalDemo":
      "Not used in the demo. The live integration follows once official API documentation and keys are received (stage 3).",
    "settings.integrations.carriers.none": "No carriers are registered.",
    "settings.integrations.capability.rates": "rate quotes",
    "settings.integrations.capability.availability": "availability check",
    "settings.integrations.capability.createShipment": "waybill creation",
    "settings.integrations.capability.updateShipment": "waybill updates",
    "settings.integrations.capability.cancelShipment": "waybill cancellation",
    "settings.integrations.capability.documents": "documents",
    "settings.integrations.capability.tracking": "tracking",
    "settings.integrations.capability.returns": "returns",
    "settings.integrations.capability.findByReference": "reconciliation by reference",
    "settings.integrations.assistant.planned": "Planned for stage 7. No key is configured; nothing is sent to AI.",
    "settings.integrations.telegram": "Telegram",
    "settings.integrations.telegram.planned": "Telegram notifications — stage 8. Nothing is sent.",

    "settings.personal.title": "Personal settings",
    "settings.personal.body":
      "Change the language and theme in the top bar (on a phone — in the menu, in Shopify Admin — at the bottom of the page). They are stored only in your browser.",

    "settings.demo.title": "Demo data",
    "settings.demo.description": "Returns the demo to its initial state. Real data is not affected.",
    "settings.demo.resetSettings": "The settings on this page will also return to their demo values.",
    "settings.demo.confirm": "Reset",
  },
};

export default messages;
