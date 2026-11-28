/**
 * Етап 6 (WP0): доступ до фінансів (F8, §14.1) і тест-сканер:
 * - requireFinance = дозвіл + роль owner (підроблений актор із дозволом, але роллю staff → 403);
 * - finance.manage — лише власник (OWNER_ONLY, не делегується), підписи uk/en;
 * - pages/routes/команди/інструменти ШІ не імпортують внутрішніх функцій проведення;
 * - фінансові модулі не імпортують normalizeAmount (він підміняє пошкоджену суму нулем, F4).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DELEGABLE_PERMISSIONS,
  ForbiddenError,
  OWNER_ONLY_PERMISSIONS,
  PERMISSIONS,
  SYSTEM_ACTOR,
  makeActor,
  resolvePermissions,
  staffOverridesFromSelection,
  type Actor,
} from "~/domain/permissions";
import { DICTIONARIES } from "~/i18n";
import { canFinance, financeFieldOrNull, requireFinance, requireFinanceOr403 } from "~/modules/finance/core/access.server";
import { INTERNAL_ONLY_MODULES, INTERNAL_POSTING_FUNCTIONS } from "~/modules/finance/core/contracts";
import { OWNER, STAFF } from "../../helpers";

/** Підроблений актор: дозволи фінансів у наборі, але роль staff (обхід resolvePermissions). */
const FORGED: Actor = { ...STAFF, id: "forged", permissions: new Set([...STAFF.permissions, "finance.view", "finance.manage"]) };

describe("finance permissions", () => {
  it("finance.manage exists, is owner-only, never delegable, labelled uk/en; SYSTEM_ACTOR has both", () => {
    expect(PERMISSIONS).toContain("finance.manage");
    expect(OWNER_ONLY_PERMISSIONS).toEqual(expect.arrayContaining(["finance.view", "finance.manage"]));
    expect(DELEGABLE_PERMISSIONS).not.toContain("finance.manage");
    expect(resolvePermissions("staff", { grant: ["finance.manage", "finance.view"] }).has("finance.manage")).toBe(false);
    expect(staffOverridesFromSelection(["finance.manage"])).toEqual({ ok: false, rejected: ["finance.manage"] });
    for (const l of ["uk", "en"] as const) expect(DICTIONARIES[l]["permission.finance.manage"]).toBeTruthy();
    expect(SYSTEM_ACTOR.permissions.has("finance.view") && SYSTEM_ACTOR.permissions.has("finance.manage")).toBe(true);
    expect(canFinance(SYSTEM_ACTOR, "manage")).toBe(true);
  });

  it("requireFinance = permission AND role owner (a forged staff actor with finance permissions is refused)", async () => {
    expect(() => requireFinance({ actor: OWNER }, "view")).not.toThrow();
    expect(() => requireFinance({ actor: OWNER }, "manage")).not.toThrow();
    for (const actor of [STAFF, FORGED]) {
      for (const level of ["view", "manage"] as const) {
        expect(() => requireFinance({ actor }, level)).toThrow(ForbiddenError);
        expect(canFinance(actor, level)).toBe(false);
      }
    }
    const ownerWithoutManage = makeActor({ id: "o2", displayName: "O2", role: "owner" });
    expect(canFinance(ownerWithoutManage, "manage")).toBe(true);
    // Loader: 403-відповідь, не переадресація.
    try {
      requireFinanceOr403({ actor: FORGED }, "view");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(403);
    }
    expect(await financeFieldOrNull({ actor: STAFF }, async () => ({ profit: "1.00" }))).toBeNull();
    expect(await financeFieldOrNull({ actor: FORGED }, async () => ({ profit: "1.00" }))).toBeNull();
    expect(await financeFieldOrNull({ actor: OWNER }, async () => ({ profit: "1.00" }))).toEqual({ profit: "1.00" });
  });
});

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.(tsx?|mjs)$/.test(e.name) ? [p] : [];
  });
}

const ROOT = path.resolve(".");
const APP = path.join(ROOT, "app");
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");
const SOURCE_EXTS = [".ts", ".tsx", ".mjs", ".js"];

/**
 * Специфікатор імпорту → ідентичність модуля: шлях від кореня без розширення (`app/modules/finance/core/entries.server`);
 * `~/…`, відносні шляхи, з `.ts`/`.tsx`/`.js` чи без, каталог → його index. Пакет npm → null.
 */
