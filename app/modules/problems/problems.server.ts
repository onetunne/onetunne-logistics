import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, like, notInArray, notLike, or, sql, type SQL } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { issues, orders } from "~/db/schema";
import type { OrderStatus } from "~/domain/order-status";
import { requirePermission } from "~/domain/permissions";
import { DomainError } from "~/lib/errors";
import { dismissIssue } from "~/modules/orders/workflow.server";
import type { ServiceContext } from "~/server/types";
import {
  PROBLEM_CATEGORIES,
  TRACKING_CODES,
  WAREHOUSE_CODES,
  categoryCodeFilter,
  problemCategory,
  problemSource,
  type ProblemCategory,
  type ProblemSource,
} from "./categories";
import { MAX_BULK_ORDERS, MAX_PROBLEM_QUERY_LENGTH, PROBLEM_PAGE_SIZE } from "./limits";

export { MAX_BULK_ORDERS, MAX_PROBLEM_QUERY_LENGTH, PROBLEM_PAGE_SIZE };

/**
 * Запити розділу «Проблеми»: проблеми, згруповані за замовленням, з фільтрами, лічильниками для
 * швидких фільтрів і посторінковим виведенням (за замовленнями). Кількість запитів не залежить від
 * кількості замовлень на сторінці (без N+1).
 */

export type ProblemTab = "open" | "closed";
export type ProblemSeverity = "error" | "warning";

export interface ProblemFilter {
  /** open — відкриті; closed — вирішені або приховані. */
  tab?: ProblemTab;
  category?: ProblemCategory | null;
  severity?: ProblemSeverity | null;
  /** Країна доставки замовлення (ISO 3166-1 alpha-2). */
  country?: string | null;
  source?: ProblemSource | null;
  /** Лише проблеми із запропонованими варіантами виправлення. */
  hasSuggestion?: boolean;
  /** Пошук за номером замовлення (частковий збіг). */
  q?: string | null;
  page?: number;
  pageSize?: number;
}

export interface ProblemIssue {
  id: string;
  code: string;
  category: ProblemCategory;
  source: ProblemSource;
  severity: ProblemSeverity;
  field: string | null;
  params: Record<string, string | number>;
  suggestion: { field: string; candidates: string[] } | null;
  createdAt: Date;
  resolvedAt: Date | null;
  resolution: string | null;
}

export interface ProblemGroup {
  orderId: string | null;
  orderNumber: string | null;
  orderStatus: OrderStatus | null;
  countryCode: string | null;
  errorCount: number;
  warningCount: number;
  issues: ProblemIssue[];
}

export interface ProblemFacets {
  /** Кількість проблем за категоріями (з урахуванням усіх фільтрів, крім категорії). */
  categories: Record<ProblemCategory, number>;
  /** Кількість проблем за серйозністю (з урахуванням усіх фільтрів, крім серйозності). */
  severities: Record<ProblemSeverity, number>;
}

export interface ProblemQueryResult {
  groups: ProblemGroup[];
  /** Кількість замовлень (груп) і проблем, що відповідають усім фільтрам. */
  totalGroups: number;
  totalIssues: number;
  page: number;
  pages: number;
  pageSize: number;
  facets: ProblemFacets;
  /** Країни доставки замовлень із проблемами на цій вкладці (для списку фільтра). */
  countries: string[];
}


function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const hasCandidates = sql`(case when jsonb_typeof(${issues.suggestion} -> 'candidates') = 'array' then jsonb_array_length(${issues.suggestion} -> 'candidates') else 0 end) > 0`;

function categoryCondition(category: ProblemCategory): SQL {
  const f = categoryCodeFilter(category);
  if ("include" in f) return f.include.length > 0 ? inArray(issues.code, f.include) : sql`false`;
  return f.exclude.length > 0 ? notInArray(issues.code, f.exclude) : sql`true`;
}

/** Те саме розбиття, що й problemSource (categories.ts): коди без префікса (відстеження, склад) — переліком. */
function sourceCondition(source: ProblemSource): SQL {
  const tracking = [...TRACKING_CODES];
  const warehouse = [...WAREHOUSE_CODES];
  switch (source) {
    case "tracking":
      return inArray(issues.code, tracking);
    case "warehouse":
      return warehouse.length > 0 ? inArray(issues.code, warehouse) : sql`false`;
    case "carrier":
      return and(like(issues.code, "CARRIER\\_%"), notInArray(issues.code, tracking))!;
    case "shopify":
      return like(issues.code, "SHOPIFY\\_%");
    case "validation":
      return and(
        notLike(issues.code, "CARRIER\\_%"),
        notLike(issues.code, "SHOPIFY\\_%"),
        notInArray(issues.code, [...tracking, ...warehouse]),
      )!;
  }
}

