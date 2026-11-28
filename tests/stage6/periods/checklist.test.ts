/**
 * Етап 6, WP6: чисте правило чек-листа закриття (§3.4, §2.7). ■ блокує (не остаточні замовлення; записи без курсу для
 * будь-якої валюти показу); ▲ лише попереджає; ☐ — право на «Чистий прибуток» (податки — «внесено» або «немає»,
 * упаковка — лише за потреби); закрити — лише повністю минулий місяць. Підтвердження узгоджуються з записами.
 */
import { describe, expect, it } from "vitest";
import { PERIOD_CHECKLIST_ITEMS } from "~/domain/finance";
import { allowedConfirmValues, checklistForLog, confirmationError, evaluateChecklist, type ChecklistFacts } from "~/modules/finance/periods/checklist";

const facts = (over: Partial<ChecklistFacts> = {}): ChecklistFacts => ({
  fullyPast: true,
  ordersRecognized: 10,
  ordersNotFinal: 0,
  entries: 120,
  entriesWithoutRate: { UAH: 0, EUR: 0 },
  openDiscrepancies: 0,
  criticalDiscrepancies: 0,
  ordersNeedReview: 0,
  unknownCostUnits: 0,
  packagingTotals: 0,
  ordersWithPackagingForecast: 0,
  entriesByConfirmItem: {},
  confirmations: {},
  ...over,
});

const ALL_CONFIRMED = {
  advertising: "entered",
  payment_fees: "entered",
  platform_fees: "entered",
  salaries: "none_this_month",
  rent_services: "none_this_month",
  taxes_company: "entered",
  other_expenses: "none_this_month",
} as const;

/** Записи місяця, що узгоджуються з ALL_CONFIRMED («внесено» — є записи, «немає» — нема). */
const MATCHING_ENTRIES = { advertising: 3, payment_fees: 2, platform_fees: 1, taxes_company: 1 } as const;

