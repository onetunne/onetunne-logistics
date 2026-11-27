import { describe, expect, it } from "vitest";
import { DICTIONARIES } from "~/i18n";

/**
 * Тексти описують поточну поведінку (рев'ю R5, B4): без застарілих «етап 3» і «тестовий перевізник не дає документів»,
 * точні межі дозволу пакування, колекцій шаблонів і ініціалізації обліку.
 */
const uk = (key: string) => DICTIONARIES.uk[key]!;
const en = (key: string) => DICTIONARIES.en[key]!;

describe("stage 5 texts describe the current behaviour", () => {
  it("carrier documents: the demo test carrier is not a reason for missing documents (it provides a sample TEST label)", () => {
    expect(uk("tracking.documents.none")).not.toMatch(/тестов/i);
    expect(en("tracking.documents.none")).not.toMatch(/test carrier/i);
    expect(uk("tracking.documents.none")).toMatch(/ручна прив’язка/);
    expect(en("tracking.documents.none")).toMatch(/manual link/);
  });

  it("waybills banner: printing and re-issue are available now (not «stage 3») and named as in the app", () => {
    expect(uk("waybills.info.stage3")).not.toMatch(/етап/i);
    expect(en("waybills.info.stage3")).not.toMatch(/stage/i);
    // Назви — як у меню й на кнопці картки замовлення.
    expect(uk("waybills.info.stage3")).toContain(`«${uk("nav.picking")}»`);
    expect(en("waybills.info.stage3")).toContain(en("nav.picking"));
    expect(uk("waybills.info.stage3")).toContain(`«${uk("order.reissue.button")}»`);
    expect(en("waybills.info.stage3")).toContain(`“${en("order.reissue.button")}”`);
  });

  it("packing permission names the parcel measurements it covers", () => {
    expect(uk("permission.packing.perform")).toBe("Пакування замовлень (зокрема коробка, вага й габарити посилки)");
    expect(en("permission.packing.perform")).toBe("Pack orders (including parcel box, weight and dimensions)");
  });

  it("kit collections: membership is per product; the model/colour filter targets variants", () => {
    expect(uk("packaging.kits.collectionPickerHelp")).toMatch(/всі варіанти товару/);
    expect(uk("packaging.kits.collectionPickerHelp")).toMatch(/фільтр моделі\/кольору/);
    expect(en("packaging.kits.collectionPickerHelp")).toMatch(/every variant of a product/);
    expect(en("packaging.kits.collectionPickerHelp")).toMatch(/model\/colour filter/);
  });

  it("opening note: a partially fulfilled pre-opening order keeps available exact and lowers on hand until it ships", () => {
    // Раніше: «таких одиниць немає ні в «доступно», ні на складі» — хибно для невиконаної частини часткового виконання.
    expect(uk("warehouse.init.fulfilledNote")).not.toMatch(/ні на складі/);
    expect(en("warehouse.init.fulfilledNote")).not.toMatch(/nor in the warehouse/);
    expect(uk("warehouse.init.fulfilledNote")).toMatch(/«доступно» точне/);
    expect(uk("warehouse.init.fulfilledNote")).toMatch(/частково виконаного замовлення «фактично» менше/);
    expect(en("warehouse.init.fulfilledNote")).toMatch(/available is exact/);
    expect(en("warehouse.init.fulfilledNote")).toMatch(/partially fulfilled order, on hand is lower/);
  });
});
