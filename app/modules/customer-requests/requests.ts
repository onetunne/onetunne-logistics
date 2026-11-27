/**
 * «Що запитати в клієнта»: відображення відкритих проблем замовлення на запити відсутніх/неправильних
 * даних і чернетка ввічливого повідомлення, яку менеджер КОПІЮЄ й надсилає ВРУЧНУ.
 *
 * Чистий модуль (без БД/мережі). Нічого не надсилає.
 * Правила:
 * - запитується лише те, що може знати клієнт (контакти, адреса). Митні дані товарів, відмови перевізника,
 *   заборонені країни, проблеми синхронізації — внутрішні справи магазину, запиту немає;
 * - невідомі (нові) коди проблем → запиту немає (безпечно за замовчуванням);
 * - у текст НЕ потрапляють значення з замовлення (поточний телефон, адреса, ім'я), параметри проблем,
 *   внутрішні нотатки — лише номер замовлення (його клієнт уже знає), якщо передано.
 */
import { translate } from "~/i18n";
import type { Locale } from "~/i18n/types";
import type { CustomerMessageDraft } from "~/integrations/messaging/types";
import type { IssueCode } from "~/modules/validation/types";

/** Ключі запитів (порядок у повідомленні — як у цьому масиві). */
export const CUSTOMER_REQUEST_KEYS = [
  "name",
  "country",
  "address",
  "houseNumber",
  "city",
  "province",
  "postalCode",
  "postalCodeConfirm",
  "phone",
  "phoneConfirm",
  "phoneMobile",
  "email",
  "emailConfirm",
] as const;
export type CustomerRequestKey = (typeof CUSTOMER_REQUEST_KEYS)[number];

export interface CustomerRequest {
  issueCode: IssueCode;
  /** Шлях поля, яке буде виправлено після відповіді (як у issues.field / order_changes.field). */
  field: string;
  /** i18n-ключ пункту повідомлення: `customerRequest.item.<key>`. */
  templateKey: `customerRequest.item.${CustomerRequestKey}`;
  /** Які саме дані потрібні від клієнта (для майбутнього аналізу відповіді й шаблонів WhatsApp). */
  requiredData: readonly string[];
}

interface RequestRule {
  key: CustomerRequestKey;
  /** Поле за замовчуванням, якщо у проблеми немає власного. */
  defaultField: string;
  requiredData: readonly string[];
}

/**
 * Явний перелік кодів, для яких є запит клієнту. Коди поза переліком → без запиту:
 * - митниця/товари, перевізник, Shopify, відстеження — внутрішні справи магазину;
 * - COUNTRY_UNSUPPORTED / COUNTRY_SHIPPING_DISABLED — рішення магазину, не клієнта;
 * - ADDRESS_LINE1_EMPTY_LINE2_FILLED, ADDRESS_FIELD_TOO_LONG, ADDRESS_DUPLICATED_FIELDS, CITY_CONTAINS_POSTAL_CODE —
 *   дані вже є, менеджер перекладає/скорочує їх сам;
 * - будь-які нові/невідомі коди (безпечно за замовчуванням: спершу вирішити, чи стосуються вони клієнта);
 * - проблеми з пропозицією виправлення (крім неоднозначного телефону): дані вже є, менеджер лише підтверджує.
 * Ключі — рядки (а не IssueCode), щоб перелік не ламався, коли набір кодів змінюється; відповідність ISSUE_CODES
 * перевіряє тест.
 */
