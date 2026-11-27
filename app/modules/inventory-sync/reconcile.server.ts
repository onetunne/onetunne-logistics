/**
 * Звірка залишків застосунку з Shopify (docs/stage5-design.md §10): завдання `inventory.reconcile`.
 *
 * Порівнюється ДОСТУПНА кількість: застосунок on_hand − reserved ↔ Shopify available у локації складу
 * (резерв застосунку відповідає committed Shopify). Читається InventoryLevel.quantities(available, on_hand, committed).
 * Очікувана різниця (expectedDiff) — одиниці, які Shopify закріпив, а застосунок не резервує (неоплачені/чернетки
 * замовлень, ще не синхронізовані): committed Shopify − reserved застосунку з поправкою на замовлення, передані
 * перевізнику, але ще не виконані в Shopify (і навпаки). Повністю пояснена різниця розбіжністю не є.
 *
 * Узгодженість читання: позиція пропускається (і звіряється пізніше), якщо до читання Shopify у неї були
 * неперенесені рухи (pending — Shopify ще не отримав) або між читанням і порівнянням змінився баланс
 * (inventory_balances.version): тоді значення Shopify й застосунку відносилися б до різних моментів.
 *
 * Результат для позиції: збіг/пояснено (diff = expectedDiff; diff = 0 при expectedDiff ≠ 0 — це розбіжність) →
 * відкрита розбіжність закривається системою (dismissed, resolution auto_resolved), невдалі передачі позначаються
 * pushed (Shopify має значення складу); розбіжність → одна відкрита на
 * позицію (оновлюється спостереження) або, якщо власник обрав externalShopifyChanges = apply (діє лише з передачею
 * змін і write_inventory — autoApplyEffective) і різниця не має інших пояснень (autoApplyBlockers: неотримані Shopify
 * внутрішні зміни, невдалі передачі, стани Shopify reserved/damaged/…, резерв понад committed, повернення, розбіжність
 * запуску обліку, невідомий результат «надіслати склад», повернення, які Shopify ще поповнить), — автоматичне прийняття значення Shopify (рух
 * shopify_external, ключ від id розбіжності).
 *
 * Узгодження (unsent.server.ts, pure.ts settlesEvidence): точний збіг (reservationExcess = 0) або пояснена різниця без
 * невизначеності — точка узгодження для неотриманих Shopify рухів і повернень (returns.server.ts) і закриття невдалих
 * передач як pushed. При reservationExcess > 0 збіг може бути випадковим (звільнені Shopify одиниці замовлення
 * «покривають» неотримане надходження) — докази не закриваються.
 * Повернення (returns.server.ts) рахуються під блокуванням балансу позиції від останнього узгодження; невідома спроба
 * «надіслати склад» переноситься з закритої розбіжності в нову (carriedPushAttempt) до 24 год.
 */
import { and, asc, count, desc, eq, gt, inArray, isNotNull, ne, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "~/db/client.server";
import {
  inventoryBalances,
  inventoryConflicts,
  inventoryMovements,
  orderLineItems,
  orders,
  productVariants,
  stockItems,
  stockReservations,
} from "~/db/schema";
import { SHIPPED_STATUSES } from "~/domain/order-status";
import { SYSTEM_ACTOR, type Actor } from "~/domain/permissions";
import { DomainError } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import type { AdminGraphql } from "~/integrations/shopify/admin-client.server";
import {
  INVENTORY_LEVELS_QUERY,
  RECONCILE_PAGE_SIZE,
  isInventoryItemNode,
  quantitiesOf,
  type GqlInventoryLevelsResult,
  type ShopifyLevelQuantities,
} from "~/integrations/shopify/inventory-graphql";
import { writeAudit } from "~/modules/audit/audit.server";
import { enqueueJob } from "~/modules/jobs/queue.server";
import { lockBalances } from "~/modules/inventory/ledger.server";
import { acceptInTx, settleFailedMovements } from "./accept.server";
import { loadSyncEnvironment, type InventorySyncEnvironment } from "./environment.server";
import { INVENTORY_SYNC_JOB, RECONCILE_DELAY_MS, RECONCILE_MAX_RESCHEDULES, reconcileAllDedupeKey } from "./jobs";
import { ensureWarehouseLocation } from "./location.server";
import { conflictOrigin, parseObservation, parsePushAttempt, type ConflictObservation } from "./observation";
import {
  PUSH_ATTEMPT_TTL_MS,
  autoApplyBlockers,
  autoApplyEffective,
  compareLevels,
  settlesEvidence,
  verdictOf,
  type FulfillmentTiming,
} from "./pure";
import { EMPTY_RETURNS_SNAPSHOT, emptyReturnsState, loadReturnsState, returnsTimingFrom, type ReturnsTiming } from "./returns.server";
import { lastAgreement, recordAgreement, unsentSinceAgreement } from "./unsent.server";
import { enqueueInventoryPush, ensureInventoryPushSweep, scheduleItemReconcile } from "./schedule.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const RECONCILE_OUTCOMES = [
  "match",
  "explained",
  "opened",
  "updated",
  "auto_applied",
  "closed",
  "skipped_pending",
  "skipped_busy",
  "not_stocked",
  "untracked",
  "missing",
  "not_opened",
] as const;
export type ReconcileOutcome = (typeof RECONCILE_OUTCOMES)[number];

