import type { MessageModule } from "../types";

/**
 * Повідомлення модуля перевірки даних замовлення.
 * Ключі: issue.<CODE>.title / issue.<CODE>.help, autofix.<ruleId>, field.<path>.
 * Параметри: {country}, {example}, {title}, {sku}, {max}, {phoneCountry}, {prefix}, {province}, {expected}.
 */
const messages: MessageModule = {
  uk: {
    // --- Контакт / телефон ---
    "issue.PHONE_MISSING.title": "Немає телефону одержувача",
    "issue.PHONE_MISSING.help":
      "Телефон не вказано ні в адресі доставки, ні в контактах замовлення, а перевізнику він потрібен для зв'язку з одержувачем. Уточніть номер у клієнта та внесіть його в поле «Телефон» у міжнародному форматі: + код країни і номер.",
    "issue.PHONE_INVALID.title": "Некоректний телефон",
    "issue.PHONE_INVALID.help":
      "Номер містить недопустимі символи або не відповідає жодному плану нумерації. Система не вгадує цифри. Уточніть номер у клієнта та введіть його в міжнародному форматі: + код країни і номер.",
    "issue.PHONE_AMBIGUOUS.title": "Телефон можна прочитати по-різному",
    "issue.PHONE_AMBIGUOUS.help":
      "Цифри номера підходять до кількох варіантів: як місцевий номер країни доставки і як номер з кодом іншої країни. Виберіть правильний варіант із запропонованих або уточніть номер у клієнта.",
    "issue.PHONE_NOT_MOBILE.title": "Стаціонарний телефон",
    "issue.PHONE_NOT_MOBILE.help":
      "Номер одержувача — стаціонарний, тож SMS-сповіщення від перевізника не дійдуть, а кур'єр може не додзвонитися. Попросіть у клієнта мобільний номер; якщо його немає — відхиліть попередження.",
    "issue.PHONE_COUNTRY_MISMATCH.title": "Телефон іншої країни",
    "issue.PHONE_COUNTRY_MISMATCH.help":
      "Номер належить країні {phoneCountry}, а доставка — у {country}. Для адресної доставки перевізники (напр. Nova Post) потребують мобільний номер країни одержувача. Уточніть місцевий номер у клієнта або відхиліть попередження, якщо номер правильний.",
    "issue.EMAIL_INVALID.title": "Некоректний email",
    "issue.EMAIL_INVALID.help":
      "Адреса електронної пошти має неправильний формат. Відправлення це не блокує, але клієнт може не отримати сповіщень від перевізника. Виправте адресу або уточніть її в клієнта.",
    "issue.EMAIL_MISSING.title": "Немає email одержувача",
    "issue.EMAIL_MISSING.help":
      "Для міжнародного відправлення перевізник і митниця використовують email одержувача для сповіщень і митних запитів. Попросіть email у клієнта та додайте його до замовлення.",

    // --- Адреса ---
    "issue.NAME_MISSING.title": "Немає імені одержувача",
    "issue.NAME_MISSING.help":
      "В адресі доставки не вказано ні ім'я, ні прізвище, а без одержувача перевізник посилку не прийме. Додайте ім'я та прізвище одержувача.",
    "issue.NAME_INCOMPLETE.title": "Неповне ім'я одержувача",
    "issue.NAME_INCOMPLETE.help":
      "Вказано лише ім'я або лише прізвище, а перевізнику потрібне повне ім'я одержувача. Додайте відсутню частину; якщо ім'я й прізвище записано в одне поле — розділіть їх.",
    "issue.ADDRESS_MISSING.title": "Немає адреси",
    "issue.ADDRESS_MISSING.help":
      "Не заповнено рядок адреси (вулиця, будинок). Додайте адресу доставки; за потреби уточніть її в клієнта.",
    "issue.ADDRESS_LINE1_EMPTY_LINE2_FILLED.title": "Адресу записано в другий рядок",
    "issue.ADDRESS_LINE1_EMPTY_LINE2_FILLED.help":
      "Перший рядок адреси порожній, а адресу вказано в другому рядку. Перевізник бере вулицю й будинок з першого рядка. Підтвердьте перенесення адреси в перший рядок і перевірте, щоб другий рядок не повторював перший.",
    "issue.ADDRESS_NO_HOUSE_NUMBER.title": "Немає номера будинку",
    "issue.ADDRESS_NO_HOUSE_NUMBER.help":
      "В адресі немає жодної цифри, тож, імовірно, не вказано номер будинку чи квартири. Уточніть номер у клієнта; якщо адреса без номера правильна (напр. назва будівлі) — відхиліть попередження.",
    "issue.ADDRESS_FIELD_TOO_LONG.title": "Задовге поле адреси",
    "issue.ADDRESS_FIELD_TOO_LONG.help":
      "Поле довше за {max} символів — перевізник не прийме таку накладну. Скоротіть текст або перенесіть частину адреси в інший рядок.",
    "issue.ADDRESS_DUPLICATED_FIELDS.title": "Поля адреси повторюються",
    "issue.ADDRESS_DUPLICATED_FIELDS.help":
      "Це поле дублює перший рядок адреси (напр. місто записано замість вулиці або другий рядок повторює перший). Перевірте адресу та виправте або очистьте зайве поле.",
    "issue.CITY_MISSING.title": "Немає міста",
    "issue.CITY_MISSING.help": "Не вказано місто доставки. Додайте місто з адреси клієнта.",
    "issue.CITY_CONTAINS_POSTAL_CODE.title": "Індекс у полі «Місто»",
    "issue.CITY_CONTAINS_POSTAL_CODE.help":
      "У назві міста є поштовий індекс. Підтвердьте запропоновану назву міста без індексу. Якщо запропонованого варіанта немає, індекс у місті відрізняється від поля «Індекс» — з'ясуйте правильний індекс у клієнта.",
    "issue.COUNTRY_MISSING.title": "Немає країни",
    "issue.COUNTRY_MISSING.help":
      "Не вказано країну доставки, тому неможливо перевірити індекс і правила доставки. Вкажіть дволітерний код країни ISO 3166-1, напр. DE.",
    "issue.COUNTRY_UNSUPPORTED.title": "Країна не налаштована",
    "issue.COUNTRY_UNSUPPORTED.help":
      "Для країни {country} немає правил доставки. Перевірте код країни в адресі; якщо він правильний — додайте правило для цієї країни в налаштуваннях.",
    "issue.COUNTRY_SHIPPING_DISABLED.title": "Доставку в країну вимкнено",
    "issue.COUNTRY_SHIPPING_DISABLED.help":
      "Доставку до країни {country} вимкнено в правилах країн, тому накладну створити не можна. Узгодьте з клієнтом іншу адресу доставки або скасуйте замовлення.",
    "issue.POSTAL_CODE_MISSING.title": "Немає поштового індексу",
    "issue.POSTAL_CODE_MISSING.help":
      "Для цієї країни поштовий індекс обов'язковий. Якщо індекс знайдено в полі «Місто», його запропоновано — перевірте й підтвердьте. Інакше уточніть індекс у клієнта та внесіть його у форматі {example}. Пошук індексу в адресних довідниках заплановано на наступних етапах.",
    "issue.POSTAL_CODE_INVALID.title": "Неправильний формат індексу",
    "issue.POSTAL_CODE_INVALID.help":
      "Індекс не відповідає формату країни доставки (приклад: {example}). Перевірте індекс і країну в адресі та виправте помилку — цифри й літери індексу система автоматично не змінює.",
    "issue.POSTAL_CODE_REGION_MISMATCH.title": "Індекс не відповідає регіону",
    "issue.POSTAL_CODE_REGION_MISMATCH.help":
      "Індекс, що починається з «{prefix}», належить регіонам {expected}, а вказано регіон {province}. Помилка може бути в індексі або в регіоні — уточніть адресу в клієнта та виправте потрібне поле.",
    "issue.PROVINCE_MISSING.title": "Немає регіону",
    "issue.PROVINCE_MISSING.help":
      "Для цієї країни потрібно вказати штат, провінцію або регіон. Додайте регіон з адреси клієнта (напр. код штату).",
    "issue.PROVINCE_INVALID.title": "Невідомий регіон",
    "issue.PROVINCE_INVALID.help":
      "Значення в полі «Регіон / штат» не є кодом регіону країни {country}. Якщо запропоновано код — перевірте й підтвердьте його; інакше введіть код регіону (напр. NY, ON, NSW).",

    // --- Товари / митниця ---
    "issue.ORDER_NO_ITEMS.title": "Немає товарів",
    "issue.ORDER_NO_ITEMS.help": "У замовленні немає жодної позиції, тож відправляти нічого. Перевірте замовлення в Shopify.",
    "issue.PRODUCT_NOT_LINKED.title": "Товар не пов'язано",
    "issue.PRODUCT_NOT_LINKED.help":
      "Позицію «{title}» не пов'язано з варіантом товару, тому немає ваги й митних даних. Пов'яжіть позицію з варіантом товару або перевірте, чи товар не видалено в Shopify.",
    "issue.PRODUCT_WEIGHT_MISSING.title": "Немає ваги товару",
    "issue.PRODUCT_WEIGHT_MISSING.help":
      "Для товару «{title}» (SKU {sku}) не вказано вагу, а без неї не розрахувати вагу посилки. Внесіть вагу варіанта в грамах у картці товару.",
    "issue.PRODUCT_HS_CODE_MISSING.title": "Немає митного коду (HS)",
    "issue.PRODUCT_HS_CODE_MISSING.help":
      "Для товару «{title}» (SKU {sku}) не вказано HS-код, потрібний для митної декларації. Додайте HS-код (6–10 цифр) у картці товару.",
    "issue.PRODUCT_HS_CODE_INVALID.title": "Некоректний HS-код",
    "issue.PRODUCT_HS_CODE_INVALID.help":
      "HS-код товару «{title}» (SKU {sku}) має містити від 6 до 10 цифр (крапки й пробіли допускаються). Перевірте код за митним класифікатором і виправте його в картці товару.",
    "issue.PRODUCT_ORIGIN_MISSING.title": "Немає країни походження",
    "issue.PRODUCT_ORIGIN_MISSING.help":
      "Для товару «{title}» (SKU {sku}) не вказано країну походження — дволітерний код ISO, напр. UA. Вона потрібна для митної декларації. Додайте її в картці товару.",
    "issue.PRODUCT_CUSTOMS_DESCRIPTION_MISSING.title": "Немає митного опису",
    "issue.PRODUCT_CUSTOMS_DESCRIPTION_MISSING.help":
      "Для товару «{title}» (SKU {sku}) не заповнено опис для митниці. Додайте короткий зрозумілий опис англійською: що це і з чого зроблено, напр. «Cotton T-shirt».",
    "issue.PRODUCT_PRICE_INVALID.title": "Некоректна ціна",
    "issue.PRODUCT_PRICE_INVALID.help":
      "Ціна позиції «{title}» відсутня, некоректна або дорівнює нулю, а митна вартість має бути більшою за нуль. Перевірте ціну в замовленні Shopify.",

    // --- Перевізник ---
    "issue.CARRIER_REJECTED.title": "Перевізник відхилив дані",
    "issue.CARRIER_REJECTED.help":
      "Перевізник відхилив запит через помилки в даних, накладну не створено. Виправте дані згідно з повідомленням перевізника та повторіть створення накладної.",
    "issue.CARRIER_RESULT_UNKNOWN.title": "Результат створення невідомий",
    "issue.CARRIER_RESULT_UNKNOWN.help":
      "Невідомо, чи створив перевізник накладну: зв'язок обірвався до отримання відповіді. Система перевірила відправлення за нашим референсом або не змогла цього перевірити, тому повторне створення заблоковано, щоб уникнути дубліката. Перевірте в кабінеті перевізника: якщо накладна існує — прив'яжіть її номер до замовлення, якщо ні — підтвердьте, що її не створено.",
    "issue.CARRIER_CANCEL_UNKNOWN.title": "Невідомо, чи скасовано накладну",
    "issue.CARRIER_CANCEL_UNKNOWN.help":
      "{carrier} не відповів на запит скасування накладної {waybill} (тайм-аут або збій зв’язку), тому невідомо, чи її скасовано. У застосунку накладна лишається активною. Перевірте в кабінеті перевізника: якщо накладну НЕ скасовано — нею можна користуватися або повторити скасування; якщо скасовано — повторіть скасування в застосунку (або створіть нову накладну). Після перевірки закрийте цю проблему.",
    "issue.CARRIER_CANCEL_CONFLICT.title": "Накладну скасовано, а посилку вже передано",
    "issue.CARRIER_CANCEL_CONFLICT.help":
      "{carrier} СКАСУВАВ накладну {waybill}, але під час скасування посилку позначено переданою перевізнику. Накладна в застосунку лишається активною, проте її номер у перевізника більше не діє. Терміново зв’яжіться з перевізником і з’ясуйте долю посилки; після вирішення закрийте цю проблему.",
    "issue.SHOPIFY_FULFILLMENT_FAILED.title": "Трек-номер не передано в Shopify",
    "issue.SHOPIFY_FULFILLMENT_FAILED.help":
      "Посилку передано перевізнику, але виконання з трек-номером у Shopify не створено після кількох спроб ({message}). Перевірте дозволи застосунку (write_merchant_managed_fulfillment_orders) і повторіть на сторінці «Синхронізація Shopify».",
    "issue.DELIVERY_PROBLEM.title": "Проблема з доставкою",
    "issue.DELIVERY_PROBLEM.help":
      "{carrier} повідомляє: «{status}» (код {code}). Перевірте відправлення в кабінеті перевізника та за потреби зв’яжіться з клієнтом.",
    "issue.CARRIER_SHIPMENT_DELETED.title": "Накладну видалено у перевізника",
    "issue.CARRIER_SHIPMENT_DELETED.help":
      "За даними відстеження {carrier} накладну {waybill} видалено, хоча в застосунку вона активна. Перевірте в кабінеті перевізника; якщо накладну справді видалено — скасуйте її в застосунку та створіть нову.",
    "issue.SHOPIFY_COUNTRY_NOT_SHIPPED.title": "Країни немає в зонах доставки Shopify",
    "issue.SHOPIFY_COUNTRY_NOT_SHIPPED.help":
      "Shopify приймає адресу замовлення лише для країн із зон доставки магазину; для {country} її немає (зараз: {shipsTo}). Активний ринок (Markets) сам цього не додає. Додайте {country} до зони доставки: Shopify → Налаштування → Доставка → профіль доставки → зона, потім збережіть адресу ще раз.",
    "issue.SHOPIFY_ORDER_CHANGED.title": "Дані замовлення змінено в Shopify",
    "issue.SHOPIFY_ORDER_CHANGED.help":
      "У Shopify змінено поля ({fields}), але локально замовлення вже не можна змінювати автоматично (накладна в роботі або є неперенесені підтверджені зміни). Перевірте, які дані правильні, і за потреби скасуйте накладну та виправте дані.",
    "issue.SHOPIFY_SYNC_FAILED.title": "Не вдалося оновити замовлення в Shopify",
    "issue.SHOPIFY_SYNC_FAILED.help":
      "Підтверджені зміни контактів/адреси не передано в Shopify після кількох спроб ({message}). Перевірте дані та повторіть на сторінці «Синхронізація Shopify».",
    "issue.SHOPIFY_CANCELLED_AFTER_SHIPMENT.title": "Замовлення скасовано в Shopify після відправлення",
    "issue.SHOPIFY_CANCELLED_AFTER_SHIPMENT.help":
      "Shopify повідомив про скасування, але автоматично скасувати неможливо ({reason}). Зв’яжіться з перевізником щодо повернення або вирішіть ситуацію з накладною вручну.",
    "issue.CARRIER_UNAVAILABLE.title": "Перевізник недоступний",
    "issue.CARRIER_UNAVAILABLE.help":
      "API перевізника не відповідає. Накладну не створено, нічого не змінено. Повторіть спробу пізніше.",

    // --- Автовиправлення ---
    "autofix.text.trim_whitespace": "Прибрано зайві пробіли",
    "autofix.country.uppercase": "Код країни записано великими літерами",
    "autofix.province.uppercase": "Код регіону записано великими літерами",
    "autofix.phone.normalize_format": "Прибрано форматування телефону (пробіли, дужки, дефіси)",
    "autofix.phone.international_prefix_00": "Префікс 00 замінено на +",
    "autofix.phone.add_plus": "Додано + перед кодом країни",
    "autofix.phone.national_to_international": "Місцевий номер переведено в міжнародний формат за країною доставки",
    "autofix.phone.copy_contact_phone": "Телефон скопійовано з контактів замовлення",
    "autofix.postal.normalize_format": "Індекс записано у стандартному форматі країни",

    // --- Назви полів ---
    "field.shipping.firstName": "Ім'я",
    "field.shipping.lastName": "Прізвище",
    "field.shipping.company": "Компанія",
    "field.shipping.address1": "Адреса",
    "field.shipping.address2": "Адреса (рядок 2)",
    "field.shipping.city": "Місто",
    "field.shipping.province": "Регіон / штат",
    "field.shipping.postalCode": "Поштовий індекс",
    "field.shipping.countryCode": "Країна",
    "field.shipping.phone": "Телефон одержувача",
    "field.email": "Email",
    "field.contactPhone": "Контактний телефон",
    "field.variant.weightGrams": "Вага, г",
    "field.variant.hsCode": "HS-код",
    "field.variant.countryOfOrigin": "Країна походження",
    "field.variant.customsDescription": "Митний опис",
    "field.lineItem": "Позиція замовлення",
    "field.order": "Замовлення",
  },
  en: {
    // --- Contact / phone ---
    "issue.PHONE_MISSING.title": "Recipient phone missing",
    "issue.PHONE_MISSING.help":
      "No phone number in the shipping address or the order contacts, and the carrier needs one to reach the recipient. Ask the customer for a number and enter it in the Phone field in international format: + country code and number.",
    "issue.PHONE_INVALID.title": "Invalid phone number",
    "issue.PHONE_INVALID.help":
      "The number contains invalid characters or matches no numbering plan. The system never guesses digits. Confirm the number with the customer and enter it in international format: + country code and number.",
    "issue.PHONE_AMBIGUOUS.title": "Phone number is ambiguous",
    "issue.PHONE_AMBIGUOUS.help":
      "The digits fit more than one reading: a local number of the shipping country and a number with another country code. Choose the correct option from the suggestions or confirm the number with the customer.",
    "issue.PHONE_NOT_MOBILE.title": "Landline phone number",
    "issue.PHONE_NOT_MOBILE.help":
      "The recipient's number is a landline, so carrier SMS notifications will not arrive and the courier may not get through. Ask the customer for a mobile number; if there is none, dismiss the warning.",
    "issue.PHONE_COUNTRY_MISMATCH.title": "Phone from another country",
    "issue.PHONE_COUNTRY_MISMATCH.help":
      "The number belongs to {phoneCountry}, but the parcel goes to {country}. For address delivery, carriers (e.g. Nova Post) need a mobile number of the recipient's country. Ask the customer for a local number or dismiss the warning if the number is correct.",
    "issue.EMAIL_INVALID.title": "Invalid email",
    "issue.EMAIL_INVALID.help":
      "The email address is malformed. This does not block shipping, but the customer may not receive carrier notifications. Fix the address or confirm it with the customer.",
    "issue.EMAIL_MISSING.title": "Recipient email missing",
    "issue.EMAIL_MISSING.help":
      "For an international shipment, the carrier and customs use the recipient's email for notifications and customs queries. Ask the customer for an email address and add it to the order.",

    // --- Address ---
    "issue.NAME_MISSING.title": "Recipient name missing",
    "issue.NAME_MISSING.help":
      "The shipping address has neither a first name nor a last name, and the carrier will not accept a parcel without a recipient. Add the recipient's first and last name.",
    "issue.NAME_INCOMPLETE.title": "Recipient name incomplete",
    "issue.NAME_INCOMPLETE.help":
      "Only the first name or only the last name is given, but the carrier needs the recipient's full name. Add the missing part; if both are written in one field, split them.",
    "issue.ADDRESS_MISSING.title": "Address missing",
    "issue.ADDRESS_MISSING.help":
      "The address line (street, house number) is empty. Add the shipping address; confirm it with the customer if needed.",
    "issue.ADDRESS_LINE1_EMPTY_LINE2_FILLED.title": "Address is in line 2",
    "issue.ADDRESS_LINE1_EMPTY_LINE2_FILLED.help":
      "Address line 1 is empty while the address is in line 2. The carrier takes the street and house number from line 1. Confirm moving the address to line 1 and make sure line 2 does not repeat line 1.",
    "issue.ADDRESS_NO_HOUSE_NUMBER.title": "No house number",
    "issue.ADDRESS_NO_HOUSE_NUMBER.help":
      "The address contains no digits, so the house or apartment number is probably missing. Confirm the number with the customer; if the address is correct without a number (e.g. a building name), dismiss the warning.",
    "issue.ADDRESS_FIELD_TOO_LONG.title": "Address field too long",
    "issue.ADDRESS_FIELD_TOO_LONG.help":
      "The field is longer than {max} characters, and the carrier will not accept such a waybill. Shorten the text or move part of the address to another line.",
    "issue.ADDRESS_DUPLICATED_FIELDS.title": "Address fields repeat",
    "issue.ADDRESS_DUPLICATED_FIELDS.help":
      "This field duplicates address line 1 (e.g. the city was entered instead of the street, or line 2 repeats line 1). Check the address and correct or clear the extra field.",
    "issue.CITY_MISSING.title": "City missing",
    "issue.CITY_MISSING.help": "The shipping city is empty. Add the city from the customer's address.",
    "issue.CITY_CONTAINS_POSTAL_CODE.title": "Postal code in the City field",
    "issue.CITY_CONTAINS_POSTAL_CODE.help":
      "The city name contains a postal code. Confirm the suggested city name without the code. If no suggestion is offered, the code in the city differs from the Postal code field — confirm the correct postal code with the customer.",
    "issue.COUNTRY_MISSING.title": "Country missing",
    "issue.COUNTRY_MISSING.help":
      "The shipping country is empty, so the postal code and shipping rules cannot be checked. Enter the two-letter ISO 3166-1 country code, e.g. DE.",
    "issue.COUNTRY_UNSUPPORTED.title": "Country not configured",
    "issue.COUNTRY_UNSUPPORTED.help":
      "There are no shipping rules for {country}. Check the country code in the address; if it is correct, add a rule for this country in Settings.",
    "issue.COUNTRY_SHIPPING_DISABLED.title": "Shipping to country disabled",
    "issue.COUNTRY_SHIPPING_DISABLED.help":
      "Shipping to {country} is disabled in the country rules, so no waybill can be created. Agree on a different shipping address with the customer or cancel the order.",
    "issue.POSTAL_CODE_MISSING.title": "Postal code missing",
    "issue.POSTAL_CODE_MISSING.help":
      "A postal code is required for this country. If a postal code was found in the City field, it is suggested — check and confirm it. Otherwise ask the customer for it and enter it in the format {example}. Postal code lookup in address directories is planned for a later stage.",
    "issue.POSTAL_CODE_INVALID.title": "Invalid postal code format",
    "issue.POSTAL_CODE_INVALID.help":
      "The postal code does not match the shipping country's format (example: {example}). Check the postal code and the country in the address and correct the mistake — the system never changes postal code digits or letters automatically.",
    "issue.POSTAL_CODE_REGION_MISMATCH.title": "Postal code does not match the region",
    "issue.POSTAL_CODE_REGION_MISMATCH.help":
      "A postal code starting with “{prefix}” belongs to {expected}, but the region is {province}. Either the postal code or the region is wrong — confirm the address with the customer and fix the right field.",
    "issue.PROVINCE_MISSING.title": "Region missing",
    "issue.PROVINCE_MISSING.help":
      "This country requires a state, province or region. Add the region from the customer's address (e.g. the state code).",
    "issue.PROVINCE_INVALID.title": "Unknown region",
    "issue.PROVINCE_INVALID.help":
      "The Region / state value is not a region code of {country}. If a code is suggested, check and confirm it; otherwise enter the region code (e.g. NY, ON, NSW).",

    // --- Products / customs ---
    "issue.ORDER_NO_ITEMS.title": "No items",
    "issue.ORDER_NO_ITEMS.help": "The order has no line items, so there is nothing to ship. Check the order in Shopify.",
    "issue.PRODUCT_NOT_LINKED.title": "Product not linked",
    "issue.PRODUCT_NOT_LINKED.help":
      "Line item “{title}” is not linked to a product variant, so there is no weight or customs data. Link the line item to a product variant or check whether the product was deleted in Shopify.",
    "issue.PRODUCT_WEIGHT_MISSING.title": "Product weight missing",
    "issue.PRODUCT_WEIGHT_MISSING.help":
      "Product “{title}” (SKU {sku}) has no weight, so the parcel weight cannot be calculated. Enter the variant weight in grams on the product page.",
    "issue.PRODUCT_HS_CODE_MISSING.title": "HS code missing",
    "issue.PRODUCT_HS_CODE_MISSING.help":
      "Product “{title}” (SKU {sku}) has no HS code, which the customs declaration requires. Add the HS code (6–10 digits) on the product page.",
    "issue.PRODUCT_HS_CODE_INVALID.title": "Invalid HS code",
    "issue.PRODUCT_HS_CODE_INVALID.help":
      "The HS code of product “{title}” (SKU {sku}) must have 6 to 10 digits (dots and spaces are allowed). Check the code against the customs tariff and fix it on the product page.",
    "issue.PRODUCT_ORIGIN_MISSING.title": "Country of origin missing",
    "issue.PRODUCT_ORIGIN_MISSING.help":
      "Product “{title}” (SKU {sku}) has no country of origin (two-letter ISO code, e.g. UA), which the customs declaration requires. Add it on the product page.",
    "issue.PRODUCT_CUSTOMS_DESCRIPTION_MISSING.title": "Customs description missing",
    "issue.PRODUCT_CUSTOMS_DESCRIPTION_MISSING.help":
      "Product “{title}” (SKU {sku}) has no customs description. Add a short, clear description in English — what it is and what it is made of, e.g. “Cotton T-shirt”.",
    "issue.PRODUCT_PRICE_INVALID.title": "Invalid price",
    "issue.PRODUCT_PRICE_INVALID.help":
      "The price of line item “{title}” is missing, invalid or zero, but the customs value must be greater than zero. Check the price in the Shopify order.",

    // --- Carrier ---
    "issue.CARRIER_REJECTED.title": "Carrier rejected the data",
    "issue.CARRIER_REJECTED.help":
      "The carrier rejected the request because of data errors; no waybill was created. Fix the data according to the carrier's message and create the waybill again.",
    "issue.CARRIER_RESULT_UNKNOWN.title": "Creation result unknown",
    "issue.CARRIER_RESULT_UNKNOWN.help":
      "It is unknown whether the carrier created the waybill: the connection dropped before a response arrived. The system checked for the shipment by our reference or could not check, so re-creation is blocked to avoid a duplicate. Check the carrier's portal: if the waybill exists, link its number to the order; if not, confirm that it was not created.",
    "issue.CARRIER_CANCEL_UNKNOWN.title": "Unknown whether the waybill was cancelled",
    "issue.CARRIER_CANCEL_UNKNOWN.help":
      "{carrier} did not answer the cancellation request for waybill {waybill} (timeout or connection failure), so it is unknown whether it was cancelled. The waybill stays active in the app. Check the carrier portal: if the waybill was NOT cancelled, it can still be used or the cancellation retried; if it was cancelled, retry the cancellation in the app (or create a new waybill). Close this problem after checking.",
    "issue.CARRIER_CANCEL_CONFLICT.title": "Waybill cancelled, but the parcel is already handed over",
    "issue.CARRIER_CANCEL_CONFLICT.help":
      "{carrier} CANCELLED waybill {waybill}, but during the cancellation the parcel was marked as handed to the carrier. The waybill stays active in the app, but its number is no longer valid at the carrier. Contact the carrier urgently to clarify what happens to the parcel; close this problem once resolved.",
    "issue.SHOPIFY_FULFILLMENT_FAILED.title": "Tracking number not sent to Shopify",
    "issue.SHOPIFY_FULFILLMENT_FAILED.help":
      "The parcel was handed to the carrier, but a Shopify fulfillment with the tracking number was not created after several attempts ({message}). Check the app permissions (write_merchant_managed_fulfillment_orders) and retry on the “Shopify sync” page.",
    "issue.DELIVERY_PROBLEM.title": "Delivery problem",
    "issue.DELIVERY_PROBLEM.help":
      "{carrier} reports: “{status}” (code {code}). Check the shipment in the carrier portal and contact the customer if needed.",
    "issue.CARRIER_SHIPMENT_DELETED.title": "Waybill deleted at the carrier",
    "issue.CARRIER_SHIPMENT_DELETED.help":
      "According to {carrier} tracking, waybill {waybill} was deleted although it is active in the app. Check the carrier portal; if it was really deleted, cancel it in the app and create a new one.",
    "issue.SHOPIFY_COUNTRY_NOT_SHIPPED.title": "Country is not in Shopify shipping zones",
    "issue.SHOPIFY_COUNTRY_NOT_SHIPPED.help":
      "Shopify accepts an order address only for countries in the store’s shipping zones; {country} is not there (currently: {shipsTo}). An active market (Markets) does not add it by itself. Add {country} to a shipping zone: Shopify → Settings → Shipping and delivery → shipping profile → zone, then save the address again.",
    "issue.SHOPIFY_ORDER_CHANGED.title": "Order data changed in Shopify",
    "issue.SHOPIFY_ORDER_CHANGED.help":
      "Fields ({fields}) changed in Shopify, but the order can no longer be updated automatically (a waybill is in progress or confirmed local changes are not yet synced). Check which data is correct and, if needed, cancel the waybill and correct the data.",
    "issue.SHOPIFY_SYNC_FAILED.title": "Could not update the order in Shopify",
    "issue.SHOPIFY_SYNC_FAILED.help":
      "Confirmed contact/address changes were not sent to Shopify after several attempts ({message}). Check the data and retry on the “Shopify sync” page.",
    "issue.SHOPIFY_CANCELLED_AFTER_SHIPMENT.title": "Order cancelled in Shopify after shipment",
    "issue.SHOPIFY_CANCELLED_AFTER_SHIPMENT.help":
      "Shopify reported a cancellation, but it cannot be applied automatically ({reason}). Contact the carrier about a return or resolve the waybill situation manually.",
    "issue.CARRIER_UNAVAILABLE.title": "Carrier unavailable",
    "issue.CARRIER_UNAVAILABLE.help":
      "The carrier API is not responding. No waybill was created and nothing was changed. Try again later.",

    // --- Auto-fixes ---
    "autofix.text.trim_whitespace": "Removed extra spaces",
    "autofix.country.uppercase": "Country code converted to upper case",
    "autofix.province.uppercase": "Region code converted to upper case",
    "autofix.phone.normalize_format": "Removed phone formatting (spaces, brackets, dashes)",
    "autofix.phone.international_prefix_00": "Replaced 00 prefix with +",
    "autofix.phone.add_plus": "Added + before the country code",
    "autofix.phone.national_to_international": "Converted local number to international format using the shipping country",
    "autofix.phone.copy_contact_phone": "Copied phone from order contacts",
    "autofix.postal.normalize_format": "Postal code written in the country's standard format",

    // --- Field labels ---
    "field.shipping.firstName": "First name",
    "field.shipping.lastName": "Last name",
    "field.shipping.company": "Company",
    "field.shipping.address1": "Address",
    "field.shipping.address2": "Address line 2",
    "field.shipping.city": "City",
    "field.shipping.province": "Region / state",
    "field.shipping.postalCode": "Postal code",
    "field.shipping.countryCode": "Country",
    "field.shipping.phone": "Recipient phone",
    "field.email": "Email",
    "field.contactPhone": "Contact phone",
    "field.variant.weightGrams": "Weight, g",
    "field.variant.hsCode": "HS code",
    "field.variant.countryOfOrigin": "Country of origin",
    "field.variant.customsDescription": "Customs description",
    "field.lineItem": "Line item",
    "field.order": "Order",
  },
};

export default messages;
