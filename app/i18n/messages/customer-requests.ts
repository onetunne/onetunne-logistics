import type { MessageModule } from "../types";

/**
 * Запит даних у клієнта: пункти й рамка чернетки повідомлення (app/modules/customer-requests/requests.ts)
 * та підписи майбутньої панелі на сторінці замовлення. Програма повідомлення НЕ надсилає — менеджер копіює текст.
 * Тексти не містять даних замовлення, крім номера {orderNumber}.
 */
const messages: MessageModule = {
  uk: {
    // Чернетка повідомлення клієнту
    "customerRequest.greeting": "Вітаємо!",
    "customerRequest.intro":
      "Дякуємо за замовлення {orderNumber} у магазині ONE TUNNE. Щоб ми могли відправити посилку, будь ласка, уточніть:",
    "customerRequest.introNoNumber":
      "Дякуємо за замовлення в магазині ONE TUNNE. Щоб ми могли відправити посилку, будь ласка, уточніть:",
    "customerRequest.item.name": "ім'я та прізвище одержувача;",
    "customerRequest.item.country": "країну доставки;",
    "customerRequest.item.address": "адресу доставки: вулицю, номер будинку та квартиру (якщо є);",
    "customerRequest.item.houseNumber": "номер будинку (і квартиру, якщо є) — в адресі його не вказано;",
    "customerRequest.item.city": "місто або населений пункт;",
    "customerRequest.item.province": "штат, область або регіон;",
    "customerRequest.item.postalCode": "поштовий індекс;",
    "customerRequest.item.postalCodeConfirm":
      "поштовий індекс і штат/регіон — щоб переконатися, що вони відповідають одне одному;",
    "customerRequest.item.phone": "номер телефону одержувача з кодом країни (для зв'язку служби доставки);",
    "customerRequest.item.phoneConfirm": "правильний номер телефону одержувача з кодом країни (для зв'язку служби доставки);",
    "customerRequest.item.phoneMobile": "мобільний номер телефону одержувача з кодом країни (служба доставки надсилає SMS);",
    "customerRequest.item.email": "адресу електронної пошти (для повідомлень про доставку);",
    "customerRequest.item.emailConfirm": "правильну адресу електронної пошти;",
    "customerRequest.replyOne": "Просто надішліть ці дані у відповідь на це повідомлення.",
    "customerRequest.replyMany": "Просто надішліть ці дані у відповідь на це повідомлення — можна одним повідомленням.",
    "customerRequest.closing": "Дякуємо! Щойно отримаємо відповідь, підготуємо відправлення.",
    "customerRequest.signature": "Команда ONE TUNNE",

    // Майбутня панель на сторінці замовлення
    "customerRequest.panel.title": "Запит даних у клієнта",
    "customerRequest.panel.hint":
      "Чернетка повідомлення. Скопіюйте й надішліть клієнтові вручну — програма нічого не надсилає.",
    "customerRequest.panel.language": "Мова повідомлення",
    "customerRequest.panel.copy": "Копіювати текст",
    "customerRequest.panel.copied": "Скопійовано",
    "customerRequest.panel.none": "Немає даних, які потрібно уточнити в клієнта.",
    "customerRequest.panel.fields": "Що уточнити",
  },
  en: {
    "customerRequest.greeting": "Hello!",
    "customerRequest.intro":
      "Thank you for your order {orderNumber} at ONE TUNNE. So that we can ship your parcel, could you please confirm:",
    "customerRequest.introNoNumber":
      "Thank you for your order at ONE TUNNE. So that we can ship your parcel, could you please confirm:",
    "customerRequest.item.name": "the recipient's first and last name;",
    "customerRequest.item.country": "the destination country;",
    "customerRequest.item.address": "the delivery address: street, house number and apartment (if any);",
    "customerRequest.item.houseNumber": "the house number (and apartment, if any) — it is missing from the address;",
    "customerRequest.item.city": "the city or town;",
    "customerRequest.item.province": "the state, province or region;",
    "customerRequest.item.postalCode": "the postal code;",
    "customerRequest.item.postalCodeConfirm": "the postal code and state/region — so we can make sure they match;",
    "customerRequest.item.phone": "the recipient's phone number with the country code (for the delivery service);",
    "customerRequest.item.phoneConfirm": "the recipient's correct phone number with the country code (for the delivery service);",
    "customerRequest.item.phoneMobile": "the recipient's mobile phone number with the country code (the delivery service sends SMS);",
    "customerRequest.item.email": "your email address (for delivery updates);",
    "customerRequest.item.emailConfirm": "your correct email address;",
    "customerRequest.replyOne": "Simply reply to this message with these details.",
    "customerRequest.replyMany": "Simply reply to this message with these details — one message is fine.",
    "customerRequest.closing": "Thank you! As soon as we hear from you, we will prepare the shipment.",
    "customerRequest.signature": "ONE TUNNE team",

    "customerRequest.panel.title": "Ask the customer for details",
    "customerRequest.panel.hint": "Message draft. Copy it and send it to the customer yourself — the app sends nothing.",
    "customerRequest.panel.language": "Message language",
    "customerRequest.panel.copy": "Copy text",
    "customerRequest.panel.copied": "Copied",
    "customerRequest.panel.none": "Nothing needs to be confirmed with the customer.",
    "customerRequest.panel.fields": "What to confirm",
  },
};

export default messages;
