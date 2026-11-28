/**
 * Етап 6, WP0-UI (рецензія): PeriodBar МАЄ показувати період, за який показано числа (§12.1, §18.3), і після навігації
 * БЕЗ перемонтування (браузерне «Назад», посилання з ?period=…, нормалізація періоду сервером) — поля не лишаються на
 * попередньому виборі, а «Застосувати» не повертає його непомітно.
 *
 * Середовище Vitest — node без DOM, тож повторний рендер змонтованого компонента моделюється так: перший SSR-рендер
 * PeriodBar з попередніми пропсами ЗАПИСУЄ його стан (перший `useState` компонента — будь-якої форми), другий — з новими
 * пропсами — ВІДТВОРЮЄ записаний стан, як React для компонента, що не перемонтовувався (решта хуків — справжні).
 * Рендер з новими пропсами має показати їх (і попросити React скинути стан), з тими самими — вибір користувача.
 * Плюс чиста `syncPeriodDraft` і перевірка, що жодне поле не лишилося некерованим (`defaultValue`: стан DOM, якого SSR
 * не відтворює). Поведінку в браузері після гідратації перевірено окремо (Playwright, звіт WP0-UI).
 */
import fs from "node:fs";
import { createElement as h, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PeriodBarProps } from "~/components/finance/contracts";
import { PeriodBar, draftFromProps, periodDraftKey, syncPeriodDraft, type PeriodDraft } from "~/components/finance/period-bar";
import { renderUi } from "./render";

/** Запис / відтворення стану першого `useState` компонента, рендер якого «озброєно» обгорткою `Armed`. */
const hooks: { armed: boolean; mode: "record" | "replay"; recorded: unknown; sets: unknown[] } = { armed: false, mode: "record", recorded: undefined, sets: [] };

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  function useState<S>(init: S | (() => S)) {
    if (!hooks.armed) return actual.useState(init);
    hooks.armed = false;
    if (hooks.mode === "record") {
      const pair = actual.useState(init);
      hooks.recorded = pair[0];
      return pair;
    }
    actual.useState(init); // той самий порядок хуків
    return [hooks.recorded as S, (v: unknown) => hooks.sets.push(v)] as const;
  }
  return { ...actual, default: { ...actual, useState }, useState };
});

afterEach(() => {
  hooks.armed = false;
  hooks.recorded = undefined;
  hooks.sets = [];
});

/** Обгортка: наступний компонент (PeriodBar) — перший, хто викличе useState (SSR рендерить дерево вглиб по черзі). */
function Armed({ children }: { children: ReactNode }) {
  hooks.armed = true;
  return children;
}

const NOV = { from: "2026-11-01", to: "2026-11-27" };
const YEAR = { from: "2026-01-01", to: "2026-11-27" };
const WEEK = { from: "2026-11-21", to: "2026-11-27" };

const selected = (html: string, name: string) => {
  const select = new RegExp(`<select[^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`).exec(html)?.[1] ?? "";
  return /<option value="([^"]+)" selected=""/.exec(select)?.[1] ?? null;
};
const inputValue = (html: string, name: string) => new RegExp(`<input[^>]*name="${name}"[^>]*value="([^"]*)"`).exec(html)?.[1] ?? null;

type BarProps = PeriodBarProps & { showCompare?: boolean; showGranularity?: boolean };
const MORE = { showCompare: true, showGranularity: true };

/** Рендер `next` компонентом, що вже був змонтований з `prev` (стан першого рендеру відтворено), і, за потреби, правка стану. */
async function rerender(prev: BarProps, next: BarProps, edit?: (state: unknown) => unknown) {
  hooks.mode = "record";
  await renderUi(() => h(Armed, null, h(PeriodBar, { ...MORE, ...prev })));
  const kind = typeof hooks.recorded;
  expect(kind === "string" || kind === "object", "PeriodBar keeps its choice in its first useState").toBe(true);
  if (edit) hooks.recorded = edit(hooks.recorded);
  hooks.mode = "replay";
  return renderUi(() => h(Armed, null, h(PeriodBar, { ...MORE, ...next })));
}

