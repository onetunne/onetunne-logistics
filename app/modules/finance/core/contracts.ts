/**
 * Етап 6: ОСТАТОЧНІ контракти між пакетами (docs/stage6-design.md §21.1). Ядро (WP0) зафіксувало сигнатури першим, тож
 * пакети пишуться паралельно з реалізацією залежностей; заглушки (stub) з цими сигнатурами створено в раунді 0 і далі
 * належать пакетам-власникам (WP0 їх не змінює). Зміна сигнатури = запит до інтеграційного раунду ядра.
 *
 * Внутрішні функції проведення (F8, §14.1) — INTERNAL_POSTING_FUNCTIONS: актора не перевіряють (їх запускають потоки
 * працівників: накладна, передача, пакування, надходження, закриття партії), записують лише posted_by і НЕ повертають
 * грошей (void або кількості). Імпортувати їх у app/pages/**, app/routes/**, команди складу/фінансів і інструменти ШІ
 * заборонено — тест-сканер tests/stage6/core/access-scanner.test.ts (розв'язує `~/`, відносні шляхи й `.ts`; ловить
 * іменовані, простір імен `* as`, динамічні `import()` і реекспорти).
 */
import type { Db, Tx } from "~/db/client.server";
import type {
  ComponentState,
  ProfitLabel,
  ReportKind,
  ShippingForecastBasis,
} from "~/domain/finance";
import type { Actor } from "~/domain/permissions";
import type { AdminGraphql } from "~/integrations/shopify/admin-client.server";
import type { DateRange } from "~/lib/periods";
import type { JobHandlers } from "~/modules/jobs/worker.server";
import type { ShopifySyncState } from "~/db/schema";
import type { MovementType } from "~/modules/inventory/movement-types";
import type { ServiceContext } from "~/server/types";
import type { CompletenessSummary } from "./states";
import type { RateUsed } from "./snapshots.server";

/** Хто проводить (posted_by): актор потоку (працівник, власник, SYSTEM_ACTOR). Лише id — без ролі й дозволів. */
export type PostingActor = Pick<Actor, "id">;

/**
 * Рух, щойно вставлений applyMovements (точка підключення в ledger.server.ts), — для оцінки собівартості в тій самій
 * транзакції. Порядок оцінки — (stockItemId, seq) (§6.4).
 */
export interface InsertedMovement {
  id: string;
  seq: number;
  warehouseId: string;
  stockItemId: string;
  type: MovementType;
  idempotencyKey: string;
  onHandDelta: number;
  reservedDelta: number;
  defectiveDelta: number;
  inProductionDelta: number;
  orderId: string | null;
  orderLineItemId: string | null;
  productionBatchId: string | null;
  packingId: string | null;
  unitCost: string | null;
  costCurrency: string | null;
  reason: string | null;
  shopifySyncState: ShopifySyncState;
  createdAt: Date;
  /** Виконавець руху (posted_by наслідків оцінки). */
  actorId: string;
}

// ---------------------------------------------------------------------------
// Внутрішні функції проведення (F8)
// ---------------------------------------------------------------------------

/**
 * WP4 — `app/modules/order-finance/sync.server.ts`. Бажаний стан фінансів замовлення: визнання, складники, прогнози,
 * проведення (ідемпотентно; бере FINANCE_ORDER_LOCK після стану собівартості, F10). Викликається наприкінці
 * syncOrderReservations (усі шляхи) і хуком оцінки — у транзакції викликача.
 */
export type SyncOrderFinance = (tx: Tx, actor: PostingActor, orderId: string) => Promise<void>;

/**
 * WP2 — `app/modules/costing/hook.server.ts`. Оцінка щойно вставлених рухів (одна транзакція з applyMovements, FOR UPDATE
 * стану собівартості у порядку stock_item_id); наслідки без замовлення проводить одразу, наслідки замовлення — через
 * syncOrderFinance (у порядку order_id). НІКОЛИ не кидає виняток через відсутні дані.
 */
export type ValueInsertedMovements = (tx: Tx, inserted: readonly InsertedMovement[]) => Promise<void>;

/**
 * WP2 — `app/modules/costing/revalue.server.ts`. Переоцінка рядків партії після зміни собівартості (updateBatchCosts /
 * closeBatch / cancelBatch).
 */
export type RevalueBatchLines = (tx: Tx, actor: PostingActor, batchId: string) => Promise<void>;

/** WP2 — `app/modules/costing/fx-pending.server.ts`. Завершення шарів fx_pending, коли з'явився курс (ручний — WP1). */
export type CompleteFxPendingLayers = (tx: Tx, actor: PostingActor, scope: { currency?: string; date?: string }) => Promise<{ completed: number }>;

