/**
 * Мінімальний структурований логер із маскуванням персональних даних і секретів.
 * Правило: у журнали (stdout) не потрапляють телефони, email, адреси, імена, токени.
 */
const SENSITIVE_KEY_RE =
  /(phone|email|name|address|city|postal|zip|street|company|token|secret|password|authorization|cookie|apikey|api_key|access|refresh)/i;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /\+?\d[\d\s().-]{6,}\d/g;
// UUID не маскуються як телефони (інакше ідентифікатори в журналі ставали непридатними): їх тимчасово
// замінюємо маркерами, маскуємо телефони, потім повертаємо. Решта рядка маскується як раніше.
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

function maskString(value: string): string {
  const ids: string[] = [];
  const protectedText = value.replace(UUID_RE, (m) => `\u0000${ids.push(m) - 1}\u0000`);
  return protectedText
    .replace(EMAIL_RE, "[email]")
    .replace(PHONE_RE, "[phone]")
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => ids[Number(i)] ?? "");
}

/**
 * Повідомлення помилки без даних запиту: помилки БД (Drizzle) містять текст SQL і значення параметрів
 * (імена, адреси) — їх відкидаємо повністю, залишаємо лише тип і код SQLSTATE.
 */
function safeErrorMessage(message: string): string {
  if (/^Failed query/i.test(message)) return "Database query failed";
  const firstLine = message.split("\n")[0] ?? "";
  return firstLine.replace(/params:.*$/i, "").slice(0, 300);
}

function errorCode(error: Error): string | undefined {
  const own = (error as { code?: unknown }).code;
  const cause = (error as { cause?: { code?: unknown } }).cause?.code;
  const code = typeof own === "string" ? own : typeof cause === "string" ? cause : undefined;
  return code && /^[A-Z0-9_]{1,32}$/i.test(code) ? code : undefined;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return maskString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) {
    const code = errorCode(value);
    return {
      name: value.name,
      ...(code ? { code } : {}),
      message: redact(safeErrorMessage(value.message), depth + 1),
    };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

type Level = "debug" | "info" | "warn" | "error";

function write(level: Level, message: string, data?: Record<string, unknown>) {
  if (process.env.NODE_ENV === "test" && level !== "error") return;
  const line = JSON.stringify({ level, time: new Date().toISOString(), message, ...(data ? { data: redact(data) } : {}) });
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export const logger = {
  debug: (m: string, d?: Record<string, unknown>) => write("debug", m, d),
  info: (m: string, d?: Record<string, unknown>) => write("info", m, d),
  warn: (m: string, d?: Record<string, unknown>) => write("warn", m, d),
  error: (m: string, d?: Record<string, unknown>) => write("error", m, d),
};
