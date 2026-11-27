import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MESSAGE_MODULES, makeT } from "~/i18n";
import { kitTemplateMatchesVariantFilter, variantFilterSelection, type KitTemplateVariantScope } from "~/modules/packaging/kit-options";

/**
 * R6 (група B): чисті правила фільтра шаблонів комплектації за моделлю й кольором; тексти нового модуля
 * warehouseInsights використовуються в коді й мають правильні форми множини.
 */
const scope = (over: Partial<KitTemplateVariantScope> = {}): KitTemplateVariantScope => ({ appliesTo: "products", models: [], colors: [], ...over });
const variants = [
  { model: "M1", color: "Red" },
  { model: "M1", color: "Blue" },
  { model: "M2", color: "Red" },
  { model: null, color: null },
];

describe("kitTemplateMatchesVariantFilter", () => {
  it("no filter — every template", () => {
    expect(kitTemplateMatchesVariantFilter(scope(), [], {})).toBe(true);
    expect(kitTemplateMatchesVariantFilter(scope({ colors: ["Green"] }), [], { model: " ", color: "" })).toBe(true);
  });

  it("«all products» matches any value unless its own filter excludes it", () => {
    expect(kitTemplateMatchesVariantFilter(scope({ appliesTo: "all" }), null, { color: "Purple" })).toBe(true);
    expect(kitTemplateMatchesVariantFilter(scope({ appliesTo: "all", colors: ["Red"] }), null, { color: "Blue" })).toBe(false);
    expect(kitTemplateMatchesVariantFilter(scope({ appliesTo: "all", colors: ["Red"] }), null, { color: " red " })).toBe(true);
  });

  it("own filter decides; the other dimension is checked on the same variant of the target", () => {
    // Власний колір Red: модель M1 — є червоний M1; модель M3 — немає варіанта.
    expect(kitTemplateMatchesVariantFilter(scope({ colors: ["Red"] }), variants, { color: "Red", model: "M1" })).toBe(true);
    expect(kitTemplateMatchesVariantFilter(scope({ colors: ["Red"] }), variants, { model: "M3" })).toBe(false);
    // Власна модель M2 (лише червоні варіанти) — синій не підходить.
    expect(kitTemplateMatchesVariantFilter(scope({ models: ["M2"] }), variants, { color: "Blue" })).toBe(false);
    expect(kitTemplateMatchesVariantFilter(scope({ models: ["M2"] }), variants, { color: "red" })).toBe(true);
  });

  it("without own filters: a single target variant must have both the model and the colour", () => {
    expect(kitTemplateMatchesVariantFilter(scope(), variants, { color: "Blue" })).toBe(true);
    expect(kitTemplateMatchesVariantFilter(scope(), variants, { color: "Blue", model: "M2" })).toBe(false);
    expect(kitTemplateMatchesVariantFilter(scope(), variants, { color: "Green" })).toBe(false);
    // Варіант без кольору під фільтр за кольором не підпадає.
    expect(kitTemplateMatchesVariantFilter(scope(), [{ model: "M1", color: null }], { color: "Red" })).toBe(false);
    expect(kitTemplateMatchesVariantFilter(scope({ appliesTo: "collections" }), [], { model: "M1" })).toBe(false);
  });
});

describe("variantFilterSelection (kits list filter field)", () => {
  it("shows the option equal after normalisation; adds a value not offered; empty — nothing selected", () => {
    const options = ["Black", "Blue", "Red"];
    expect(variantFilterSelection(options, " blue ")).toEqual({ options, value: "Blue" });
    expect(variantFilterSelection(options, "Blue")).toEqual({ options, value: "Blue" });
    expect(variantFilterSelection(options, "Teal")).toEqual({ options: [...options, "Teal"], value: "Teal" });
    expect(variantFilterSelection(options, "  ")).toEqual({ options, value: "" });
    expect(variantFilterSelection(options, null)).toEqual({ options, value: "" });
    // Кирилиця — без регістру, як у розрахунку комплектації.
    expect(variantFilterSelection(["Чорний"], "чорний").value).toBe("Чорний");
  });
});

describe("warehouseInsights texts", () => {
  it("every key is used in app code; uk/en plural forms", () => {
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? walk(p) : /\.tsx?$/.test(e.name) ? [p] : [];
      });
    const src = walk(path.resolve("app"))
      .filter((f) => !f.includes(`${path.sep}i18n${path.sep}messages${path.sep}`))
      .map((f) => fs.readFileSync(f, "utf8"))
      .join("\n");
    const mod = MESSAGE_MODULES.warehouseInsights;
    expect(mod).toBeDefined();
    expect(Object.keys(mod!.uk).filter((k) => !src.includes(`"${k}"`))).toEqual([]);
    const uk = makeT("uk");
    const en = makeT("en");
    expect(uk("warehouseInsights.material.daysLeftValue", { days: 2 })).toBe("Вистачить на 2 дні");
    expect(uk("warehouseInsights.material.daysLeftValue", { days: 5 })).toBe("Вистачить на 5 днів");
    expect(en("warehouseInsights.material.consumed", { days: 30 })).toBe("Used in the last 30 days");
    expect(en("warehouseInsights.material.forecastHint", { days: 30 })).toBe("Forecast from the average packing usage over the last 30 days.");
  });
});
