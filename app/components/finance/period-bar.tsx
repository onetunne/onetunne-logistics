/**
 * Етап 6, WP0-UI: вибір періоду (§12.1, §18.3) — GET-форма: шаблон («Цей місяць», «30 днів» …), довільний період
 * (від/до, лише з `allowCustom`), відрізок і порівняння (у розгортанні «Ще», згорнутому на телефоні), поточний відрізок
 * дат стисло («01–27.11.2026»). Параметри запиту — `${paramPrefix}period|from|to|granularity|compare` (типово без
 * префікса); ІНШІ параметри сторінки (вкладка, валюта, фільтри) зберігаються прихованими полями, пагінація
 * (`page`, `cursor`) скидається. Перевіряє й обмежує період сервер сторінки (lib/periods: ≤ 366 днів / ≤ 5 років).
 *
 * Пропси — `PeriodBarProps` з contracts.ts; додаткові необов'язкові (`PeriodBarExtraProps`): які елементи показувати
 * (`showGranularity`, `showCompare`, типово — ні: сторінка без відрізків і порівняння не показує зайвих полів) і
 * `extra` (напр. `CurrencySwitch`) у розгортанні «Ще».
 *
 * Поля — КЕРОВАНІ чернеткою (`PeriodDraft`), що скидається до пропсів, щойно змінився застосований період
 * (`syncPeriodDraft`: «Назад» у браузері, посилання з ?period=…, нормалізація періоду сервером). Інакше після
 * навігації без перемонтування поля показували б попередній вибір над числами іншого періоду, а «Застосувати»
 * непомітно повертало б його (§12.1, §18.3: панель періоду називає саме той період, за який показано числа).
 */
import { useId, useState } from "react";
import { Form, useLocation } from "react-router";
import { useLocale, useT } from "~/i18n";
import {
  COMPARE_MODES,
  GRANULARITIES,
  PERIOD_PRESETS,
  comparisonRange,
  isAllowedCustomRange,
  type CompareMode,
  type Granularity,
  type PeriodPreset,
} from "~/lib/periods";
import { financeLabelKeys } from "~/modules/finance/core/labels";
import { Button, Disclosure, Select, TextField } from "~/ui";
import type { PeriodBarProps } from "./contracts";
import { formatDateRange } from "./format-ui";

/** Додаткові пропси WP0-UI — тепер частина контракту (PeriodBarProps); псевдонім для сумісності. */
export type PeriodBarExtraProps = Pick<PeriodBarProps, "showGranularity" | "showCompare" | "granularities" | "extra">;

/** Параметри запиту PeriodBar з префіксом. */
export function periodParamNames(prefix = "") {
  return {
    period: `${prefix}period`,
    from: `${prefix}from`,
    to: `${prefix}to`,
    granularity: `${prefix}granularity`,
    compare: `${prefix}compare`,
  } as const;
}

/** Чернетка полів панелі: те, що вибрав користувач до «Застосувати»; `key` — застосований період, з якого вона почалась. */
export interface PeriodDraft {
  key: string;
  preset: PeriodPreset;
  from: string;
  to: string;
  granularity: Granularity;
  compare: CompareMode;
}

type AppliedPeriod = Pick<PeriodBarProps, "preset" | "range" | "granularity" | "compare">;

/** Ключ застосованого періоду (пропсів): змінюється з будь-якою зміною того, за що показано числа. */
export function periodDraftKey(p: AppliedPeriod): string {
  return [p.preset, p.range.from, p.range.to, p.granularity, p.compare].join("|");
}

/** Чернетка з застосованого періоду. */
export function draftFromProps(p: AppliedPeriod): PeriodDraft {
  return { key: periodDraftKey(p), preset: p.preset, from: p.range.from, to: p.range.to, granularity: p.granularity, compare: p.compare };
}

/**
 * Узгодження чернетки з пропсами (чиста функція): той самий застосований період — чернетка користувача лишається
 * (той самий об'єкт); інший — чернетка скидається до нового періоду (вибір, не застосований до навігації, відкидається).
 */
export function syncPeriodDraft(draft: PeriodDraft, p: AppliedPeriod): PeriodDraft {
  return draft.key === periodDraftKey(p) ? draft : draftFromProps(p);
}

/** Параметри поточного запиту, які форма передає далі прихованими полями (усі, крім керованих і пагінації). */
export function preservedParams(search: string, controlled: readonly string[]): Array<[string, string]> {
  const skip = new Set([...controlled, "page", "cursor"]);
  return [...new URLSearchParams(search).entries()].filter(([k]) => !skip.has(k));
}

