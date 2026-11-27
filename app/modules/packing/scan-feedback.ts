/**
 * Повідомлення про останнє сканування на екрані пакування (чиста логіка для сторінки): результат сканування не має
 * «висіти» після інших дій. Повідомлення ховається:
 * - коли пакувальник робить іншу дію (збереження посилки, ±1, «Запаковано» тощо) — старе «Помилка …» інакше
 *   стояло б поруч із новим «Збережено»;
 * - через час: вдале — SCAN_FEEDBACK_TTL_MS.ok, помилка — SCAN_FEEDBACK_TTL_MS.error (довше: її треба прочитати).
 * Нове сканування завжди показує свій результат.
 */

export const SCAN_FEEDBACK_TTL_MS = { ok: 6_000, error: 20_000 } as const;

export interface ScanFeedbackState {
  /** Номер показаного результату (зростає з кожним новим результатом сканування). */
  seq: number;
  visible: boolean;
  ok: boolean;
  shownAt: number;
}

export type ScanFeedbackEvent =
  /** Новий результат сканування. */
  | { type: "result"; ok: boolean; at: number }
  /** Інша дія на сторінці (не сканування). */
  | { type: "otherAction"; at: number }
  /** Перевірка часу (таймер сторінки). */
  | { type: "tick"; at: number };

export const INITIAL_SCAN_FEEDBACK: ScanFeedbackState = { seq: 0, visible: false, ok: true, shownAt: 0 };

export function scanFeedbackReducer(state: ScanFeedbackState, event: ScanFeedbackEvent): ScanFeedbackState {
  switch (event.type) {
    case "result":
      return { seq: state.seq + 1, visible: true, ok: event.ok, shownAt: event.at };
    case "otherAction":
      return state.visible ? { ...state, visible: false } : state;
    case "tick": {
      if (!state.visible) return state;
      const ttl = state.ok ? SCAN_FEEDBACK_TTL_MS.ok : SCAN_FEEDBACK_TTL_MS.error;
      return event.at - state.shownAt >= ttl ? { ...state, visible: false } : state;
    }
  }
}
