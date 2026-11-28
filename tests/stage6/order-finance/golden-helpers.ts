/**
 * Етап 6, WP4: відтворення фактів золотих випадків еталонної моделі (tests/stage6/reference/golden, WP12a) у базі
 * застосунку — так, як їх записали б WP3 (факти Shopify), WP2 (оцінки складу), WP5 (рядки рахунку перевізника), власник
 * (спори, правила комісій, позначки) — і порівняння результату syncOrderFinance з моделлю (postOrder): записи журналу
 * за кортежем (категорія, сума, валюта, recognized_on, fx_on), стани складників, прогнози.
 * Факти додаються поступово (`advance(asOf)`: лише відомі на момент asOf), як у моделі «стан на момент asOf».
 * Усі ідентифікатори, коди й суми вигадані; персональних даних немає.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DatabaseHandle, Db } from "~/db/client.server";
import {
  carrierInvoiceLines,
  carrierInvoices,
  financeEntries,
  financeFeeRules,
  fxRates,
  inventoryMovements,
  inventoryValuations,
  orderDisputes,
  orderFinance,
  orderFinanceForecasts,
  orderLineItems,
  orderSales,
  orderShopifyFinance,
  orderTransactionFees,
  orderTransactions,
  orders,
  packagingMaterials,
  shipmentCostEstimates,
  shipments,
  stockItemCosts,
} from "~/db/schema";
import { DEMO_SETTINGS, seedReferenceData } from "~/db/seed/seed.server";
import { SYSTEM_ACTOR, type Actor } from "~/domain/permissions";
import { DemoShopifyGateway } from "~/integrations/shopify/types";
import { fromMinor, ratePerUnitScaled, scaledRateToDecimal, toMinor } from "~/lib/decimal";
import { businessDate } from "~/lib/periods";
import { emptySnapshot } from "~/modules/finance-sync/snapshot";
import { postEntries } from "~/modules/finance/core/entries.server";
import { financeKeys } from "~/modules/finance/core/keys";
import { saveFinanceSettings } from "~/modules/finance/core/settings.server";
import { isSettled, parseOrderComponents } from "~/modules/finance/core/states";
import { ensureStockItemForMaterial, ensureStockItemForVariant } from "~/modules/inventory/ledger.server";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import { syncOrderFinanceAt } from "~/modules/order-finance/sync.server";
import { createPartner } from "~/modules/partners/partners.server";
import { createDemoCarriers } from "~/server/demo-runtime.server";
import type { ServiceContext } from "~/server/types";
import type { RefEntry, RefForecast, RefOrderFacts, RefRate } from "../reference/model";
import { OWNER, openTestDatabase } from "../../helpers";
import { insertProduct } from "../../stage5/helpers";

export interface GoldenEnv {
  hd: DatabaseHandle;
  db: Db;
  warehouseId: string;
  ctx: (actor?: Actor, now?: string | Date) => ServiceContext;
  close: () => Promise<void>;
}

export async function openGoldenEnv(rates: readonly RefRate[] = []): Promise<GoldenEnv> {
  const hd = await openTestDatabase();
  await seedReferenceData(hd.db, DEMO_SETTINGS);
  const carriers = createDemoCarriers(hd.db);
  const w = await getDefaultWarehouse(hd.db);
  await insertRefRates(hd.db, rates);
  return {
    hd,
    db: hd.db,
    warehouseId: w.id,
    ctx: (actor = OWNER, now) => ({
      mode: "demo",
      db: hd.db,
      actor,
      carriers,
      shopify: new DemoShopifyGateway(),
      now: () => (now === undefined ? new Date() : typeof now === "string" ? new Date(now) : now),
    }),
    close: () => hd.close(),
  };
}

/**
 * Контекст сервісів власника в режимі production: у базі золотих випадків лише курси НБУ / вручну (без демо-рядків),
 * тож і синхронізація (resolveRateMode → production), і картка / список рахують за тими самими курсами.
 */
export function prodCtx(env: GoldenEnv, now?: string | Date, actor: Actor = OWNER): ServiceContext {
  return { ...env.ctx(actor, now), mode: "production" };
}