function resolveModule(spec: string, fromFile: string): string | null {
  let abs: string;
  if (spec.startsWith("~/")) abs = path.join(APP, spec.slice(2));
  else if (spec.startsWith("./") || spec.startsWith("../")) abs = path.resolve(path.dirname(fromFile), spec);
  else return null;
  abs = abs.replace(/\.(?:tsx?|mjs|js)$/, "");
  const isFile = SOURCE_EXTS.some((e) => fs.existsSync(abs + e));
  if (!isFile && SOURCE_EXTS.some((e) => fs.existsSync(path.join(abs, `index${e}`)))) abs = path.join(abs, "index");
  return rel(abs);
}
/** Ідентичність модуля з шляху `~/…` контракту. */
const moduleIdOf = (spec: string) => rel(path.join(APP, spec.replace(/^~\//, "")));
const fileModuleId = (file: string) => rel(file).replace(/\.(?:tsx?|mjs|js)$/, "").replace(/\/index$/, "");

type ImportKind = "named" | "namespace" | "default" | "dynamic" | "side-effect" | "reexport-all" | "reexport-named";
interface ImportRef {
  kind: ImportKind;
  /** Імпортовані (оригінальні) назви для named / reexport-named; для інших — []. */
  names: string[];
  /** Локальні назви (для `* as X` — X), щоб шукати `X.<назва>`. */
  locals: string[];
  from: string;
}

/** Імпорти й реекспорти файла: статичні, `import * as`, типові, побічні, `export * from`, динамічні `import()`. */
function importsOf(src: string): ImportRef[] {
  const out: ImportRef[] = [];
  // Лише коментарі з початку рядка (JSDoc, `// …`): рядки на кшталт "app/**/*.ts" у коді не зрізаються.
  const code = src.replace(/(^|\n)[ \t]*\/\*[\s\S]*?\*\//g, "$1").replace(/^[ \t]*\/\/.*$/gm, "");
  for (const m of code.matchAll(/\bimport\s+(?:type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g)) {
    const clause = m[1]!.trim();
    const from = m[2]!;
    const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
    if (ns) out.push({ kind: "namespace", names: [], locals: [ns[1]!], from });
    const braces = /\{([\s\S]*)\}/.exec(clause);
    if (braces) {
      const specs = braces[1]!.split(",").map((x) => x.trim().replace(/^type\s+/, "")).filter(Boolean);
      out.push({
        kind: "named",
        names: specs.map((x) => x.split(/\s+as\s+/)[0]!.trim()),
        locals: specs.map((x) => (x.split(/\s+as\s+/)[1] ?? x).trim()),
        from,
      });
    }
    const def = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause);
    if (def && def[1] !== "type") out.push({ kind: "default", names: [], locals: [def[1]!], from });
  }
  for (const m of code.matchAll(/\bimport\s+["']([^"']+)["']/g)) out.push({ kind: "side-effect", names: [], locals: [], from: m[1]! });
  for (const m of code.matchAll(/\bexport\s+(?:type\s+)?\*\s*(?:as\s+[A-Za-z_$][\w$]*\s*)?from\s+["']([^"']+)["']/g)) {
    out.push({ kind: "reexport-all", names: [], locals: [], from: m[1]! });
  }
  for (const m of code.matchAll(/\bexport\s+(?:type\s+)?\{([^}]*)\}\s*from\s+["']([^"']+)["']/g)) {
    const specs = m[1]!.split(",").map((x) => x.trim().replace(/^type\s+/, "")).filter(Boolean);
    out.push({
      kind: "reexport-named",
      names: specs.map((x) => x.split(/\s+as\s+/)[0]!.trim()),
      locals: specs.map((x) => (x.split(/\s+as\s+/)[1] ?? x).trim()),
      from: m[2]!,
    });
  }
  for (const m of code.matchAll(/\bimport\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) out.push({ kind: "dynamic", names: [], locals: [], from: m[1]! });
  return out;
}

const INTERNAL_NAMES = new Set(Object.keys(INTERNAL_POSTING_FUNCTIONS));
const INTERNAL_ONLY = new Set<string>(INTERNAL_ONLY_MODULES.map(moduleIdOf));

/**
 * Які внутрішні функції «відкриває» кожен модуль app/: визначення з INTERNAL_POSTING_FUNCTIONS (точні модулі) +
 * реекспорти (`export { x as y } from`, `export * from`) — транзитивно (нерухома точка).
 */
function exposureMap(files: readonly string[]): Map<string, Map<string, string>> {
  /** модуль → (назва, під якою відкрито → внутрішня функція). */
  const exposed = new Map<string, Map<string, string>>();
  const add = (mod: string, as: string, fn: string) => {
    const m = exposed.get(mod) ?? new Map<string, string>();
    if (m.get(as) === fn) return false;
    m.set(as, fn);
    exposed.set(mod, m);
    return true;
  };
  for (const [fn, spec] of Object.entries(INTERNAL_POSTING_FUNCTIONS)) add(moduleIdOf(spec), fn, fn);
  const reexports = files.map((f) => ({ id: fileModuleId(f), file: f, refs: importsOf(fs.readFileSync(f, "utf8")).filter((r) => r.kind.startsWith("reexport")) }));
  for (let changed = true; changed; ) {
    changed = false;
    for (const { id, file, refs } of reexports) {
      for (const r of refs) {
        const target = resolveModule(r.from, file);
        const src = target ? exposed.get(target) : undefined;
        if (!src) continue;
        if (r.kind === "reexport-all") for (const [as, fn] of src) changed = add(id, as, fn) || changed;
        else r.names.forEach((n, i) => {
          const fn = src.get(n);
          if (fn) changed = add(id, r.locals[i]!, fn) || changed;
        });
      }
    }
  }
  return exposed;
}

/** Порушення F8 у файлі захищеної поверхні (чиста функція: шлях файла, вихідний код, карта відкритих функцій). */
function violationsIn(file: string, src: string, exposed: Map<string, Map<string, string>>): string[] {
  const out: string[] = [];
  for (const imp of importsOf(src)) {
    const target = resolveModule(imp.from, file);
    const opens = target ? exposed.get(target) : undefined;
    if (target && INTERNAL_ONLY.has(target)) {
      out.push(`${imp.kind} import of internal-only module ${target}`);
      continue;
    }
    if (imp.kind === "named" || imp.kind === "reexport-named") {
      for (const n of imp.names) if (INTERNAL_NAMES.has(n) || opens?.has(n)) out.push(`${n} from ${imp.from}`);
      continue;
    }
    if (opens && opens.size > 0) {
      // Простір імен / типовий / динамічний / export * модуля, що відкриває внутрішню функцію (змішаний модуль).
      out.push(`${imp.kind} import of ${target} (exposes ${[...opens.keys()].sort().join(", ")})`);
    }
  }
  return out;
}

/** Поверхні, яким заборонено внутрішні функції проведення (§14.1). */
const GUARDED_FILES = [
  ...walk(path.resolve("app/pages")),
  ...walk(path.resolve("app/routes")),
  path.resolve("app/modules/assistant/tools.server.ts"),
  path.resolve("app/modules/warehouse/commands.server.ts"),
  ...walk(path.resolve("app/modules/finance-reports")).filter((f) => /commands?\.server\.ts$/.test(f)),
].filter((f) => fs.existsSync(f));

const APP_FILES = walk(APP);
const EXPOSED = exposureMap(APP_FILES);

describe("scanner: internal posting functions stay internal (F8)", () => {
  it("finds the guarded surfaces", () => {
    expect(GUARDED_FILES.some((f) => f.endsWith(path.join("pages", "finance.tsx")))).toBe(true);
    expect(GUARDED_FILES.some((f) => f.endsWith("tools.server.ts"))).toBe(true);
    expect(GUARDED_FILES.length).toBeGreaterThan(40);
  });

  it("every internal function has an EXACT module (a file, not a directory) that defines it once it exists", () => {
    for (const [fn, spec] of Object.entries(INTERNAL_POSTING_FUNCTIONS)) {
      const id = moduleIdOf(spec);
      expect(fs.existsSync(path.join(ROOT, id)) && fs.statSync(path.join(ROOT, id)).isDirectory(), `${fn}: ${spec} is a directory`).toBe(false);
      const file = SOURCE_EXTS.map((e) => path.join(ROOT, id + e)).find((f) => fs.existsSync(f));
      expect(file, `${fn}: ${spec} exists`).toBeTruthy();
      expect(fs.readFileSync(file!, "utf8"), `${fn} is defined in ${spec}`).toMatch(new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${fn}\\b`));
    }
    for (const spec of INTERNAL_ONLY_MODULES) expect(Object.values(INTERNAL_POSTING_FUNCTIONS), spec).toContain(spec);
  });

  it("no page, route, command or AI tool imports an internal posting function or module", () => {
    const offenders: string[] = [];
    for (const file of GUARDED_FILES) for (const v of violationsIn(file, fs.readFileSync(file, "utf8"), EXPOSED)) offenders.push(`${rel(file)}: ${v}`);
    expect(offenders).toEqual([]);
  });

  it("the scanner catches named, aliased, relative, namespace, dynamic, side-effect and re-exported violations (self-check)", () => {
    const page = path.join(APP, "pages", "_scanner_sample.tsx");
    const caught = (src: string, exposed = EXPOSED) => violationsIn(page, src, exposed).length > 0;
    // іменований, з .ts, з псевдонімом
    expect(caught(`import { postEntries } from "~/modules/finance/core/entries.server.ts";`)).toBe(true);
    expect(caught(`import { repostEntries as rp } from "~/modules/finance/core/entries.server";`)).toBe(true);
    // (B) відносний шлях до суто внутрішнього модуля
    expect(caught(`import * as entries from "../modules/finance/core/entries.server";\nawait entries.postEntries(tx, a, []);`)).toBe(true);
    expect(caught(`import type { EntryInput } from "../modules/finance/core/entries.server";`)).toBe(true);
    // (A) простір імен змішаного модуля (openDiscrepancy поруч із публічними сервісами)
    expect(caught(`import * as disc from "~/modules/finance/core/discrepancies.server";\nawait disc.openDiscrepancy(db, a, x);`)).toBe(true);
    expect(caught(`const m = await import("~/modules/finance/core/discrepancies.server");`)).toBe(true);
    expect(caught(`const x = await import("~/modules/order-finance/sync.server");`)).toBe(true);
    expect(caught(`import "~/modules/costing/hook.server";`)).toBe(true);
    expect(caught(`export * from "~/modules/returns/sync.server";`)).toBe(true);
    expect(caught(`export { revalueBatchLines } from "../modules/costing/revalue.server";`)).toBe(true);
    // реекспорт через проміжний модуль (транзитивно)
    const viaHelper = new Map(EXPOSED);
    viaHelper.set("app/modules/helpers/finance-bridge", new Map([["post", "postEntries"]]));
    expect(caught(`import { post } from "~/modules/helpers/finance-bridge";`, viaHelper)).toBe(true);
    expect(caught(`import * as bridge from "~/modules/helpers/finance-bridge";`, viaHelper)).toBe(true);
    // дозволено: публічні сервіси змішаного модуля за назвою; модулі без внутрішніх функцій
    expect(caught(`import { listDiscrepancies, resolveDiscrepancy } from "~/modules/finance/core/discrepancies.server";`)).toBe(false);
    expect(caught(`import { requireFinanceOr403 } from "../modules/finance/core/access.server";`)).toBe(false);
    expect(caught(`import * as access from "~/modules/finance/core/access.server";`)).toBe(false);
    // коментарі не рахуються
    expect(caught(`// import { postEntries } from "~/modules/finance/core/entries.server";`)).toBe(false);
  });

  it("exposure is transitive through real re-export files (export * / export { x as y } from)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f8-scan-"));
    try {
      const a = path.join(dir, "bridge-a.ts");
      const b = path.join(dir, "bridge-b.ts");
      const c = path.join(dir, "bridge-c.ts");
      fs.writeFileSync(a, `export * from "~/modules/finance/core/discrepancies.server";\n`);
      fs.writeFileSync(b, `export { openDiscrepancy as open, listDiscrepancies } from "./bridge-a";\n`);
      fs.writeFileSync(c, `export { listDiscrepancies } from "./bridge-b";\n`);
      const exposed = exposureMap([...APP_FILES, a, b, c]);
      const sample = path.join(dir, "page.tsx");
      expect(violationsIn(sample, `import { open } from "./bridge-b";`, exposed)).not.toEqual([]);
      expect(violationsIn(sample, `import * as x from "./bridge-a";`, exposed)).not.toEqual([]);
      expect(violationsIn(sample, `import { listDiscrepancies } from "./bridge-b";`, exposed)).toEqual([]);
      // bridge-c реекспортує лише публічну функцію — простір імен дозволено.
      expect(violationsIn(sample, `import * as x from "./bridge-c";`, exposed)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Фінансові модулі етапу 6 (усі пакети). */
const FINANCE_MODULE_DIRS = [
  "app/modules/finance",
  "app/modules/fx",
  "app/modules/costing",
  "app/modules/order-finance",
  "app/modules/finance-sync",
  "app/modules/finance-reports",
  "app/modules/finance-analytics",
  "app/modules/finance-import",
  "app/modules/shipping-costs",
  "app/modules/expenses",
  "app/modules/partners",
  "app/modules/returns",
  "app/integrations/fx",
];

describe("scanner: finance modules never use normalizeAmount (F4, §14.3 п. 5)", () => {
  it("no finance module imports normalizeAmount", () => {
    const offenders: string[] = [];
    for (const dir of FINANCE_MODULE_DIRS) {
      for (const file of walk(path.resolve(dir))) {
        const src = fs.readFileSync(file, "utf8");
        for (const imp of importsOf(src)) if (imp.names.includes("normalizeAmount")) offenders.push(rel(file));
        if (/\bnormalizeAmount\s*\(/.test(src)) offenders.push(`${rel(file)} (call)`);
      }
    }
    expect(offenders).toEqual([]);
    expect(walk(path.resolve("app/modules/finance")).length).toBeGreaterThan(10);
  });
});

describe("pointers to guard tests are real", () => {
  it("every tests/stage6/** file named in app/ source or comments exists", () => {
    const missing: string[] = [];
    for (const file of walk(APP)) {
      for (const m of fs.readFileSync(file, "utf8").matchAll(/tests\/stage6\/[\w./-]+?\.test\.ts/g)) {
        if (!fs.existsSync(path.join(ROOT, m[0]))) missing.push(`${rel(file)} → ${m[0]}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
