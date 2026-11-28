/**
 * Етап 6, WP9: період статистики повернень із параметрів запиту (?period=<шаблон> або ?period=custom&from=&to=).
 * Чиста функція; довільний період — не довший за 5 років, from ≤ to, інакше — типовий шаблон («30 днів»).
 */
import {
  addMonths,
  isAllowedCustomRange,
  monthStart,
  parseIsoDate,
  PERIOD_PRESETS,
  resolvePreset,
  type DateRange,
  type PeriodPreset,
} from "~/lib/periods";

export const DEFAULT_RETURNS_PRESET: Exclude<PeriodPreset, "custom"> = "last30";

export function returnsPeriodOf(sp: URLSearchParams, today: string): { preset: PeriodPreset; range: DateRange } {
  const raw = sp.get("period") ?? "";
  const preset = (PERIOD_PRESETS as readonly string[]).includes(raw) ? (raw as PeriodPreset) : DEFAULT_RETURNS_PRESET;
  if (preset === "custom") {
    const from = parseIsoDate(sp.get("from"));
    const to = parseIsoDate(sp.get("to"));
    if (from && to && from <= to && isAllowedCustomRange({ from, to }, "month") && from >= addMonths(monthStart(today), -12 * 5)) {
      return { preset, range: { from, to } };
    }
    return {
      preset: DEFAULT_RETURNS_PRESET,
      range: resolvePreset(DEFAULT_RETURNS_PRESET, today),
    };
  }
  return { preset, range: resolvePreset(preset, today) };
}
