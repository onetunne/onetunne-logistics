/**
 * ЗАПЛАНОВАНО (етап 10): комунікація з клієнтами (WhatsApp / email). Лише типи, без реалізації.
 *
 * Автоматична комунікація з клієнтами НЕ РЕАЛІЗОВАНА. Майбутня реалізація має:
 * - відповідати політикам WhatsApp Business (згода клієнта / opt-in, затверджені шаблони,
 *   правила вікна обслуговування, можливість відмовитися від повідомлень);
 * - відповідати вимогам захисту персональних даних (мінімізація, правова підстава, строк зберігання);
 * - не передавати в шаблони більше даних, ніж потрібно для конкретного повідомлення.
 */

export type CustomerMessagingChannelKind = "whatsapp" | "email";

export interface CustomerMessage {
  /** Замовлення, до якого стосується повідомлення; контакт одержувача визначається на сервері. */
  orderId: string;
  /** Ключ нашого шаблону (для WhatsApp — відповідає затвердженому шаблону). */
  templateKey: string;
  locale: string;
  /** Мінімальний набір змінних шаблону. */
  params: Record<string, string>;
}

export interface CustomerMessagingChannel {
  readonly channel: CustomerMessagingChannelKind;
  /** Відправка лише за наявності згоди клієнта на цей канал. */
  send(message: CustomerMessage): Promise<{ accepted: boolean; providerMessageId: string | null }>;
}

// ---------------------------------------------------------------------------
// Розширення контракту (етап 4, лише типи): згода клієнта, шаблони, вікно обслуговування, чернетки.
// НІЧОГО не надсилається: реалізацій немає. Політика WhatsApp Business — docs/ai-whatsapp-readiness.md.
// ---------------------------------------------------------------------------

/** Стан згоди клієнта на канал. unknown → надсилати не можна (лише чернетка для ручного надсилання). */
export type CustomerConsentStatus = "opted_in" | "opted_out" | "unknown";

export interface CustomerChannelConsent {
  channel: CustomerMessagingChannelKind;
  status: CustomerConsentStatus;
  /** Як отримано згоду/відмову: чекбокс у Checkout, повідомлення клієнта, ручна позначка менеджера. */
  source: "checkout_checkbox" | "customer_message" | "manager" | "import";
  recordedAt: Date;
  /** actor.id того, хто зафіксував (для source "manager"); без персональних даних. */
  recordedBy: string | null;
}

/**
 * Категорії шаблонів WhatsApp Business. Запит відсутніх даних для доставки — "utility"
 * (службове повідомлення щодо наявного замовлення), не "marketing".
 */
export type MessageTemplateCategory = "utility" | "marketing" | "authentication";

export type MessageTemplateApprovalStatus = "draft" | "pending" | "approved" | "rejected" | "paused" | "disabled";

export interface CustomerMessageTemplate {
  /** Наш ключ (як у CustomerMessage.templateKey), напр. "customer_request.missing_data". */
  key: string;
  channel: CustomerMessagingChannelKind;
  locale: string;
  category: MessageTemplateCategory;
  /** Назва затвердженого шаблону в кабінеті провайдера (для WhatsApp — Meta); null для email. */
  providerTemplateName: string | null;
  approvalStatus: MessageTemplateApprovalStatus;
  /** Імена змінних у порядку шаблону; значення — лише мінімально потрібні дані. */
  variables: string[];
}

/**
 * Вікно обслуговування WhatsApp: довільний текст можна надсилати лише протягом 24 годин після
 * останнього повідомлення КЛІЄНТА; поза вікном — тільки затверджений шаблон.
 */
export interface CustomerServiceWindow {
  channel: CustomerMessagingChannelKind;
  lastInboundAt: Date | null;
  /** lastInboundAt + 24 год (для WhatsApp); null — вікно закрите або канал без вікна. */
  openUntil: Date | null;
}

/** Причини, з яких майбутня реалізація ЗОБОВ'ЯЗАНА відмовитися надсилати повідомлення. */
export type CustomerMessageBlockReason =
  | "no_consent"
  | "opted_out"
  | "template_not_approved"
  | "outside_service_window"
  | "channel_not_configured"
  | "automation_paused"
  | "rate_limited";

/** Чернетка для РУЧНОГО надсилання менеджером (поточний етап): програма її лише показує. */
export interface CustomerMessageDraft {
  orderId: string;
  locale: string;
  templateKey: string;
  text: string;
  /** Які поля запитуються (шляхи полів, напр. "shipping.postalCode") — без значень. */
  requestedFields: string[];
}

/** Вхідне повідомлення клієнта (майбутнє): текст — недовірені дані (markUntrusted), лише після маскування для ШІ. */
export interface InboundCustomerMessage {
  channel: CustomerMessagingChannelKind;
  providerMessageId: string;
  /** Внутрішній псевдонім розмови, не номер телефону. */
  conversationId: string;
  receivedAt: Date;
  text: string;
}

/**
 * Розширений канал (майбутня реалізація WhatsApp Business API / email). Кожен метод send* перевіряє
 * згоду, статус шаблону та вікно обслуговування НА СЕРВЕРІ й повертає причину відмови замість надсилання.
 */
export interface TemplatedCustomerMessagingChannel extends CustomerMessagingChannel {
  /** Ідентифікатор підключеного бізнес-номера/скриньки (вибір у налаштуваннях власника). */
  readonly senderId: string;
  getConsent(orderId: string): Promise<CustomerChannelConsent | null>;
  listTemplates(locale?: string): Promise<CustomerMessageTemplate[]>;
  getServiceWindow(orderId: string): Promise<CustomerServiceWindow>;
  sendTemplate(
    message: CustomerMessage,
  ): Promise<{ accepted: true; providerMessageId: string } | { accepted: false; reason: CustomerMessageBlockReason }>;
}
