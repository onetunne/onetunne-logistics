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
