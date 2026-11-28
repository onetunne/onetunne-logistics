/**
 * Етап 6: ключі спільного модуля i18n `finance` (app/i18n/messages/finance.ts) за родинами — ЄДИНИЙ спосіб отримати
 * підпис коду (категорія, стан, причина, розбіжність, завдання…). Родини динамічні (`finance.category.${код}`), тож
 * тест «без зайвих ключів» (tests/i18n/completeness.test.ts) бачить їх використаними; тест переліків перевіряє, що для
 * кожного коду є переклад uk/en. Пакети ключів у модуль finance не додають (§18.10) — лише у власні модулі.
 */
import type {
  AgreementKind,
  CompletenessMarker,
  ComponentReason,
  ComponentState,
  DiscrepancyCode,
  DiscrepancyResolution,
  DiscrepancySeverity,
  DiscrepancyStatus,
  FactsSource,
  FinanceBasis,
  FinanceCategory,
  FinanceChangeAction,
  FinanceChangeEntityType,
  FinanceKind,
  FinanceNotice,
  FinancePeriodStatus,
  FinanceSourceType,
  FinanceTab,
  FinanceTerm,
  FxRateDatePolicy,
  OrderComponent,
  OrderFinanceState,
  PartnerCommissionState,
  PeriodChecklistItem,
  PnlLine,
  PnlMemoLine,
  PnlSubline,
  PnlTotal,
  ProfitLabel,
  ProfitState,
  RecognitionBasis,
  ReportKind,
  ReviewReason,
  SnapshotSource,
} from "~/domain/finance";
import type { CompareMode, Granularity, PeriodPreset } from "~/lib/periods";
import type { FinanceSettingsField } from "~/modules/settings/schema";
import type { FinanceJobName } from "../jobs";

/** Коди помилок фінансів (DomainError.code = `finance.error.<код>`). */
export const FINANCE_ERROR_CODES = [
  "monthClosed",
  "valuationCurrencyLocked",
  "amountEmpty",
  "amountInvalid",
  "amountAmbiguous",
  "amountTooPrecise",
  "amountWholeUnits",
  "unsupportedCurrency",
  "noRate",
  "invalidEntry",
  "entryNotFound",
  "reverseReversal",
  "forbidden",
  "nbuDisabled",
  "demoOnly",
  "notImplemented",
] as const;
export type FinanceErrorCode = (typeof FINANCE_ERROR_CODES)[number];

export const CHECKLIST_KINDS = ["blocking", "warning", "confirm"] as const;
export const RATE_LABELS = ["fallback", "none", "cross", "unconverted", "weekend"] as const;
export const COVERAGE_KINDS = ["orders", "waybills"] as const;

export const financeLabelKeys = {
  kind: (k: FinanceKind) => `finance.kind.${k}`,
  category: (c: FinanceCategory) => `finance.category.${c}`,
  pnl: (l: PnlLine | PnlTotal | PnlMemoLine | PnlSubline) => `finance.pnl.${l}`,
  state: (s: ComponentState) => `finance.state.${s}`,
  profitState: (s: ProfitState) => `finance.profitState.${s === "n/a" ? "na" : s}`,
  orderState: (s: OrderFinanceState) => `finance.orderState.${s}`,
  recognitionBasis: (b: RecognitionBasis) => `finance.recognitionBasis.${b}`,
  factsSource: (s: FactsSource) => `finance.factsSource.${s}`,
  reason: (r: ComponentReason) => `finance.reason.${r}`,
  basis: (b: FinanceBasis) => `finance.basis.${b}`,
  component: (c: OrderComponent) => `finance.component.${c}`,
  completeness: (m: CompletenessMarker) => `finance.completeness.${m}`,
  coverage: (k: (typeof COVERAGE_KINDS)[number]) => `finance.coverage.${k}`,
  discrepancy: (d: DiscrepancyCode) => `finance.discrepancy.${d}`,
  discrepancyStatus: (s: DiscrepancyStatus) => `finance.discrepancyStatus.${s}`,
  severity: (s: DiscrepancySeverity) => `finance.severity.${s}`,
  resolution: (r: DiscrepancyResolution) => `finance.resolution.${r}`,
  review: (r: ReviewReason) => `finance.review.${r}`,
  job: (j: FinanceJobName) => `finance.job.${j.slice("finance.".length)}`,
  source: (s: FinanceSourceType) => `finance.source.${s}`,
  agreement: (a: AgreementKind) => `finance.agreement.${a}`,
  rateSource: (s: "base" | "nbu" | "manual" | "demo") => `finance.rateSource.${s}`,
  rate: (k: (typeof RATE_LABELS)[number]) => `finance.rate.${k}`,
  tab: (t: FinanceTab) => `finance.tab.${t}`,
  term: (t: FinanceTerm) => `finance.term.${t}`,
  notice: (n: FinanceNotice) => `finance.notice.${n}`,
  profitLabel: (l: ProfitLabel) => `finance.profitLabel.${l}`,
  partnerState: (s: PartnerCommissionState) => `finance.partnerState.${s}`,
  period: (p: PeriodPreset) => `finance.period.${p}`,
  granularity: (g: Granularity | "weekLabel") => `finance.granularity.${g}`,
  compare: (m: CompareMode) => `finance.compare.${m}`,
  changeEntity: (e: FinanceChangeEntityType) => `finance.changeEntity.${e}`,
  changeAction: (a: FinanceChangeAction) => `finance.changeAction.${a}`,
  settingLabel: (f: FinanceSettingsField) => `finance.settings.${f}.label`,
  settingHelp: (f: FinanceSettingsField) => `finance.settings.${f}.help`,
  rateDatePolicy: (p: FxRateDatePolicy) => `finance.rateDatePolicy.${p}`,
  error: (e: FinanceErrorCode) => `finance.error.${e}`,
  checklist: (i: PeriodChecklistItem) => `finance.checklist.${i}`,
  checklistKind: (k: (typeof CHECKLIST_KINDS)[number]) => `finance.checklistKind.${k}`,
  periodStatus: (s: FinancePeriodStatus) => `finance.periodStatus.${s}`,
  reportKind: (k: ReportKind) => `finance.reportKind.${k}`,
  snapshotSource: (s: SnapshotSource) => `finance.snapshotSource.${s}`,
} as const;

export type FinanceLabelFamily = keyof typeof financeLabelKeys;
