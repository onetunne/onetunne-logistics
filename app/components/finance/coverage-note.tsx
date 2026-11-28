/**
 * Етап 6, WP0-UI: рядок покриття «за N з M замовлень» / «на основі N з M накладних» (§2.6) з малим лічильником повноти
 * (смуга N/M, декоративна — число вже в тексті). Чисельник і знаменник — завжди той самий набір (правило повноти).
 */
import { useLocale, useT } from "~/i18n";
import type { CoverageNoteProps } from "./contracts";
import { countText } from "./format-ui";

/** Заповнення смуги у відсотках (ціле 0–100); m ≤ 0 → 0. */
export function coveragePercent(n: number, m: number): number {
  if (!Number.isFinite(n) || !Number.isFinite(m) || m <= 0 || n <= 0) return 0;
  return Math.min(100, Math.round((n * 100) / m));
}

export function CoverageNote({ n, m, kind = "orders" }: CoverageNoteProps) {
  const ft = useT();
  const locale = useLocale();
  const pct = coveragePercent(n, m);
  return (
    <span className="ot-coverage" data-coverage={`${n}/${m}`}>
      <span className="ot-coverage__meter" aria-hidden="true">
        <span className="ot-coverage__fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="ot-coverage__text">{ft(`financeUi.coverage.${kind}`, { n: countText(n, locale), m: countText(m, locale) })}</span>
    </span>
  );
}
