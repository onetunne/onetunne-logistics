import { redactText, type RedactionKind } from "./redact";

/**
 * Вільний текст працівника, що зберігається в обліку й показується іншим працівникам: примітки рухів залишків
 * (inventory_movements.note — склад, матеріали, причини браку з виробництва), примітки надходжень з виробництва.
 *
 * Без email, IBAN, номерів карток, телефонів і довгих чисел (privacy/redact; телефон — будь-яка група з 7–15 цифр,
 * 16+ цифр — `[number]`: телефон, «склеєний» із сусіднім числом, теж не лишається відкритим). Імена/адреси шаблонами
 * не розпізнаються (обмеження redact.ts).
 * Пробіли нормалізовано (рядок для таблиці), обрізано до maxLength; порожньо → null.
 * Маскування — ДО обрізання: email чи телефон на межі maxLength інакше обрізався б і вже не розпізнавався
 * («…ivan.petren», «+380 67 1»). Обрізаний заповнювач («[ema») нічого не розкриває.
 * Ідемпотентно: maskFreeTextNote(maskFreeTextNote(x)) === maskFreeTextNote(x) — безпечно застосовувати і у викликача,
 * і в ledger (applyMovements маскує КОЖНУ примітку руху, тож новий викликач не може це пропустити).
 */
export const FREE_TEXT_NOTE_KINDS: readonly RedactionKind[] = ["email", "iban", "card", "phone", "number"];

/**
 * Скільки символів після maxLength ще маскується разом з текстом: довше за будь-який шаблон, що може перетнути межу
 * (email — до 254 символів за RFC 5321, IBAN з пробілами — до ~70, телефон із роздільниками — до ~60). Решту тексту
 * не обробляємо: вона все одно відкидається, а шаблон email на дуже довгому рядку працює повільно.
 */
export const NOTE_PII_LOOKAHEAD = 320;

export function maskFreeTextNote(note: string | null | undefined, maxLength = 500): string | null {
  const normalized = (note ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  const window = normalized.slice(0, maxLength + NOTE_PII_LOOKAHEAD);
  const masked = redactText(window, { kinds: FREE_TEXT_NOTE_KINDS }).slice(0, maxLength).trim();
  return masked || null;
}
