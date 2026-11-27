/**
 * ЗАПЛАНОВАНО (етап 7): контракт AI-асистента / LLM-провайдера. Лише типи, без реалізації.
 *
 * Принципи:
 * - Модель змінна: провайдер і модель обираються в налаштуваннях, код залежить лише від LlmProvider.
 * - LLM НІКОЛИ не використовується для розрахунку тарифів у Checkout (лише детермінований код/перевізник).
 * - Інструменти (tools) перевіряються на сервері: дозвіл (requiredPermission) актора, рівень ризику,
 *   підтвердження людиною для небезпечних дій. Відповідь моделі — лише пропозиція виклику.
 * - Дані клієнтів, що передаються моделі, мінімізовані; будь-який текст від клієнтів (адреси, нотатки)
 *   вважається недовіреним (захист від prompt injection) і не може змінювати інструкції чи права.
 * - Витрати обліковуються (usage, costUsd) і обмежуються бюджетом (AiBudget).
 */
import type { Permission } from "~/domain/permissions";

/** Режим автоматизації AI: manual — лише пропозиції; semi — безпечні дії; auto — у межах правил і бюджету. */
export type AiAutomationMode = "manual" | "semi" | "auto";

/** read — читання; write — зміна даних; critical — незворотні/зовнішні дії; financial — гроші. */
export type AiToolRisk = "read" | "write" | "critical" | "financial";

export interface AiToolDefinition {
  name: string;
  description: string;
  /** JSON Schema вхідних параметрів інструмента. */
  inputSchema: Record<string, unknown>;
  /** Дозвіл, який перевіряється на сервері для актора, від імені якого діє AI. */
  requiredPermission: Permission;
  risk: AiToolRisk;
  /** true — виклик виконується лише після явного підтвердження людиною. */
  requiresConfirmation: boolean;
}

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  tools?: AiToolDefinition[];
  maxOutputTokens: number;
}

export interface LlmToolCall {
  name: string;
  /** Недовірені дані: валідуються за inputSchema перед виконанням. */
  input: unknown;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResponse {
  text: string;
  toolCalls: LlmToolCall[];
  usage: LlmUsage;
  /** Вартість виклику в USD (десятковий рядок) або null, якщо невідома. */
  costUsd: string | null;
}

export interface LlmProvider {
  /** Ідентифікатор провайдера (з налаштувань). */
  id: string;
  /** Ідентифікатор моделі (з налаштувань). */
  model: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/** Місячний бюджет AI. Гроші — десяткові рядки, напр. "50.00". */
export interface AiBudget {
  monthlyLimitUsd: string;
  spentUsd: string;
}

// ---------------------------------------------------------------------------
// Виконання інструментів асистента (етап 4: реалізовано виконавця без моделі —
// app/modules/assistant/tools.server.ts). Модель ще НЕ підключена: виклики надходять лише з коду/тестів.
// ---------------------------------------------------------------------------

export interface AiToolExecutionOptions {
  /**
   * true — людина (менеджер/власник) явно підтвердила САМЕ цей виклик з цими параметрами.
   * Модель не може встановити це значення: його передає серверний маршрут після натискання кнопки.
   */
  confirmed?: boolean;
  /**
   * Бажаний режим. Фактичний режим — суворіший з бажаного і налаштування власника (`automation.mode`),
   * тобто виклик не може підвищити рівень автоматизації понад дозволений власником.
   */
  mode?: AiAutomationMode;
}

export type AiToolRefusalReason =
  | "unknown_tool"
  | "invalid_input"
  | "forbidden"
  | "global_pause"
  | "order_paused"
  /** Підтверджено іншу накладну, ніж активна зараз (змінилася після попереднього перегляду) — нічого не змінено. */
  | "stale_confirmation";

/** Чому потрібне підтвердження: режим manual, інструмент позначено як небезпечний, критична/фінансова дія. */
export type AiConfirmationReason = "manual_mode" | "tool_requires_confirmation" | "critical_or_financial";

export interface AiToolInputIssue {
  path: string;
  message: string;
}

export type AiToolExecutionResult =
  | { status: "ok"; tool: string; risk: AiToolRisk; data: unknown }
  | {
      status: "confirmation_required";
      tool: string;
      risk: AiToolRisk;
      reason: AiConfirmationReason;
      /** Нормалізовані параметри, які буде виконано після підтвердження (показати людині). */
      input: unknown;
      /** Попередній перегляд наслідків (якщо інструмент його надає), напр. різниця «було → стане». */
      preview: unknown;
    }
  | {
      status: "refused";
      tool: string;
      reason: AiToolRefusalReason;
      /** Для forbidden — відсутній дозвіл; для invalid_input — помилки полів (без значень). */
      permission?: Permission;
      issues?: AiToolInputIssue[];
    }
  | { status: "error"; tool: string; risk: AiToolRisk; code: string; params: Record<string, string | number> };