export type ReconcileSummary = Record<ReconcileOutcome, number> & { checked: number };

export function emptySummary(): ReconcileSummary {
  return Object.fromEntries([...RECONCILE_OUTCOMES.map((o) => [o, 0]), ["checked", 0]]) as ReconcileSummary;
}

export function addToSummary(summary: ReconcileSummary, outcomes: ReadonlyArray<{ outcome: ReconcileOutcome }>): ReconcileSummary {
  const out = { ...summary };
  for (const o of outcomes) {
    out[o.outcome] = (out[o.outcome] ?? 0) + 1;
    out.checked++;
  }
  return out;
}

export interface ReconcileTarget {
  stockItemId: string;
  inventoryItemId: string;
}

export interface ReconcileItemResult extends ReconcileTarget {
  outcome: ReconcileOutcome;
  conflictId?: string;
  diff?: number;
}

export interface ReconcileOptions {
  now?: () => Date;
  actor?: Actor;
}

// ---------------------------------------------------------------------------
// Позиції для звірки
// ---------------------------------------------------------------------------

const openedTargetQuery = (db: DbOrTx, warehouseId: string) =>
  db
    .select({ stockItemId: stockItems.id, inventoryItemId: productVariants.inventoryItemId })
    .from(stockItems)
    .innerJoin(productVariants, eq(productVariants.id, stockItems.variantId))
    .innerJoin(inventoryBalances, and(eq(inventoryBalances.stockItemId, stockItems.id), eq(inventoryBalances.warehouseId, warehouseId)))
    .$dynamic();

/** Відкриті позиції складу з InventoryItem Shopify, після stockItemId `after` (сторінка повної звірки). */
export async function openedTargets(db: DbOrTx, warehouseId: string, after: string | null, limit: number): Promise<ReconcileTarget[]> {
  const rows = await openedTargetQuery(db, warehouseId)
    .where(
      and(
        eq(stockItems.kind, "product"),
        isNotNull(inventoryBalances.openedAt),
        isNotNull(productVariants.inventoryItemId),
        after ? gt(stockItems.id, after) : undefined,
      ),
    )
    .orderBy(asc(stockItems.id))
    .limit(limit);
  return rows.map((r) => ({ stockItemId: r.stockItemId, inventoryItemId: r.inventoryItemId! }));
}

/** Позиції (відкриті чи ні) для InventoryItem Shopify. */
export async function targetsForInventoryItem(db: DbOrTx, inventoryItemGid: string): Promise<ReconcileTarget[]> {
  const rows = await db
    .select({ stockItemId: stockItems.id })
    .from(stockItems)
    .innerJoin(productVariants, eq(productVariants.id, stockItems.variantId))
    .where(eq(productVariants.inventoryItemId, inventoryItemGid));
  return rows.map((r) => ({ stockItemId: r.stockItemId, inventoryItemId: inventoryItemGid }));
}

/** Позиція за id (для дії «звірити цей товар»). */
export async function targetForStockItem(db: DbOrTx, stockItemId: string): Promise<ReconcileTarget | null> {
  const [row] = await db
    .select({ stockItemId: stockItems.id, inventoryItemId: productVariants.inventoryItemId })
    .from(stockItems)
    .innerJoin(productVariants, eq(productVariants.id, stockItems.variantId))
    .where(eq(stockItems.id, stockItemId));
  return row?.inventoryItemId ? { stockItemId: row.stockItemId, inventoryItemId: row.inventoryItemId } : null;
}

// ---------------------------------------------------------------------------
// Дані застосунку
// ---------------------------------------------------------------------------

export { RETURN_PENDING_WINDOW_MS } from "./returns.server";

