/**
 * Мінімальний структурований логер із маскуванням персональних даних і секретів.
 * Правило: у журнали (stdout) не потрапляють телефони, email, адреси, імена, токени.
 */
const SENSITIVE_KEY_RE =
  /(phone|email|name|address|city|postal|zip|street|company|token|secret|password|authorization|cookie|apikey|api_key|access|refresh)/i;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /\+?\d[\d\s().-]{6,}\d/g;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.replace(EMAIL_RE, "[email]").replace(PHONE_RE, "[phone]");
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) return { name: value.name, message: redact(value.message, depth + 1) };
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