/** Курси моделі → fx_rates (НБУ / вручну). Режим тестів — production (немає демо-рядків) → джерело nbu. */
export async function insertRefRates(db: Db, rates: readonly RefRate[]): Promise<void> {
  for (const r of rates) {
    const units = r.units ?? 1;
    await db
      .insert(fxRates)
      .values({
        source: r.source,
        currency: r.currency,
        quoteCurrency: "UAH",
        effectiveDate: r.date,
        rate: r.rate,
        units,
        ratePerUnit: scaledRateToDecimal(ratePerUnitScaled(r.rate, units)),
        version: r.version ?? 1,
        isCurrent: r.isCurrent ?? true,
        enteredBy: r.source === "manual" ? "test-owner" : null,
        reason: r.source === "manual" ? "test" : null,
      })
      .onConflictDoNothing();
  }
}

const ms = (iso: string) => new Date(iso).getTime();
const known = (knownAt: string | undefined, at: string, asOf: string) => ms(knownAt ?? at) <= ms(asOf);

let counter = 0;

/** Замовлення моделі в базі застосунку (факти додаються поступово). */
export class GoldenOrder {
  orderId = "";
  readonly lineIds = new Map<string, string>();
  readonly variantIds = new Map<string, string>();
  readonly stockItemIds = new Map<string, string>();
  readonly shipmentIds = new Map<string, string>();
  private materialStockItemId = "";
  private readonly inserted = new Set<string>();
  private transactionIds = new Map<string, string>();

  constructor(
    readonly env: GoldenEnv,
    readonly ref: RefOrderFacts,
    readonly opts: {
      partnerCode?: string;
      shipmentTest?: boolean;
      source?: "shopify" | "demo";
    } = {},
  ) {}

  private async productVariant(productId: string): Promise<{ variantId: string; stockItemId: string }> {
    const existing = this.variantIds.get(productId);
    if (existing)
      return {
        variantId: existing,
        stockItemId: this.stockItemIds.get(productId)!,
      };
    counter++;
    const { variantIds } = await insertProduct(this.env.db, `Golden ${productId} ${counter}`, [{ sku: `G-${productId}-${process.pid}-${counter}` }]);
    const variantId = variantIds[0]!;
    const stockItemId = await ensureStockItemForVariant(this.env.db, variantId);
    this.variantIds.set(productId, variantId);
    this.stockItemIds.set(productId, stockItemId);
    return { variantId, stockItemId };
  }

