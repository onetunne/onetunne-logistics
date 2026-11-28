/**
 * Етап 6: типи пропсів спільних фінансових компонентів (docs/stage6-design.md §18.9). Ядро (WP0) зафіксувало їх першим,
 * тож сторінки пакетів пишуться паралельно з реалізацією компонентів (WP0-UI). Гроші — десяткові рядки (ніколи float);
 * відсутнє — null («—»), ніколи не 0. Числа й дати форматуються лише через app/lib/format.ts (детерміновано для SSR).
 * Компоненти: kpi-tile, state-badge, money-value, period-bar, currency-switch, completeness-banner, coverage-note,
 * profit-chart, breakdown-bars, sparkline, finance-tabs (файли app/components/finance/*.tsx — WP0-UI).
 */
import type {
  CompletenessMarker,
  ComponentReason,
  ComponentState,
  FinanceBasis,
  FinanceTab,
  OrderFinanceState,
  ProfitLabel,
  ProfitState,
} from "~/domain/finance";
import type { CompareMode, DateRange, Granularity, PeriodPreset } from "~/lib/periods";
import type { CompletenessSummary } from "~/modules/finance/core/states";

/** Сума з валютою (десятковий рядок з 2 знаками). */
export interface MoneyAmount {
  amount: string;
  currency: string;
}

/** Курс, за яким сконвертовано значення (підказка «Курс НБУ на 22.11.2026 (вихідний: курс п'ятниці)»). */
export interface RateHint {
  rateDate: string;
  source: "base" | "nbu" | "manual" | "demo";
  fallback: boolean;
}

export interface MoneyValueProps {
  /** Сума у валюті звітності; null — «—» (немає даних / немає курсу). */
  value: MoneyAmount | null;
  /** Початкові суми підрядком (у валютах записів). */
  original?: readonly MoneyAmount[];
  state?: ComponentState;
  rate?: RateHint | null;
  /** Позначка «≈ Прогноз». */
  forecast?: boolean;
  emphasis?: "default" | "strong";
}

export interface StateBadgeProps {
  state: ComponentState | ProfitState | OrderFinanceState;
  reason?: ComponentReason | null;
  basis?: FinanceBasis | null;
  size?: "sm" | "md";
}

export interface CoverageNoteProps {
  n: number;
  m: number;
  kind?: "orders" | "waybills";
}

export interface MissingItem {
  /** Ключ i18n підпису (finance.component.* / finance.reason.* / ключ пакета). */
  labelKey: string;
  count: number;
  href?: string;
}

export interface SparklinePoint {
  key: string;
  /** Десятковий рядок; null — розрив (немає даних), не 0. */
  value: string | null;
}

export interface SparklineProps {
  points: readonly SparklinePoint[];
  /** Текстова альтернатива для читачів екрана. */
  label: string;
}

export interface KpiTileProps {
  id: string;
  title: string;
  /** Факт; null — «—». */
  value: MoneyAmount | null;
  /** «≈ Прогноз» окремим числом (ніколи не в факті). */
  forecast?: MoneyAmount | null;
  marker: CompletenessMarker;
  coverage?: CoverageNoteProps | null;
  delta?: { amount: MoneyAmount | null; percent: string | null } | null;
  missing?: readonly MissingItem[];
  sparkline?: readonly SparklinePoint[];
  href?: string;
  /** Додатковий рядок (напр. «маржа 41,2 %»). */
  note?: string | null;
}

export interface PeriodBarProps {
  preset: PeriodPreset;
  range: DateRange;
  granularity: Granularity;
  compare: CompareMode;
  presets?: readonly PeriodPreset[];
  allowCustom?: boolean;
  /** Назва параметрів запиту (типово period / from / to / granularity / compare). */
  paramPrefix?: string;
}

export interface CurrencySwitchProps {
  current: string;
  options: readonly string[];
  /** Параметр запиту (типово currency; не зберігається). */
  paramName?: string;
}

export interface CompletenessBannerProps {
  completeness: CompletenessSummary;
  marker: CompletenessMarker;
  profitLabel: ProfitLabel;
  includesTestOrders: boolean;
  demo: boolean;
}

export interface ChartBucket {
  key: string;
  label: string;
  actual: string | null;
  forecast: string | null;
  compare?: string | null;
}

export interface ProfitChartProps {
  buckets: readonly ChartBucket[];
  currency: string;
  /** Заголовок таблиці «Показати таблицею». */
  tableCaption: string;
}

export interface BreakdownRow {
  key: string;
  label: string;
  value: string | null;
  state?: ComponentState;
}

export interface BreakdownBarsProps {
  rows: readonly BreakdownRow[];
  currency: string;
  total?: string | null;
}

export interface FinanceTabsProps {
  current: FinanceTab;
}