/**
 * Замовлення, передані/виконані не синхронно в застосунку й Shopify (поправка до committed − reserved):
 * - inFlight: передано перевізнику (списано в застосунку), у Shopify ще не виконано — committed Shopify містить поточну
 *   кількість позиції (без повернених/відшкодованих одиниць); також позиції, уперше побачені вже переданими (історичні,
 *   без рядка резерву — reservations.server.ts), якщо Shopify їх ще не виконав;
 * - fulfilledOutside: виконано в Shopify, а в застосунку ще зарезервовано;
 * - uncertain: частково виконані замовлення (Shopify виконав або міг виконати фізичні позиції — розподіл одиниць
 *   невідомий) і резерви відкритих замовлень із неперенесеними змінами позицій Shopify (orders.shopify_lines_pending_at).
 * Часткове виконання ЛИШЕ позицій без доставки (orders.shopify_shippable_fulfilled = false: цифрова подарункова картка,
 * цифрові товари) фізичних позицій не торкається — вони й далі «committed» у Shopify, тож рахуються як невиконані.
 * Shopify: «committed — Committed when a placed order isn't fulfilled»; «After the order is fulfilled, Shopify decrements
 * the committed inventory quantity» (docs/research/stage5/shopify-inventory-quantities.md); PARTIALLY_FULFILLED — «Some of
 * the items in the order have been fulfilled» (OrderDisplayFulfillmentStatus, 2026-10).
 * Статус Shopify RESTOCKED у 2026-10 замінено на UNFULFILLED (лишається лише для старих даних) — повернення
 * визначаються за current_quantity, а не за статусом (returns.server.ts).
 */
export async function orderTiming(db: DbOrTx, warehouseId: string, stockItemIds: readonly string[]): Promise<Map<string, FulfillmentTiming>> {
  const out = new Map<string, FulfillmentTiming>();
  if (stockItemIds.length === 0) return out;
  const ids = [...stockItemIds];
  const get = (id: string) => {
    let t = out.get(id);
    if (!t) out.set(id, (t = { inFlight: 0, fulfilledOutside: 0, uncertain: false }));
    return t;
  };
  const shipped = inArray(orders.status, [...SHIPPED_STATUSES]);
  const fs = sql`coalesce(${orders.fulfillmentStatus}, '')`;
  // Часткове виконання, яке могло зачепити фізичні позиції: shopify_shippable_fulfilled = false — виконано лише позиції
  // без доставки; null (невідомо, дані до етапу 5) — як true (безпечніше, як isFulfilledInShopify).
  const partialPhysical = sql`(${fs} = 'partially_fulfilled' and coalesce(${orders.shopifyShippableFulfilled}, true))`;
  const notFulfilled = sql`not (${fs} in ('fulfilled', 'restocked') or ${partialPhysical})`;
  // Shopify змінив позиції відкритого замовлення, а застосунок їх ще не застосував (shopify-sync/pending-lines.server.ts):
  // резерв застосунку — за старими позиціями, committed Shopify — уже за новими (currentQuantity).
  const linesPending = sql`(${orders.shopifyLinesPendingAt} is not null and ${orders.status} <> 'cancelled' and not ${shipped})`;
  // Поточна кількість позиції (Shopify currentQuantity); позиції вже немає — як списано (без висновку про повернення).
  const lineQty = sql`greatest(coalesce(${orderLineItems.currentQuantity}, ${orderLineItems.quantity}, ${stockReservations.consumedQty}), 0)`;
  const rows = await db
    .select({
      stockItemId: stockReservations.stockItemId,
      inFlight: sql<number>`coalesce(sum(case when ${shipped} and ${notFulfilled}
        then least(${stockReservations.consumedQty}, ${lineQty}) else 0 end), 0)`.mapWith(Number),
      fulfilledOutside: sql<number>`coalesce(sum(case when not ${shipped} and ${orders.status} <> 'cancelled' and ${fs} = 'fulfilled'
        then ${stockReservations.reservedQty} else 0 end), 0)`.mapWith(Number),
      uncertain: sql<boolean>`coalesce(bool_or(
        ((${partialPhysical} or ${fs} = 'restocked')
          and (${stockReservations.reservedQty} > 0 or (${shipped} and ${stockReservations.consumedQty} > 0)))
        or (${linesPending} and ${stockReservations.reservedQty} > 0)), false)`,
    })
    .from(stockReservations)
    .innerJoin(orders, eq(orders.id, stockReservations.orderId))
    .leftJoin(orderLineItems, eq(orderLineItems.id, stockReservations.orderLineItemId))
    .where(and(eq(stockReservations.warehouseId, warehouseId), inArray(stockReservations.stockItemId, ids)))
    .groupBy(stockReservations.stockItemId);
  for (const r of rows) Object.assign(get(r.stockItemId), { inFlight: r.inFlight, fulfilledOutside: r.fulfilledOutside, uncertain: Boolean(r.uncertain) });

  // Історичні позиції: уперше побачені вже переданими (до знімка) — рядка резерву немає, але Shopify, поки не виконав
  // замовлення, тримає їх у committed (і on_hand), тоді як у залишку застосунку їх немає.
  const historical = await db
    .select({
      stockItemId: stockItems.id,
      inFlight: sql<number>`coalesce(sum(case when ${notFulfilled}
        then greatest(coalesce(${orderLineItems.currentQuantity}, ${orderLineItems.quantity}), 0) else 0 end), 0)`.mapWith(Number),
      uncertain: sql<boolean>`coalesce(bool_or(${partialPhysical}), false)`,
    })
    .from(orderLineItems)
    .innerJoin(orders, eq(orders.id, orderLineItems.orderId))
    .innerJoin(stockItems, eq(stockItems.variantId, orderLineItems.variantId))
    .where(
      and(
        inArray(stockItems.id, ids),
        shipped,
        isNotNull(orders.shopifyOrderId),
        sql`not exists (select 1 from ${stockReservations} where ${stockReservations.orderLineItemId} = ${orderLineItems.id})`,
      ),
    )
    .groupBy(stockItems.id);
  for (const r of historical) {
    const t = get(r.stockItemId);
    t.inFlight += r.inFlight;
    t.uncertain ||= Boolean(r.uncertain);
  }
  return out;
}

