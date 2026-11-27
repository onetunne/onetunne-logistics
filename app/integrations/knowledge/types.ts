/**
 * ЗАПЛАНОВАНО: база знань для майбутнього ШІ-асистента й автовідповідача (етапи 7–10).
 * Лише контракти + порожня реалізація NullKnowledgeBase. Імпорт реальних даних НЕ РЕАЛІЗОВАНИЙ.
 *
 * Джерело знань, яке готує власник, — історія листування ONE TUNNE у WhatsApp. Правила (див.
 * docs/ai-whatsapp-readiness.md):
 * - Джерела додає й затверджує ЛИШЕ власник; кожне має правову підставу, строк зберігання й відповідального.
 * - До бази потрапляє лише ЗНЕОСОБЛЕНИЙ текст (app/modules/privacy/redact.ts + ручна перевірка):
 *   без телефонів, email, адрес, імен, номерів карток/IBAN, вкладень і голосових.
 * - Записи бази — довідка (як відповідати, типові питання), а НЕ інструкції для моделі: результат пошуку
 *   передається моделі через markUntrusted(..., { source: "knowledge_base" }).
 * - Зберігання окреме від замовлень (окрема таблиця/сховище), щоб видалення джерела видаляло всі його документи.
 */

export type KnowledgeSourceKind = "whatsapp_export" | "manual" | "faq";

/**
 * Правова підстава обробки (GDPR ст. 6 / Закон України «Про захист персональних даних»).
 * Остаточний вибір — за власником (за потреби з юристом); "none" — джерело не можна індексувати.
 */
export type KnowledgeLegalBasis = "consent" | "legitimate_interest" | "contract" | "anonymised" | "none";

export type KnowledgeSourceStatus =
  /** Завантажено, але не перевірено власником — у пошуку не бере участі. */
  | "pending_review"
  /** Перевірено й затверджено власником — використовується. */
  | "approved"
  /** Вимкнено (тимчасово). */
  | "disabled"
  /** Видаляється: документи прибираються, після завершення запис джерела лишається лише для журналу. */
  | "deleting";

export interface KnowledgeSource {
  id: string;
  kind: KnowledgeSourceKind;
  /** Назва для власника, без персональних даних (напр. "WhatsApp: питання про доставку, 2024–2026"). */
  title: string;
  status: KnowledgeSourceStatus;
  legalBasis: KnowledgeLegalBasis;
  /** Короткий опис підстави/згоди (без персональних даних), напр. посилання на внутрішнє рішення власника. */
  legalBasisNote: string | null;
  /** Строк зберігання документів джерела, днів; null — до ручного видалення власником. */
  retentionDays: number | null;
  /** Ідентифікатор власника, який затвердив джерело (actor.id), і коли. */
  approvedBy: string | null;
  approvedAt: Date | null;
  /** Період листування, який охоплює джерело (для WhatsApp-експорту). */
  coversFrom: Date | null;
  coversTo: Date | null;
  createdAt: Date;
}

export interface KnowledgeDocument {
  id: string;
  sourceId: string;
  /** Мова документа: "uk", "en", "de" тощо (ISO 639-1). */
  language: string;
  title: string;
  /** ВЖЕ знеособлений текст. Неперевірений сирий текст сюди не потрапляє. */
  content: string;
  tags: string[];
  /**
   * Затвердження власником окремого запису (напр. «зразкова відповідь про митницю»).
   * Записи без затвердження не використовуються автовідповідачем.
   */
  approved: boolean;
  /** Кількість замаскованих фрагментів під час підготовки (контроль якості, без значень). */
  redactionCounts?: Record<string, number>;
  createdAt: Date;
  /** Дата, після якої документ має бути видалений (з retentionDays джерела). */
  expiresAt: Date | null;
}

export interface KnowledgeSearchOptions {
  /** Бажана мова; null — будь-яка. */
  language: string | null;
  /** Максимум результатів (реалізація обмежує, напр. до 10). */
  limit: number;
  /** Лише затверджені записи (за замовчуванням true; false — тільки для екрана перевірки власником). */
  approvedOnly?: boolean;
  tags?: string[];
}

export interface KnowledgeSearchResult {
  document: Pick<KnowledgeDocument, "id" | "sourceId" | "language" | "title" | "content" | "tags">;
  /** Релевантність 0..1 (залежить від реалізації пошуку). */
  score: number;
}

export interface KnowledgeBase {
  /** Пошук довідки. Запит теж має бути знеособлений (redactPii) перед передачею в зовнішній сервіс пошуку. */
  search(query: string, options: KnowledgeSearchOptions): Promise<KnowledgeSearchResult[]>;
}

/** Порожня база знань: використовується, поки власник не підключив джерела. */
export class NullKnowledgeBase implements KnowledgeBase {
  async search(_query: string, _options: KnowledgeSearchOptions): Promise<KnowledgeSearchResult[]> {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Архів розмов (імпорт історії WhatsApp) — НЕ РЕАЛІЗОВАНО, лише контракт.
// ---------------------------------------------------------------------------

/** Формат вхідного файлу. WhatsApp «Експорт чату» дає .txt (без медіа) або .zip (з медіа — медіа НЕ імпортуємо). */
export type ConversationExportFormat = "whatsapp_txt" | "whatsapp_zip" | "whatsapp_business_api_json";

export interface ConversationImportRequest {
  /** Джерело, створене й затверджене власником заздалегідь (status "pending_review" → перевірка → "approved"). */
  sourceId: string;
  format: ConversationExportFormat;
  /** Шлях/ідентифікатор файлу в окремому сховищі (не в репозиторії, не в журналах). */
  fileRef: string;
  /** Мова за замовчуванням, якщо не визначена автоматично. */
  defaultLanguage: string | null;
}

export interface ConversationImportReport {
  sourceId: string;
  conversations: number;
  messages: number;
  /** Скільки повідомлень пропущено (медіа, системні, порожні, від невідомих учасників). */
  skipped: number;
  /** Кількість замаскованих фрагментів за типами — без самих значень. */
  redactionCounts: Record<string, number>;
  /** Документи створюються зі статусом approved=false — їх переглядає власник. */
  documentsCreated: number;
}

/**
 * Майбутній імпорт архіву розмов. Вимоги до реалізації:
 * - розбір файлу локально, без надсилання сирого тексту будь-яким зовнішнім сервісам (у т.ч. моделям);
 * - номери телефонів учасників → псевдоніми ("customer_1", "staff_1"); імена контактів не зберігаються;
 * - текст → redactPii(..., { numbered: true }) + ручна перевірка власником перед затвердженням;
 * - медіа, голосові, геолокації, контакти — не імпортуються;
 * - сирий файл видаляється після імпорту; зберігаються лише знеособлені документи;
 * - повторний імпорт того самого файлу не створює дублікатів (ідемпотентність за хешем вмісту).
 */
export interface ConversationArchive {
  importExport(request: ConversationImportRequest): Promise<ConversationImportReport>;
  /** Видаляє всі документи джерела (відкликання згоди, закінчення строку зберігання, рішення власника). */
  deleteSource(sourceId: string): Promise<{ deletedDocuments: number }>;
}
