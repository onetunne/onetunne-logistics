/**
 * Етап 6, WP1: внутрішні функції курсів не доступні зі сторінок, маршрутів, команд та інструментів ШІ (§14.1 F8, §14.2
 * «внутрішні функції проведення … заборонені в pages/routes (тест-сканер)»). Доповнює сканер ядра
 * (tests/stage6/core/access-scanner.test.ts), поки ці функції не внесено в INTERNAL_POSTING_FUNCTIONS (CORE REQUEST):
 * - суто внутрішні модулі (будь-який імпорт, зокрема типів, побічний, динамічний, реекспорт — заборонено):
 *   conversions-internal.server (repriceConversions, conversionsNeedingRate — проводять / сторнують записи),
 *   rates-store.server (storeOfficialRates — пише курси, розбіжності, історію), impact.server (rateChangeImpact — Δ
 *   прибутку без requireFinance);
 * - змішаний модуль nbu-fetch.server (кнопки власника з requireFinance поруч із логікою завдань без перевірки актора):
 *   іменований імпорт логіки завдань, простір імен, типовий, динамічний імпорт і `export *` — заборонено;
 * - demo-rates.server (seedDemoRates — заповнення демо без актора) — лише для демо-заповнення.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(".");
const APP = path.join(ROOT, "app");
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");
const EXTS = [".ts", ".tsx", ".mjs", ".js"];

/** Суто внутрішні модулі WP1 → функції, які вони визначають. */
const INTERNAL_ONLY: Record<string, readonly string[]> = {
  "app/modules/fx/conversions-internal.server": ["repriceConversions", "conversionsNeedingRate", "exactRate", "conversionEntries", "conversionEntry"],
  "app/modules/fx/rates-store.server": ["storeOfficialRates"],
  "app/modules/fx/impact.server": ["rateChangeImpact", "loadRateRows", "scaledFrom"],
  "app/modules/fx/demo-rates.server": ["seedDemoRates"],
};
/** Змішані модулі: внутрішні функції поруч із публічними сервісами. */
const MIXED: Record<string, readonly string[]> = {
  "app/modules/fx/nbu-fetch.server": ["runFxFetch", "runFxBackfill", "runFxFetchScheduled", "scheduleFxChain", "enqueueFxFetch"],
};
const INTERNAL_NAMES = new Set([...Object.values(INTERNAL_ONLY), ...Object.values(MIXED)].flat());
/** Публічні модулі, які імпортує сторінка курсів: не відкривають внутрішніх функцій (ні визначенням, ні реекспортом). */
const PUBLIC_FX_MODULES = ["app/modules/fx/conversions.server", "app/modules/fx/manual-rates.server", "app/modules/fx/queries.server", "app/modules/fx/nbu-fetch.server"];

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.(tsx?|mjs)$/.test(e.name) ? [p] : [];
  });
}

function resolveModule(spec: string, fromFile: string): string | null {
  let abs: string;
  if (spec.startsWith("~/")) abs = path.join(APP, spec.slice(2));
  else if (spec.startsWith("./") || spec.startsWith("../")) abs = path.resolve(path.dirname(fromFile), spec);
  else return null;
  abs = abs.replace(/\.(?:tsx?|mjs|js)$/, "");
  if (!EXTS.some((e) => fs.existsSync(abs + e)) && EXTS.some((e) => fs.existsSync(path.join(abs, `index${e}`)))) abs = path.join(abs, "index");
  return rel(abs);
}

interface Ref {
  kind: "named" | "namespace" | "default" | "dynamic" | "side-effect" | "reexport-all" | "reexport-named";
  names: string[];
  from: string;
}

