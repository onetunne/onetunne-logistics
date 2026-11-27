import type { MessageModule } from "../types";

/** Розділ «Товари» і форма митних даних, ваги й габаритів варіанта (також на сторінці замовлення). */
const messages: MessageModule = {
  uk: {
    "products.subtitle": "Митні дані, вага й габарити кожного варіанта товару",
    "products.info.title": "Звідки беруться дані",
    "products.info.production":
      "Значення, змінені тут, зберігаються в застосунку, мають пріоритет над даними Shopify і не перезаписуються синхронізацією. Порожнє поле у формі — використовується значення з Shopify. У самому Shopify нічого не змінюється.",
    "products.info.demo":
      "У демо роль «даних Shopify» виконують вигадані демо-дані товару. Змінені тут значення мають пріоритет над ними; порожнє поле у формі — повернення до демо-значення.",
    "products.filters.searchPlaceholder": "Назва товару, варіант, SKU або штрихкод",
    "products.filters.missingOnly": "Лише з неповними митними даними (HS-код, країна походження, опис англійською або вага)",
    "products.missingCount": "Варіантів з неповними митними даними: {count}",
    "products.list.caption": "Варіанти товарів",
    "products.list.range": "{from}–{to} з {total}",
    "products.empty.title": "Товарів ще немає",
    "products.empty.production": "Товари з’являться після синхронізації з Shopify (розділ «Shopify»).",
    "products.empty.demo": "Демо-товари створюються разом із демо-даними.",
    "products.empty.filtered.title": "Нічого не знайдено",
    "products.empty.filtered.description": "Змініть пошуковий запит або скиньте фільтри.",
    "products.sku": "SKU",
    "products.deleted": "Видалено в Shopify",
    "products.missing": "Не заповнено",
    "products.overridden": "змінено в застосунку",
    "products.shopifyValue": "У Shopify: {value}",
    "products.shopifyEmpty": "У Shopify не заповнено",
    "products.demoValue": "Демо-значення: {value}",
    "products.demoEmpty": "Демо-значення не задано",
    "products.hsShort": "Nova Post: потрібно 8–10 цифр",
    "products.dimensions": "Габарити (Д × Ш × В)",
    "products.dimensionsValue": "{length} × {width} × {height} мм",

    // Поля варіанта (доповнюють field.variant.* з модуля validation).
    "field.variant.customsDescriptionLocal": "Митний опис українською",
    "field.variant.material": "Матеріал",
    "field.variant.lengthMm": "Довжина, мм",
    "field.variant.widthMm": "Ширина, мм",
    "field.variant.heightMm": "Висота, мм",

    // Форма
    "products.form.edit": "Змінити митні дані, вагу й габарити",
    "products.form.help.production":
      "Зміни зберігаються в застосунку, мають пріоритет над Shopify і не перезаписуються синхронізацією. Порожнє поле — значення з Shopify. Після збереження замовлення з цим товаром, які ще не мають накладної, буде перевірено повторно.",
    "products.form.help.demo":
      "Порожнє поле — демо-значення товару (у робочій версії — значення з Shopify). Після збереження замовлення з цим товаром, які ще не мають накладної, буде перевірено повторно.",
    "products.form.hsHelp":
      "Nova Post приймає лише 8–10 цифр (код УКТ ЗЕД); 6-значний код із Shopify Nova Post відхилить. Крапки й пробіли дозволено.",
    "products.form.originHelp": "Дволітерний код ISO, напр. UA",
    "products.form.descriptionHelp": "Коротко англійською: що це і з чого, напр. Cotton T-shirt",
    "products.form.descriptionLocalHelp": "Той самий опис українською (для документів)",
    "products.form.materialHelp": "Основний матеріал англійською, напр. Cotton",
    "products.form.weightHelp": "Вага одного товару в грамах",
    "products.form.dimensionsHelp":
      "Габарити товару зберігаються для довідки. Розмір посилки в накладній поки береться з налаштувань пакування, а не з цих полів.",
    "products.form.save": "Зберегти",

    "products.error.hsCode": "Від 6 до 10 цифр (для Nova Post — 8–10)",
    "products.error.countryOfOrigin": "Дволітерний код країни ISO, напр. UA",
    "products.error.customsDescription": "Не довше за 200 символів",
    "products.error.customsDescriptionLocal": "Не довше за 200 символів",
    "products.error.material": "Не довше за 50 символів",
    "products.error.weightGrams": "Ціле число від 1 до 100000",
    "products.error.lengthMm": "Ціле число від 1 до 3000",
    "products.error.widthMm": "Ціле число від 1 до 3000",
    "products.error.heightMm": "Ціле число від 1 до 3000",

    // Сторінка замовлення
    "products.order.allProducts": "Усі товари й митні дані — у розділі «Товари».",
    "products.order.openProducts": "Відкрити «Товари»",
  },
  en: {
    "products.subtitle": "Customs data, weight and dimensions of each product variant",
    "products.info.title": "Where the data comes from",
    "products.info.production":
      "Values changed here are stored in the app, take priority over Shopify data and are not overwritten by sync. An empty form field means the Shopify value is used. Nothing is changed in Shopify itself.",
    "products.info.demo":
      "In the demo, made-up demo product data plays the role of “Shopify data”. Values changed here take priority over it; an empty form field reverts to the demo value.",
    "products.filters.searchPlaceholder": "Product title, variant, SKU or barcode",
    "products.filters.missingOnly": "Only with incomplete customs data (HS code, country of origin, English description or weight)",
    "products.missingCount": "Variants with incomplete customs data: {count}",
    "products.list.caption": "Product variants",
    "products.list.range": "{from}–{to} of {total}",
    "products.empty.title": "No products yet",
    "products.empty.production": "Products appear after the Shopify sync (the “Shopify” section).",
    "products.empty.demo": "Demo products are created together with the demo data.",
    "products.empty.filtered.title": "Nothing found",
    "products.empty.filtered.description": "Change the search or reset the filters.",
    "products.sku": "SKU",
    "products.deleted": "Deleted in Shopify",
    "products.missing": "Not set",
    "products.overridden": "changed in the app",
    "products.shopifyValue": "In Shopify: {value}",
    "products.shopifyEmpty": "Not set in Shopify",
    "products.demoValue": "Demo value: {value}",
    "products.demoEmpty": "No demo value",
    "products.hsShort": "Nova Post: 8–10 digits required",
    "products.dimensions": "Dimensions (L × W × H)",
    "products.dimensionsValue": "{length} × {width} × {height} mm",

    "field.variant.customsDescriptionLocal": "Customs description in Ukrainian",
    "field.variant.material": "Material",
    "field.variant.lengthMm": "Length, mm",
    "field.variant.widthMm": "Width, mm",
    "field.variant.heightMm": "Height, mm",

    "products.form.edit": "Change customs data, weight and dimensions",
    "products.form.help.production":
      "Changes are stored in the app, take priority over Shopify and are not overwritten by sync. An empty field means the Shopify value. After saving, orders with this product that have no waybill yet are re-checked.",
    "products.form.help.demo":
      "An empty field means the product's demo value (in production — the Shopify value). After saving, orders with this product that have no waybill yet are re-checked.",
    "products.form.hsHelp":
      "Nova Post accepts only 8–10 digits (UKT ZED code); Nova Post rejects a 6-digit code from Shopify. Dots and spaces are allowed.",
    "products.form.originHelp": "Two-letter ISO code, e.g. UA",
    "products.form.descriptionHelp": "Short, in English: what it is and what it is made of, e.g. Cotton T-shirt",
    "products.form.descriptionLocalHelp": "The same description in Ukrainian (for documents)",
    "products.form.materialHelp": "Main material in English, e.g. Cotton",
    "products.form.weightHelp": "Weight of one item in grams",
    "products.form.dimensionsHelp":
      "Product dimensions are stored for reference. The parcel size on the waybill still comes from the packaging settings, not from these fields.",
    "products.form.save": "Save",

    "products.error.hsCode": "6 to 10 digits (8–10 for Nova Post)",
    "products.error.countryOfOrigin": "Two-letter ISO country code, e.g. UA",
    "products.error.customsDescription": "At most 200 characters",
    "products.error.customsDescriptionLocal": "At most 200 characters",
    "products.error.material": "At most 50 characters",
    "products.error.weightGrams": "A whole number from 1 to 100000",
    "products.error.lengthMm": "A whole number from 1 to 3000",
    "products.error.widthMm": "A whole number from 1 to 3000",
    "products.error.heightMm": "A whole number from 1 to 3000",

    "products.order.allProducts": "All products and customs data are in the “Products” section.",
    "products.order.openProducts": "Open “Products”",
  },
};

export default messages;
