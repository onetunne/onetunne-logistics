/**
 * Етап 6 (інтеграційний раунд ядра): форматування й тексти ядра.
 * - formatMoney: кількість знаків — за валютою (той самий довідник, що перевірка налаштувань: currencyMinorDigits) —
 *   JPY/KRW без «,00»; суми з сотими в такій валюті показуються точно; UAH/EUR/USD — байт у байт як раніше;
 * - formatMonthYear + localizeParams: параметр month (finance.error.monthClosed) — «жовтень 2026» / «October 2026»
 *   (мітка часу — місяць за Києвом), централізовано;
 * - finance.coverage.orders|waybills — ICU-множина uk (one/few/many/other) і en;
 * - нові причини MISSING_REASONS (awaiting_reallocation, dispute_amount_unknown) — з підписами uk/en.
 */
import { describe, expect, it } from "vitest";
import { MISSING_REASONS } from "~/domain/finance";
import { DICTIONARIES, makeT } from "~/i18n";
import { localizeParams } from "~/i18n/localize";
import { currencyMinorDigits } from "~/lib/decimal";
import { formatMoney, formatMonthYear } from "~/lib/format";
import { formatMoney as formatMoneyExact } from "~/lib/money";
import { financeLabelKeys } from "~/modules/finance/core/labels";

const NB = " ";

describe("formatMoney: minor digits by currency", () => {
  it("0-decimal currencies (JPY, KRW) print whole units — no «,00» / «.00»", () => {
    expect(currencyMinorDigits("JPY")).toBe(0);
    expect(formatMoney("1250.00", "JPY", "uk")).toBe(`1${NB}250${NB}JPY`);
    expect(formatMoney("1250", "JPY", "en")).toBe(`JPY${NB}1,250`);
    expect(formatMoney("-1234567.00", "KRW", "uk")).toBe(`-1${NB}234${NB}567${NB}KRW`);
    expect(formatMoney("-1234567.00", "krw", "en")).toBe(`-KRW${NB}1,234,567`);
    expect(formatMoney("0.00", "JPY", "en")).toBe(`JPY${NB}0`);
  });

  it("damaged data (cents in a 0-decimal currency) is shown exactly, never rounded away", () => {
    expect(formatMoney("1250.50", "JPY", "uk")).toBe(`1${NB}250,50${NB}JPY`);
    expect(formatMoney("1250.05", "JPY", "en")).toBe(`JPY${NB}1,250.05`);
  });

  it("UAH / EUR / USD / GBP / PLN output is byte-identical to app/lib/money.ts (stages 1–5)", () => {
    for (const currency of ["UAH", "EUR", "USD", "GBP", "PLN"]) {
      for (const amount of ["0.00", "1.5", "-0.01", "1234.50", "-987654321.99", "100"]) {
        for (const locale of ["uk", "en"] as const) expect(formatMoney(amount, currency, locale), `${amount} ${currency} ${locale}`).toBe(formatMoneyExact(amount, currency, locale));
      }
    }
    expect(formatMoney("1234.50", "UAH", "uk")).toBe(`1${NB}234,50${NB}грн`);
    expect(formatMoney("1234.50", "EUR", "en")).toBe("€1,234.50");
    expect(formatMoney(null, "EUR", "en")).toBe("—");
    expect(formatMoney("1.00", null, "en")).toBe("—");
  });
});