function importsOf(src: string): Ref[] {
  const code = src.replace(/(^|\n)[ \t]*\/\*[\s\S]*?\*\//g, "$1").replace(/^[ \t]*\/\/.*$/gm, "");
  const out: Ref[] = [];
  const names = (list: string) => list.split(",").map((x) => x.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim()).filter(Boolean);
  for (const m of code.matchAll(/\bimport\s+(?:type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g)) {
    const clause = m[1]!.trim();
    if (/\*\s+as\s+/.test(clause)) out.push({ kind: "namespace", names: [], from: m[2]! });
    const braces = /\{([\s\S]*)\}/.exec(clause);
    if (braces) out.push({ kind: "named", names: names(braces[1]!), from: m[2]! });
    const def = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause);
    if (def && def[1] !== "type") out.push({ kind: "default", names: [], from: m[2]! });
  }
  for (const m of code.matchAll(/\bimport\s+["']([^"']+)["']/g)) out.push({ kind: "side-effect", names: [], from: m[1]! });
  for (const m of code.matchAll(/\bexport\s+(?:type\s+)?\*\s*(?:as\s+[A-Za-z_$][\w$]*\s*)?from\s+["']([^"']+)["']/g)) out.push({ kind: "reexport-all", names: [], from: m[1]! });
  for (const m of code.matchAll(/\bexport\s+(?:type\s+)?\{([^}]*)\}\s*from\s+["']([^"']+)["']/g)) out.push({ kind: "reexport-named", names: names(m[1]!), from: m[2]! });
  for (const m of code.matchAll(/\bimport\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) out.push({ kind: "dynamic", names: [], from: m[1]! });
  return out;
}

function violationsIn(file: string, src: string): string[] {
  const out: string[] = [];
  for (const r of importsOf(src)) {
    const target = resolveModule(r.from, file);
    if (target && target in INTERNAL_ONLY) {
      out.push(`${r.kind} import of internal-only ${target}`);
      continue;
    }
    if (r.kind === "named" || r.kind === "reexport-named") {
      for (const n of r.names) if (INTERNAL_NAMES.has(n) && target?.startsWith("app/")) out.push(`${n} from ${r.from}`);
      continue;
    }
    if (target && target in MIXED && r.kind !== "side-effect") out.push(`${r.kind} import of mixed ${target}`);
  }
  return out;
}

const GUARDED = [
  ...walk(path.join(APP, "pages")),
  ...walk(path.join(APP, "routes")),
  path.join(APP, "modules/assistant/tools.server.ts"),
  path.join(APP, "modules/warehouse/commands.server.ts"),
  ...walk(path.join(APP, "modules/finance-reports")).filter((f) => /commands?\.server\.ts$/.test(f)),
].filter((f) => fs.existsSync(f));

const sourceOf = (id: string) => {
  const file = EXTS.map((e) => path.join(ROOT, id + e)).find((f) => fs.existsSync(f));
  if (!file) throw new Error(`${id} not found`);
  return fs.readFileSync(file, "utf8");
};

describe("WP1 internal functions stay internal (F8)", () => {
  it("each listed internal function is defined in its module", () => {
    for (const [id, fns] of Object.entries({ ...INTERNAL_ONLY, ...MIXED })) {
      const src = sourceOf(id);
      for (const fn of fns) expect(src, `${fn} in ${id}`).toMatch(new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${fn}\\b`));
    }
  });

  it("the public FX modules the page imports neither define nor re-export internal-only functions", () => {
    const internalOnlyNames = Object.values(INTERNAL_ONLY).flat();
    for (const id of PUBLIC_FX_MODULES) {
      const src = sourceOf(id);
      for (const fn of internalOnlyNames) expect(src, `${fn} in ${id}`).not.toMatch(new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${fn}\\b`));
      for (const r of importsOf(src)) {
        if (r.kind === "reexport-all") expect(resolveModule(r.from, path.join(ROOT, id + ".ts")), `export * in ${id}`).not.toMatch(/^app\/modules\/fx\//);
        if (r.kind === "reexport-named") for (const n of r.names) expect(INTERNAL_NAMES.has(n), `re-export ${n} in ${id}`).toBe(false);
      }
    }
  });

  it("no page, route, command or AI tool imports a WP1 internal function or module", () => {
    expect(GUARDED.some((f) => f.endsWith(path.join("pages", "finance-rates.tsx")))).toBe(true);
    const offenders = GUARDED.flatMap((f) => violationsIn(f, fs.readFileSync(f, "utf8")).map((v) => `${rel(f)}: ${v}`));
    expect(offenders).toEqual([]);
  });

  it("the scanner catches named, aliased, relative, type, namespace, dynamic, side-effect and re-export imports (self-check)", () => {
    const page = path.join(APP, "pages", "_fx_scanner_sample.tsx");
    const caught = (src: string) => violationsIn(page, src).length > 0;
    expect(caught(`import { repriceConversions } from "~/modules/fx/conversions-internal.server";`)).toBe(true);
    expect(caught(`import { conversionsNeedingRate as n } from "../modules/fx/conversions-internal.server.ts";`)).toBe(true);
    expect(caught(`import type { RepriceResult } from "~/modules/fx/conversions-internal.server";`)).toBe(true);
    expect(caught(`import { storeOfficialRates } from "~/modules/fx/rates-store.server";`)).toBe(true);
    expect(caught(`import * as impact from "~/modules/fx/impact.server";`)).toBe(true);
    expect(caught(`const m = await import("~/modules/fx/rates-store.server");`)).toBe(true);
    expect(caught(`import "~/modules/fx/impact.server";`)).toBe(true);
    expect(caught(`export * from "~/modules/fx/conversions-internal.server";`)).toBe(true);
    expect(caught(`import { runFxFetch } from "~/modules/fx/nbu-fetch.server";`)).toBe(true);
    expect(caught(`import * as nbu from "~/modules/fx/nbu-fetch.server";`)).toBe(true);
    expect(caught(`const n = await import("~/modules/fx/nbu-fetch.server");`)).toBe(true);
    expect(caught(`import { seedDemoRates } from "~/modules/fx/demo-rates.server";`)).toBe(true);
    // Дозволене: публічні сервіси власника.
    expect(caught(`import { requestNbuFetch, setNbuEnabled } from "~/modules/fx/nbu-fetch.server";`)).toBe(false);
    expect(caught(`import { createFxConversion } from "~/modules/fx/conversions.server";`)).toBe(false);
    expect(caught(`// import { repriceConversions } from "~/modules/fx/conversions-internal.server";`)).toBe(false);
  });
});
