/**
 * Етап 6, WP0-UI: банер повноти (§2.6, §2.7, §18.1, §18.3). Порожній період — «Немає визнаних замовлень», НЕ «Повні
 * дані»; маркер — значок + текст; «Що заповнити»: бракує за складниками, без курсу («Без курсу: 120,00 PLN (2 записи)»),
 * розбіжності, перевірка, закриті місяці; назва прибутку — лише за правилом §2.7; демо й тестові замовлення.
 */
import { createElement as h } from "react";
import { describe, expect, it } from "vitest";
import { CompletenessBanner, completenessItems } from "~/components/finance/completeness-banner";
import { makeFinanceUiT } from "~/components/finance/i18n";
import { completenessMarker, emptyCompleteness, type CompletenessSummary } from "~/modules/finance/core/states";
import { CYRILLIC, renderUi, textOf } from "./render";

function summary(over: Partial<CompletenessSummary>): CompletenessSummary {
  return { ...emptyCompleteness(), ...over };
}

const INCOMPLETE = summary({
  orders: 120,
  final: 96,
  preliminary: 22,
  incomplete: 2,
  open: 14,
  excluded: 1,
  missingByComponent: { shipping_cost: 9, cogs: 2 },
  forecastByComponent: { shipping_cost: 22 },
  needsReview: 3,
  unconverted: [{ currency: "PLN", amount: "120.00", entries: 2 }],
  staleRates: 1,
  openDiscrepancies: 4,
  unknownCostUnitsOnHand: 5,
  lateEntries: 1,
  closedMonths: ["2026-10-01"],
});

