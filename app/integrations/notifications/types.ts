/**
 * ЗАПЛАНОВАНО (етап 8): службові сповіщення для власника/менеджерів (Telegram). Лише типи, без реалізації.
 *
 * Сповіщення — для команди, не для клієнтів. Вміст не містить персональних даних клієнтів:
 * лише номери замовлень/накладних, коди проблем і посилання в адмінку.
 */

export type NotificationCategory =
  | "daily_report"
  | "critical_error"
  | "waybill_problem"
  | "delivery_delay"
  | "api_problem"
  | "low_stock"
  | "cost_overrun";

export type NotificationSeverity = "info" | "warning" | "critical";

export interface Notification {
  category: NotificationCategory;
  severity: NotificationSeverity;
  title: string;
  /** Текст сповіщення. НЕ МІСТИТЬ персональних даних клієнтів (імен, телефонів, адрес, email). */
  body: string;
  /** Посилання на відповідну сторінку застосунку або null. */
  link: string | null;
}

export interface Notifier {
  readonly channel: "telegram";
  send(n: Notification): Promise<{ delivered: boolean }>;
}