const RULES: Readonly<Record<string, RequestRule>> = {
  NAME_MISSING: { key: "name", defaultField: "shipping.lastName", requiredData: ["recipient_full_name"] },
  NAME_INCOMPLETE: { key: "name", defaultField: "shipping.lastName", requiredData: ["recipient_full_name"] },
  COUNTRY_MISSING: { key: "country", defaultField: "shipping.countryCode", requiredData: ["country"] },
  ADDRESS_MISSING: { key: "address", defaultField: "shipping.address1", requiredData: ["street", "building", "apartment_optional"] },
  ADDRESS_NO_HOUSE_NUMBER: { key: "houseNumber", defaultField: "shipping.address1", requiredData: ["building", "apartment_optional"] },
  CITY_MISSING: { key: "city", defaultField: "shipping.city", requiredData: ["city"] },
  PROVINCE_MISSING: { key: "province", defaultField: "shipping.province", requiredData: ["province"] },
  PROVINCE_INVALID: { key: "province", defaultField: "shipping.province", requiredData: ["province"] },
  POSTAL_CODE_MISSING: { key: "postalCode", defaultField: "shipping.postalCode", requiredData: ["postal_code"] },
  POSTAL_CODE_INVALID: { key: "postalCode", defaultField: "shipping.postalCode", requiredData: ["postal_code"] },
  POSTAL_CODE_REGION_MISMATCH: {
    key: "postalCodeConfirm",
    defaultField: "shipping.postalCode",
    requiredData: ["postal_code", "province"],
  },
  PHONE_MISSING: { key: "phone", defaultField: "shipping.phone", requiredData: ["phone_with_country_code"] },
  PHONE_INVALID: { key: "phoneConfirm", defaultField: "shipping.phone", requiredData: ["phone_with_country_code"] },
  PHONE_AMBIGUOUS: { key: "phoneConfirm", defaultField: "shipping.phone", requiredData: ["phone_with_country_code"] },
  PHONE_COUNTRY_MISMATCH: { key: "phoneConfirm", defaultField: "shipping.phone", requiredData: ["phone_with_country_code"] },
  PHONE_NOT_MOBILE: { key: "phoneMobile", defaultField: "shipping.phone", requiredData: ["mobile_phone_with_country_code"] },
  EMAIL_MISSING: { key: "email", defaultField: "email", requiredData: ["email"] },
  EMAIL_INVALID: { key: "emailConfirm", defaultField: "email", requiredData: ["email"] },
};

/** Коди, для яких є запит клієнту (для тестів і документації). */
export const CUSTOMER_REQUEST_ISSUE_CODES: readonly string[] = Object.keys(RULES);

/** Групи пунктів, що питають про одне й те саме: лишається найточніший (останній у групі). */
const SAME_QUESTION: readonly (readonly CustomerRequestKey[])[] = [
  ["phone", "phoneConfirm", "phoneMobile"],
  ["email", "emailConfirm"],
  ["address", "houseNumber"],
  ["postalCode", "postalCodeConfirm"],
];

/** Мінімальна форма проблеми (рядок issues або ValidationIssue). */
export interface IssueLike {
  code: string;
  field?: string | null;
  /** Якщо передано — враховуються лише відкриті. */
  status?: string;
  /** Пропозиція виправлення (дані вже є в замовленні — менеджер лише підтверджує). */
  suggestion?: { candidates?: readonly string[] | null } | null;
}

/**
 * Неоднозначний номер (кілька прочитань) — лише клієнт знає, яке правильне: питаємо навіть за наявності кандидатів.
 * Для решти кодів пропозиція означає, що дані вже є в замовленні (індекс із поля «Місто», «Texas» → TX).
 */
const ASK_EVEN_WITH_SUGGESTION: ReadonlySet<string> = new Set(["PHONE_AMBIGUOUS"]);

function hasSuggestion(issue: IssueLike): boolean {
  return (issue.suggestion?.candidates?.length ?? 0) > 0;
}

/** Поле проблеми приймається лише якщо це поле контакту/адреси (не товар, не замовлення в цілому). */
function contactField(field: string | null | undefined): string | null {
  if (!field) return null;
  if (field === "email" || field === "contactPhone") return field;
  return /^shipping\.[a-zA-Z0-9]+$/.test(field) ? field : null;
}