describe("CompletenessBanner", () => {
  it("empty finance database: «No recognized orders», never «Complete data»", async () => {
    for (const marker of ["complete", "with_forecast", "incomplete"] as const) {
      const html = await renderUi(() =>
        h(CompletenessBanner, { completeness: emptyCompleteness(), marker, profitLabel: "profit_after_recorded_costs", includesTestOrders: false, demo: false }),
      );
      const text = textOf(html);
      expect(text).toContain("Немає даних за цей період");
      expect(text).toContain("Немає визнаних замовлень за цей період");
      expect(text).not.toContain("Повні дані");
      expect(html).toContain('data-marker="empty"');
      expect(html).toContain("ot-banner--info");
      expect(text).toContain("Щоб показати чистий прибуток, закрийте місяць");
    }
  });

  it("0 recognized orders with info-only items (paid not shipped, test orders, closed months): never «Complete data»", async () => {
    // Рецензія WP0-UI: на початку місяця до першого відвантаження ядро дає маркер complete для 0 замовлень.
    for (const over of [{ open: 3 }, { excluded: 2 }, { closedMonths: ["2026-10-01"] }, { open: 1, excluded: 1, lateEntries: 2, staleRates: 1 }]) {
      const c = summary(over);
      const marker = completenessMarker(c);
      expect(marker).toBe("complete");
      for (const locale of ["uk", "en"] as const) {
        const html = await renderUi(
          () => h(CompletenessBanner, { completeness: c, marker, profitLabel: "profit_after_recorded_costs", includesTestOrders: false, demo: false }),
          { locale },
        );
        const text = textOf(html);
        const where = `${locale} ${JSON.stringify(over)}`;
        expect(html, where).toContain('data-marker="empty"');
        expect(html, where).toContain("ot-banner--info");
        expect(html, where).not.toContain("ot-banner--success");
        expect(html, where).not.toContain('class="ot-marker"');
        expect(text, where).not.toMatch(locale === "uk" ? /Повні дані|З прогнозом|з 0 визнаних/ : /Complete data|With forecast|of 0 recognized/);
        expect(text, where).toContain(locale === "uk" ? "Немає визнаних замовлень" : "No recognized orders");
        expect(text, where).toContain(locale === "uk" ? "показників замовлень ще немає" : "no order figures yet");
        // Пункти періоду лишаються видимими (розгортання відкрите).
        expect(html, where).toMatch(/<details class="ot-disclosure ot-completeness__details"[^>]*open=""/);
        if (locale === "en") expect(text, where).not.toMatch(CYRILLIC);
      }
    }
    const uk = textOf(
      await renderUi(() =>
        h(CompletenessBanner, { completeness: summary({ open: 3, excluded: 2, closedMonths: ["2026-10-01"] }), marker: "complete", profitLabel: "profit_after_recorded_costs", includesTestOrders: false, demo: false }),
      ),
    );
    expect(uk).toContain("Оплачено, ще не відвантажено: 3 замовлення");
    expect(uk).toContain("Не враховуються (тестові тощо): 2 замовлення");
    expect(uk).toContain("Закриті місяці — з остаточних знімків: 10.2026");
    expect(uk).not.toContain("Немає даних за цей період");
  });

  it("0 recognized orders but entries without a rate: «Incomplete data» stays, without the «0 · 0 · 0 — of 0» line", async () => {
    const c = summary({ unconverted: [{ currency: "PLN", amount: "120.00", entries: 2 }], open: 1 });
    const marker = completenessMarker(c);
    expect(marker).toBe("incomplete");
    const html = await renderUi(() => h(CompletenessBanner, { completeness: c, marker, profitLabel: "profit_after_recorded_costs", includesTestOrders: false, demo: false }));
    const text = textOf(html);
    expect(html).toContain('data-marker="incomplete"');
    expect(html).toContain("ot-banner--warning");
    expect(text).toContain("Неповні дані");
    expect(text).toContain("Визнаних замовлень за цей період немає");
    expect(text).not.toMatch(/з 0 визнаних|Остаточно: 0/);
    expect(text).toContain("Без курсу: 120,00 PLN (2 записи)");
  });

  it("incomplete data: warning banner with the marker icon, order states and every item to fill in", async () => {
    const html = await renderUi(() =>
      h(CompletenessBanner, { completeness: INCOMPLETE, marker: "incomplete", profitLabel: "profit_after_recorded_costs", includesTestOrders: false, demo: false }),
    );
    const text = textOf(html);
    expect(html).toContain("ot-banner--warning");
    expect(html).toMatch(/data-marker="incomplete"[\s\S]*data-icon="warning"/);
    expect(text).toContain("Неповні дані");
    expect(text).toContain("Остаточно: 96 · Попередньо: 22 · Неповно: 2 — з 120 визнаних замовлень");
    expect(text).toContain("Що заповнити");
    for (const line of [
      "Собівартість: немає даних — 2 замовлення",
      "Доставка: немає даних — 9 замовлень",
      "Без курсу: 120,00 PLN (2 записи)",
      "Не входять у прибуток через неповні дані: 2 замовлення",
      "Відкриті розбіжності: 4",
      "Потребують перевірки: 3 замовлення",
      "Без собівартості на складі: 5 од.",
      "Доставка: лише прогноз — 22 замовлення",
      "Лише в «≈ Прогноз» (попередні): 22 замовлення",
      "Курси за попередні дати (запасні): 1",
      "Пізні записи: 1",
      "Оплачено, ще не відвантажено: 14 замовлень",
      "Не враховуються (тестові тощо): 1 замовлення",
      "Закриті місяці — з остаточних знімків: 10.2026",
    ]) {
      expect(text, line).toContain(line);
    }
    // Порядок: спершу те, що змінює числа (складники в порядку ORDER_COMPONENTS), потім пояснення.
    const items = completenessItems(INCOMPLETE, makeFinanceUiT("uk"), "uk");
    expect(items.slice(0, 2).map((i) => i.key)).toEqual(["missing:cogs", "missing:shipping_cost"]);
    expect(items.filter((i) => i.tone === "warning").map((i) => i.key)).toEqual([
      "missing:cogs",
      "missing:shipping_cost",
      "unconverted:PLN",
      "incomplete",
      "discrepancies",
      "needsReview",
      "unknownCost",
    ]);
    // Розгорнуто для неповних даних (details open).
    expect(html).toMatch(/<details class="ot-disclosure ot-completeness__details"[^>]*open=""/);
  });

  it("complete data: success banner, no «What to fill in»; net profit wording only with profitLabel net_profit (§2.7)", async () => {
    const done = summary({ orders: 10, final: 10, netProfitEligible: true });
    const net = textOf(await renderUi(() => h(CompletenessBanner, { completeness: done, marker: "complete", profitLabel: "net_profit", includesTestOrders: false, demo: false })));
    expect(net).toContain("Повні дані");
    expect(net).toContain("показано чистий прибуток");
    expect(net).not.toContain("Що заповнити");
    const after = textOf(
      await renderUi(() => h(CompletenessBanner, { completeness: done, marker: "complete", profitLabel: "profit_after_recorded_costs", includesTestOrders: false, demo: false })),
    );
    expect(after).not.toContain("чистий прибуток.");
    expect(after).toContain("Щоб показати чистий прибуток, закрийте місяць і підтвердьте всі витрати й податки.");
  });

  it("demo and test-order banners", async () => {
    const html = await renderUi(() =>
      h(CompletenessBanner, { completeness: summary({ orders: 1, final: 1 }), marker: "complete", profitLabel: "profit_after_recorded_costs", includesTestOrders: true, demo: true }),
    );
    const text = textOf(html);
    expect(text).toContain("Демо: усі фінансові дані вигадані.");
    expect(text).toContain("Враховано тестові замовлення");
  });

  it("English: no Cyrillic; plurals", async () => {
    const html = await renderUi(
      () => h(CompletenessBanner, { completeness: INCOMPLETE, marker: "incomplete", profitLabel: "profit_after_recorded_costs", includesTestOrders: true, demo: true }),
      { locale: "en" },
    );
    const text = textOf(html);
    expect(text).not.toMatch(CYRILLIC);
    expect(text).toContain("Final: 96 · Preliminary: 22 · Incomplete: 2 — of 120 recognized orders");
    expect(text).toContain("Shipping: no data — 9 orders");
    expect(text).toContain("Not included (test orders etc.): 1 order");
    expect(text).toContain("Closed months come from final snapshots: 10/2026");
  });
});
