import { describe, expect, it } from "vitest";
import common from "~/i18n/messages/common";
import { ORDER_STATUSES } from "~/domain/order-status";

const NAV_KEYS = [
  "dashboard",
  "orders",
  "waybills",
  "shipping",
  "picking",
  "tracking",
  "problems",
  "returns",
  "warehouse",
  "production",
  "finance",
  "analytics",
  "assistant",
  "development",
  "countryRules",
  "staff",
  "settings",
];

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "").sort();
}

describe("i18n common messages", () => {
  it("has identical key sets for uk and en", () => {
    expect(Object.keys(common.uk).sort()).toEqual(Object.keys(common.en).sort());
  });

  it("has only non-empty strings", () => {
    for (const locale of ["uk", "en"] as const) {
      for (const [key, value] of Object.entries(common[locale])) {
        expect(typeof value, `${locale}:${key}`).toBe("string");
        expect(value.trim().length, `${locale}:${key}`).toBeGreaterThan(0);
      }
    }
  });

  it("uses the same {placeholders} in both locales", () => {
    for (const key of Object.keys(common.uk)) {
      expect(placeholders(common.en[key] ?? ""), key).toEqual(placeholders(common.uk[key] ?? ""));
    }
  });

  it("covers every order status and nav section", () => {
    for (const status of ORDER_STATUSES) expect(common.uk[`status.${status}`], status).toBeTruthy();
    for (const key of NAV_KEYS) expect(common.uk[`nav.${key}`], key).toBeTruthy();
  });

  it("keeps required Ukrainian wording", () => {
    expect(common.uk["app.name"]).toBe("ONE TUNNE Logistics");
    expect(common.en["app.name"]).toBe("ONE TUNNE Logistics");
    expect(ORDER_STATUSES.map((s) => common.uk[`status.${s}`])).toEqual([
      "Оплачено",
      "Очікує перевірки",
      "Потребує виправлення",
      "Накладна створена",
      "Очікує комплектації",
      "Запаковано",
      "Передано перевізнику",
      "У дорозі",
      "Митне оформлення",
      "Доставлено",
      "Проблема з доставкою",
      "Повернення",
      "Скасовано",
    ]);
    expect(common.uk["nav.assistant"]).toBe("ШІ-асистент");
    expect(common.uk["shipmentStatus.unknown"]).toBe("Результат невідомий");
    expect(common.uk["common.pageOf"]).toBe("Сторінка {page} з {pages}");
    expect(common.uk["common.required"]).toBe("Обов’язкове поле");
    expect(common.uk["error.conflict"]).toBe("Дані змінилися іншим користувачем. Оновіть сторінку.");
    expect(common.uk["language.uk"]).toBe("Українська");
    expect(common.en["language.en"]).toBe("English");
  });
});