/** Повернення позиції відносно останнього узгодження (returns.server.ts). Під блокуванням балансу — узгоджено з рухами. */
async function returnsTiming(db: DbOrTx, warehouseId: string, stockItemId: string, now: Date): Promise<ReturnsTiming> {
  const state = (await loadReturnsState(db, warehouseId, [stockItemId], now)).get(stockItemId) ?? emptyReturnsState();
  const agreed = await lastAgreement(db, warehouseId, stockItemId);
  return returnsTimingFrom(state, agreed?.returns ?? EMPTY_RETURNS_SNAPSHOT);
}

function withReturns(t: FulfillmentTiming, r: ReturnsTiming): FulfillmentTiming {
  return { ...t, returnsPending: r.pending, returnsAwaiting: r.awaiting, uncertain: t.uncertain || r.pending > 0 };
}

/**
 * Поправки замовлень (orderTiming) і повернення (returns.server.ts) — як їх бачить звірка:
 * - returnsPending: після списання поточна кількість позиції зменшилася (повернення/відшкодування в Shopify; Shopify
 *   міг поповнити «доступно» сам), а склад ще не оприбуткував стільки ПРИДАТНИХ повернень покупця (від останнього
 *   узгодження) — автоприйняття такої різниці подвоїло б одиниці або додало б брак як придатний товар;
 * - returnsAwaiting: склад оприбуткував повернення, яке Shopify ще має поповнити сам;
 * - uncertain: частково виконані замовлення або returnsPending > 0.
 */
export async function fulfillmentTiming(
  db: DbOrTx,
  warehouseId: string,
  stockItemIds: readonly string[],
  now: Date = new Date(),
): Promise<Map<string, FulfillmentTiming>> {
  const base = await orderTiming(db, warehouseId, stockItemIds);
  const out = new Map<string, FulfillmentTiming>();
  for (const id of new Set(stockItemIds)) {
    const t = base.get(id) ?? { inFlight: 0, fulfilledOutside: 0, uncertain: false };
    out.set(id, withReturns(t, await returnsTiming(db, warehouseId, id, now)));
  }
  return out;
}

interface PreState {
  version: number | null;
  opened: boolean;
  pending: number;
}

async function preStates(db: DbOrTx, warehouseId: string, stockItemIds: readonly string[]): Promise<Map<string, PreState>> {
  const out = new Map<string, PreState>(stockItemIds.map((id) => [id, { version: null, opened: false, pending: 0 }]));
  if (stockItemIds.length === 0) return out;
  const balances = await db
    .select({ stockItemId: inventoryBalances.stockItemId, version: inventoryBalances.version, openedAt: inventoryBalances.openedAt })
    .from(inventoryBalances)
    .where(and(eq(inventoryBalances.warehouseId, warehouseId), inArray(inventoryBalances.stockItemId, [...stockItemIds])));
  for (const b of balances) Object.assign(out.get(b.stockItemId)!, { version: b.version, opened: b.openedAt !== null });
  const pending = await db
    .select({ stockItemId: inventoryMovements.stockItemId, c: count() })
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.warehouseId, warehouseId),
        eq(inventoryMovements.shopifySyncState, "pending"),
        inArray(inventoryMovements.stockItemId, [...stockItemIds]),
      ),
    )
    .groupBy(inventoryMovements.stockItemId);
  for (const p of pending) out.get(p.stockItemId)!.pending = Number(p.c);
  return out;
}

export type ShopifyRead =
  | { kind: "ok"; quantities: ShopifyLevelQuantities }
  | { kind: "missing" | "untracked" | "not_stocked" };