/** WP2 — `app/modules/costing/backfill.server.ts`. Довантаження оцінки позицій без стану (старт, seedReferenceData). */
export type EnsureValuationBackfill = (db: Db) => Promise<void>;

/** WP2 — перебудова оцінки демо-історії (лише demo/тест; інакше відмова). */
export type RebuildValuationForDemo = (tx: Tx, ctx: Pick<ServiceContext, "mode">) => Promise<void>;

/** WP9 — `app/modules/returns/sync.server.ts`. Випадки повернень замовлення (ідемпотентно; ret:refund:<id>, надходження-повернення). */
export type SyncReturnCasesForOrder = (tx: Tx, actor: PostingActor, orderId: string) => Promise<void>;

/**
 * Перелік внутрішніх функцій проведення (назва → ТОЧНИЙ модуль, де вона визначена; пакет-власник не переносить її в
 * інший файл без інтеграційного раунду ядра). Сканер забороняє ці назви й модулі в pages/routes/командах/ШІ.
 * З інтеграційного раунду 1 — також внутрішні читання без перевірки актора, що повертають гроші (пул собівартості,
 * прогноз, факти замовлення, Δ курсу, розподіл), і логіка завдань (НБУ, факти Shopify, перерахунок розподілу): кожен
 * суто внутрішній модуль має тут щонайменше одну назву (тест сканера), а реекспорт БУДЬ-ЯКОГО його значення публічним
 * модулем сканер теж вважає порушенням.
 */
export const INTERNAL_POSTING_FUNCTIONS = {
  postEntries: "~/modules/finance/core/entries.server",
  repostEntries: "~/modules/finance/core/entries.server",
  reverseEntry: "~/modules/finance/core/entries.server",
  reverseEntries: "~/modules/finance/core/entries.server",
  activeEntryRefs: "~/modules/finance/core/entries.server",
  openDiscrepancy: "~/modules/finance/core/discrepancies.server",
  autoResolveDiscrepancy: "~/modules/finance/core/discrepancies.server",
  recordExternalWaybills: "~/modules/finance/core/waybills.server",
  syncOrderFinance: "~/modules/order-finance/sync.server",
  valueInsertedMovements: "~/modules/costing/hook.server",
  completeFxPendingLayers: "~/modules/costing/fx-pending.server",
  ensureValuationBackfill: "~/modules/costing/backfill.server",
  rebuildValuationForDemo: "~/modules/costing/backfill.server",
  revalueBatchLines: "~/modules/costing/revalue.server",
  syncReturnCasesForOrder: "~/modules/returns/sync.server",
  // WP2 — собівартість (внутрішні модулі: оцінка, завершення, стан, факти замовлення, входи, прогноз, читання пулу).
  valueItemMovements: "~/modules/costing/valuation.server",
  flushValuationResults: "~/modules/costing/valuation.server",
  applyCompletionPlan: "~/modules/costing/completion.server",
  planOwnerCompletion: "~/modules/costing/completion.server",
  planLayerValueCompletion: "~/modules/costing/completion.server",
  saveCostState: "~/modules/costing/store.server",
  insertValuation: "~/modules/costing/store.server",
  persistLayers: "~/modules/costing/store.server",
  insertCompletions: "~/modules/costing/store.server",
  loadOrderCostingFacts: "~/modules/costing/order-facts.server",
  costingEntriesForOrder: "~/modules/costing/order-facts.server",
  loadCostingContext: "~/modules/costing/inputs.server",
  convertToValuation: "~/modules/costing/inputs.server",
  unitCostForecast: "~/modules/costing/forecast.server",
  ownerStandardCost: "~/modules/costing/forecast.server",
  poolStatesAt: "~/modules/costing/pool-read.server",
  loadPoolValues: "~/modules/costing/pool-read.server",
  // WP1 — курси (переоцінка обмінів, запис офіційних курсів, Δ зміни курсу, демо-курси, логіка завдань НБУ).
  repriceConversions: "~/modules/fx/conversions-internal.server",
  conversionsNeedingRate: "~/modules/fx/conversions-internal.server",
  storeOfficialRates: "~/modules/fx/rates-store.server",
  rateChangeImpact: "~/modules/fx/impact.server",
  seedDemoRates: "~/modules/fx/demo-rates.server",
  // Змішаний модуль: кнопки власника (requestNbuFetch, requestNbuBackfill, setNbuEnabled — requireFinance("manage") і
  // відмова в демо) поруч із логікою завдань (постановка завантажень НБУ без цих перевірок).
  runFxFetch: "~/modules/fx/nbu-fetch.server",
  runFxBackfill: "~/modules/fx/nbu-fetch.server",
  runFxFetchScheduled: "~/modules/fx/nbu-fetch.server",
  enqueueFxFetch: "~/modules/fx/nbu-fetch.server",
  scheduleFxChain: "~/modules/fx/nbu-fetch.server",
  // WP3 — фінансові факти Shopify (запис фактів, позначка «не читається», завдання синхронізації й довантаження).
  writeOrderFinanceFacts: "~/modules/finance-sync/facts.server",
  markOrderUnreadable: "~/modules/finance-sync/facts.server",
  runFinanceOrderSync: "~/modules/finance-sync/sync-order.server",
  runFinanceBackfill: "~/modules/finance-sync/scheduled.server",
  runFinanceReconcile: "~/modules/finance-sync/scheduled.server",
  enqueueFinanceOrderSync: "~/modules/finance-sync/schedule.server",
  enqueueJourneyRecheck: "~/modules/finance-sync/schedule.server",
  scheduleReconcileChain: "~/modules/finance-sync/schedule.server",
  scheduleBackfill: "~/modules/finance-sync/schedule.server",
  // Змішаний модуль: лічильники (без грошей) поруч зі скиданням довантаження (зі сторінки — лише requestFinanceBackfill).
  restartFinanceBackfill: "~/modules/finance-sync/backfill-status.server",
  // WP6 — проведення витрат і розподіл сум періоду; перерахунок розподілу завданням.
  syncExpenseEntries: "~/modules/expenses/posting.server",
  syncOrderExpenseEntries: "~/modules/expenses/posting.server",
  computeAllocation: "~/modules/expenses/allocation.server",
  coveringStatusForOrder: "~/modules/expenses/allocation.server",
  runExpenseReallocation: "~/modules/expenses/reallocation.server",
  enqueueExpenseReallocation: "~/modules/expenses/reallocation.server",
  enqueueOrHoldReallocation: "~/modules/expenses/reallocation.server",
  scheduleNoRateRetry: "~/modules/expenses/reallocation.server",
  // Змішаний модуль: сервіси власника правил комісій поруч із читанням правил із сумами без перевірки актора.
  loadFeeRules: "~/modules/expenses/fee-rules.server",
  // WP7 — комісія партнерів; події комісії з сумами (читання без перевірки актора).
  syncPartnerCommission: "~/modules/partners/sync.server",
  loadOrderEvents: "~/modules/partners/events.server",
  loadPartnerEvents: "~/modules/partners/events.server",
  // Ядро: запис історії змін (змішаний модуль: listFinanceChanges — для сервісів власника), скидання магазинів демо,
  // реєстр завдань (обробники від SYSTEM_ACTOR і запуск ланцюжків).
  writeFinanceChange: "~/modules/finance/core/change-log.server",
  resetStoresForDemo: "~/modules/finance/core/store.server",
  createFinanceJobHandlers: "~/modules/finance/jobs.server",
  ensureFinanceSchedules: "~/modules/finance/jobs.server",
} as const;
export type InternalPostingFunction = keyof typeof INTERNAL_POSTING_FUNCTIONS;

