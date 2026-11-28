/**
 * Етап 6 (WP0): повнота переліків app/domain/finance.ts і спільного модуля i18n finance (docs/stage6-design.md §2.1,
 * §18.10). «Тест падає, якщо категорія не має виду, рядка P&L або перекладу»; SALE_CATEGORY_MAP — кожна комбінація
 * виду угоди × часу × типу рядка × знака.
 */
import { describe, expect, it } from "vitest";
import {
  AGREEMENT_KINDS,
  CHARGE_TYPES,
  COMPLETENESS_MARKERS,
  COMPONENT_REASONS,
  COMPONENT_STATES,
  DISCREPANCY_CODES,
  DISCREPANCY_DEFAULT_SEVERITY,
  DISCREPANCY_RESOLUTIONS,
  DISCREPANCY_SEVERITIES,
  DISCREPANCY_STATUSES,
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_RULES,
  FACTS_SOURCES,
  FINANCE_BASES,
  FINANCE_CATEGORIES,
  FINANCE_CATEGORY_DEFS,
  FINANCE_CHANGE_ACTIONS,
  FINANCE_CHANGE_ENTITY_TYPES,
  FINANCE_EXPORT_DATASET_NAMES,
  FINANCE_KINDS,
  FINANCE_NOTICES,
  FINANCE_PERIOD_STATUSES,
  FINANCE_SOURCE_TYPES,
  FINANCE_TABS,
  FINANCE_TERMS,
  FX_RATE_DATE_POLICIES,
  MEMO_CATEGORIES,
  ORDER_COMPONENTS,
  ORDER_FINANCE_STATES,
  PARTNER_COMMISSION_STATES,
  PERIOD_CHECKLIST_ITEMS,
  PNL_LINES,
  PNL_MEMO_LINES,
  PNL_SUBLINES,
  PNL_TOTALS,
  PNL_TOTAL_PARTS,
  PROFIT_CATEGORIES,
  PROFIT_LABELS,
  PROFIT_STATES,
  RECOGNITION_BASES,
  RECONCILIATION_AFFECTS,
  RECONCILIATION_CANDIDATES,
  RECONCILIATION_CHECKS,
  REPORT_KINDS,
  RETURN_SALE_SIGN,
  REVIEW_REASONS,
  SALE_CATEGORY_MAP,
  SALE_LINE_TYPES,
  SALE_TIMINGS,
  SNAPSHOT_SOURCES,
  affectsProfit,
  categoriesOfLine,
  classifySale,
  kindOf,
} from "~/domain/finance";
import { DICTIONARIES, MESSAGE_MODULES } from "~/i18n";
import { COMPARE_MODES, GRANULARITIES, PERIOD_PRESETS } from "~/lib/periods";
import { CHECKLIST_KINDS, COVERAGE_KINDS, FINANCE_ERROR_CODES, RATE_LABELS, financeLabelKeys } from "~/modules/finance/core/labels";
import { FINANCE_JOB, FINANCE_JOB_NAMES, FINANCE_JOB_OWNER } from "~/modules/finance/jobs";
import { FINANCE_SETTINGS_FIELDS, financeSchema } from "~/modules/settings/schema";

const both = (key: string) => [DICTIONARIES.uk[key], DICTIONARIES.en[key]];
function expectTranslated(keys: readonly string[]) {
  const missing = keys.filter((k) => both(k).some((v) => !v || !v.trim()));
  expect(missing).toEqual([]);
}

