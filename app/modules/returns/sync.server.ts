/**
 * Етап 6, WP9: випадки повернень замовлення з фактів (docs/stage6-design.md §11) — ВНУТРІШНЯ функція
 * (INTERNAL_POSTING_FUNCTIONS, contracts.ts SyncReturnCasesForOrder): актора не перевіряє (її запускають потоки
 * працівників — надходження повернення на склад, синхронізація Shopify), записує лише `created_by = actor.id`, нічого не
 * повертає; сторінки/маршрути/команди/ШІ її не імпортують (тест-сканер).
 *
 * Викликає WP4 у `syncOrderFinance` (після фактів Shopify і оцінки рухів замовлення — §6.4), а також сервіси розділу
 * «Повернення» перед ручним випадком. Ідемпотентно: повторний виклик нічого не змінює (ключі джерел `ret:refund:<id>`,
 * `ret:receipt:<id>` + детерміновані id позицій, keys.ts); правила зв'язування — rules.ts planReturnSync.
 *
 * Блокування: advisory-блокування фінансів замовлення (FINO, повторно-вхідне в межах транзакції — виклик із
 * syncOrderFinance, що вже тримає його, безпечний). Його беруть УСІ, хто змінює випадки замовлення (ця функція й ручні
 * сервіси cases.server.ts), тож план, складений за прочитаним станом, застосовується без гонок. Порядок F10 не
 * порушується: після FINO — лише рядки order_returns / order_return_lines (і журнал audit_log).
 */
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "~/db/client.server";
import { auditLog, orderReturnLines, orderReturns } from "~/db/schema";
import type { PostingActor, SyncReturnCasesForOrder } from "~/modules/finance/core/contracts";
import { lockFinanceOrder } from "~/modules/finance/core/locks.server";
import { DEFAULT_STORE_ID } from "~/modules/finance/core/store.server";
import { loadReceiptSources, loadRefundSources, loadShippingFacts } from "./facts.server";
import { planReturnSync, type ExistingCase } from "./rules";

/** Тип виконавця для audit_log (без персональних даних — лише id). */
function actorType(actor: PostingActor): "system" | "user" {
  return actor.id === "system" ? "system" : "user";
}

export const syncReturnCasesForOrder: SyncReturnCasesForOrder = async (tx: Tx, actor: PostingActor, orderId: string): Promise<void> => {
  await lockFinanceOrder(tx, orderId);
  // Послідовно: транзакція — одне з'єднання (паралельні запити на ньому pg лише ставить у чергу й попереджає).
  const refunds = await loadRefundSources(tx, orderId);
  const receipts = await loadReceiptSources(tx, orderId);
  if (refunds.length === 0 && receipts.length === 0) return;
  const shipping = (await loadShippingFacts(tx, [orderId])).get(orderId);
  const caseRows = await tx.select().from(orderReturns).where(eq(orderReturns.orderId, orderId));
  if (!shipping) return; // замовлення видалено
  const lines = caseRows.length
    ? await tx
        .select({
          id: orderReturnLines.id,
          returnId: orderReturnLines.returnId,
        })
        .from(orderReturnLines)
        .where(
          inArray(
            orderReturnLines.returnId,
            caseRows.map((c) => c.id),
          ),
        )
    : [];
  const cases: ExistingCase[] = caseRows.map((c) => ({
    id: c.id,
    kind: c.kind,
    status: c.status,
    source: c.source,
    sourceKey: c.sourceKey,
    firstSignalAt: c.firstSignalAt,
    receivedAt: c.receivedAt,
    createdAt: c.createdAt,
    version: c.version,
  }));
  const plan = planReturnSync({
    refunds,
    receipts,
    shipping,
    cases,
    lines,
    newId: randomUUID,
  });
  if (plan.creates.length === 0 && plan.updates.length === 0 && plan.lines.length === 0) return;

  const remap = new Map<string, string>();
  for (const c of plan.creates) {
    const [row] = await tx
      .insert(orderReturns)
      .values({
        id: c.id,
        storeId: DEFAULT_STORE_ID,
        orderId,
        kind: c.kind,
        status: c.status,
        reasonCode: "unknown",
        source: c.source,
        sourceKey: c.sourceKey,
        firstSignalAt: c.firstSignalAt,
        receivedAt: c.receivedAt,
        createdBy: actor.id,
      })
      .onConflictDoNothing({ target: orderReturns.sourceKey })
      .returning({ id: orderReturns.id });
    if (!row) {
      // Ключ уже зайнятий (не мало б статися під блокуванням) — позиції йдуть до наявного випадку.
      const [existing] = await tx.select({ id: orderReturns.id }).from(orderReturns).where(eq(orderReturns.sourceKey, c.sourceKey));
      if (existing) remap.set(c.id, existing.id);
      continue;
    }
    await tx.insert(auditLog).values({
      actorType: actorType(actor),
      actorId: actor.id,
      action: "returns.case_created",
      entityType: "order_return",
      entityId: c.id,
      details: { orderId, source: c.source, kind: c.kind, status: c.status },
    });
  }
  const before = new Map(caseRows.map((c) => [c.id, c]));
  for (const u of plan.updates) {
    await tx
      .update(orderReturns)
      .set({
        kind: u.kind,
        status: u.status,
        firstSignalAt: u.firstSignalAt,
        receivedAt: u.receivedAt,
        version: sql`${orderReturns.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(orderReturns.id, u.id));
    const prev = before.get(u.id);
    if (prev && prev.status !== u.status) {
      await tx.insert(auditLog).values({
        actorType: actorType(actor),
        actorId: actor.id,
        action: "returns.status_changed",
        entityType: "order_return",
        entityId: u.id,
        details: { orderId, from: prev.status, to: u.status, source: "sync" },
      });
    }
  }
  for (const l of plan.linked) {
    const returnId = remap.get(l.returnId) ?? l.returnId;
    await tx.insert(auditLog).values({
      actorType: actorType(actor),
      actorId: actor.id,
      action: "returns.source_linked",
      entityType: "order_return",
      entityId: returnId,
      details: {
        orderId,
        source: l.sourceKey.startsWith("ret:refund:") ? "shopify_refund" : "stock_receipt",
      },
    });
  }
  if (plan.lines.length > 0) {
    await tx
      .insert(orderReturnLines)
      .values(
        plan.lines.map((l) => ({
          id: l.id,
          returnId: remap.get(l.returnId) ?? l.returnId,
          orderLineItemId: l.orderLineItemId,
          variantId: l.variantId,
          quantity: l.quantity,
          condition: l.condition,
          restockedQty: l.restockedQty,
        })),
      )
      .onConflictDoNothing({ target: orderReturnLines.id });
  }
};
