import type { MessageModule } from "../types";

const messages: MessageModule = {
  uk: {
    "demo.banner.title": "Демонстраційний режим",
    "demo.banner.body": "Усі замовлення вигадані. Накладні створює тестовий перевізник; у Shopify та перевізникам нічого не надсилається.",
    "demo.role.label": "Роль",
    "demo.login.description": "Демо-версія захищена паролем.",
    "demo.login.password": "Пароль",
    "demo.login.submit": "Увійти",
    "demo.login.invalid": "Неправильний пароль.",
    "demo.login.tooMany": "Забагато спроб. Спробуйте через 15 хвилин.",
    "demo.simulate.button": "Імітувати нове оплачене замовлення",
    "demo.simulate.help": "Створює вигадане замовлення та обробляє його відповідно до режиму автоматизації.",
    "demo.reset.button": "Скинути демо-дані",
    "demo.reset.title": "Скинути демо-дані?",
    "demo.reset.message": "Усі зміни демо-замовлень, накладні та історія будуть видалені й відновлені початкові дані.",
    "demo.testCarrier": "Тестовий перевізник",
  },
  en: {
    "demo.banner.title": "Demo mode",
    "demo.banner.body": "All orders are fictional. Waybills are created by a test carrier; nothing is sent to Shopify or carriers.",
    "demo.role.label": "Role",
    "demo.login.description": "The demo is password-protected.",
    "demo.login.password": "Password",
    "demo.login.submit": "Sign in",
    "demo.login.invalid": "Wrong password.",
    "demo.login.tooMany": "Too many attempts. Try again in 15 minutes.",
    "demo.simulate.button": "Simulate a new paid order",
    "demo.simulate.help": "Creates a fictional order and processes it according to the automation mode.",
    "demo.reset.button": "Reset demo data",
    "demo.reset.title": "Reset demo data?",
    "demo.reset.message": "All demo order changes, waybills and history will be deleted and the initial data restored.",
    "demo.testCarrier": "Test carrier",
  },
};

export default messages;