export async function readShopifyLevels(
  admin: AdminGraphql,
  inventoryItemIds: readonly string[],
  locationId: string,
): Promise<Map<string, ShopifyRead>> {
  const out = new Map<string, ShopifyRead>();
  const unique = [...new Set(inventoryItemIds)];
  for (let i = 0; i < unique.length; i += RECONCILE_PAGE_SIZE) {
    const ids = unique.slice(i, i + RECONCILE_PAGE_SIZE);
    const data = await admin<GqlInventoryLevelsResult>(INVENTORY_LEVELS_QUERY, { ids, locationId });
    for (const node of data.nodes ?? []) {
      if (!isInventoryItemNode(node)) continue;
      if (node.tracked === false) out.set(node.id, { kind: "untracked" });
      else {
        const q = quantitiesOf(node.inventoryLevel);
        out.set(node.id, q ? { kind: "ok", quantities: q } : { kind: "not_stocked" });
      }
    }
    for (const id of ids) if (!out.has(id)) out.set(id, { kind: "missing" });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Звірка
// ---------------------------------------------------------------------------

/**
 * Звіряє позиції з однією локацією Shopify. Мережеві помилки Shopify (ShopifyApiError) прокидаються —
 * завдання повториться.
 */
export async function reconcileTargets(
  db: Db,
  admin: AdminGraphql,
  env: Pick<InventorySyncEnvironment, "externalMode" | "pushMode" | "canWrite" | "warehouse">,
  locationId: string,
  targets: readonly ReconcileTarget[],
  opts: ReconcileOptions = {},
): Promise<ReconcileItemResult[]> {
  const now = opts.now ?? (() => new Date());
  const actor = opts.actor ?? SYSTEM_ACTOR;
  const warehouseId = env.warehouse.id;
  const ids = [...new Set(targets.map((t) => t.stockItemId))];
  const pre = await preStates(db, warehouseId, ids);
  const results: ReconcileItemResult[] = [];
  const toRead: ReconcileTarget[] = [];
  for (const t of targets) {
    const state = pre.get(t.stockItemId);
    if (!state?.opened) results.push({ ...t, outcome: "not_opened" });
    else if (state.pending > 0) results.push({ ...t, outcome: "skipped_pending" });
    else toRead.push(t);
  }
  if (toRead.length === 0) return results;

  const shopify = await readShopifyLevels(admin, toRead.map((t) => t.inventoryItemId), locationId);
  // Поправки замовлень — пакетом; повернення — під блокуванням балансу кожної позиції (reconcileOne).
  const timing = await orderTiming(db, warehouseId, toRead.map((t) => t.stockItemId));
  const autoApply = autoApplyEffective(env);
  for (const t of toRead) {
    const read = shopify.get(t.inventoryItemId) ?? { kind: "missing" as const };
    if (read.kind !== "ok") {
      results.push({ ...t, outcome: read.kind });
      continue;
    }
    const result = await reconcileOne(db, {
      target: t,
      warehouseId,
      locationId,
      autoApply,
      preVersion: pre.get(t.stockItemId)?.version ?? null,
      quantities: read.quantities,
      timing: timing.get(t.stockItemId) ?? { inFlight: 0, fulfilledOutside: 0, uncertain: false },
      now: now(),
      actor,
    });
    results.push(result);
  }
  return results;
}

interface ReconcileOneInput {
  target: ReconcileTarget;
  warehouseId: string;
  locationId: string;
  /** Автоприйняття діє (externalShopifyChanges = apply + передача змін + write_inventory). */
  autoApply: boolean;
  preVersion: number | null;
  quantities: ShopifyLevelQuantities;
  timing: FulfillmentTiming;
  now: Date;
  actor: Actor;
}

async function reconcileOne(db: Db, input: ReconcileOneInput): Promise<ReconcileItemResult> {
  const { target, warehouseId, now, actor } = input;
  return db.transaction(async (tx) => {
    const locked = await lockBalances(tx, [{ warehouseId, stockItemId: target.stockItemId }]);
    const b = [...locked.values()][0]!;
    if (!b.openedAt || b.kind !== "product") return { ...target, outcome: "not_opened" as const };
    if (input.preVersion === null || b.version !== input.preVersion) return { ...target, outcome: "skipped_busy" as const };

    // Розбіжність блокується до читання доказів: відхилення (failed → skipped) не прослизне між ними.
    const [open] = await tx
      .select()
      .from(inventoryConflicts)
      .where(
        and(
          eq(inventoryConflicts.stockItemId, target.stockItemId),
          eq(inventoryConflicts.warehouseId, warehouseId),
          eq(inventoryConflicts.status, "open"),
        ),
      )
      .for("update");
    const failed = await tx
      .select({ id: inventoryMovements.id, onHandDelta: inventoryMovements.onHandDelta })
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.warehouseId, warehouseId),
          eq(inventoryMovements.stockItemId, target.stockItemId),
          eq(inventoryMovements.shopifySyncState, "failed"),
        ),
      )
      .orderBy(asc(inventoryMovements.createdAt))
      .limit(500);
    const unsent = await unsentSinceAgreement(tx, warehouseId, target.stockItemId);
    const timing = withReturns(input.timing, await returnsTiming(tx, warehouseId, target.stockItemId, now));
    const cmp = compareLevels(input.quantities, { onHand: b.onHand, reserved: b.reserved }, timing);
    const verdict = verdictOf(cmp);

    if (verdict !== "conflict") {
      // Узгодження: точний збіг (без reservationExcess) або пояснена різниця без невизначеності (settlesEvidence) —
      // інакше збіг міг бути випадковим, докази лишаються.
      if (settlesEvidence(cmp)) {
        const settled = await settleFailedMovements(tx, failed.map((f) => f.id), "pushed");
        if (settled > 0) {
          await writeAudit(tx, actor, "inventory_sync.push_reconciled", { type: "stock_item", id: target.stockItemId }, { settled });
        }
        await recordAgreement(tx, actor, warehouseId, target.stockItemId, verdict, now);
      }
      if (!open) return { ...target, outcome: verdict, diff: cmp.diff };
      await tx
        .update(inventoryConflicts)
        .set({
          status: "dismissed",
          resolvedAt: now,
          resolvedBy: actor.id,
          details: { ...(open.details ?? {}), resolution: "auto_resolved", resolvedObservation: { ...cmp, observedAt: now.toISOString() } },
        })
        .where(eq(inventoryConflicts.id, open.id));
      await writeAudit(tx, actor, "inventory_sync.conflict_auto_resolved", { type: "inventory_conflict", id: open.id }, { verdict });
      return { ...target, outcome: "closed" as const, conflictId: open.id, diff: cmp.diff };
    }

    const previous = open ? parseObservation(open.details) : null;
    const origin = open ? (previous?.origin ?? conflictOrigin(open.details) ?? undefined) : undefined;
    const internalOnHand = open ? numberOrUndefined((open.details as Record<string, unknown>)?.internalOnHand) : undefined;
    // Спроба «надіслати склад» із невідомим результатом лишається видимою (і блокує автоприйняття) до 24 год — також
    // після відхилення/закриття розбіжності: Shopify міг застосувати запит пізніше (тоді нова різниця — саме він).
    const attempt = open ? parsePushAttempt((open.details as Record<string, unknown>)?.pushAttempt) : await carriedPushAttempt(tx, target.stockItemId, warehouseId);
    const pushAttempt = attempt && now.getTime() - Date.parse(attempt.at) < PUSH_ATTEMPT_TTL_MS ? attempt : null;
    const blockers = autoApplyBlockers(cmp, { failedPushes: failed.length, unsentDelta: unsent.delta, origin, pushPending: pushAttempt !== null });
    const observation: ConflictObservation = {
      kind: "reconciliation",
      observationSeq: (previous?.observationSeq ?? 0) + 1,
      observedAt: now.toISOString(),
      inventoryItemId: target.inventoryItemId,
      locationId: input.locationId,
      appVersion: b.version,
      ...cmp,
      failedMovementIds: failed.map((f) => f.id),
      failedDelta: failed.reduce((s, f) => s + f.onHandDelta, 0),
      unsentCount: unsent.count,
      unsentDelta: unsent.delta,
      unsentMovementIds: unsent.movementIds,
      ...(input.autoApply && blockers.length > 0 ? { autoApplyBlockers: blockers } : {}),
      ...(pushAttempt ? { pushAttempt } : {}),
      ...(origin ? { origin } : {}),
      ...(internalOnHand !== undefined ? { internalOnHand } : {}),
    };
    const values = {
      appOnHand: b.onHand,
      shopifyOnHand: input.quantities.onHand,
      shopifyAvailable: input.quantities.available,
      expectedDiff: cmp.expectedDiff,
      details: observation as unknown as Record<string, unknown>,
    };
    let conflict: typeof inventoryConflicts.$inferSelect;
    let outcome: ReconcileOutcome;
    if (open) {
      [conflict] = (await tx.update(inventoryConflicts).set(values).where(eq(inventoryConflicts.id, open.id)).returning()) as [
        typeof inventoryConflicts.$inferSelect,
      ];
      outcome = "updated";
    } else {
      const [inserted] = await tx
        .insert(inventoryConflicts)
        .values({ stockItemId: target.stockItemId, warehouseId, ...values })
        .onConflictDoNothing({
          target: [inventoryConflicts.stockItemId, inventoryConflicts.warehouseId],
          where: sql`${inventoryConflicts.status} = 'open'`,
        })
        .returning();
      // Паралельна вставка (немислима при заблокованому балансі, але безпечно) — позиція звіриться пізніше.
      if (!inserted) return { ...target, outcome: "skipped_busy" as const };
      conflict = inserted;
      outcome = "opened";
      await writeAudit(tx, actor, "inventory_sync.conflict_opened", { type: "inventory_conflict", id: conflict.id }, {
        diff: cmp.diff,
        expectedDiff: cmp.expectedDiff,
      });
    }

    if (input.autoApply && blockers.length === 0) {
      try {
        await acceptInTx(tx, SYSTEM_ACTOR, conflict, observation, "auto", now);
        return { ...target, outcome: "auto_applied" as const, conflictId: conflict.id, diff: cmp.diff };
      } catch (e) {
        if (!(e instanceof DomainError) || e.code !== "inventory.insufficient") throw e;
        await tx
          .update(inventoryConflicts)
          .set({ details: { ...observation, autoApplyBlocked: "insufficient" } })
          .where(eq(inventoryConflicts.id, conflict.id));
      }
    }
    return { ...target, outcome, conflictId: conflict.id, diff: cmp.diff };
  });
}