/**
 * Модулі, які ВЗАГАЛІ не імпортуються зі сторінок/маршрутів/команд (лише внутрішні функції; пакет не додає туди
 * публічних сервісів). Змішані модулі (discrepancies.server: openDiscrepancy поруч із resolveDiscrepancy) — дозволені,
 * але без простору імен `* as`, динамічного `import()` і реекспорту (сканер).
 */
export const INTERNAL_ONLY_MODULES = [
  "~/modules/finance/core/entries.server",
  "~/modules/finance/core/waybills.server",
  "~/modules/order-finance/sync.server",
  "~/modules/costing/hook.server",
  "~/modules/costing/fx-pending.server",
  "~/modules/costing/backfill.server",
  "~/modules/costing/revalue.server",
  "~/modules/returns/sync.server",
  "~/modules/costing/valuation.server",
  "~/modules/costing/completion.server",
  "~/modules/costing/store.server",
  "~/modules/costing/order-facts.server",
  "~/modules/costing/inputs.server",
  "~/modules/costing/forecast.server",
  "~/modules/costing/pool-read.server",
  "~/modules/fx/conversions-internal.server",
  "~/modules/fx/rates-store.server",
  "~/modules/fx/impact.server",
  "~/modules/fx/demo-rates.server",
  "~/modules/finance-sync/facts.server",
  "~/modules/finance-sync/sync-order.server",
  "~/modules/finance-sync/scheduled.server",
  "~/modules/expenses/posting.server",
  "~/modules/expenses/allocation.server",
  "~/modules/expenses/reallocation.server",
  "~/modules/partners/sync.server",
  "~/modules/partners/events.server",
  "~/modules/finance-sync/schedule.server",
  "~/modules/finance/jobs.server",
] as const;