describe("finance categories (§2.1)", () => {
  it("every category has a kind, a P&L line and uk/en labels", () => {
    expect(FINANCE_CATEGORIES.length).toBe(44);
    for (const c of FINANCE_CATEGORIES) {
      const def = FINANCE_CATEGORY_DEFS[c];
      expect(FINANCE_KINDS, c).toContain(def.kind);
      if (def.kind === "memo") expect(PNL_MEMO_LINES, c).toContain(def.line);
      else expect(PNL_LINES, c).toContain(def.line);
    }
    expectTranslated(FINANCE_CATEGORIES.map(financeLabelKeys.category));
    expectTranslated(FINANCE_KINDS.map(financeLabelKeys.kind));
  });

  it("the P&L definition of §2.2: every line has categories; memo categories never affect profit (I8)", () => {
    for (const line of [...PNL_LINES, ...PNL_MEMO_LINES]) expect(categoriesOfLine(line).length, line).toBeGreaterThan(0);
    expect(categoriesOfLine("D").sort()).toEqual(["refund_adjustment", "refund_other", "refund_product", "refund_shipping", "refund_unknown"]);
    expect(categoriesOfLine("G").sort()).toEqual(["return_shipping_cost", "shipping_cost", "shipping_unallocated"]);
    expect(categoriesOfLine("O").sort()).toEqual(["bank_fees", "other_expense", "other_income", "rent", "return_handling", "salaries", "services"]);
    expect(categoriesOfLine("N").sort()).toEqual(["inventory_gain", "inventory_loss"]);
    for (const c of MEMO_CATEGORIES) expect(affectsProfit(c)).toBe(false);
    expect(PROFIT_CATEGORIES.length + MEMO_CATEGORIES.length).toBe(FINANCE_CATEGORIES.length);
    expect(PNL_TOTAL_PARTS.PR).toEqual(PNL_LINES);
    expectTranslated([...PNL_LINES, ...PNL_TOTALS, ...PNL_MEMO_LINES, ...PNL_SUBLINES].map(financeLabelKeys.pnl));
  });

  it("manual expense categories (§10.1) are journal categories with an order rule", () => {
    for (const c of EXPENSE_CATEGORIES) expect(FINANCE_CATEGORIES).toContain(c);
    expect(EXPENSE_CATEGORY_RULES.return_shipping_cost).toBe("required");
    expect(EXPENSE_CATEGORY_RULES.advertising).toBe("forbidden");
    expect(EXPENSE_CATEGORY_RULES.inventory_loss).toBe("batch_only");
    expect(EXPENSE_CATEGORY_RULES.shipping_cost).toBe("optional");
    expect(kindOf("advertising")).toBe("period_cost");
  });
});

describe("SALE_CATEGORY_MAP (§2.1): every agreement kind × timing × line type × sign", () => {
  const expected = (kind: string, timing: string, line: string): string => {
    const after = timing === "after_recognition" && (kind === "refund" || kind === "return" || kind === "unknown");
    const salesMap: Record<string, string> = {
      PRODUCT: "sales_product",
      SHIPPING: "sales_shipping",
      TIP: "sales_other",
      DUTY: "sales_other",
      FEE: "sales_other",
      ADDITIONAL_FEE: "sales_other",
      ADJUSTMENT: "sales_adjustment",
      GIFT_CARD: "gift_card_memo",
      UNKNOWN: "sales_unknown",
    };
    const refundMap: Record<string, string> = {
      PRODUCT: "refund_product",
      SHIPPING: "refund_shipping",
      TIP: "refund_other",
      DUTY: "refund_other",
      FEE: "refund_other",
      ADDITIONAL_FEE: "refund_other",
      ADJUSTMENT: "refund_adjustment",
      GIFT_CARD: "gift_card_memo",
      UNKNOWN: "refund_unknown",
    };
    return (after ? refundMap : salesMap)[line]!;
  };

  for (const kind of AGREEMENT_KINDS) {
    for (const timing of SALE_TIMINGS) {
      for (const line of SALE_LINE_TYPES) {
        for (const sign of [-1, 0, 1] as const) {
          it(`${kind} · ${timing} · ${line} · ${sign}`, () => {
            const r = classifySale({ agreementKind: kind, timing, lineType: line, sign });
            expect(r.category).toBe(expected(kind, timing, line));
            expect(SALE_CATEGORY_MAP[kind][timing][line]).toBe(r.category);
            // Категорія від знака не залежить; позначка «повернення до відвантаження» — лише до визнання.
            const refundLike = kind === "refund" || kind === "return" || (kind === "unknown" && sign < 0);
            expect(r.preRecognitionRefund).toBe(timing === "before_recognition" && refundLike);
            expect(r.review.includes("unknown_line_type")).toBe(line === "UNKNOWN");
            expect(r.review.includes("unknown_agreement")).toBe(kind === "unknown");
            expect(r.review.includes("edited_after_recognition")).toBe(kind === "order_edit" && timing === "after_recognition");
          });
        }
      }
    }
  }

  it("RETURN_SALE_SIGN and reconciliation constants live in one place", () => {
    expect(RETURN_SALE_SIGN).toBe(-1);
    expect(RECONCILIATION_CANDIDATES).toEqual(["RC1", "RC4"]);
    expect(Object.keys(RECONCILIATION_AFFECTS).sort()).toEqual([...RECONCILIATION_CHECKS].sort());
    expect(RECONCILIATION_AFFECTS.RC2).toEqual(["fees"]);
  });
});