/**
 * Спроба «надіслати склад» останньої закритої розбіжності позиції (відхилено / закрито звіркою / прийнято), якщо її
 * результат так і не став відомим. Успіх і остаточна відмова Shopify знімають позначку (conflicts.server.ts).
 */
async function carriedPushAttempt(tx: DbOrTx, stockItemId: string, warehouseId: string) {
  const [last] = await tx
    .select({ details: inventoryConflicts.details })
    .from(inventoryConflicts)
    .where(
      and(
        eq(inventoryConflicts.stockItemId, stockItemId),
        eq(inventoryConflicts.warehouseId, warehouseId),
        ne(inventoryConflicts.status, "open"),
        sql`${inventoryConflicts.details} ? 'pushAttempt'`,
      ),
    )
    .orderBy(sql`${inventoryConflicts.resolvedAt} desc nulls last`, desc(inventoryConflicts.createdAt))
    .limit(1);
  return last ? parsePushAttempt((last.details as Record<string, unknown> | null)?.pushAttempt) : null;
}

async function anyOpened(db: DbOrTx, warehouseId: string, targets: readonly ReconcileTarget[]): Promise<boolean> {
  if (targets.length === 0) return false;
  const [row] = await db
    .select({ c: count() })
    .from(inventoryBalances)
    .where(
      and(
        eq(inventoryBalances.warehouseId, warehouseId),
        inArray(inventoryBalances.stockItemId, targets.map((t) => t.stockItemId)),
        isNotNull(inventoryBalances.openedAt),
      ),
    );
  return Number(row?.c ?? 0) > 0;
}