  async create(): Promise<this> {
    const db = this.env.db;
    const o = this.ref;
    counter++;
    const [row] = await db
      .insert(orders)
      .values({
        source: this.opts.source ?? "shopify",
        shopifyOrderId: `gid://shopify/Order/${counter}${process.pid}`,
        orderNumber: `#G${counter}-${process.pid}`,
        status: "paid",
        financialStatus: "paid",
        currency: o.currency,
        subtotal: "0.00",
        total: "0.00",
        placedAt: new Date(o.placedAt),
        shipCountryCode: o.country,
        shopifyTest: o.test ?? false,
      })
      .returning({ id: orders.id });
    this.orderId = row!.id;
    let position = 0;
    for (const l of o.lines) {
      const { variantId } = await this.productVariant(l.productId);
      const [li] = await db
        .insert(orderLineItems)
        .values({
          orderId: this.orderId,
          variantId,
          shopifyLineItemId: `gid://shopify/LineItem/${randomUUID()}`,
          title: l.productId,
          quantity: l.quantity,
          unitPrice: "1.00",
          currency: o.currency,
          position: position++,
          requiresShipping: l.requiresShipping ?? null,
        })
        .returning({ id: orderLineItems.id });
      this.lineIds.set(l.id, li!.id);
    }
    const [mat] = await db
      .insert(packagingMaterials)
      .values({
        code: `GM-${counter}-${process.pid}`,
        name: "Golden box",
        kind: "box",
        unitCost: "10.00",
        costCurrency: "UAH",
      })
      .returning({ id: packagingMaterials.id });
    this.materialStockItemId = await ensureStockItemForMaterial(db, mat!.id);
    const snapshot = emptySnapshot();
    snapshot.status = {
      sales: "complete",
      transactions: "complete",
      fees: "complete",
      refunds: "complete",
    };
    const gateways = [...new Set(o.transactions.map((t) => t.gateway))];
    await db.insert(orderShopifyFinance).values({
      orderId: this.orderId,
      shopCurrency: o.currency,
      presentmentCurrency: o.currency,
      displayFinancialStatus: o.displayFinancialStatus ?? "PAID",
      paymentGatewayNames: gateways,
      discountCodes: this.opts.partnerCode ? [this.opts.partnerCode] : [],
      journeyReady: true,
      snapshot: snapshot as unknown as Record<string, unknown>,
    });
    if (o.feeRule) {
      for (const g of gateways) {
        await db.insert(financeFeeRules).values({
          gateway: g,
          kind: "payment",
          percentBp: o.feeRule.kind === "percent" ? o.feeRule.percentBp : 0,
          fixedAmount: o.feeRule.kind === "percent" && o.feeRule.fixed ? o.feeRule.fixed : null,
          fixedCurrency: o.feeRule.kind === "percent" && o.feeRule.fixed ? o.currency : null,
          noFees: o.feeRule.kind === "no_fees",
          appliesFrom: "2026-01-01",
          createdBy: "test-owner",
        });
      }
    }
    // Ручна собівартість позицій без списання (stdcogs моделі) — рядки stock_item_costs (підтверджені), датовані раніше.
    for (const v of o.valuations.filter((x) => x.kind === "stdcogs")) {
      const line = o.lines.find((l) => l.id === v.lineId)!;
      const { stockItemId } = await this.productVariant(line.productId);
      await db.insert(stockItemCosts).values({
        stockItemId,
        unitCost: fromMinor(toMinor(v.value!) / BigInt(v.quantity)),
        currency: v.currency,
        effectiveFrom: "2026-09-01",
        source: "manual",
        confirmed: true,
        createdBy: "test-owner",
      });
    }
    // Позначки власника (order_finance.overrides) і DDP.
    const overrides: Record<string, unknown> = {};
    const mark = { at: "2026-10-01T00:00:00Z", by: "test-owner" };
    if (o.shippingOwnerMark) overrides[o.shippingOwnerMark] = mark;
    if (o.packagingAccountedInBulk) overrides.packaging_accounted_in_total = mark;
    if (Object.keys(overrides).length > 0) await db.insert(orderFinance).values({ orderId: this.orderId, overrides });
    // «Обліковано загальною сумою» діє, лише коли за місяць визнання є загальна сума упаковки (§2.6): рядок рахунку
    // packaging_unlinked без замовлення (так його проводить WP5) у місяці передачі.
    if (o.packagingAccountedInBulk) {
      const at = businessDate(new Date(o.handedOverAt ?? o.consumeAt ?? o.placedAt));
      const day = `${at.slice(0, 7)}-01`;
      await db.transaction((tx) =>
        postEntries(tx, SYSTEM_ACTOR, [
          {
            idempotencyKey: financeKeys.invoiceLine(randomUUID(), 1),
            category: "packaging_unlinked",
            recognizedOn: day,
            fxOn: day,
            amount: "-50.00",
            currency: "UAH",
            sourceType: "invoice_line",
            sourceId: randomUUID(),
          },
        ]),
      );
    }
    if (o.noWaybillForecast && o.noWaybillForecast.basis === "owner_table" && o.noWaybillForecast.amount) {
      await saveFinanceSettings(this.env.ctx(OWNER), {
        shippingForecast: {
          historyDays: 90,
          minSamples: 3,
          byCountry: [
            {
              country: o.country,
              amount: o.noWaybillForecast.amount,
              currency: o.noWaybillForecast.currency,
            },
          ],
        },
      });
    }
    if (o.partner && o.partner !== "ambiguous" && this.opts.partnerCode) {
      await createPartner(this.env.ctx(OWNER, "2026-09-01T10:00:00Z"), {
        displayName: `Golden partner ${counter}`,
        kind: "blogger",
        rateBp: o.partner.rateBp,
        holdDays: o.partner.holdDays ?? 30,
        codes: [{ source: "discount_code", code: this.opts.partnerCode }],
      });
    }
    return this;
  }

