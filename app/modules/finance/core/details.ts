/**
 * Етап 6: перевірка `details` записів журналу, розбіжностей, оцінок (jsonb без персональних даних, F9). Дозволено:
 * коди, id, кількості, десяткові рядки, ISO-дати, булеві, короткі списки. Ключі — camelCase; ключі, що натякають на
 * персональні дані (ім'я, email, телефон, адреса, місто, індекс, примітка…), відхиляються.
 */
import { z } from "zod";

export const DETAIL_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/;
/** Ключі, яких не може бути у фінансових деталях (той самий шаблон, що перевіряє тест набору для ШІ, §13.4). */
export const PII_KEY_RE = /(name|email|phone|address|city|zip|postal|street|note|comment|customer|recipient)/i;
export const MAX_DETAIL_STRING = 200;
const MAX_DETAIL_KEYS = 40;
const MAX_DETAIL_LIST = 50;

const scalar = z.union([z.string().max(MAX_DETAIL_STRING), z.number().finite(), z.boolean(), z.null()]);
const value = z.union([scalar, z.array(z.union([z.string().max(MAX_DETAIL_STRING), z.number().finite()])).max(MAX_DETAIL_LIST)]);

export const financeDetailsSchema = z
  .record(z.string(), value)
  .refine((d) => Object.keys(d).length <= MAX_DETAIL_KEYS, "tooManyKeys")
  .refine((d) => Object.keys(d).every((k) => DETAIL_KEY_RE.test(k) && !PII_KEY_RE.test(k)), "forbiddenKey");

export type FinanceDetailsInput = z.infer<typeof financeDetailsSchema>;

/** Перевіряє деталі (RangeError — помилка програміста, не користувача). */
export function assertFinanceDetails(details: unknown): FinanceDetailsInput {
  const parsed = financeDetailsSchema.safeParse(details ?? {});
  if (!parsed.success) {
    const keys = details && typeof details === "object" ? Object.keys(details).join(",") : typeof details;
    throw new RangeError(`invalid finance details (${keys})`);
  }
  return parsed.data;
}
