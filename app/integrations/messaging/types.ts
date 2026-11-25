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