  /** Додає факти, відомі на момент asOf, і синхронізує фінанси замовлення (now = asOf; `sync: false` — лише факти). */
  async advance(asOf: string, opts: { sync?: boolean } = {}): Promise<void> {
    const db = this.env.db;
    const o = this.ref;
    const once = async (key: string, fn: () => Promise<void>) => {
      if (this.inserted.has(key)) return;
      this.inserted.add(key);
      await fn();
    };
    for (const s of o.sales) {
      if (!known(s.knownAt, s.happenedAt, asOf)) continue;
      await once(`sale:${s.id}`, async () => {
        await db.insert(orderSales).values({
          orderId: this.orderId,
          shopifySaleId: `gid://shopify/Sale/${s.id}-${this.orderId}`,
          agreementId: `gid://shopify/Agreement/${s.id}-${this.orderId}`,
          agreementKind: s.agreement,
          happenedAt: new Date(s.happenedAt),
          actionType: s.agreement === "order" ? "ORDER" : s.agreement === "order_edit" ? "ORDER_EDIT" : "RETURN",
          lineType: s.lineType,
          quantity: s.quantity ?? null,
          orderLineItemId: s.lineId ? (this.lineIds.get(s.lineId) ?? null) : null,
          totalAmount: s.totalAmount,
          totalTax: s.taxAmount,
          discountBeforeTax: s.discountAmount ?? null,
          currency: o.currency,
          pTotalAmount: s.totalAmount,
          pTotalTax: s.taxAmount,
          pCurrency: o.currency,
          source: "shopify",
          fetchedAt: new Date(s.knownAt ?? s.happenedAt),
        });
      });
    }
    for (const t of o.transactions) {
      if (!known(t.knownAt, t.processedAt, asOf)) continue;
      await once(`tx:${t.id}`, async () => {
        const [tx] = await db
          .insert(orderTransactions)
          .values({
            orderId: this.orderId,
            shopifyTransactionId: `gid://shopify/OrderTransaction/${t.id}-${this.orderId}`,
            kind: t.kind,
            status: t.status,
            test: t.test ?? false,
            gateway: t.gateway,
            amount: t.amount,
            currency: o.currency,
            processedAt: new Date(t.processedAt),
            fetchedAt: new Date(t.knownAt ?? t.processedAt),
          })
          .returning({ id: orderTransactions.id });
        this.transactionIds.set(t.id, tx!.id);
        for (const f of t.fees ?? []) {
          await db.insert(orderTransactionFees).values({
            transactionId: tx!.id,
            orderId: this.orderId,
            shopifyFeeId: `gid://shopify/TransactionFee/${f.id}-${this.orderId}`,
            type: "card",
            amount: f.amount,
            currency: f.currency,
            fetchedAt: new Date(t.knownAt ?? t.processedAt),
          });
        }
      });
    }
    // Відправлення застосунку (передача) і зовнішній доказ визнання (рух consume_sale без відправлення).
    const handedOver = o.handedOverAt && ms(o.handedOverAt) <= ms(asOf);
    for (const w of o.waybills) {
      if (w.source !== "app") continue;
      await once(`wb:${w.id}`, async () => {
        const [s] = await db
          .insert(shipments)
          .values({
            orderId: this.orderId,
            carrierCode: "test",
            mode: "test",
            status: w.cancelled ? "cancelled" : "created",
            carrierReference: `G-${w.id}-${this.orderId}`,
            waybillNumber: `${w.number}-${counter++}`,
            chargeableWeightGrams: w.chargeableWeightGrams ?? null,
            requestSnapshot: {
              destinationCountry: w.country,
              customs: { incoterm: o.ddp ? "DDP" : "DAP" },
            },
            createdBy: "test-staff",
          })
          .returning({ id: shipments.id });
        this.shipmentIds.set(w.id, s!.id);
        if (w.frozenForecast.basis === "carrier_reported" && w.frozenForecast.amount) {
          await db.insert(shipmentCostEstimates).values({
            shipmentId: s!.id,
            carrierCode: "test",
            amount: w.frozenForecast.amount,
            currency: w.frozenForecast.currency,
            currencyAssumed: true,
            payer: w.payerRecipient ? "Recipient" : "Sender",
            source: "test_carrier",
          });
        }
      });
    }
    if (handedOver) {
      for (const [, id] of this.shipmentIds) {
        await db
          .update(shipments)
          .set({ handedOverAt: new Date(o.handedOverAt!) })
          .where(and(eq(shipments.id, id), isNull(shipments.handedOverAt)));
      }
      if (this.shipmentIds.size === 0) {
        await once("consume-evidence", async () => {
          const line = o.lines[0];
          const stockItemId = line ? this.stockItemIds.get(line.productId)! : this.materialStockItemId;
          await db.insert(inventoryMovements).values({
            warehouseId: this.env.warehouseId,
            stockItemId,
            type: "consume_sale",
            onHandDelta: -(line?.quantity ?? 1),
            idempotencyKey: `golden-consume:${this.orderId}`,
            orderId: this.orderId,
            orderLineItemId: line ? this.lineIds.get(line.id)! : null,
            actorId: "test-staff",
            actorName: "Staff",
            createdAt: new Date(o.handedOverAt!),
          });
        });
      }
      await db.update(orders).set({ status: "delivered" }).where(eq(orders.id, this.orderId));
    } else if (o.cancelledBeforeHandover) {
      await db
        .update(orders)
        .set({ status: "cancelled", cancelledAt: new Date(asOf) })
        .where(eq(orders.id, this.orderId));
    }
    // Оцінки складу (WP2).
    for (const v of o.valuations) {
      if (v.kind === "stdcogs" || v.kind === "completion" || !known(v.knownAt, v.occurredAt, asOf)) continue;
      await once(`val:${v.id}`, async () => {
        const line = v.lineId ? o.lines.find((l) => l.id === v.lineId) : undefined;
        const stockItemId = v.kind === "material" ? this.materialStockItemId : this.stockItemIds.get(line?.productId ?? v.productId ?? "")!;
        const movementType = v.kind === "consume" ? "consume_sale" : v.kind === "material" ? "material_consume" : "receipt_manual";
        await db.insert(inventoryValuations).values({
          eventKey: `mv:${randomUUID()}`,
          movementId: randomUUID(),
          warehouseId: this.env.warehouseId,
          stockItemId,
          currency: v.currency,
          kind: v.kind === "return" ? "inflow" : "outflow",
          qty: v.quantity,
          knownQty: v.quantity - (v.unknownQty ?? 0),
          unknownQty: v.unknownQty ?? 0,
          value: v.value,
          valueSource: v.kind === "return" ? "original_sale" : "pool_average",
          orderId: this.orderId,
          orderLineItemId: v.lineId ? (this.lineIds.get(v.lineId) ?? null) : null,
          occurredOn: businessDate(new Date(v.occurredAt)),
          details: {
            movementType,
            ...(v.kind === "return" ? { kind: "customer_return" } : {}),
          },
        });
      });
    }
    // Рядки рахунків перевізника (WP5): зіставлені з накладною замовлення.
    for (const l of o.invoiceLines) {
      if (!known(l.importedAt, l.importedAt, asOf)) continue;
      await once(`inv:${l.id}`, async () => {
        const [doc] = await db
          .insert(carrierInvoices)
          .values({
            carrierCode: "test",
            documentKind: "invoice",
            posting: true,
            invoiceNumber: `${l.documentId}-${this.orderId.slice(0, 8)}`,
            invoiceNumberNorm: `${l.documentId}-${this.orderId.slice(0, 8)}`.toUpperCase(),
            fileSha256: randomUUID().replace(/-/g, "").padEnd(64, "0").slice(0, 64),
            fileSize: 100,
            fileKind: "csv",
            operationId: randomUUID(),
            importedBy: "test-owner",
            importedAt: new Date(l.importedAt),
          })
          .returning({ id: carrierInvoices.id });
        await db.insert(carrierInvoiceLines).values({
          invoiceId: doc!.id,
          rowNumber: 1,
          waybillRaw: "x",
          waybillNorm: "X",
          lineKind: l.amount.startsWith("-") ? "credit" : "charge",
          chargeType: l.chargeType,
          chargeDate: l.serviceDate,
          amount: l.amount,
          currency: l.currency,
          shipmentId: l.waybillId ? (this.shipmentIds.get(l.waybillId) ?? null) : null,
          orderId: this.orderId,
          matchStatus: "matched",
        });
      });
    }
    // Спори / chargeback (власник).
    for (const d of o.disputes ?? []) {
      if (!known(d.enteredAt, d.enteredAt, asOf)) continue;
      await once(`dispute:${d.id}`, async () => {
        await db.insert(orderDisputes).values({
          orderId: this.orderId,
          disputeGid: `manual:${randomUUID()}`,
          outcome: d.outcome,
          amount: d.disputed,
          recoveredAmount: d.reversed,
          currency: o.currency,
          fee: d.fee?.amount ?? null,
          feeCurrency: d.fee?.currency ?? null,
          decidedOn: d.decidedOn,
          vatReducible: d.vatReduces ?? false,
          fullPartnerCancellation: d.cancelCommission ?? false,
          source: "manual",
        });
      });
    }
    if (opts.sync === false) return;
    await db.transaction((tx) =>
      syncOrderFinanceAt(tx, SYSTEM_ACTOR, this.orderId, {
        now: new Date(asOf),
      }),
    );
  }