/** Запит для однієї проблеми або null (код невідомий чи не стосується клієнта). */
export function customerRequestFor(issue: IssueLike): CustomerRequest | null {
  if (issue.status !== undefined && issue.status !== "open") return null;
  if (!Object.prototype.hasOwnProperty.call(RULES, issue.code)) return null;
  // Дані вже є в замовленні (є пропозиція) — клієнта не питаємо, менеджер підтверджує пропозицію.
  if (hasSuggestion(issue) && !ASK_EVEN_WITH_SUGGESTION.has(issue.code)) return null;
  const rule = RULES[issue.code];
  if (!rule) return null;
  return {
    issueCode: issue.code as IssueCode,
    field: contactField(issue.field) ?? rule.defaultField,
    templateKey: `customerRequest.item.${rule.key}`,
    requiredData: rule.requiredData,
  };
}

/**
 * Запити для набору проблем: без дублікатів (кілька проблем телефону → один пункт; «немає адреси» поглинає
 * «немає номера будинку»), у стабільному порядку CUSTOMER_REQUEST_KEYS.
 */
export function customerRequestsFor(issues: readonly IssueLike[]): CustomerRequest[] {
  const byKey = new Map<CustomerRequestKey, CustomerRequest>();
  for (const issue of issues) {
    const request = customerRequestFor(issue);
    if (!request) continue;
    const key = request.templateKey.slice("customerRequest.item.".length) as CustomerRequestKey;
    if (!byKey.has(key)) byKey.set(key, request);
  }
  for (const group of SAME_QUESTION) {
    // «Немає адреси» — ширше питання: просимо всю адресу, а не лише номер будинку.
    const keep = group[0] === "address" ? group.find((k) => byKey.has(k)) : [...group].reverse().find((k) => byKey.has(k));
    for (const k of group) if (k !== keep) byKey.delete(k);
  }
  return CUSTOMER_REQUEST_KEYS.flatMap((k) => {
    const r = byKey.get(k);
    return r ? [r] : [];
  });
}

export interface CustomerRequestDraftOptions {
  /** Номер замовлення, який клієнт уже знає (напр. "#1004"). Інші дані замовлення в текст не потрапляють. */
  orderNumber?: string | null;
}

export interface CustomerRequestDraft {
  locale: Locale;
  requests: CustomerRequest[];
  /** Готовий текст для копіювання. */
  text: string;
  /** Ключ шаблону для майбутнього каналу (WhatsApp-шаблон категорії utility). */
  templateKey: "customer_request.missing_data";
}

/** Номер замовлення — лише безпечні символи (захист від вставки довільного тексту в повідомлення). */
function safeOrderNumber(value: string | null | undefined): string | null {
  const v = value?.trim() ?? "";
  return /^#?[A-Za-z0-9-]{1,20}$/.test(v) ? v : null;
}

/**
 * Чернетка повідомлення клієнту (uk або en). null — немає чого запитувати.
 * Текст складається ЛИШЕ з шаблонів i18n (модуль customer-requests) і номера замовлення.
 */
export function buildCustomerRequestDraft(
  issues: readonly IssueLike[],
  locale: Locale,
  options: CustomerRequestDraftOptions = {},
): CustomerRequestDraft | null {
  const requests = customerRequestsFor(issues);
  if (requests.length === 0) return null;
  const orderNumber = safeOrderNumber(options.orderNumber);
  const intro = orderNumber
    ? translate(locale, "customerRequest.intro", { orderNumber })
    : translate(locale, "customerRequest.introNoNumber");
  const items = requests.map((r) => `• ${translate(locale, r.templateKey)}`);
  const lines = [
    translate(locale, "customerRequest.greeting"),
    "",
    intro,
    ...items,
    "",
    translate(locale, requests.length === 1 ? "customerRequest.replyOne" : "customerRequest.replyMany"),
    "",
    translate(locale, "customerRequest.closing"),
    translate(locale, "customerRequest.signature"),
  ];
  return { locale, requests, text: lines.join("\n"), templateKey: "customer_request.missing_data" };
}

/** Та сама чернетка у формі контракту каналу повідомлень (для майбутнього надсилання після згоди). */
export function toMessageDraft(orderId: string, draft: CustomerRequestDraft): CustomerMessageDraft {
  return {
    orderId,
    locale: draft.locale,
    templateKey: draft.templateKey,
    text: draft.text,
    requestedFields: [...new Set(draft.requests.map((r) => r.field))],
  };
}
