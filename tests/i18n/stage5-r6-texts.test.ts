import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DICTIONARIES } from "~/i18n";

/**
 * Тексти раунду R6 (група A): однозначні назви сторінок і правильний напрямок посилань на попередження.
 */
const uk = (key: string) => DICTIONARIES.uk[key]!;
const en = (key: string) => DICTIONARIES.en[key]!;

describe("kit templates are not confused with order picking (S5-UI-NAME)", () => {
  it("the kits tab and page are «Шаблони комплектації» / «Kit templates»; the menu item «Комплектація» stays the packing queue", () => {
    expect(uk("warehouse.nav.kits")).toBe("Шаблони комплектації");
    expect(uk("packaging.kits.title")).toBe(uk("warehouse.nav.kits"));
    expect(en("warehouse.nav.kits")).toBe("Kit templates");
    expect(en("packaging.kits.title")).toBe(en("warehouse.nav.kits"));
    // Пункт меню черги пакування не змінено (на нього посилаються інші тексти).
    expect(uk("nav.picking")).toBe("Комплектація");
    expect(en("nav.picking")).toBe("Picking");
    for (const l of ["uk", "en"] as const) {
      const d = DICTIONARIES[l];
      expect(d["warehouse.nav.kits"], l).not.toBe(d["nav.picking"]);
      expect(d["packaging.kits.title"], l).not.toBe(d["nav.picking"]);
    }
  });
});

describe("packing screen: the save result points to the warnings in the right direction (S5-TEXT)", () => {
  const src = fs.readFileSync(path.resolve("app/pages/packing-order.tsx"), "utf8");

  it("the result banner is rendered above the weight and parcel-mismatch warnings", () => {
    const result = src.indexOf("<ActionBanner data={actionData} />");
    expect(result).toBeGreaterThan(0);
    expect(src.indexOf("<WeightCheckBanner data={data} />")).toBeGreaterThan(result);
    expect(src.indexOf("<MismatchBanner data={data} />")).toBeGreaterThan(result);
  });

  it("so the result texts say «below», not «above»", () => {
    for (const key of ["packing.parcel.mismatch", "packing.parcel.weightIgnoredSaved"]) {
      expect(uk(key), key).toMatch(/попередження нижче/);
      expect(uk(key), key).not.toMatch(/вгорі/);
      expect(en(key), key).toMatch(/warning below/);
      expect(en(key), key).not.toMatch(/above/);
    }
    // Підказка в картці посилки стоїть під попередженням — там «вгорі» правильне.
    expect(uk("packing.parcel.savedIgnoredHint")).toMatch(/вгорі/);
    expect(en("packing.parcel.savedIgnoredHint")).toMatch(/above/);
  });
});
