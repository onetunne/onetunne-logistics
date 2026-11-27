import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DICTIONARIES } from "~/i18n";
import { MOVEMENT_REASON_CODES } from "~/modules/inventory/movement-types";
import { DEFECT_REASONS, RECEIPT_REASONS, REPAIR_REASON, STOCKTAKE_REASON, WRITE_OFF_REASONS } from "~/modules/warehouse/constants";

/**
 * Причини руху (ui-5, ui-m1): кожен код, який записує застосунок, має підпис warehouse.reason.<код> (uk/en) —
 * «Історія руху» й картка позиції не показують сирих кодів («packing_box», «production_receipt»).
 */

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

/** Літерали в полях reason, що НЕ є причинами руху (деталі журналу, пропуски передачі тощо). */
const NOT_MOVEMENT_REASONS = new Set(["opened_with_internal_history", "no_inventory_item", "unknown_command", "forbidden", "invalid_input"]);

describe("movement reason codes", () => {
  it("every reason code has uk and en labels", () => {
    const missing = MOVEMENT_REASON_CODES.flatMap((code) =>
      (["uk", "en"] as const).filter((l) => !(`warehouse.reason.${code}` in DICTIONARIES[l])).map((l) => `${l}:${code}`),
    );
    expect(missing).toEqual([]);
  });

  it("form reasons and app-set reasons are listed", () => {
    const all = new Set<string>(MOVEMENT_REASON_CODES);
    for (const code of [...RECEIPT_REASONS, ...DEFECT_REASONS, ...WRITE_OFF_REASONS, STOCKTAKE_REASON, REPAIR_REASON]) {
      expect(all.has(code), code).toBe(true);
    }
  });

  it("every reason literal written by movement-producing modules is a listed code", () => {
    const listed = new Set<string>(MOVEMENT_REASON_CODES);
    const unknown: string[] = [];
    for (const file of walk(path.resolve("app"))) {
      const src = fs.readFileSync(file, "utf8");
      // Лише модулі, що створюють рухи залишків.
      if (file.endsWith(path.join("db", "schema.ts"))) continue;
      if (!/\bapplyMovements\b|\bMovementInput\b|plan\.movements\.push|OPERATION_REASON/.test(src)) continue;
      const literals = new Set<string>();
      // reason: "x" / reason: cond ? "x" : "y" / release(r, qty, "x") / OPERATION_REASON = { op: "x", ... }
      for (const m of src.matchAll(/\breason\??\s*:\s*([^\n,}]*(?:\?[^\n,}]*:[^\n,}]*)?)/g)) {
        const expr = m[1]!.includes("?") ? m[1]!.slice(m[1]!.indexOf("?") + 1) : m[1]!; // умова тернарного виразу — не причина
        for (const lit of expr.matchAll(/"([a-z][a-z0-9_]*)"/g)) literals.add(lit[1]!);
      }
      for (const m of src.matchAll(/\brelease\([^)]*"([a-z][a-z0-9_]*)"\)/g)) literals.add(m[1]!);
      const block = /OPERATION_REASON[^=]*=\s*\{([^}]*)\}/.exec(src);
      if (block) for (const lit of block[1]!.matchAll(/:\s*"([a-z][a-z0-9_]*)"/g)) literals.add(lit[1]!);
      for (const lit of literals) {
        if (!listed.has(lit) && !NOT_MOVEMENT_REASONS.has(lit)) unknown.push(`${path.relative(".", file)}: ${lit}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it("the scan sees the known producers (guards against a silently empty scan)", () => {
    const seen = new Set<string>();
    for (const file of walk(path.resolve("app/modules"))) {
      const src = fs.readFileSync(file, "utf8");
      for (const code of ["production_receipt", "packing_box", "shopify_conflict", "material_receipt", "order_paid"]) {
        if (src.includes(`"${code}"`)) seen.add(code);
      }
    }
    expect([...seen].sort()).toEqual(["material_receipt", "order_paid", "packing_box", "production_receipt", "shopify_conflict"]);
  });
});
