/**
 * Постановка завдань синхронізації залишків у чергу. Модуль навмисно легкий (лише черга): його імпортують
 * синхронізація Shopify (webhook) і модулі складу, що створюють рухи для передачі.
 */
import { and, eq, inArray, isNotNull, like, sql } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { inventoryBalances, jobs, productVariants, stockItems } from "~/db/schema";
import { enqueueJob } from "~/modules/jobs/queue.server";
import { getSetting } from "~/modules/settings/settings.server";
import { loadSyncEnvironment } from "./environment.server";
import {
  INVENTORY_SYNC_JOB,
  PUSH_DEDUPE_KEY,
  PUSH_SWEEP_MS,
  RECONCILE_DELAY_MS,
  RECONCILE_MAX_DEFER_MS,
  SCHEDULED_RECONCILE_DEDUPE_KEY,
  SCHEDULED_RECONCILE_INTERVAL_MS,
  SCHEDULED_RECONCILE_REQUESTER,
  reconcileAllDedupeKey,
  reconcileItemDedupeKey,
} from "./jobs";

const PUSH_MAX_ATTEMPTS = 10;

function insertedFlag(result: unknown): boolean {
  const rows = (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as Array<{ inserted?: boolean }>;
  return rows[0]?.inserted === true;
}

/**
 * Поставити передачу рухів у Shopify (одне очікуване завдання на всіх). Викликайте в ТІЙ САМІЙ транзакції, що
 * створила рухи зі станом pending (надходження, коригування, брак…): завдання стане видимим обробнику разом із рухами.
 * Уже заплановане завдання (страховий обхід) пришвидшується до runAt (за замовчуванням — зараз). Якщо передачу
 * вимкнено або немає дозволу, завдання позначить рухи skipped. Повертає true, якщо створено нове завдання.
 */
export async function enqueueInventoryPush(db: DbOrTx, opts: { runAt?: Date } = {}): Promise<boolean> {
  const runAt = (opts.runAt ?? new Date()).toISOString();
  const result = await db.execute(sql`
    insert into ${jobs} (type, payload, dedupe_key, run_at, max_attempts)
    values (${INVENTORY_SYNC_JOB.push}, '{}'::jsonb, ${PUSH_DEDUPE_KEY}, ${runAt}::timestamptz, ${PUSH_MAX_ATTEMPTS})
    on conflict (dedupe_key) where status = 'queued'
    do update set run_at = least(${jobs.runAt}, excluded.run_at), updated_at = now()
    returning (xmax = 0) as inserted`);
  return insertedFlag(result);
}

/**
 * Для модулів складу/виробництва: після applyMovements у тій самій транзакції —
 * `await enqueueInventoryPushIfPending(tx, res.applied)`. Ставить передачу, лише якщо серед записаних рухів є pending.
 */
export async function enqueueInventoryPushIfPending(
  db: DbOrTx,
  applied: ReadonlyArray<{ shopifySyncState: string }>,
): Promise<boolean> {
  if (!applied.some((m) => m.shopifySyncState === "pending")) return false;
  await enqueueInventoryPush(db);
  return true;
}

/**
 * Страховий обхід (PUSH_SWEEP_MS): наступне завдання передачі, якщо в черзі ще немає жодного. Не пришвидшує
 * заплановане. Підтримує ланцюжок, поки передачу ввімкнено (обробник inventory.push, звірка, webhook).
 */
export async function ensureInventoryPushSweep(db: DbOrTx, now: Date = new Date()): Promise<boolean> {
  return enqueueJob(db, INVENTORY_SYNC_JOB.push, {}, {
    dedupeKey: PUSH_DEDUPE_KEY,
    maxAttempts: PUSH_MAX_ATTEMPTS,
    runAt: new Date(now.getTime() + PUSH_SWEEP_MS),
  });
}

export interface ScheduleItemReconcileInput {
  shop: string;
  inventoryItemGid: string;
  /** Затримка від зараз (за замовчуванням RECONCILE_DELAY_MS). */
  delayMs?: number;
  /**
   * defer (webhook): повторна подія відкладає вже заплановану звірку до now + delay, але не далі ніж на
   * RECONCILE_MAX_DEFER_MS від першої; asap: запланована звірка не відкладається, лише пришвидшується.
   */
  mode?: "defer" | "asap";
  /** Номер повторного планування (позиція з неперенесеними рухами). */
  attempt?: number;
  now?: Date;
}

/**
 * Відкладена звірка однієї позиції (dedupe: одна очікувана звірка на InventoryItem). Повертає true, якщо створено
 * нове завдання (false — оновлено час наявного).
 */
export async function scheduleItemReconcile(db: DbOrTx, input: ScheduleItemReconcileInput): Promise<boolean> {
  const now = input.now ?? new Date();
  const runAt = new Date(now.getTime() + (input.delayMs ?? RECONCILE_DELAY_MS)).toISOString();
  const payload = JSON.stringify({ scope: "item", shop: input.shop, inventoryItemGid: input.inventoryItemGid, attempt: input.attempt ?? 0 });
  const update =
    input.mode === "asap"
      ? sql`least(${jobs.runAt}, excluded.run_at)`
      : sql`least(greatest(${jobs.runAt}, excluded.run_at), ${jobs.createdAt} + ${`${RECONCILE_MAX_DEFER_MS} milliseconds`}::interval)`;
  const result = await db.execute(sql`
    insert into ${jobs} (type, payload, dedupe_key, run_at, max_attempts)
    values (${INVENTORY_SYNC_JOB.reconcile}, ${payload}::jsonb, ${reconcileItemDedupeKey(input.inventoryItemGid)},
            ${runAt}::timestamptz, 6)
    on conflict (dedupe_key) where status = 'queued'
    do update set run_at = ${update}, updated_at = now()
    returning (xmax = 0) as inserted`);
  return insertedFlag(result);
}

/**
 * Webhook inventory_levels/update: відкладена звірка — лише якщо InventoryItem відповідає товару, ВІДКРИТОМУ в обліку
 * складу (до запуску обліку звіряти нічого; знімок при відкритті все одно береться свіжий). Повертає true, якщо
 * звірку заплановано (створено або відкладено наявну).
 */
export async function scheduleReconcileForInventoryWebhook(db: DbOrTx, shop: string, inventoryItemGid: string): Promise<boolean> {
  const [opened] = await db
    .select({ id: stockItems.id })
    .from(productVariants)
    .innerJoin(stockItems, eq(stockItems.variantId, productVariants.id))
    .innerJoin(inventoryBalances, and(eq(inventoryBalances.stockItemId, stockItems.id), isNotNull(inventoryBalances.openedAt)))
    .where(eq(productVariants.inventoryItemId, inventoryItemGid))
    .limit(1);
  if (!opened) return false;
  await scheduleItemReconcile(db, { shop, inventoryItemGid, mode: "defer" });
  // Страховий обхід передачі (якщо ланцюжок обірвався, напр. після вимкнення й повторного ввімкнення передачі).
  if ((await getSetting(db, "warehouse")).shopifyPush === "deltas") await ensureInventoryPushSweep(db);
  return true;
}

/** Повна звірка всіх відкритих позицій (сторінками, кожна сторінка — окреме завдання). */
export async function enqueueFullReconcile(db: DbOrTx, shop: string, requestedBy: string): Promise<boolean> {
  return enqueueJob(
    db,
    INVENTORY_SYNC_JOB.reconcile,
    { scope: "all", shop, after: null, requestedBy, startedAt: new Date().toISOString(), summary: {} },
    { dedupeKey: reconcileAllDedupeKey(null), maxAttempts: 6 },
  );
}

/**
 * Наступна планова перевірка повної звірки (одне очікуване завдання; уже заплановане не переноситься — перезапуск
 * сервера не відкладає і не множить звірки).
 */
export async function scheduleFullReconcileCheck(db: DbOrTx, opts: { now?: Date; delayMs?: number } = {}): Promise<boolean> {
  const now = opts.now ?? new Date();
  return enqueueJob(db, INVENTORY_SYNC_JOB.scheduledReconcile, {}, {
    dedupeKey: SCHEDULED_RECONCILE_DEDUPE_KEY,
    maxAttempts: 3,
    runAt: new Date(now.getTime() + (opts.delayMs ?? SCHEDULED_RECONCILE_INTERVAL_MS)),
  });
}

/** Повна звірка вже в черзі або виконується (будь-яка її сторінка). */
export async function fullReconcileActive(db: DbOrTx): Promise<boolean> {
  const [row] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.type, INVENTORY_SYNC_JOB.reconcile),
        inArray(jobs.status, ["queued", "running"]),
        like(jobs.dedupeKey, reconcileAllDedupeKey("%")),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export type ScheduledReconcileOutcome = "queued" | "not_installed" | "missing_scope" | "not_opened" | "already_running";

/**
 * Обробник планової звірки: спершу планує наступну перевірку (ланцюжок не обривається ні при збої, ні поки звіряти
 * нічого), потім ставить повну звірку — лише коли застосунок установлено, є дозвіл читати залишки, облік складу
 * відкрито й повна звірка ще не йде. Сама звірка — звичайне завдання inventory.reconcile (scope all).
 */
export async function runScheduledReconcile(db: DbOrTx, now: Date = new Date()): Promise<ScheduledReconcileOutcome> {
  await scheduleFullReconcileCheck(db, { now });
  const env = await loadSyncEnvironment(db);
  if (!env.shop) return "not_installed";
  if (!env.canRead) return "missing_scope";
  const [opened] = await db
    .select({ id: inventoryBalances.stockItemId })
    .from(inventoryBalances)
    .where(and(eq(inventoryBalances.warehouseId, env.warehouse.id), isNotNull(inventoryBalances.openedAt)))
    .limit(1);
  if (!opened) return "not_opened";
  if (await fullReconcileActive(db)) return "already_running";
  await enqueueFullReconcile(db, env.shop, SCHEDULED_RECONCILE_REQUESTER);
  return "queued";
}
