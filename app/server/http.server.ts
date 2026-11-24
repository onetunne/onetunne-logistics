import { ZodError } from "zod";
import { ForbiddenError } from "~/domain/permissions";
import { DomainError } from "~/lib/errors";
import { logger } from "~/lib/logger.server";

/** Безпечне перетворення помилок дій у відповідь для UI (без внутрішніх деталей). */
export type ActionError = { ok: false; error: string; params?: Record<string, string | number>; fieldErrors?: Record<string, string> };

export function toActionError(e: unknown): ActionError {
  if (e instanceof Response) throw e;
  if (e instanceof ForbiddenError) return { ok: false, error: "error.forbidden" };
  if (e instanceof DomainError) return { ok: false, error: e.code, params: e.params };
  if (e instanceof ZodError) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of e.issues) fieldErrors[issue.path.join(".")] ??= issue.message;
    return { ok: false, error: "error.validation", fieldErrors };
  }
  logger.error("action.unexpected_error", { error: e });
  return { ok: false, error: "error.generic" };
}

/** Перевірка дозволу в loader: 403 замість даних. */
export function forbidden(): Response {
  return new Response("Forbidden", { status: 403 });
}

export function formString(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
}

/** Дозволені лише відносні шляхи цього застосунку (захист від open redirect). */
export function safeRedirectPath(value: string | null | undefined, fallback: string): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  return value;
}
