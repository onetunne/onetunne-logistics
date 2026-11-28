/**
 * Етап 6, WP9: ключі i18n модуля `returns` за родинами (app/i18n/messages/returns.ts) — єдиний спосіб отримати підпис
 * коду розділу «Повернення» (вид, статус, причина, стан позиції, джерело, сигнал перевізника, подія хронології). Родини
 * динамічні (`returns.kind.${код}`), тож перевірка «без зайвих ключів» бачить їх використаними; тест пакета перевіряє,
 * що для кожного коду є переклад uk/en (§18.10: `returns.reason.<code>`, `returns.kind.<kind>`).
 */
import type { RETURN_KINDS, RETURN_LINE_CONDITIONS, RETURN_REASON_CODES, RETURN_SOURCES, RETURN_STATUSES } from "~/domain/finance";
import type { CarrierReturnSignal } from "./carrier-codes";
import type { ReturnMoneyGroup } from "./money-groups";
import type { ReturnLineOrigin, ReturnTimelineType } from "./cases.server";

export const returnsLabelKeys = {
  kind: (k: (typeof RETURN_KINDS)[number]) => `returns.kind.${k}`,
  status: (s: (typeof RETURN_STATUSES)[number]) => `returns.status.${s}`,
  reason: (r: (typeof RETURN_REASON_CODES)[number]) => `returns.reason.${r}`,
  condition: (c: (typeof RETURN_LINE_CONDITIONS)[number]) => `returns.condition.${c}`,
  source: (s: (typeof RETURN_SOURCES)[number]) => `returns.source.${s}`,
  signal: (s: CarrierReturnSignal) => `returns.signal.${s}`,
  origin: (o: ReturnLineOrigin) => `returns.origin.${o}`,
  timeline: (t: ReturnTimelineType) => `returns.timeline.${t}`,
  money: (g: ReturnMoneyGroup | "returnCosts") => `returns.money.${g}`,
} as const;
