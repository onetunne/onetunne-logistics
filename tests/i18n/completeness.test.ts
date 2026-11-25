import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DICTIONARIES, MESSAGE_MODULES } from "~/i18n";
import { ORDER_STATUSES } from "~/domain/order-status";
import { SECTIONS } from "~/domain/navigation";
import { ISSUE_CODES, AUTO_FIX_RULES } from "~/modules/validation/types";

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
    ];
    expect(keys.filter((k) => !(k in DICTIONARIES.uk) || !(k in DICTIONARIES.en))).toEqual([]);
  });
});