export function PeriodBar({
  preset,
  range,
  granularity,
  compare,
  presets = PERIOD_PRESETS,
  allowCustom = false,
  paramPrefix = "",
  showGranularity = false,
  showCompare = false,
  granularities = GRANULARITIES,
  extra,
}: PeriodBarProps & PeriodBarExtraProps) {
  const ft = useT();
  const locale = useLocale();
  const location = useLocation();
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, "");
  const names = periodParamNames(paramPrefix);
  const applied: AppliedPeriod = { preset, range, granularity, compare };
  const [stored, setDraft] = useState<PeriodDraft>(() => draftFromProps(applied));
  // Застосований період змінився без перемонтування — скинути чернетку під час рендеру (React: «adjusting state when a
  // prop changes»), щоб жоден кадр не показав старий вибір над новими числами.
  const draft = syncPeriodDraft(stored, applied);
  if (draft !== stored) setDraft(draft);
  const edit = (patch: Partial<Omit<PeriodDraft, "key">>) => setDraft((d) => ({ ...syncPeriodDraft(d, applied), ...patch }));
  const selected = draft.preset;
  const presetOptions = presets.filter((p) => allowCustom || p !== "custom");
  if (!presetOptions.includes(preset)) presetOptions.unshift(preset);
  const controlled: string[] = [names.period, names.from, names.to];
  if (showGranularity) controlled.push(names.granularity);
  if (showCompare) controlled.push(names.compare);
  const preserved = preservedParams(location.search, controlled);
  const custom = allowCustom && selected === "custom";
  const hasMore = showGranularity || showCompare || extra !== undefined;
  return (
    <Form method="get" preventScrollReset className="ot-period-bar">
      {preserved.map(([k, v], i) => (
        <input key={`${k}:${i}`} type="hidden" name={k} value={v} />
      ))}
      <div className="ot-period-bar__main">
        <Select
          id={`${uid}-period`}
          label={ft("financeUi.period.label")}
          name={names.period}
          value={selected}
          onChange={(e) => edit({ preset: e.currentTarget.value as PeriodPreset })}
          options={presetOptions.map((p) => ({ value: p, label: ft(financeLabelKeys.period(p)) }))}
          className="ot-period-bar__preset"
        />
        {custom ? (
          <>
            <TextField
              id={`${uid}-from`}
              type="date"
              label={ft("financeUi.period.from")}
              name={names.from}
              value={draft.from}
              onChange={(e) => edit({ from: e.currentTarget.value })}
              required
              className="ot-period-bar__date"
            />
            <TextField
              id={`${uid}-to`}
              type="date"
              label={ft("financeUi.period.to")}
              name={names.to}
              value={draft.to}
              onChange={(e) => edit({ to: e.currentTarget.value })}
              required
              className="ot-period-bar__date"
            />
          </>
        ) : null}
        <p className="ot-period-bar__range ot-text--numeric" data-from={range.from} data-to={range.to}>
          {formatDateRange(range, locale)}
        </p>
        <Button type="submit" variant="secondary">
          {ft("common.apply")}
        </Button>
      </div>
      {hasMore ? (
        <Disclosure collapsedOnMobile summary={ft("financeUi.period.more")} className="ot-period-bar__extra">
          <div className="ot-period-bar__extra-body">
            {showGranularity ? (
              <Select
                id={`${uid}-granularity`}
                label={ft("financeUi.period.granularity")}
                name={names.granularity}
                value={draft.granularity}
                onChange={(e) => edit({ granularity: e.currentTarget.value as Granularity })}
                options={granularities.map((g) => ({
                  value: g,
                  label: ft(financeLabelKeys.granularity(g)),
                  // Забагато відрізків для поточного періоду (§12.1: день/тиждень — ≤ 366 днів).
                  disabled: g !== granularity && !isAllowedCustomRange(range, g),
                }))}
              />
            ) : null}
            {showCompare ? (
              <Select
                id={`${uid}-compare`}
                label={ft("financeUi.period.compare")}
                name={names.compare}
                value={draft.compare}
                onChange={(e) => edit({ compare: e.currentTarget.value as CompareMode })}
                options={COMPARE_MODES.map((m) => ({ value: m, label: ft(financeLabelKeys.compare(m)) }))}
                helpText={
                  compare !== "none" ? ft("financeUi.period.compareRange", { range: formatDateRange(comparisonRange(range, compare), locale) }) : undefined
                }
              />
            ) : null}
            {extra}
          </div>
        </Disclosure>
      ) : null}
    </Form>
  );
}
