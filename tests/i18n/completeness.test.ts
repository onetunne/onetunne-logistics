import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DICTIONARIES, MESSAGE_MODULES } from "~/i18n";
import { ORDER_STATUSES } from "~/domain/order-status";
import { SECTIONS } from "~/domain/navigation";
import { ISSUE_CODES, AUTO_FIX_RULES } from "~/modules/validation/types";
import { COMPONENT_STATES, DISCREPANCY_CODES, FINANCE_CATEGORIES, FINANCE_TABS, REVIEW_REASONS } from "~/domain/finance";
import { financeLabelKeys } from "~/modules/finance/core/labels";

/**
 * Модулі «без зайвих ключів»: етап 5 + етап 6 (спільний finance і модулі пакетів, docs/stage6-design.md §18.10).
 * Кожен пакет етапу 6 додає ключі лише у свій модуль — і кожен ключ має використовуватися.
 */
const STRICT_MODULES = [
  "warehouse",
  "production",
  "warehouseAnalytics",
  "dashboard",
  "staff",
  "finance",
  "financeDashboard",
  "financeOrders",
  "financeShipping",
  "financeCosts",
  "financeFx",
  "financeExpenses",
  "partners",
  "analytics",
  "returns",
  "financeReports",
  "financeCommands",
  "financeUi",
] as const;

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.(tsx?|ts)$/.test(e.name) ? [p] : [];
  });
}

describe("i18n completeness", () => {
  it("every module has identical uk/en key sets and no empty strings", () => {
    for (const [name, mod] of Object.entries(MESSAGE_MODULES)) {
      expect(Object.keys(mod.en).sort(), `module ${name}`).toEqual(Object.keys(mod.uk).sort());
      for (const [k, v] of [...Object.entries(mod.uk), ...Object.entries(mod.en)]) {
        expect(v.trim().length, `${name}:${k}`).toBeGreaterThan(0);
      }
    }
  });

  it("no key is defined in two modules", () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const [name, mod] of Object.entries(MESSAGE_MODULES)) {
      for (const k of Object.keys(mod.uk)) {
        if (seen.has(k)) dupes.push(`${k} (${seen.get(k)} & ${name})`);
        seen.set(k, name);
      }
    }
    expect(dupes).toEqual([]);
  });

  it("every literal t(\"...\") key used in app code exists", () => {
    const missing: string[] = [];
    for (const file of walk(path.resolve("app"))) {
      const src = fs.readFileSync(file, "utf8");
      for (const m of src.matchAll(/\bt\(\s*["']([a-zA-Z0-9_.]+)["']/g)) {
        const key = m[1]!;
        if (!(key in DICTIONARIES.uk)) missing.push(`${path.relative(".", file)}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("stage-5 and stage-6 modules have no unused keys (literal use or a dynamic `prefix.${…}` family in app code)", () => {
    const files = walk(path.resolve("app")).filter((f) => !f.includes(`${path.sep}i18n${path.sep}messages${path.sep}`));
    const src = files.map((f) => fs.readFileSync(f, "utf8")).join("\n");
    // Динамічні родини: `warehouse.reason.${code}`, "packing.tab." + key тощо.
    const prefixes = [...src.matchAll(/[`"']([a-zA-Z0-9_.]+\.)(?:\$\{|["'`]\s*\+)/g)].map((m) => m[1]!);
    const unused: string[] = [];
    for (const name of [...STRICT_MODULES]) {
      const mod = MESSAGE_MODULES[name];
      expect(mod, name).toBeDefined();
      for (const k of Object.keys(mod!.uk)) {
        const literal = src.includes(`"${k}"`) || src.includes(`'${k}'`) || src.includes(`\`${k}\``);
        if (!literal && !prefixes.some((p) => k.startsWith(p))) unused.push(`${name}: ${k}`);
      }
    }
    expect(unused).toEqual([]);
  });

  it("dynamic key families are complete", () => {
    const keys = [
      ...ORDER_STATUSES.map((s) => `status.${s}`),
      ...["creating", "created", "unknown", "failed", "cancelled"].map((s) => `shipmentStatus.${s}`),
      ...SECTIONS.map((s) => `nav.${s.key}`),
      ...SECTIONS.filter((s) => !s.implemented).map((s) => `planned.${s.key}.description`),
      ...ISSUE_CODES.flatMap((c) => [`issue.${c}.title`, `issue.${c}.help`]),
      ...AUTO_FIX_RULES.map((r) => `autofix.${r}`),
      ...["created", "already_exists", "recovered", "rejected", "not_created", "unknown"].map((k) => `result.waybill.${k}`),
      ...["validation", "status", "automation_paused", "shipper_incomplete", "no_carrier", "carrier_not_configured", "in_progress"].map(
        (k) => `result.waybill.blocked.${k}`,
      ),
      // Етап 6: спільні родини фінансів (повний перелік — tests/stage6/core/enumerations.test.ts).
      ...FINANCE_CATEGORIES.map(financeLabelKeys.category),
      ...COMPONENT_STATES.map(financeLabelKeys.state),
      ...DISCREPANCY_CODES.map(financeLabelKeys.discrepancy),
      ...REVIEW_REASONS.map(financeLabelKeys.review),
      ...FINANCE_TABS.map((t) => financeLabelKeys.tab(t.key)),
    ];
    expect(keys.filter((k) => !(k in DICTIONARIES.uk) || !(k in DICTIONARIES.en))).toEqual([]);
  });
});

describe("texts describe implemented behaviour only", () => {
  it("Nova Post tariff help describes option B (one fixed tariff for checkout and waybills)", () => {
    const uk = DICTIONARIES.uk["settings.novaPost.deliveryTypeHelp"]!;
    const en = DICTIONARIES.en["settings.novaPost.deliveryTypeHelp"]!;
    expect(uk).toMatch(/Один тариф/);
    expect(uk).toMatch(/Checkout увімкнути не можна/);
    expect(en).toMatch(/One Nova Post tariff/);
    expect(en).toMatch(/checkout cannot be enabled/);
  });

  it("an active CarrierService is not reported as «Shopify requests the rates» before a zone/market uses it", () => {
    expect(DICTIONARIES.uk["settings.checkoutConnection.state.active"]).not.toMatch(/^Підключено: Shopify запитує тарифи застосунку\.$/);
    expect(DICTIONARIES.en["settings.checkoutConnection.state.active"]).not.toMatch(/^Connected: Shopify requests the app's rates\.$/);
  });
});