/**
 * Позиції з неперенесеними рухами: поставити передачу НЕЗАЛЕЖНО від режиму й дозволів — саме завдання передачі
 * переводить pending у skipped (з причиною), якщо передачу вимкнено або немає write_inventory; інакше такі рухи
 * лишилися б pending назавжди (позиція ніколи не звірялася б, дії з розбіжністю завжди були б «застарілими»).
 * Поки передачу ввімкнено — підтримати страховий обхід.
 */
async function afterSkipped(db: DbOrTx, env: Pick<InventorySyncEnvironment, "pushMode">, results: readonly ReconcileItemResult[]) {
  if (results.some((r) => r.outcome === "skipped_pending")) await enqueueInventoryPush(db);
  else if (env.pushMode === "deltas") await ensureInventoryPushSweep(db);
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isSafeInteger(v) ? v : undefined;
}

/**
 * Негайна звірка однієї позиції (дія власника «Звірити», застаріле спостереження під час розв'язання).
 * null — звірка неможлива (немає магазину/дозволу/локації або зв'язку з Shopify).
 */
export async function reconcileStockItemNow(
  db: Db,
  admin: AdminGraphql,
  stockItemId: string,
  opts: ReconcileOptions = {},
): Promise<ReconcileOutcome | null> {
  // Неправильний id (застаріла/підроблена форма) — без звернень до Shopify і без помилки БД (uuid).
  if (!UUID_RE.test(stockItemId)) return null;
  const env = await loadSyncEnvironment(db);
  if (!env.shop || !env.canRead) return null;
  const location = await ensureWarehouseLocation(db, admin, env.warehouse);
  if (location.status !== "ready") return null;
  const target = await targetForStockItem(db, stockItemId);
  if (!target) return null;
  const results = await reconcileTargets(db, admin, env, location.locationId, [target], opts);
  await afterSkipped(db, env, results);
  return results[0]?.outcome ?? null;
}

// ---------------------------------------------------------------------------
// Завдання
// ---------------------------------------------------------------------------

export interface ReconcileJobDeps {
  db: Db;
  admin: (shop: string) => Promise<AdminGraphql>;
  now?: () => Date;
}

