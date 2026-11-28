/**
 * Етап 6, WP9: ознаки випадків при читанні (без грошей, без перевірки актора — викликають сервіси, що вже перевірили
 * `orders.view` / `finance.view`): походження позицій із джерел замовлень, одиниці з неточною кількістю (MIXED),
 * «Очікує надходження на склад» (§6.7). Правила — attribution.ts (чисті).
 */
import { inArray } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { orderReturnLines } from "~/db/schema";
import { caseInsight, lineOrigins, type CaseInsight, type LineOrigin } from "./attribution";
import { loadReceiptMovementIds, loadRefundSourcesForOrders } from "./facts.server";
import type { ReturnKind, ReturnStatus } from "./rules";

export type { CaseInsight } from "./attribution";

type LineRow = typeof orderReturnLines.$inferSelect;

/** Походження позицій з джерел (id позиції → повернення коштів з видом / надходження) для замовлень. */
export async function loadLineOrigins(db: DbOrTx, orderIds: readonly string[]): Promise<Map<string, LineOrigin>> {
  // Послідовно: db може бути транзакцією (одне з'єднання).
  const refunds = await loadRefundSourcesForOrders(db, orderIds);
  const receipts = await loadReceiptMovementIds(db, orderIds);
  const out = new Map<string, LineOrigin>();
  for (const id of new Set(orderIds)) {
    for (const [k, v] of lineOrigins(refunds.get(id) ?? [], receipts.get(id) ?? [])) out.set(k, v);
  }
  return out;
}

/** Позиції випадків (за випадком). */
export async function loadCaseLines(db: DbOrTx, caseIds: readonly string[]): Promise<Map<string, LineRow[]>> {
  const byCase = new Map<string, LineRow[]>();
  for (let i = 0; i < caseIds.length; i += 1000) {
    for (const l of await db
      .select()
      .from(orderReturnLines)
      .where(inArray(orderReturnLines.returnId, caseIds.slice(i, i + 1000)))) {
      const list = byCase.get(l.returnId);
      if (list) list.push(l);
      else byCase.set(l.returnId, [l]);
    }
  }
  return byCase;
}

/** Одиниці й ознаки випадків (одиниці — max(заявлено точно, оглянуто); MIXED — окремо «можливо ще»). */
export async function caseInsights(
  db: DbOrTx,
  cases: ReadonlyArray<{ id: string; orderId: string; kind: ReturnKind; status: ReturnStatus }>,
): Promise<Map<string, CaseInsight>> {
  const out = new Map<string, CaseInsight>();
  if (cases.length === 0) return out;
  const lines = await loadCaseLines(
    db,
    cases.map((c) => c.id),
  );
  const origins = await loadLineOrigins(
    db,
    cases.map((c) => c.orderId),
  );
  for (const c of cases) out.set(c.id, caseInsight(c, lines.get(c.id) ?? [], origins));
  return out;
}
