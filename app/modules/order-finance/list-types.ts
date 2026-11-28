/**
 * Етап 6, WP4: типи й константи списку «Фінанси → Замовлення» (§18.2) — без серверного коду, тож їх імпортують і
 * сторінка (вибір стану й сортування), і чисті параметри запиту (list-params.ts), і сервіс (list.server.ts).
 */
import type { ComponentState, OrderComponent, OrderFinanceState, ProfitState } from "~/domain/finance";

export const ORDER_FINANCE_PAGE_SIZE = 50;
export const ORDER_FINANCE_LIST_STATES = ["final", "preliminary", "incomplete", "open", "closed_unrecognized", "excluded"] as const;
export type OrderFinanceListState = (typeof ORDER_FINANCE_LIST_STATES)[number];
export const ORDER_FINANCE_SORTS = ["recognized_desc", "recognized_asc", "profit_desc", "profit_asc", "margin_desc", "margin_asc", "revenue_desc"] as const;
export type OrderFinanceSort = (typeof ORDER_FINANCE_SORTS)[number];

export interface OrderFinanceListFilter {
  q?: string | null;
  from?: string | null;
  to?: string | null;
  state?: OrderFinanceListState | null;
  country?: string | null;
  needsReview?: boolean;
  partnerId?: string | null;
  lossOnly?: boolean;
  sort?: OrderFinanceSort;
  page?: number;
  currency?: string | null;
}

export interface OrderFinanceListRow {
  orderId: string;
  orderNumber: string;
  recognizedOn: string | null;
  placedOn: string;
  country: string | null;
  state: OrderFinanceState;
  profitState: ProfitState;
  needsReview: boolean;
  /** Чиста виручка (виручка + повернення + chargeback). */
  netRevenue: string | null;
  cogs: string | null;
  shipping: string | null;
  fees: string | null;
  partner: string | null;
  /** Прибуток за станом (факт / ≈ прогноз); null — не показується. */
  profit: string | null;
  /**
   * `fact` / `forecast` — показано; `no_rate` — final / preliminary, але є записи чи прогнози без курсу у валюті показу
   * («— без курсу», кількість — `unconverted`); `hidden` — incomplete («немає даних»); `not_applicable` — не визнане.
   */
  profitKind: "fact" | "forecast" | "no_rate" | "hidden" | "not_applicable";
  margin: string | null;
  /** Записів без курсу для валюти показу (прибуток і суми колонок з ними — «—»). */
  unconverted: number;
  /** Колонки, у яких є записи без курсу: значення null («—» з позначкою «без курсу»), не часткова сума. */
  unconvertedColumns: Array<"netRevenue" | "cogs" | "shipping" | "fees" | "partner">;
  components: Partial<Record<OrderComponent, ComponentState>>;
  partnerId: string | null;
}

export interface OrderFinanceList {
  currency: string;
  displayCurrencies: string[];
  rows: OrderFinanceListRow[];
  total: number;
  page: number;
  pageSize: number;
  countries: string[];
}
