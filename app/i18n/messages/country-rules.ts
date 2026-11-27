import type { MessageModule } from "../types";

/**
 * Розділ «Правила країн» (етап 4): редагування власником, історія, скидання, нові країни, перевірка індексу.
 * Назви колонок таблиці — planned.countryRules.* (модуль planned).
 */
const messages: MessageModule = {
  uk: {
    "countryRules.info.owner":
      "Ці правила одразу використовує перевірка даних замовлень. Після збереження відкриті замовлення цієї країни (ще без накладної) перевіряються повторно.",
    "countryRules.info.readOnly": "Перегляд правил. Змінювати правила може лише власник.",
    "countryRules.verify.title": "Типові правила потребують перевірки",
    "countryRules.verify.body":
      "Правил з позначкою «verify before production» (типові значення, не перевірені бізнесом): {count}. Перевірте формат індексу, обов’язкові поля і платника мита перед роботою з реальними замовленнями.",
    "countryRules.verify.rule":
      "Це типове правило ще не перевірене (позначка «verify before production» у примітках). Перевірте значення і приберіть позначку з приміток після перевірки.",

    "countryRules.filters.searchPlaceholder": "Код (DE) або назва країни",
    "countryRules.filters.shipping": "Доставка",
    "countryRules.filters.shipping.all": "Усі",
    "countryRules.filters.shipping.enabled": "Лише дозволена",
    "countryRules.filters.shipping.disabled": "Лише заборонена",
    "countryRules.filters.changed": "Лише змінені відносно типових (або додані власником)",
    "countryRules.list.count": "Показано країн: {shown} з {total}",
    "countryRules.list.empty.title": "Нічого не знайдено",
    "countryRules.list.empty.description": "Змініть пошуковий запит або скиньте фільтри.",
    "countryRules.list.status": "Стан",
    "countryRules.list.open": "Відкрити правило {country}",

    "countryRules.badge.changed": "Змінено",
    "countryRules.badge.custom": "Додано власником",
    "countryRules.badge.verify": "Потребує перевірки",
    "countryRules.badge.default": "Типове",

    "countryRules.detail.close": "До списку",
    "countryRules.detail.version": "Версія {version}",
    "countryRules.detail.notFound": "Правило для країни {country} не знайдено.",
    "countryRules.detail.noPattern": "Формат не перевіряється",

    "countryRules.field.shippingEnabled": "Доставка в країну дозволена",
    "countryRules.field.shippingEnabledHelp": "Якщо вимкнено, замовлення в цю країну отримують проблему «Доставку в країну вимкнено».",
    "countryRules.field.postalCodeRequired": "Поштовий індекс обов’язковий",
    "countryRules.field.postalCodePattern": "Формат індексу (регулярний вираз)",
    "countryRules.field.postalCodePatternHelp":
      "Перевіряється весь індекс після нормалізації (верхній регістр, зайві пробіли прибрано). Напр. ^\\d{5}$ — п’ять цифр. Порожнє поле — формат не перевіряється.",
    "countryRules.field.postalCodeExample": "Приклад індексу",
    "countryRules.field.postalCodeExampleHelp": "Має відповідати формату. Показується менеджерам як підказка.",
    "countryRules.field.provinceRequired": "Регіон (область/штат) обов’язковий",
    "countryRules.field.phoneRequired": "Телефон одержувача обов’язковий",
    "countryRules.field.dutyPayer": "Платник мита",
    "countryRules.field.notes": "Примітки",
    "countryRules.field.notesHelp": "До 500 символів. Не вносьте персональні дані.",
    "countryRules.field.countryCode": "Код країни (ISO 3166-1, 2 літери)",
    "countryRules.field.countryCodeHelp": "Напр. NO, CH, US. Країна ще не повинна бути в списку.",
    "countryRules.field.nameUk": "Назва українською",
    "countryRules.field.nameEn": "Назва англійською",
    "countryRules.field.nameHelp": "Порожнє поле — стандартна назва країни.",

    "countryRules.test.title": "Перевірити індекс",
    "countryRules.test.description": "Перевірка на сервері: індекс нормалізується так само, як під час перевірки замовлення.",
    "countryRules.test.descriptionOwner": "Використовується формат із поля вище, навіть якщо його ще не збережено.",
    "countryRules.test.sample": "Зразок індексу",
    "countryRules.test.submit": "Перевірити",
    "countryRules.test.match": "Відповідає формату: {value}",
    "countryRules.test.noMatch": "Не відповідає формату: {value}",
    "countryRules.test.noPattern": "Формат для цієї країни не задано — будь-який індекс приймається: {value}",
    "countryRules.test.patternInvalid": "Формат містить помилку — перевірка неможлива.",

    "countryRules.reset.button": "Повернути типове правило",
    "countryRules.reset.title": "Повернути типове правило?",
    "countryRules.reset.message":
      "Значення правила {country} буде замінено типовими. Поточна версія залишиться в історії. Відкриті замовлення країни буде перевірено повторно.",
    "countryRules.reset.confirm": "Повернути",
    "countryRules.reset.isDefault": "Правило збігається з типовим.",
    "countryRules.reset.noDefault": "Для цієї країни немає типового правила (додана власником).",

    "countryRules.history.title": "Історія змін",
    "countryRules.history.empty": "Змін у застосунку ще не було — діють початкові значення.",
    "countryRules.history.entry": "Версія {version} · {source}",
    "countryRules.history.source.initial": "початкові значення",
    "countryRules.history.source.add": "країну додано",
    "countryRules.history.source.update": "зміна",
    "countryRules.history.source.reset": "повернення до типового",
    "countryRules.history.by.system": "Система",
    "countryRules.history.by.owner": "Власник",
    "countryRules.history.change": "{field}: {from} → {to}",
    "countryRules.history.empty_value": "—",

    "countryRules.add.title": "Додати країну",
    "countryRules.add.description": "Нова країна з власними правилами. Без правила замовлення в країну отримують проблему «Країна не налаштована».",
    "countryRules.add.submit": "Додати",

    "countryRules.result.updated": "Правило збережено. Повторно перевірено відкритих замовлень країни: {count}.",
    "countryRules.result.unchanged": "Змін немає — правило не змінено.",
    "countryRules.result.reset": "Типове правило відновлено. Повторно перевірено відкритих замовлень країни: {count}.",
    "countryRules.result.added": "Країну додано. Повторно перевірено відкритих замовлень країни: {count}.",

    "countryRules.error.invalid": "Некоректне значення",
    "countryRules.error.tooLong": "Занадто довге значення",
    "countryRules.error.patternInvalid": "Некоректний або недозволений шаблон: використовуйте \\d, [A-Z], {n} або {n,m}, ? і |; без +, * та {n,} (захист від перевантаження сервера)",
    "countryRules.error.exampleMismatch": "Приклад не відповідає формату індексу",
    "countryRules.error.codeInvalid": "Потрібно 2 латинські літери (A–Z)",
    "countryRules.error.codeExists": "Ця країна вже є в списку",
    "countryRules.error.nameRequired": "Вкажіть назву країни",
    "countryRules.error.noDefault": "Для країни {country} немає типового правила",
  },
  en: {
    "countryRules.info.owner":
      "Order data validation uses these rules immediately. After saving, open orders for this country (without a waybill yet) are re-checked.",
    "countryRules.info.readOnly": "Read-only view. Only the owner can change rules.",
    "countryRules.verify.title": "Default rules need verification",
    "countryRules.verify.body":
      "Rules marked “verify before production” (default values not yet confirmed by the business): {count}. Check the postal code format, required fields and duty payer before working with real orders.",
    "countryRules.verify.rule":
      "This default rule has not been verified yet (marker “verify before production” in the notes). Check the values and remove the marker from the notes once verified.",

    "countryRules.filters.searchPlaceholder": "Code (DE) or country name",
    "countryRules.filters.shipping": "Shipping",
    "countryRules.filters.shipping.all": "All",
    "countryRules.filters.shipping.enabled": "Allowed only",
    "countryRules.filters.shipping.disabled": "Prohibited only",
    "countryRules.filters.changed": "Only changed from defaults (or added by the owner)",
    "countryRules.list.count": "Countries shown: {shown} of {total}",
    "countryRules.list.empty.title": "Nothing found",
    "countryRules.list.empty.description": "Change the search query or reset the filters.",
    "countryRules.list.status": "State",
    "countryRules.list.open": "Open rule {country}",

    "countryRules.badge.changed": "Changed",
    "countryRules.badge.custom": "Added by owner",
    "countryRules.badge.verify": "Needs verification",
    "countryRules.badge.default": "Default",

    "countryRules.detail.close": "Back to list",
    "countryRules.detail.version": "Version {version}",
    "countryRules.detail.notFound": "No rule found for country {country}.",
    "countryRules.detail.noPattern": "Format is not checked",

    "countryRules.field.shippingEnabled": "Shipping to this country is allowed",
    "countryRules.field.shippingEnabledHelp": "When off, orders to this country get the “Shipping to country disabled” problem.",
    "countryRules.field.postalCodeRequired": "Postal code is required",
    "countryRules.field.postalCodePattern": "Postal code format (regular expression)",
    "countryRules.field.postalCodePatternHelp":
      "The whole postal code is checked after normalisation (upper case, extra spaces removed). E.g. ^\\d{5}$ — five digits. Empty — the format is not checked.",
    "countryRules.field.postalCodeExample": "Postal code example",
    "countryRules.field.postalCodeExampleHelp": "Must match the format. Shown to managers as a hint.",
    "countryRules.field.provinceRequired": "Region (state/province) is required",
    "countryRules.field.phoneRequired": "Recipient phone is required",
    "countryRules.field.dutyPayer": "Duty payer",
    "countryRules.field.notes": "Notes",
    "countryRules.field.notesHelp": "Up to 500 characters. Do not enter personal data.",
    "countryRules.field.countryCode": "Country code (ISO 3166-1, 2 letters)",
    "countryRules.field.countryCodeHelp": "E.g. NO, CH, US. The country must not be in the list yet.",
    "countryRules.field.nameUk": "Name in Ukrainian",
    "countryRules.field.nameEn": "Name in English",
    "countryRules.field.nameHelp": "Empty — the standard country name.",

    "countryRules.test.title": "Test a postal code",
    "countryRules.test.description": "Checked on the server: the code is normalised the same way as during order validation.",
    "countryRules.test.descriptionOwner": "Uses the format from the field above, even if it is not saved yet.",
    "countryRules.test.sample": "Sample postal code",
    "countryRules.test.submit": "Check",
    "countryRules.test.match": "Matches the format: {value}",
    "countryRules.test.noMatch": "Does not match the format: {value}",
    "countryRules.test.noPattern": "No format is set for this country — any postal code is accepted: {value}",
    "countryRules.test.patternInvalid": "The format contains an error — cannot check.",

    "countryRules.reset.button": "Restore default rule",
    "countryRules.reset.title": "Restore the default rule?",
    "countryRules.reset.message":
      "The {country} rule values will be replaced with the defaults. The current version stays in the history. Open orders for the country will be re-checked.",
    "countryRules.reset.confirm": "Restore",
    "countryRules.reset.isDefault": "The rule matches the default.",
    "countryRules.reset.noDefault": "There is no default rule for this country (added by the owner).",

    "countryRules.history.title": "Change history",
    "countryRules.history.empty": "No changes in the app yet — the initial values apply.",
    "countryRules.history.entry": "Version {version} · {source}",
    "countryRules.history.source.initial": "initial values",
    "countryRules.history.source.add": "country added",
    "countryRules.history.source.update": "change",
    "countryRules.history.source.reset": "restored to default",
    "countryRules.history.by.system": "System",
    "countryRules.history.by.owner": "Owner",
    "countryRules.history.change": "{field}: {from} → {to}",
    "countryRules.history.empty_value": "—",

    "countryRules.add.title": "Add a country",
    "countryRules.add.description": "A new country with its own rules. Without a rule, orders to the country get the “Country not configured” problem.",
    "countryRules.add.submit": "Add",

    "countryRules.result.updated": "Rule saved. Open orders for the country re-checked: {count}.",
    "countryRules.result.unchanged": "No changes — the rule was not modified.",
    "countryRules.result.reset": "Default rule restored. Open orders for the country re-checked: {count}.",
    "countryRules.result.added": "Country added. Open orders for the country re-checked: {count}.",

    "countryRules.error.invalid": "Invalid value",
    "countryRules.error.tooLong": "Value is too long",
    "countryRules.error.patternInvalid": "Invalid or disallowed pattern: use \\d, [A-Z], {n} or {n,m}, ? and |; no +, * or {n,} (protects the server from overload)",
    "countryRules.error.exampleMismatch": "The example does not match the postal code format",
    "countryRules.error.codeInvalid": "2 Latin letters (A–Z) are required",
    "countryRules.error.codeExists": "This country is already in the list",
    "countryRules.error.nameRequired": "Enter the country name",
    "countryRules.error.noDefault": "There is no default rule for country {country}",
  },
};

export default messages;