/** Умови без категорії та серйозності (вони застосовуються окремо — для лічильників фасетів). */
function baseConditions(filter: ProblemFilter): SQL[] {
  const conditions: SQL[] = [
    filter.tab === "closed" ? inArray(issues.status, ["resolved", "dismissed"]) : eq(issues.status, "open"),
  ];
  if (filter.country) conditions.push(eq(orders.shipCountryCode, filter.country.toUpperCase()));
  if (filter.source) conditions.push(sourceCondition(filter.source));
  if (filter.hasSuggestion) conditions.push(hasCandidates);
  const q = filter.q?.trim().slice(0, MAX_PROBLEM_QUERY_LENGTH);
  if (q) conditions.push(ilike(orders.orderNumber, `%${escapeLike(q)}%`));
  return conditions;
}

function emptyFacets(): ProblemFacets {
  return {
    categories: Object.fromEntries(PROBLEM_CATEGORIES.map((c) => [c, 0])) as Record<ProblemCategory, number>,
    severities: { error: 0, warning: 0 },
  };
}

async function loadFacets(db: DbOrTx, filter: ProblemFilter, base: SQL[]): Promise<ProblemFacets> {
  const rows = await db
    .select({ code: issues.code, severity: issues.severity, value: sql<number>`count(*)::int` })
    .from(issues)
    .leftJoin(orders, eq(issues.orderId, orders.id))
    .where(and(...base))
    .groupBy(issues.code, issues.severity);
  const facets = emptyFacets();
  for (const r of rows) {
    const category = problemCategory(r.code);
    const n = Number(r.value);
    if (!filter.severity || r.severity === filter.severity) facets.categories[category] += n;
    if (!filter.category || category === filter.category) facets.severities[r.severity] += n;
  }
  return facets;
}

async function loadCountries(db: DbOrTx, tab: ProblemTab): Promise<string[]> {
  const rows = await db
    .selectDistinct({ code: orders.shipCountryCode })
    .from(issues)
    .innerJoin(orders, eq(issues.orderId, orders.id))
    .where(
      and(
        tab === "closed" ? inArray(issues.status, ["resolved", "dismissed"]) : eq(issues.status, "open"),
        isNotNull(orders.shipCountryCode),
      ),
    )
    .orderBy(asc(orders.shipCountryCode));
  return rows.map((r) => r.code).filter((c): c is string => Boolean(c));
}