describe("states, reasons, codes: complete and translated (§2.6, §7.5, §14.4, §18.10)", () => {
  it("component states, profit/order states, reasons, bases, components", () => {
    expectTranslated(COMPONENT_STATES.map(financeLabelKeys.state));
    expectTranslated(PROFIT_STATES.map(financeLabelKeys.profitState));
    expectTranslated(ORDER_FINANCE_STATES.map(financeLabelKeys.orderState));
    expectTranslated(RECOGNITION_BASES.map(financeLabelKeys.recognitionBasis));
    expectTranslated(FACTS_SOURCES.map(financeLabelKeys.factsSource));
    expectTranslated(COMPONENT_REASONS.map(financeLabelKeys.reason));
    expectTranslated(FINANCE_BASES.map(financeLabelKeys.basis));
    expectTranslated(ORDER_COMPONENTS.map(financeLabelKeys.component));
    expectTranslated(COMPLETENESS_MARKERS.map(financeLabelKeys.completeness));
    expectTranslated(COVERAGE_KINDS.map(financeLabelKeys.coverage));
    expect(COMPONENT_STATES).toEqual(["actual", "partial", "forecast", "missing", "zero_confirmed", "not_applicable"]);
    expect(DICTIONARIES.uk[financeLabelKeys.state("missing")]).toBe("Немає даних");
    expect(DICTIONARIES.en[financeLabelKeys.state("zero_confirmed")]).toBe("0 (confirmed)");
  });

  it("discrepancy codes (§7.5 + others) with default severity, statuses and resolutions", () => {
    expect(DISCREPANCY_CODES.length).toBe(26);
    for (const c of DISCREPANCY_CODES) expect(DISCREPANCY_SEVERITIES).toContain(DISCREPANCY_DEFAULT_SEVERITY[c]);
    expectTranslated(DISCREPANCY_CODES.map(financeLabelKeys.discrepancy));
    expectTranslated(DISCREPANCY_STATUSES.map(financeLabelKeys.discrepancyStatus));
    expectTranslated(DISCREPANCY_SEVERITIES.map(financeLabelKeys.severity));
    expectTranslated(DISCREPANCY_RESOLUTIONS.map(financeLabelKeys.resolution));
  });

  it("review reasons, sources, agreement kinds, rate labels, partner states, change log", () => {
    expectTranslated(REVIEW_REASONS.map(financeLabelKeys.review));
    expectTranslated(FINANCE_SOURCE_TYPES.map(financeLabelKeys.source));
    expectTranslated(AGREEMENT_KINDS.map(financeLabelKeys.agreement));
    expectTranslated((["base", "nbu", "manual", "demo"] as const).map(financeLabelKeys.rateSource));
    expectTranslated(RATE_LABELS.map(financeLabelKeys.rate));
    expectTranslated(PARTNER_COMMISSION_STATES.map(financeLabelKeys.partnerState));
    expectTranslated(FINANCE_CHANGE_ENTITY_TYPES.map(financeLabelKeys.changeEntity));
    expectTranslated(FINANCE_CHANGE_ACTIONS.map(financeLabelKeys.changeAction));
  });

  it("menu, glossary, notices, errors, periods, reports, checklist", () => {
    expectTranslated(FINANCE_TABS.map((t) => financeLabelKeys.tab(t.key)));
    expect(FINANCE_TABS.map((t) => t.key)).toEqual(["overview", "orders", "shipping", "expenses", "partners", "costs", "rates", "reports", "periods", "settings"]);
    expectTranslated(FINANCE_TERMS.map(financeLabelKeys.term));
    expectTranslated(FINANCE_NOTICES.map(financeLabelKeys.notice));
    expectTranslated(FINANCE_ERROR_CODES.map(financeLabelKeys.error));
    expectTranslated(PROFIT_LABELS.map(financeLabelKeys.profitLabel));
    expectTranslated(PERIOD_PRESETS.map(financeLabelKeys.period));
    expectTranslated([...GRANULARITIES, "weekLabel" as const].map(financeLabelKeys.granularity));
    expectTranslated(COMPARE_MODES.map(financeLabelKeys.compare));
    expectTranslated(PERIOD_CHECKLIST_ITEMS.map(financeLabelKeys.checklist));
    expectTranslated(CHECKLIST_KINDS.map(financeLabelKeys.checklistKind));
    expectTranslated(FINANCE_PERIOD_STATUSES.map(financeLabelKeys.periodStatus));
    expectTranslated(REPORT_KINDS.map(financeLabelKeys.reportKind));
    expectTranslated(SNAPSHOT_SOURCES.map(financeLabelKeys.snapshotSource));
    // Глосарій §18.10 — ключові пари.
    expect(DICTIONARIES.uk[financeLabelKeys.term("profitAfterRecordedCosts")]).toBe("Прибуток після врахованих витрат");
    expect(DICTIONARIES.en[financeLabelKeys.term("profitAfterRecordedCosts")]).toBe("Profit after recorded costs");
    expect(DICTIONARIES.en[financeLabelKeys.term("turnover")]).toBe("Turnover");
    expect(DICTIONARIES.uk[financeLabelKeys.notice("demo")]).toBe("Демо: усі фінансові дані вигадані.");
  });

  it("finance settings: every field has a label and help; rate date policies translated", () => {
    expectTranslated(FINANCE_SETTINGS_FIELDS.flatMap((f) => [financeLabelKeys.settingLabel(f), financeLabelKeys.settingHelp(f)]));
    expectTranslated(FX_RATE_DATE_POLICIES.map(financeLabelKeys.rateDatePolicy));
    // Кожен шлях — справжнє поле схеми.
    const defaults = financeSchema.parse({}) as Record<string, unknown>;
    for (const f of FINANCE_SETTINGS_FIELDS) {
      const value = f.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], defaults);
      expect(value, f).not.toBeUndefined();
    }
  });

  it("job names: unique, all owned by a package module, all translated", () => {
    expect(new Set(FINANCE_JOB_NAMES).size).toBe(FINANCE_JOB_NAMES.length);
    expect(Object.keys(FINANCE_JOB_OWNER).sort()).toEqual([...FINANCE_JOB_NAMES].sort());
    for (const name of FINANCE_JOB_NAMES) expect(name.startsWith("finance.")).toBe(true);
    expect(FINANCE_JOB.syncOrder).toBe("finance.sync_order");
    expectTranslated(FINANCE_JOB_NAMES.map(financeLabelKeys.job));
  });

  it("other enumerations used by packages are non-empty and unique", () => {
    for (const list of [CHARGE_TYPES, FINANCE_EXPORT_DATASET_NAMES, REPORT_KINDS, SNAPSHOT_SOURCES] as readonly (readonly string[])[]) {
      expect(list.length).toBeGreaterThan(0);
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it("the shared finance module holds only finance.* keys; package modules only their own prefix", () => {
    for (const k of Object.keys(MESSAGE_MODULES.finance!.uk)) expect(k.startsWith("finance.")).toBe(true);
    for (const name of ["financeDashboard", "financeOrders", "financeShipping", "financeCosts", "financeFx", "financeExpenses", "partners", "analytics", "returns", "financeReports", "financeCommands"]) {
      const mod = MESSAGE_MODULES[name];
      expect(mod, name).toBeDefined();
      for (const k of Object.keys(mod!.uk)) expect(k.startsWith(`${name}.`), `${name}: ${k}`).toBe(true);
    }
  });
});
