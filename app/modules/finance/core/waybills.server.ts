/**
 * Етап 6: зовнішні номери накладних замовлення (відправлено поза застосунком): з Shopify (fulfillments.trackingInfo,
 * WP3), вручну на картці (WP4), демо (WP11). ВНУТРІШНЯ функція проведення (contracts.ts): без перевірки актора,
 * результат — лише кількості. Номер, що збігається з накладною самого застосунку для цього замовлення (застосунок сам
 * передав трек-номер у Shopify), НЕ записується як зовнішній — інакше одна накладна рахувалася б двічі.
 * Після запису викликач у тій самій транзакції викликає syncOrderFinance замовлення (§16.3).
 */
import { eq } from "drizzle-orm";
import type { Tx } from "~/db/client.server";
import { orderExternalWaybills, shipments } from "~/db/schema";
import type { ExternalWaybillSource } from "~/domain/finance";
import type { PostingActor } from "./entries.server";
import { DEFAULT_STORE_ID } from "./store.server";
import { normalizeWaybillNumber } from "./waybills";

export interface ExternalWaybillInput {
  number: string | number;
  carrierCode?: string | null;
}

export interface RecordExternalWaybillsResult {
  inserted: number;
  /** Уже були записані для цього замовлення. */
  skipped: number;
  /** Порожні / пошкоджені номери. */
  invalid: number;
  /** Номер накладної самого застосунку для цього замовлення. */
  ownShipment: number;
}

export async function recordExternalWaybills(
  tx: Tx,
  actor: PostingActor,
  input: { orderId: string; source: ExternalWaybillSource; numbers: readonly ExternalWaybillInput[]; storeId?: string },
): Promise<RecordExternalWaybillsResult> {
  const result: RecordExternalWaybillsResult = { inserted: 0, skipped: 0, invalid: 0, ownShipment: 0 };
  if (input.numbers.length === 0) return result;
  const own = await tx
    .select({ waybill: shipments.waybillNumber, tracking: shipments.trackingNumber })
    .from(shipments)
    .where(eq(shipments.orderId, input.orderId));
  const ownNorms = new Set<string>();
  for (const s of own) {
    for (const n of [s.waybill, s.tracking]) {
      const r = normalizeWaybillNumber(n);
      if (r.ok) ownNorms.add(r.norm);
    }
  }
  const seen = new Set<string>();
  for (const item of input.numbers) {
    const r = normalizeWaybillNumber(item.number);
    if (!r.ok) {
      result.invalid++;
      continue;
    }
    if (ownNorms.has(r.norm)) {
      result.ownShipment++;
      continue;
    }
    if (seen.has(r.norm)) {
      result.skipped++;
      continue;
    }
    seen.add(r.norm);
    const out = await tx
      .insert(orderExternalWaybills)
      .values({
        storeId: input.storeId ?? DEFAULT_STORE_ID,
        orderId: input.orderId,
        carrierCode: item.carrierCode ?? null,
        numberNorm: r.norm,
        numberClass: r.numberClass,
        source: input.source,
        createdBy: actor.id,
      })
      .onConflictDoNothing({ target: [orderExternalWaybills.orderId, orderExternalWaybills.numberNorm] })
      .returning({ id: orderExternalWaybills.id });
    if (out.length > 0) result.inserted++;
    else result.skipped++;
  }
  return result;
}