describe("checklist evaluation", () => {
  it("lists every item of the design in order ■ ▲ ☐", () => {
    const r = evaluateChecklist(facts());
    expect(r.items.map((i) => i.item)).toEqual([...PERIOD_CHECKLIST_ITEMS]);
    expect(r.items.map((i) => i.kind)).toEqual(["blocking", "blocking", "warning", "warning", "warning", "warning", ...Array(8).fill("confirm")]);
  });

  it("■ blocks closing: a non-final order or an entry without a rate for any display currency", () => {
    expect(evaluateChecklist(facts()).canClose).toBe(true);
    const notFinal = evaluateChecklist(facts({ ordersNotFinal: 1 }));
    expect(notFinal).toMatchObject({ canClose: false, blockingFailures: 1 });
    expect(notFinal.items[0]).toMatchObject({ status: "blocked", count: 1, details: { recognized: 10 } });
    const noRate = evaluateChecklist(facts({ entriesWithoutRate: { UAH: 0, EUR: 3 } }));
    expect(noRate).toMatchObject({ canClose: false, blockingFailures: 1 });
    expect(noRate.items[1]).toMatchObject({ status: "blocked", count: 3, details: { EUR: 3, UAH: 0, entries: 120 } });
    expect(evaluateChecklist(facts({ fullyPast: false })).canClose).toBe(false);
  });

  it("▲ only warns", () => {
    const r = evaluateChecklist(facts({ openDiscrepancies: 2, criticalDiscrepancies: 1, ordersNeedReview: 1, unknownCostUnits: 7 }));
    expect(r).toMatchObject({ canClose: true, warnings: 3 });
    expect(r.items.find((i) => i.item === "open_discrepancies")).toMatchObject({ status: "warning", count: 2, details: { critical: 1 } });
  });

  it("☐: net profit needs every confirmation incl. taxes; packaging only when a packaging total exists", () => {
    expect(evaluateChecklist(facts()).allConfirmed).toBe(false);
    const ok = evaluateChecklist(facts({ confirmations: ALL_CONFIRMED, entriesByConfirmItem: MATCHING_ENTRIES }));
    expect(ok).toMatchObject({ allConfirmed: true, packagingNeeded: false, pendingConfirmations: 0, staleConfirmations: 0 });
    expect(ok.items.find((i) => i.item === "packaging_total_accounted")).toMatchObject({ status: "not_needed" });
    const { taxes_company: _t, ...noTaxes } = ALL_CONFIRMED;
    expect(evaluateChecklist(facts({ confirmations: noTaxes, entriesByConfirmItem: MATCHING_ENTRIES })).allConfirmed).toBe(false);
    const pkgEntries = { ...MATCHING_ENTRIES, packaging_total_accounted: 2 };
    const pkg = evaluateChecklist(facts({ confirmations: ALL_CONFIRMED, entriesByConfirmItem: pkgEntries, packagingTotals: 2, ordersWithPackagingForecast: 5 }));
    expect(pkg).toMatchObject({ packagingNeeded: true, allConfirmed: false });
    expect(pkg.items.find((i) => i.item === "packaging_forecast_with_total")).toMatchObject({ status: "warning", count: 5 });
    const pkgOk = evaluateChecklist(
      facts({ confirmations: { ...ALL_CONFIRMED, packaging_total_accounted: "entered" }, entriesByConfirmItem: pkgEntries, packagingTotals: 2, ordersWithPackagingForecast: 5 }),
    );
    expect(pkgOk).toMatchObject({ allConfirmed: true });
    expect(pkgOk.items.find((i) => i.item === "packaging_forecast_with_total")).toMatchObject({ status: "ok", count: 0 });
    expect(evaluateChecklist(facts({ confirmations: { ...ALL_CONFIRMED, packaging_total_accounted: "not_needed" }, entriesByConfirmItem: pkgEntries, packagingTotals: 2 })).allConfirmed).toBe(true);
  });

  it("☐ confirmations are re-checked on every evaluation: one that no longer matches the ledger is «stale» and denies net profit (§2.7)", () => {
    // «Внесено» податки, але діючих записів і витрат податків за місяць уже немає (анульовано).
    const { taxes_company: _x, ...noTaxEntries } = MATCHING_ENTRIES;
    const voided = evaluateChecklist(facts({ confirmations: ALL_CONFIRMED, entriesByConfirmItem: noTaxEntries }));
    expect(voided).toMatchObject({ allConfirmed: false, staleConfirmations: 1, pendingConfirmations: 0, canClose: true });
    expect(voided.items.find((i) => i.item === "taxes_company")).toMatchObject({
      status: "stale",
      value: "entered",
      staleReason: "financeExpenses.error.confirmEnteredWithoutEntries",
    });
    // «За місяць немає» зарплат, а зарплату внесено пізніше.
    const added = evaluateChecklist(facts({ confirmations: ALL_CONFIRMED, entriesByConfirmItem: { ...MATCHING_ENTRIES, salaries: 1 } }));
    expect(added).toMatchObject({ allConfirmed: false, staleConfirmations: 1 });
    expect(added.items.find((i) => i.item === "salaries")).toMatchObject({ status: "stale", staleReason: "financeExpenses.error.confirmNoneWithEntries" });
    // Витрати періоду, датовані місяцем (частки яких визнано в наступному), — теж «внесено».
    const { payment_fees: _p, ...noFeeEntries } = MATCHING_ENTRIES;
    const viaExpense = evaluateChecklist(facts({ confirmations: ALL_CONFIRMED, entriesByConfirmItem: noFeeEntries, expensesByConfirmItem: { payment_fees: 1 } }));
    expect(viaExpense).toMatchObject({ allConfirmed: true, staleConfirmations: 0 });
    expect(viaExpense.items.find((i) => i.item === "payment_fees")).toMatchObject({ status: "confirmed", count: 0, details: { expenses: 1 } });
    // «Упаковку обліковано загальною сумою», а загальної суми вже немає — теж застаріло.
    const pkgGone = evaluateChecklist(facts({ confirmations: { ...ALL_CONFIRMED, packaging_total_accounted: "entered" }, entriesByConfirmItem: MATCHING_ENTRIES }));
    expect(pkgGone).toMatchObject({ packagingNeeded: false, allConfirmed: false, staleConfirmations: 1 });
    expect(pkgGone.items.find((i) => i.item === "packaging_total_accounted")).toMatchObject({ status: "stale" });
    // Журнал закриття фіксує застаріле підтвердження як «stale».
    expect(checklistForLog(voided)).toMatchObject({ taxes_company: "stale", advertising: "entered", salaries: "none_this_month" });
  });

  it("confirmations agree with the month's entries", () => {
    expect(allowedConfirmValues("taxes_company")).toEqual(["entered", "none_this_month"]);
    expect(allowedConfirmValues("packaging_total_accounted")).toEqual(["entered", "not_needed"]);
    expect(confirmationError("taxes_company", "entered", 0)).toBe("financeExpenses.error.confirmEnteredWithoutEntries");
    expect(confirmationError("taxes_company", "entered", 1)).toBeNull();
    expect(confirmationError("taxes_company", "none_this_month", 1)).toBe("financeExpenses.error.confirmNoneWithEntries");
    expect(confirmationError("taxes_company", "none_this_month", 0)).toBeNull();
    expect(confirmationError("taxes_company", "not_needed", 0)).toBe("financeExpenses.error.confirmValueInvalid");
    expect(confirmationError("packaging_total_accounted", "not_needed", 0)).toBeNull();
  });

  it("flat log view: counts for ■ ▲, values for ☐", () => {
    const flat = checklistForLog(evaluateChecklist(facts({ ordersNotFinal: 2, confirmations: { taxes_company: "entered" }, entriesByConfirmItem: { taxes_company: 1 } })));
    expect(flat).toMatchObject({ orders_final: 2, rates_for_display_currencies: 0, taxes_company: "entered", advertising: null });
  });
});