describe("month names (finance.error.monthClosed {month}) — centrally in localizeParams", () => {
  it("formatMonthYear: calendar months as is, timestamps by Kyiv time; unknown text unchanged", () => {
    expect(formatMonthYear("2026-10-01", "uk")).toBe("жовтень 2026");
    expect(formatMonthYear("2026-10", "en")).toBe("October 2026");
    expect(formatMonthYear("2026-01-01", "uk")).toBe("січень 2026");
    expect(formatMonthYear("2026-12-01", "en")).toBe("December 2026");
    // 31.10 22:30 UTC = 01.11 00:30 за Києвом.
    expect(formatMonthYear(new Date("2026-10-31T22:30:00Z"), "uk")).toBe("листопад 2026");
    expect(formatMonthYear("2026-10-31T22:30:00Z", "en")).toBe("November 2026");
    expect(formatMonthYear("2026-13-01", "uk")).toBe("2026-13-01");
    expect(formatMonthYear("10.2026", "uk")).toBe("10.2026");
  });

  it("localizeParams formats a raw ISO month; a pre-formatted month stays; the message reads naturally", () => {
    const uk = makeT("uk");
    const en = makeT("en");
    const p = localizeParams({ month: "2026-10-01" }, uk, "uk");
    expect(p?.month).toBe("жовтень 2026");
    expect(uk("finance.error.monthClosed", p)).toBe("Місяць жовтень 2026 закрито. Щоб змінити, відкрийте місяць повторно (з причиною).");
    expect(en("finance.error.monthClosed", localizeParams({ month: "2026-10-01" }, en, "en"))).toBe("Month October 2026 is closed. To change it, reopen the month (with a reason).");
    expect(localizeParams({ month: "10.2026" }, uk, "uk")?.month).toBe("10.2026");
    expect(localizeParams({ month: "2026-10-15" }, uk, "uk")?.month).toBe("2026-10-15");
    expect(localizeParams({ month: 10 }, uk, "uk")?.month).toBe(10);
  });
});

describe("finance.coverage plurals", () => {
  it("uk: one / few / many / other; en: one / other", () => {
    const uk = makeT("uk");
    const en = makeT("en");
    const k = financeLabelKeys.coverage;
    expect(uk(k("orders"), { n: 1, m: 1 })).toBe("за 1 з 1 замовлення");
    expect(uk(k("orders"), { n: 2, m: 3 })).toBe("за 2 з 3 замовлень");
    expect(uk(k("orders"), { n: 4, m: 5 })).toBe("за 4 з 5 замовлень");
    expect(uk(k("orders"), { n: 20, m: 21 })).toBe("за 20 з 21 замовлення");
    expect(uk(k("orders"), { n: "1", m: "1,5" })).toBe("за 1 з 1,5 замовлення");
    expect(uk(k("waybills"), { n: 1, m: 1 })).toBe("на основі 1 з 1 накладної");
    expect(uk(k("waybills"), { n: 1, m: 2 })).toBe("на основі 1 з 2 накладних");
    expect(uk(k("waybills"), { n: 3, m: 11 })).toBe("на основі 3 з 11 накладних");
    expect(en(k("orders"), { n: 1, m: 1 })).toBe("for 1 of 1 order");
    expect(en(k("orders"), { n: 2, m: 3 })).toBe("for 2 of 3 orders");
    expect(en(k("waybills"), { n: 0, m: 1 })).toBe("based on 0 of 1 waybill");
    expect(en(k("waybills"), { n: 1, m: 1234 })).toBe("based on 1 of 1234 waybills");
  });
});

describe("missing reasons added in the integration round", () => {
  it("awaiting_reallocation (WP6, I16) and dispute_amount_unknown (WP7) exist with uk/en labels", () => {
    expect(MISSING_REASONS).toEqual(expect.arrayContaining(["awaiting_reallocation", "dispute_amount_unknown"]));
    for (const r of MISSING_REASONS) {
      for (const l of ["uk", "en"] as const) expect(DICTIONARIES[l][financeLabelKeys.reason(r)], `${l}:${r}`).toBeTruthy();
    }
    expect(DICTIONARIES.uk[financeLabelKeys.reason("awaiting_reallocation")]).toBe("Очікує перерахунку розподілу суми періоду");
    expect(DICTIONARIES.en[financeLabelKeys.reason("dispute_amount_unknown")]).toBe("Dispute amount unknown");
  });
});
