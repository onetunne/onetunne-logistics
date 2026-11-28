/**
 * Етап 6 (WP12a): еталонна модель НЕЗАЛЕЖНА від застосунку (§21.3: «без імпорту з app/»). Сканер перевіряє кожен
 * файл tests/stage6/reference/**: дозволені лише відносні імпорти всередині каталогу, `vitest` і вбудовані `node:*`.
 * Також: у даних золотих випадків немає персональних даних (email, телефони) — F9.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { REF_CATEGORY_NAMES } from "./model/categories";

const ROOT = dirname(fileURLToPath(import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|mts|js|mjs)$/.test(name) ? [p] : [];
  });
}

const IMPORT_RE = /(?:import|export)\s[^;'"]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;

function importsOf(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(IMPORT_RE)) out.push((m[1] ?? m[2] ?? m[3] ?? m[4])!);
  return out;
}

describe("еталонна модель не імпортує app/", () => {
  const files = walk(ROOT);

  it("знайдено файли моделі, даних і тестів", () => {
    expect(files.length).toBeGreaterThanOrEqual(15);
  });

  it("кожен імпорт — відносний усередині tests/stage6/reference, vitest або node:*", () => {
    const bad: string[] = [];
    for (const f of files) {
      for (const spec of importsOf(readFileSync(f, "utf8"))) {
        if (spec === "vitest" || spec.startsWith("node:")) continue;
        if (!spec.startsWith(".")) {
          bad.push(`${relative(ROOT, f)} → ${spec}`);
          continue;
        }
        const target = resolve(dirname(f), spec);
        if (!(target === ROOT || target.startsWith(ROOT + sep))) bad.push(`${relative(ROOT, f)} → ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("сканер ловить заборонені імпорти (самоперевірка)", () => {
    // Лапки підставляються під час виконання (Q → "), щоб зразки не спрацьовували на самому цьому файлі.
    const src = (s: string) => s.replaceAll("Q", '"');
    expect(importsOf(src("import { x } from Q~/lib/decimalQ;"))).toEqual(["~/lib/decimal"]);
    expect(importsOf(src("export * from Q../../../app/lib/moneyQ;"))).toEqual(["../../../app/lib/money"]);
    expect(importsOf(src("const m = await import(Q~/domain/financeQ);"))).toEqual(["~/domain/finance"]);
    expect(importsOf(src("import Q../../app/xQ;"))).toEqual(["../../app/x"]);
    expect(importsOf(src("import type { T } from Q./model/fxQ;"))).toEqual(["./model/fx"]);
    expect(importsOf(src("import {\n  a,\n  b,\n} from Q~/modules/finance/core/keysQ;"))).toEqual(["~/modules/finance/core/keys"]);
  });

  it("у даних золотих випадків немає email і телефонів (F9)", () => {
    const golden = files.filter((f) => f.includes(`${sep}golden${sep}`));
    expect(golden.length).toBeGreaterThan(0);
    for (const f of golden) {
      const text = readFileSync(f, "utf8");
      expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
      expect(text).not.toMatch(/\+\d{10,13}\b/);
    }
  });

  it("перелік категорій моделі — рівно 44 категорії §2.1 (власна копія)", () => {
    expect(REF_CATEGORY_NAMES).toHaveLength(44);
    expect(new Set(REF_CATEGORY_NAMES).size).toBe(44);
  });
});
