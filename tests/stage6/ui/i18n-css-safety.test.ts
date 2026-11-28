/**
 * Етап 6, WP0-UI: тексти, стилі й безпека спільних фінансових компонентів.
 * - модуль текстів `financeUi` (app/i18n/messages/finance-ui.ts, зареєстрований у MESSAGE_MODULES): однакові ключі
 *   uk/en, без порожніх, жоден інший модуль не перевизначає ці ключі, кожен ключ використано, кожен літеральний ключ
 *   перекладача існує, en — без кирилиці;
 * - styles.css, розділ «finance»: токени `--ot-chart-ink/muted/grid/hatch` для світлої, темної й системної темної тем,
 *   висота графіка на телефоні, prefers-reduced-motion;
 * - компоненти — клієнтські: без серверних модулів, без внутрішніх функцій проведення (F8), без normalizeAmount (F4),
 *   без parseFloat/toFixed над сумами; кожен компонент контракту експортує свою функцію.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import financeUiMessages from "~/i18n/messages/finance-ui";
import { INTERNAL_ONLY_MODULES, INTERNAL_POSTING_FUNCTIONS } from "~/modules/finance/core/contracts";
import { DICTIONARIES, MESSAGE_MODULES, translate as translateFinanceUi } from "~/i18n";
import { CYRILLIC } from "./render";

const DIR = path.resolve("app/components/finance");
const files = fs
  .readdirSync(DIR)
  .filter((f) => /\.(tsx?|ts)$/.test(f))
  .map((f) => ({ name: f, src: fs.readFileSync(path.join(DIR, f), "utf8") }));
const code = files;

describe("financeUi messages", () => {
  const uk = financeUiMessages.uk;
  const en = financeUiMessages.en;

  it("identical uk/en key sets, no empty strings, same placeholders, English without Cyrillic", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(uk).sort());
    for (const [k, v] of Object.entries(uk)) {
      expect(v.trim().length, k).toBeGreaterThan(0);
      expect(en[k]!.trim().length, k).toBeGreaterThan(0);
      const params = (s: string) => [...s.matchAll(/\{(\w+)[},]/g)].map((m) => m[1]).sort();
      expect(params(en[k]!), k).toEqual(params(v));
      expect(en[k], k).not.toMatch(CYRILLIC);
      expect(k.startsWith("financeUi."), k).toBe(true);
    }
  });

  it("registered as MESSAGE_MODULES.financeUi; no other module defines (overrides) these keys", () => {
    expect(MESSAGE_MODULES.financeUi).toBe(financeUiMessages);
    const others = Object.entries(MESSAGE_MODULES).filter(([name]) => name !== "financeUi");
    expect(Object.keys(uk).filter((k) => others.some(([, m]) => k in m.uk || k in m.en))).toEqual([]);
    for (const k of Object.keys(uk)) {
      expect(DICTIONARIES.uk[k], k).toBe(uk[k]);
      expect(DICTIONARIES.en[k], k).toBe(en[k]);
    }
  });

  it("every key is used by a component (literally or through a dynamic family)", () => {
    const src = code.map((f) => f.src).join("\n");
    const prefixes = [...src.matchAll(/`(financeUi\.[a-zA-Z0-9_.]+\.)\$\{/g)].map((m) => m[1]!);
    const unused = Object.keys(uk).filter((k) => !src.includes(`"${k}"`) && !prefixes.some((p) => k.startsWith(p)));
    expect(unused).toEqual([]);
  });

  it("every literal key passed to the translator exists (own module or shared dictionaries, uk and en)", () => {
    const missing: string[] = [];
    for (const f of code) {
      for (const m of f.src.matchAll(/\bft\(\s*"([a-zA-Z0-9_.]+)"/g)) {
        const key = m[1]!;
        if (!(key in uk || key in DICTIONARIES.uk) || !(key in en || key in DICTIONARIES.en)) missing.push(`${f.name}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("translator (shared translate): module keys and shared dictionaries; plurals and parameters", () => {
    expect(translateFinanceUi("uk", "financeUi.coverage.orders", { n: "1", m: "1" })).toBe("за 1 з 1 замовлення");
    expect(translateFinanceUi("en", "financeUi.coverage.orders", { n: "2", m: "3" })).toBe("for 2 of 3 orders");
    expect(translateFinanceUi("en", "finance.state.missing")).toBe("No data");
    expect(translateFinanceUi("uk", "common.apply")).toBe("Застосувати");
    expect(translateFinanceUi("en", "no.such.key")).toBe("no.such.key");
  });
});

describe("styles.css finance section", () => {
  const css = fs.readFileSync("app/ui/styles.css", "utf8");
  const start = css.indexOf("Фінанси (етап 6, WP0-UI");
  const section = css.slice(start);

  it("exists at the end of the file and defines chart tokens for light, dark and system-dark themes", () => {
    expect(start).toBeGreaterThan(0);
    const block = (selector: RegExp) => section.match(selector)?.[1] ?? "";
    const light = block(/:root \{([^}]*--ot-chart-ink[^}]*)\}/);
    const dark = block(/html\[data-theme="dark"\] \{([^}]*)\}/);
    const system = block(/@media \(prefers-color-scheme: dark\) \{\s*html\[data-theme="system"\] \{([^}]*)\}/);
    for (const [name, b] of [
      ["light", light],
      ["dark", dark],
      ["system", system],
    ] as const) {
      for (const token of ["--ot-chart-ink", "--ot-chart-muted", "--ot-chart-grid", "--ot-chart-hatch"]) expect(b, `${name} ${token}`).toContain(`${token}:`);
    }
    const norm = (b: string) => b.replace(/\s+/g, " ").trim();
    expect(norm(dark)).toEqual(norm(system));
    expect(section).toMatch(/@media \(max-width: 767\.98px\) \{\s*:root \{\s*--ot-chart-height: 140px;/);
  });

  it("hatching, completeness meter, reduced motion and print rules", () => {
    expect(section).toMatch(/\.ot-chart__hatch-line \{[^}]*stroke: var\(--ot-chart-hatch\)/);
    expect(section).toMatch(/\.ot-coverage__meter \{/);
    expect(section).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^@]*\.ot-breakdown__bar/);
    expect(section).toMatch(/@media print \{[^@]*\.ot-chart__tooltip/);
    // Цілі дотику: вибір файлу — кнопка UI-кіту (min-height = --ot-control-height, 44 px на телефоні), поле поверх неї.
    expect(section).toMatch(/\.ot-file__input \{[^}]*position: absolute;[^}]*inset: 0;[^}]*opacity: 0;/);
  });

  it("every class used by the components is styled in the finance section", () => {
    const used = new Set<string>();
    for (const f of code) for (const m of f.src.matchAll(/["` ](ot-(?:chart|kpi|money|state|marker|coverage|sparkline|breakdown|currency-switch|period-bar|completeness)[a-z0-9_-]*)/g)) used.add(m[1]!);
    const ignore = new Set(["ot-chart__bucket", "ot-chart__table", "ot-kpi__more", "ot-chart__hatch", "ot-chart__swatch--", "ot-state--", "ot-kpi--", "ot-money--forecast", "ot-money--missing"]);
    // Ім'я контейнера підписів осі X (не клас): оголошене в розділі як `container: ot-chart-xaxis / inline-size`.
    expect(section).toContain("container: ot-chart-xaxis / inline-size;");
    ignore.add("ot-chart-xaxis");
    const missing = [...used].filter((c) => !ignore.has(c) && !c.endsWith("-") && !section.includes(`.${c}`));
    expect(missing).toEqual([]);
  });

  it("touch targets: currency links are ≥ 44 px on phones and touch screens (§18.3), as the other controls", () => {
    const media = /@media \(max-width: 1023\.98px\), \(pointer: coarse\) \{\s*\.ot-currency-switch__link \{([^}]*)\}/.exec(section)?.[1] ?? "";
    expect(media).toMatch(/min-height: (44px|var\(--ot-control-height\));/);
    // Жодна ціль фінансових компонентів у розділі не задає висоту дотику менше 44 px під медіазапитом телефону.
    for (const m of section.matchAll(/min-height: (\d+)px;/g)) {
      const before = section.slice(0, m.index);
      const openMedia = before.lastIndexOf("@media (max-width: 1023.98px), (pointer: coarse)");
      const closed = openMedia >= 0 && /\n\}\n/.test(section.slice(openMedia, m.index));
      if (openMedia >= 0 && !closed) expect(Number(m[1]), section.slice(Math.max(0, m.index! - 80), m.index! + 20)).toBeGreaterThanOrEqual(44);
    }
  });
});

describe("client safety of app/components/finance", () => {
  it("no server modules, no internal posting functions, no normalizeAmount, no float parsing of money", () => {
    const internalNames = Object.keys(INTERNAL_POSTING_FUNCTIONS);
    for (const f of files) {
      expect(f.src, f.name).not.toMatch(/from\s+["'][^"']*\.server["']/);
      for (const mod of INTERNAL_ONLY_MODULES) expect(f.src, `${f.name} imports ${mod}`).not.toContain(`"${mod}"`);
      for (const name of internalNames) expect(f.src, `${f.name} uses ${name}`).not.toMatch(new RegExp(`\\b${name}\\b`));
      expect(f.src, f.name).not.toContain("normalizeAmount");
      expect(f.src, f.name).not.toMatch(/parseFloat|\.toFixed\(/);
    }
  });

  it("each contract component file exports its component", async () => {
    const expected: Record<string, string> = {
      "kpi-tile": "KpiTile",
      "state-badge": "StateBadge",
      "money-value": "MoneyValue",
      "period-bar": "PeriodBar",
      "currency-switch": "CurrencySwitch",
      "completeness-banner": "CompletenessBanner",
      "coverage-note": "CoverageNote",
      "profit-chart": "ProfitChart",
      "breakdown-bars": "BreakdownBars",
      sparkline: "Sparkline",
      "finance-tabs": "FinanceTabs",
    };
    for (const [file, name] of Object.entries(expected)) {
      const mod = (await import(`~/components/finance/${file}.tsx`)) as Record<string, unknown>;
      expect(typeof mod[name], `${file} → ${name}`).toBe("function");
    }
  });
});