/**
 * Модулі завдань пакетів (FinanceJobModule: `handlers` виконують роботу від SYSTEM_ACTOR без requireFinance,
 * `ensureSchedules` ставить ланцюжки) — так само суто внутрішні: сканер забороняє будь-який їх імпорт зі сторінок,
 * маршрутів, команд і ШІ, а реекспорт будь-якого їх значення вважає обходом F8. Окремим переліком, бо їхні назви
 * (`handlers`, `ensureSchedules`) однакові в усіх модулях і не можуть бути ключами INTERNAL_POSTING_FUNCTIONS.
 * Новий модуль FINANCE_JOB_MODULES (jobs.server.ts) — рядок тут (тест сканера).
 */
export const INTERNAL_JOB_MODULES = [
  "~/modules/fx/jobs.server",
  "~/modules/costing/jobs.server",
  "~/modules/finance-sync/jobs.server",
  "~/modules/finance-reports/jobs.server",
  "~/modules/expenses/jobs.server",
] as const;

// ---------------------------------------------------------------------------
// Завдання (реєстр app/modules/finance/jobs.server.ts)
// ---------------------------------------------------------------------------

export interface FinanceJobDeps {
  db: Db;
  serviceContext: () => ServiceContext;
  admin: (shop: string) => Promise<AdminGraphql>;
}

/**
 * Модуль завдань пакета (`fx/jobs.server.ts` WP1, `costing/jobs.server.ts` WP2, `finance-sync/jobs.server.ts` WP3,
 * `finance-reports/jobs.server.ts` WP10): обробники своїх завдань FINANCE_JOB і запуск своїх ланцюжків. Обробники
 * НБУ повторно перевіряють fx.nbuEnabled (I18). ensureSchedules не кидає винятків (помилку логує й повертає).
 */
export interface FinanceJobModule {
  handlers(deps: FinanceJobDeps): JobHandlers;
  ensureSchedules(db: Db): Promise<void>;
}

// ---------------------------------------------------------------------------
// Дані звіту (WP8 buildReportData → знімки WP6/WP10, експорт, бот, ШІ)
// ---------------------------------------------------------------------------

export const REPORT_DATA_SCHEMA_VERSION = 1;

/** Сума рядка: факт і ≈ прогноз (десяткові рядки у валюті звітності; null — немає / «—», ніколи не 0). */
export interface ReportPnlRow {
  /** Ключ рядка: PnlLine | PnlTotal | PnlMemoLine | PnlSubline (i18n finance.pnl.<ключ>). */
  line: string;
  actual: string | null;
  forecast: string | null;
  /** Стовпці повноти §2.6: остаточні, попередні (факт + прогноз), без повних даних, витрати періоду, разом. */
  columns?: { final: string | null; preliminary: string | null; incomplete: string | null; period: string | null; total: string | null };
}

export interface ReportTopRow {
  /** Ключ (sku, ISO-код країни, код партнера — без імен і персональних даних). */
  key: string;
  label: string;
  orders: number;
  netRevenue: string | null;
  profit: string | null;
  margin: string | null;
  state: ComponentState;
}

export interface ReportData {
  schemaVersion: typeof REPORT_DATA_SCHEMA_VERSION;
  /** Не входить у data_sha256 (canonicalJson). */
  generatedAt: string;
  kind: ReportKind;
  period: DateRange;
  reportingCurrency: string;
  profitLabel: ProfitLabel;
  includesTestOrders: boolean;
  pnl: ReportPnlRow[];
  /** Ті самі рядки по днях (щоб закриті місяці входили в будь-який діапазон, §2.6). */
  daily: Array<{ date: string; rows: ReportPnlRow[] }>;
  completeness: CompletenessSummary;
  metrics: Record<string, string | number | null>;
  top: { products: ReportTopRow[]; countries: ReportTopRow[]; partners: ReportTopRow[] };
  shipping: Record<string, string | number | null>;
  returns: Record<string, string | number | null>;
  /** Блок прогнозу §12.3 (null — замало даних); НІКОЛИ не факт. */
  forecast: Record<string, string | number | null> | null;
  /** Коди обмежень (limitations). */
  limitations: string[];
}

export interface BuildReportInput {
  kind: ReportKind;
  period: DateRange;
  reportingCurrency: string;
}

/** WP8 — `app/modules/finance-analytics/report-data.server.ts` (requireFinance view). */
export type BuildReportData = (ctx: ServiceContext, input: BuildReportInput) => Promise<{ data: ReportData; ratesUsed: RateUsed[] }>;

// ---------------------------------------------------------------------------
// Демо (WP11)
// ---------------------------------------------------------------------------

/** WP11 — `app/db/seed/demo-finance.server.ts`; наприкінці seedDemoData (ідемпотентно; лише демо). */
export type SeedDemoFinance = (ctx: ServiceContext) => Promise<void>;

/** Основа замороженого прогнозу доставки (§7.1) — для довідки пакетів. */
export type FrozenShippingBasis = ShippingForecastBasis;
