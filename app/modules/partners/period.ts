/**
 * Етап 6, WP7: період сторінок партнерів із параметрів запиту (?period=<шаблон> або ?period=custom&from=&to=).
 * Чиста функція; довільний період — не довший за 5 років, from ≤ to, інакше — типовий шаблон.
 */
import { addMonths, isAllowedCustomRange, monthStart, parseIsoDate, PERIOD_PRESETS, resolvePreset, type DateRange, type PeriodPreset } from "~/lib/periods";

export const DEFAULT_PARTNER_PRESET: Exclude<PeriodPreset, "custom"> = "thisYear";

export function partnerPeriodOf(sp: URLSearchParams, today: string): { preset: PeriodPreset; range: DateRange } {
  const raw = sp.get("period") ?? "";
  const preset = (PERIOD_PRESETS as readonly string[]).includes(raw) ? (raw as PeriodPreset) : DEFAULT_PARTNER_PRESET;
  if (preset === "custom") {
    const from = parseIsoDate(sp.get("from"));
    const to = parseIsoDate(sp.get("to"));
    if (from && to && from <= to && isAllowedCustomRange({ from, to }, "month") && from >= addMonths(monthStart(today), -12 * 5)) {
      return { preset, range: { from, to } };
    }
    return { preset: DEFAULT_PARTNER_PRESET, range: resolvePreset(DEFAULT_PARTNER_PRESET, today) };
  }
  return { preset, range: resolvePreset(preset, today) };
}