  /** Діючі записи замовлення у формі моделі (для порівняння за кортежем). */
  async entries(): Promise<RefEntry[]> {
    const rev = alias(financeEntries, "g_rev");
    const rows = await this.env.db
      .select()
      .from(financeEntries)
      .where(
        and(
          eq(financeEntries.orderId, this.orderId),
          isNull(financeEntries.reversesEntryId),
          notExists(
            this.env.db
              .select({ one: sql`1` })
              .from(rev)
              .where(eq(rev.reversesEntryId, financeEntries.id)),
          ),
        ),
      )
      .orderBy(asc(financeEntries.seq));
    return rows.map((r) => ({
      key: r.idempotencyKey,
      orderId: r.orderId,
      category: r.category as RefEntry["category"],
      amount: r.amount,
      currency: r.currency.trim(),
      recognizedOn: r.recognizedOn,
      fxOn: r.fxOn,
      originalOn: r.originalOn,
      isLate: r.isLate,
      isLateCompletion: r.isLateCompletion,
      reversesKey: null,
      details: r.details as RefEntry["details"],
    }));
  }

  /** Стан фінансів замовлення. */
  async finance() {
    const [row] = await this.env.db.select().from(orderFinance).where(eq(orderFinance.orderId, this.orderId));
    return {
      ...row!,
      componentsParsed: parseOrderComponents(row!.components) ?? {},
    };
  }

  /** Прогнози, що враховуються (складник не фактичний), у формі моделі. */
  async forecasts(): Promise<Array<Pick<RefForecast, "component" | "amount" | "currency" | "basis">>> {
    const f = await this.finance();
    const rows = await this.env.db.select().from(orderFinanceForecasts).where(eq(orderFinanceForecasts.orderId, this.orderId));
    return rows
      .filter((r) => {
        const c = f.componentsParsed[r.component as keyof typeof f.componentsParsed];
        return !c || !isSettled(c.state);
      })
      .map((r) => ({
        component: r.component as RefForecast["component"],
        amount: r.amount,
        currency: r.currency.trim(),
        basis: r.basis,
      }));
  }
}

/** Кортеж порівняння запису (без ключа — ключі моделі ілюстративні). */
export function tupleOf(e: Pick<RefEntry, "category" | "amount" | "currency" | "recognizedOn" | "fxOn">): string {
  return `${e.category}|${e.amount}|${e.currency}|${e.recognizedOn}|${e.fxOn}`;
}

export function tuples(entries: readonly RefEntry[]): string[] {
  return entries.map(tupleOf).sort();
}
