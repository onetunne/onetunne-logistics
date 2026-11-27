/**
 * Форма надходження на картці позиції (/warehouse/items/:id): підсумок «Після операції» для матеріалу — без
 * «доступно» (резервів у матеріалів немає; «доступно для продажу» стосується лише товарів), для товару — як раніше.
 */
import { describe, expect, it } from "vitest";
import { makeT } from "~/i18n";
import { receivePreview } from "~/modules/warehouse/format";

describe("receive preview on the item card", () => {
  const uk = makeT("uk");
  const en = makeT("en");

  it("material: on hand and defective only, no «available»", () => {
    const p = receivePreview({ kind: "material", onHand: 4, available: 4, defective: 0 }, 10, 2);
    expect(p).toEqual({ key: "warehouse.op.receive.previewMaterial", params: { onHand: 14, defective: 2 } });
    expect(uk(p.key, p.params)).toBe("Після операції: фактично 14, брак 2.");
    expect(en(p.key, p.params)).toBe("After this: on hand 14, defective 2.");
    expect(uk(p.key, p.params)).not.toMatch(/доступно/i);
    expect(en(p.key, p.params)).not.toMatch(/available/i);
  });

  it("product: on hand, available (reservations stay) and defective", () => {
    const p = receivePreview({ kind: "product", onHand: 12, available: 9, defective: 1 }, 5, 1);
    expect(p).toEqual({ key: "warehouse.op.receive.preview", params: { onHand: 17, available: 14, defective: 2 } });
    expect(uk(p.key, p.params)).toBe("Після операції: фактично 17, доступно 14, брак 2.");
    expect(en(p.key, p.params)).toBe("After this: on hand 17, available 14, defective 2.");
  });

  it("damaged units only do not change on hand / available", () => {
    expect(receivePreview({ kind: "product", onHand: 3, available: 3, defective: 0 }, 0, 4).params).toEqual({ onHand: 3, available: 3, defective: 4 });
    expect(receivePreview({ kind: "material", onHand: 3, available: 3, defective: 0 }, 0, 4).params).toEqual({ onHand: 3, defective: 4 });
  });
});