describe("syncPeriodDraft", () => {
  const month: PeriodBarProps = { preset: "thisMonth", range: NOV, granularity: "day", compare: "none" };
  const year: PeriodBarProps = { preset: "thisYear", range: YEAR, granularity: "month", compare: "previous" };

  it("same applied period → the user's unsaved choice stays (same object)", () => {
    const edited: PeriodDraft = { ...draftFromProps(month), preset: "thisYear", compare: "lastYear" };
    expect(syncPeriodDraft(edited, month)).toBe(edited);
  });

  it("another applied period (Back, a link, server normalisation) → the draft follows the props", () => {
    const stale: PeriodDraft = draftFromProps(year);
    expect(syncPeriodDraft(stale, month)).toEqual({ key: periodDraftKey(month), preset: "thisMonth", from: "2026-11-01", to: "2026-11-27", granularity: "day", compare: "none" });
    // Лише інша дата, відрізок чи порівняння — теж інший період.
    for (const p of [
      { ...month, range: WEEK },
      { ...month, granularity: "week" as const },
      { ...month, compare: "previous" as const },
      { ...month, preset: "last30" as const },
    ]) {
      expect(syncPeriodDraft(draftFromProps(month), p)).toEqual(draftFromProps(p));
    }
  });
});

describe("PeriodBar keeps its controls in sync with the URL without remounting", () => {
  const month: BarProps = { preset: "thisMonth", range: NOV, granularity: "day", compare: "none" };
  const year: BarProps = { preset: "thisYear", range: YEAR, granularity: "month", compare: "previous" };

  it("Back after applying «This year»: the fields follow the props, not the previous choice", async () => {
    // Змонтовано з «Цей рік» (вибір застосовано), «Назад» → «Цей місяць» без порівняння, без перемонтування.
    const html = await rerender(year, month);
    expect(selected(html, "period")).toBe("thisMonth");
    expect(selected(html, "compare")).toBe("none");
    expect(selected(html, "granularity")).toBe("day");
    // React отримує запит скинути збережений стан до нового періоду (інакше наступний рендер знову показав би старе).
    expect(hooks.sets).toEqual([draftFromProps(month)]);
  });

  it("a link to ?period=last7 and a server-normalised custom range: fields show the applied period", async () => {
    const last7 = await rerender(year, { preset: "last7", range: WEEK, granularity: "day", compare: "none" });
    expect(selected(last7, "period")).toBe("last7");
    // Довільний період, який сервер звузив (напр. до 366 днів): дати — з пропсів, не з попереднього вводу.
    const wide: BarProps = { preset: "custom", range: { from: "2020-01-01", to: "2026-11-27" }, granularity: "day", compare: "none", allowCustom: true };
    const custom = await rerender(wide, { ...wide, range: { from: "2025-11-27", to: "2026-11-27" } });
    expect(selected(custom, "period")).toBe("custom");
    expect(inputValue(custom, "from")).toBe("2025-11-27");
    expect(inputValue(custom, "to")).toBe("2026-11-27");
  });

  it("the same applied period keeps the user's unsaved choice (controlled fields, no reset)", async () => {
    const applied: BarProps = { ...month, allowCustom: true };
    const html = await rerender(applied, applied, (d) => ({
      ...(d as PeriodDraft),
      preset: "custom",
      from: "2026-10-01",
      to: "2026-10-31",
      compare: "lastYear",
      granularity: "week",
    }));
    expect(selected(html, "period")).toBe("custom");
    expect(inputValue(html, "from")).toBe("2026-10-01");
    expect(inputValue(html, "to")).toBe("2026-10-31");
    expect(selected(html, "compare")).toBe("lastYear");
    expect(selected(html, "granularity")).toBe("week");
    expect(hooks.sets).toEqual([]);
    // Рядок періоду — завжди застосований період (за який показано числа), не чернетка.
    expect(html).toMatch(/data-from="2026-11-01" data-to="2026-11-27"/);
  });

  it("no field is uncontrolled: every value comes from the draft, which is synced on render", () => {
    const src = fs.readFileSync("app/components/finance/period-bar.tsx", "utf8");
    expect(src).not.toMatch(/defaultValue/);
    expect(src).toMatch(/const draft = syncPeriodDraft\(stored, applied\);/);
    for (const field of ["selected", "draft.from", "draft.to", "draft.granularity", "draft.compare"]) expect(src).toContain(`value={${field}}`);
  });
});
