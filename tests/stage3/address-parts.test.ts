import { describe, expect, it } from "vitest";
import { splitStreetAndBuilding } from "~/modules/customs/address-parts";

describe("splitStreetAndBuilding (only unambiguous)", () => {
  it.each([
    ["Hauptstraße 12a", "Hauptstraße", "12a"],
    ["Hauptstr. 1", "Hauptstr.", "1"],
    ["Straße des 17. Juni 135", "Straße des 17. Juni", "135"],
    ["ul. Marszałkowska 10/12", "ul. Marszałkowska", "10/12"],
    ["Via Roma, 5", "Via Roma", "5"],
    ["Rue de la Paix 7 B", "Rue de la Paix", "7B"],
    ["Kerkstraat 12-14", "Kerkstraat", "12-14"],
    ["123 Main St", "Main St", "123"],
    ["4500 Wilshire Boulevard", "Wilshire Boulevard", "4500"],
    ["Calle Mayor Nr. 3", "Calle Mayor", "3"],
  ])("%s", (input, street, building) => {
    expect(splitStreetAndBuilding(input)).toEqual({ street, building });
  });

  it.each([
    [""],
    [null],
    ["Main Street"],
    ["12 Rue 5"],
    ["12"],
    ["PO Box 123"],
    ["Postfach 12 34"],
  ])("ambiguous or missing → null: %s", (input) => {
    expect(splitStreetAndBuilding(input)).toBeNull();
  });
});
