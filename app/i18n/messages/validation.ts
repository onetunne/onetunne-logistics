import type { MessageModule } from "../types";

/**
 * Повідомлення модуля перевірки даних замовлення.
 * Ключі: issue.<CODE>.title / issue.<CODE>.help, autofix.<ruleId>, field.<path>.
 * Параметри: {country}, {example}, {title}, {sku}.
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
    "issue.EMAIL_INVALID.title": "Некоректний email",
    "issue.EMAIL_INVALID.help":
      "Адреса електронної пошти має неправильний формат. Відправлення це не блокує, але клієнт може не отримати сповіщень від перевізника. Виправте адресу або уточніть її в клієнта.",

    // --- Адреса ---
    "issue.NAME_MISSING.title": "Немає імені одержувача",
    "issue.NAME_MISSING.help":
      "В адресі доставки не вказано ні ім'я, ні прізвище, а без одержувача перевізник посилку не прийме. Додайте ім'я та прізвище одержувача.",
    "issue.ADDRESS_MISSING.title": "Немає адреси",
    "issue.ADDRESS_MISSING.help":
      "Не заповнено рядок адреси (вулиця, будинок). Додайте адресу доставки; за потреби уточніть її в клієнта.",
    "issue.CITY_MISSING.title": "Немає міста",
    "issue.CITY_MISSING.help": "Не вказано місто доставки. Додайте місто з адреси клієнта.",
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
      "Для цієї країни поштовий індекс обов'язковий. Уточніть індекс у клієнта та внесіть його у форматі {example}. Автоматичний пошук індексу за адресою заплановано на наступних етапах.",
    "issue.POSTAL_CODE_INVALID.title": "Неправильний формат індексу",
    "issue.POSTAL_CODE_INVALID.help":
      "Індекс не відповідає формату країни доставки (приклад: {example}). Перевірте індекс і країну в адресі та виправте помилку — цифри й літери індексу система автоматично не змінює.",
    "issue.PROVINCE_MISSING.title": "Немає регіону",
    "issue.PROVINCE_MISSING.help":
      "Для цієї країни потрібно вказати штат, провінцію або регіон. Додайте регіон з адреси клієнта (напр. код штату).",

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
    "issue.CARRIER_UNAVAILABLE.title": "Перевізник недоступний",
    "issue.CARRIER_UNAVAILABLE.help":
      "API перевізника не відповідає. Накладну не створено, нічого не змінено. Повторіть спробу пізніше.",

    // --- Автовиправлення ---
    "autofix.text.trim_whitespace": "Прибрано зайві пробіли",
    "autofix.country.uppercase": "Код країни записано великими літерами",
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
    "issue.EMAIL_INVALID.title": "Invalid email",
    "issue.EMAIL_INVALID.help":
      "The email address is malformed. This does not block shipping, but the customer may not receive carrier notifications. Fix the address or confirm it with the customer.",

    // --- Address ---
    "issue.NAME_MISSING.title": "Recipient name missing",
    "issue.NAME_MISSING.help":
      "The shipping address has neither a first name nor a last name, and the carrier will not accept a parcel without a recipient. Add the recipient's first and last name.",
    "issue.ADDRESS_MISSING.title": "Address missing",
    "issue.ADDRESS_MISSING.help":
      "The address line (street, house number) is empty. Add the shipping address; confirm it with the customer if needed.",
    "issue.CITY_MISSING.title": "City missing",
    "issue.CITY_MISSING.help": "The shipping city is empty. Add the city from the customer's address.",
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
      "A postal code is required for this country. Ask the customer for it and enter it in the format {example}. Automatic postal code lookup by address is planned for a later stage.",
    "issue.POSTAL_CODE_INVALID.title": "Invalid postal code format",
    "issue.POSTAL_CODE_INVALID.help":
      "The postal code does not match the shipping country's format (example: {example}). Check the postal code and the country in the address and correct the mistake — the system never changes postal code digits or letters automatically.",
    "issue.PROVINCE_MISSING.title": "Region missing",
    "issue.PROVINCE_MISSING.help":
      "This country requires a state, province or region. Add the region from the customer's address (e.g. the state code).",

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
    "issue.CARRIER_UNAVAILABLE.title": "Carrier unavailable",
    "issue.CARRIER_UNAVAILABLE.help":
      "The carrier API is not responding. No waybill was created and nothing was changed. Try again later.",

    // --- Auto-fixes ---
    "autofix.text.trim_whitespace": "Removed extra spaces",
    "autofix.country.uppercase": "Country code converted to upper case",
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