export async function queryProblems(db: DbOrTx, filter: ProblemFilter = {}): Promise<ProblemQueryResult> {
  const tab: ProblemTab = filter.tab === "closed" ? "closed" : "open";
  const pageSize = Math.min(Math.max(filter.pageSize ?? PROBLEM_PAGE_SIZE, 1), 100);
  const base = baseConditions({ ...filter, tab });
  const conditions = [...base];
  if (filter.category) conditions.push(categoryCondition(filter.category));
  if (filter.severity) conditions.push(eq(issues.severity, filter.severity));
  const where = and(...conditions);

  const [facets, countries, [totals]] = await Promise.all([
    loadFacets(db, filter, base),
    loadCountries(db, tab),
    db
      .select({
        groups: sql<number>`count(distinct coalesce(${issues.orderId}::text, ''))::int`,
        issues: sql<number>`count(*)::int`,
      })
      .from(issues)
      .leftJoin(orders, eq(issues.orderId, orders.id))
      .where(where),
  ]);
  const totalGroups = Number(totals?.groups ?? 0);
  const totalIssues = Number(totals?.issues ?? 0);
  const pages = Math.max(1, Math.ceil(totalGroups / pageSize));
  // Застаріле посилання на сторінку за межами списку → остання наявна сторінка.
  const page = Math.min(Math.max(filter.page ?? 1, 1), pages);

  // Відкриті: спершу замовлення з помилками, далі — з найстарішою проблемою. Вирішені — найновіші першими.
  const hasErrors = sql<boolean>`bool_or(${issues.severity} = 'error')`;
  const groupRows = await db
    .select({
      orderId: issues.orderId,
      orderNumber: orders.orderNumber,
      orderStatus: orders.status,
      countryCode: orders.shipCountryCode,
      errorCount: sql<number>`count(*) filter (where ${issues.severity} = 'error')::int`,
      warningCount: sql<number>`count(*) filter (where ${issues.severity} = 'warning')::int`,
    })
    .from(issues)
    .leftJoin(orders, eq(issues.orderId, orders.id))
    .where(where)
    .groupBy(issues.orderId, orders.orderNumber, orders.status, orders.shipCountryCode)
    .orderBy(
      ...(tab === "open"
        ? [desc(hasErrors), asc(sql`min(${issues.createdAt})`)]
        : [sql`max(${issues.resolvedAt}) desc nulls last`]),
      asc(orders.orderNumber),
      asc(issues.orderId),
    )
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const orderIds = groupRows.map((g) => g.orderId).filter((id): id is string => id !== null);
  const includesNoOrder = groupRows.some((g) => g.orderId === null);
  const scope = [
    ...(orderIds.length > 0 ? [inArray(issues.orderId, orderIds)] : []),
    ...(includesNoOrder ? [isNull(issues.orderId)] : []),
  ];
  const issueRows =
    scope.length === 0
      ? []
      : await db
          .select({ issue: issues })
          .from(issues)
          .leftJoin(orders, eq(issues.orderId, orders.id))
          .where(and(where, or(...scope)))
          .orderBy(
            ...(tab === "open"
              ? [sql`(${issues.severity} = 'error') desc`, asc(issues.createdAt)]
              : [sql`${issues.resolvedAt} desc nulls last`]),
            asc(issues.id),
          );

  const byOrder = new Map<string, ProblemGroup>();
  const groups: ProblemGroup[] = groupRows.map((g) => {
    const group: ProblemGroup = {
      orderId: g.orderId,
      orderNumber: g.orderNumber,
      orderStatus: g.orderStatus,
      countryCode: g.countryCode,
      errorCount: Number(g.errorCount),
      warningCount: Number(g.warningCount),
      issues: [],
    };
    byOrder.set(g.orderId ?? "", group);
    return group;
  });
  for (const { issue } of issueRows) {
    byOrder.get(issue.orderId ?? "")?.issues.push({
      id: issue.id,
      code: issue.code,
      category: problemCategory(issue.code),
      source: problemSource(issue.code),
      severity: issue.severity,
      field: issue.field,
      params: issue.params,
      suggestion: issue.suggestion ?? null,
      createdAt: issue.createdAt,
      resolvedAt: issue.resolvedAt,
      resolution: issue.resolution,
    });
  }

  return { groups, totalGroups, totalIssues, page, pages, pageSize, facets, countries };
}

// ---------------------------------------------------------------------------
// Масові дії
// ---------------------------------------------------------------------------

const MAX_BULK_ISSUES = 1000;

export interface BulkDismissResult {
  dismissed: number;
  orders: number;
  failed: number;
}

/**
 * Приховує відкриті ПОПЕРЕДЖЕННЯ вибраних замовлень, що відповідають поточним фільтрам (тим, які бачить менеджер).
 * Помилки не змінюються. Кожне попередження — окремою транзакцією з записом у журнал (через dismissIssue).
 */
export async function dismissWarnings(
  ctx: ServiceContext,
  orderIds: string[],
  filter: Omit<ProblemFilter, "tab" | "page" | "pageSize"> = {},
): Promise<BulkDismissResult> {
  requirePermission(ctx.actor, "orders.edit");
  const ids = [...new Set(orderIds)].slice(0, MAX_BULK_ORDERS);
  // Фільтр «лише помилки» — менеджер не бачить попереджень, тож нічого не приховуємо.
  if (ids.length === 0 || filter.severity === "error") return { dismissed: 0, orders: 0, failed: 0 };
  const conditions = [...baseConditions({ ...filter, tab: "open" }), eq(issues.severity, "warning"), inArray(issues.orderId, ids)];
  if (filter.category) conditions.push(categoryCondition(filter.category));
  const rows = await ctx.db
    .select({ id: issues.id, orderId: issues.orderId })
    .from(issues)
    .leftJoin(orders, eq(issues.orderId, orders.id))
    .where(and(...conditions))
    .orderBy(asc(issues.createdAt))
    .limit(MAX_BULK_ISSUES);

  const touched = new Set<string>();
  let dismissed = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await dismissIssue(ctx, row.id);
      dismissed += 1;
      if (row.orderId) touched.add(row.orderId);
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
      failed += 1;
    }
  }
  return { dismissed, orders: touched.size, failed };
}