export type ReconcileJobPayload =
  | { scope: "item"; shop?: string; inventoryItemGid: string; attempt?: number }
  | { scope: "all"; shop?: string; after: string | null; requestedBy?: string; startedAt?: string; summary?: Partial<ReconcileSummary> };

export type ReconcileJobResult =
  | { status: "skipped"; reason: "not_installed" | "missing_scope" }
  | { status: "location_required" }
  | { status: "done" | "more"; results: ReconcileItemResult[]; summary?: ReconcileSummary };

export function parseReconcilePayload(raw: unknown): ReconcileJobPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (p.scope === "item" && typeof p.inventoryItemGid === "string") {
    return { scope: "item", inventoryItemGid: p.inventoryItemGid, attempt: typeof p.attempt === "number" ? p.attempt : 0 };
  }
  if (p.scope === "all") {
    return {
      scope: "all",
      after: typeof p.after === "string" ? p.after : null,
      requestedBy: typeof p.requestedBy === "string" ? p.requestedBy : undefined,
      startedAt: typeof p.startedAt === "string" ? p.startedAt : undefined,
      summary: p.summary && typeof p.summary === "object" ? (p.summary as Partial<ReconcileSummary>) : {},
    };
  }
  return null;
}

/** Обробник завдання inventory.reconcile (одна позиція або сторінка повної звірки). */
export async function runReconcileJob(deps: ReconcileJobDeps, payload: ReconcileJobPayload): Promise<ReconcileJobResult> {
  const env = await loadSyncEnvironment(deps.db);
  if (!env.shop) return { status: "skipped", reason: "not_installed" };
  if (!env.canRead) return { status: "skipped", reason: "missing_scope" };
  const now = deps.now ?? (() => new Date());

  if (payload.scope === "item") {
    const targets = await targetsForInventoryItem(deps.db, payload.inventoryItemGid);
    // Товар не відкрито (облік ще не запущено / не відстежується) — без звернень до Shopify.
    if (!(await anyOpened(deps.db, env.warehouse.id, targets))) {
      return { status: "done", results: targets.map((t) => ({ ...t, outcome: "not_opened" as const })) };
    }
    const admin = await deps.admin(env.shop);
    const location = await ensureWarehouseLocation(deps.db, admin, env.warehouse);
    if (location.status !== "ready") return { status: "location_required" };
    const results = await reconcileTargets(deps.db, admin, env, location.locationId, targets, { now });
    await afterSkipped(deps.db, env, results);
    const retry = results.some((r) => r.outcome === "skipped_pending" || r.outcome === "skipped_busy");
    const attempt = payload.attempt ?? 0;
    if (retry && attempt < RECONCILE_MAX_RESCHEDULES) {
      await scheduleItemReconcile(deps.db, { shop: env.shop, inventoryItemGid: payload.inventoryItemGid, attempt: attempt + 1, now: now() });
    }
    return { status: "done", results };
  }

  const admin = await deps.admin(env.shop);
  const location = await ensureWarehouseLocation(deps.db, admin, env.warehouse);
  if (location.status !== "ready") return { status: "location_required" };
  const targets = await openedTargets(deps.db, env.warehouse.id, payload.after, RECONCILE_PAGE_SIZE);
  const results = await reconcileTargets(deps.db, admin, env, location.locationId, targets, { now });
  const summary = addToSummary({ ...emptySummary(), ...(payload.summary ?? {}) }, results);
  await afterSkipped(deps.db, env, results);
  // Пропущені (рухи в дорозі / зміна під час читання) — окремою відкладеною звіркою.
  for (const r of results) {
    if (r.outcome === "skipped_pending" || r.outcome === "skipped_busy") {
      await scheduleItemReconcile(deps.db, { shop: env.shop, inventoryItemGid: r.inventoryItemId, delayMs: RECONCILE_DELAY_MS, now: now() });
    }
  }
  const last = targets[targets.length - 1];
  if (targets.length >= RECONCILE_PAGE_SIZE && last) {
    await enqueueJob(
      deps.db,
      INVENTORY_SYNC_JOB.reconcile,
      { scope: "all", shop: env.shop, after: last.stockItemId, requestedBy: payload.requestedBy, startedAt: payload.startedAt, summary },
      { dedupeKey: reconcileAllDedupeKey(last.stockItemId), maxAttempts: 6 },
    );
    return { status: "more", results, summary };
  }
  await writeAudit(deps.db, SYSTEM_ACTOR, "inventory_sync.reconcile_finished", { type: "warehouse", id: env.warehouse.id }, {
    scope: "all",
    startedAt: payload.startedAt ?? null,
    ...summary,
  });
  logger.info("inventory_sync.reconcile_finished", { checked: summary.checked, opened: summary.opened, updated: summary.updated });
  return { status: "done", results, summary };
}
