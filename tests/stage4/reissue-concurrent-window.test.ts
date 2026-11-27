/**
 * R6F-1: «Переоформити» двома менеджерами одночасно. Програвший читає накладну ще «створеною», а замовлення — уже у
 * вікні після скасування старої накладної переможцем (скасування й «Очікує перевірки» — одна транзакція), але до нової.
 * Це «паралельний запит» (concurrent), а не відмова «Переоформлення доступне лише для статусів…».
 * Вікно відтворено детерміновано: перехоплення loadOrderRow (один раз, перед читанням замовлення програвшим) і
 * керована заглушка перевізника, що тримає створення нової накладної переможця.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { orders, shipments } from "~/db/schema";
import { createCarrierRegistry } from "~/integrations/carriers";
import type { CarrierAdapter, CarrierCapabilities, CreatedShipment, LookupResult } from "~/integrations/carriers/types";
import { validateOrderById } from "~/modules/orders/workflow.server";
import { reissueWaybill, type ReissueResult } from "~/modules/shipments/reissue.server";
import { cancelWaybill, createWaybill } from "~/modules/shipments/waybill.server";
import type { ServiceContext } from "~/server/types";
import { createTestEnv, OWNER, type TestEnv } from "../helpers";

const hook = vi.hoisted(() => ({ beforeLoadOrder: null as null | (() => Promise<void>) }));
vi.mock("~/modules/orders/repository.server", async (importOriginal) => {
  const mod = await importOriginal<typeof import("~/modules/orders/repository.server")>();
  return {
    ...mod,
    loadOrderRow: async (...args: Parameters<typeof mod.loadOrderRow>) => {
      const h = hook.beforeLoadOrder;
      if (h) {
        hook.beforeLoadOrder = null;
        await h();
      }
      return mod.loadOrderRow(...args);
    },
  };
});

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

class GatedCarrier implements CarrierAdapter {
  readonly code = "gate4";
  readonly displayName = "Gated carrier";
  readonly mode = "live" as const;
  capabilities: CarrierCapabilities = {
    rates: false,
    availability: false,
    createShipment: true,
    updateShipment: false,
    cancelShipment: true,
    documents: false,
    tracking: false,
    returns: false,
    findByReference: false,
    referenceLookupAuthoritative: false,
  };
  /** Поки задано — створення чекає на gate (після сигналу started). */
  gate: { started: () => void; release: Promise<void> } | null = null;
  createCalls = 0;
  private n = 0;
  async createShipment(): Promise<CreatedShipment> {
    this.createCalls++;
    this.n++;
    const g = this.gate;
    if (g) {
      this.gate = null;
      g.started();
      await g.release;
    }
    return { carrierShipmentId: `g4-${this.n}`, waybillNumber: `GATE4${String(this.n).padStart(8, "0")}`, trackingNumber: null, createdAt: new Date() };
  }
  async findShipmentByReference(): Promise<LookupResult> {
    return { found: false, authoritative: false };
  }
  async cancelShipment() {
    return { cancelled: true };
  }
}

let env: TestEnv;
let carrier: GatedCarrier;
let ctx: ServiceContext;

beforeAll(async () => {
  env = await createTestEnv();
  carrier = new GatedCarrier();
  ctx = { ...env.ctx(OWNER), carriers: createCarrierRegistry([carrier], carrier.code) };
});
afterAll(async () => {
  hook.beforeLoadOrder = null;
  await env.close();
});

async function withWaybill(number: string) {
  const id = await env.orderId(number);
  await validateOrderById(ctx, id);
  const r = await createWaybill(ctx, id);
  if (r.kind !== "created") throw new Error(`waybill for ${number}: ${r.kind}`);
  return { id, shipment: r.shipment };
}

const orderShipments = (orderId: string) => ctx.db.select().from(shipments).where(eq(shipments.orderId, orderId));
const active = (rows: Array<{ status: string }>) => rows.filter((s) => ["creating", "created", "unknown"].includes(s.status));

describe("reissueWaybill: the loser of a concurrent re-issue gets 'concurrent', not a status refusal (R6F-1)", () => {
  it("shipment read before the winner's cancel, order read while the winner creates the new waybill", async () => {
    const { id, shipment: old } = await withWaybill("#1001");
    const started = deferred();
    const release = deferred();
    carrier.gate = { started: started.resolve, release: release.promise };
    const race: { winner: Promise<ReissueResult> | null } = { winner: null };
    // Перше читання замовлення програвшим (накладну він уже прочитав «створеною»): переможець скасовує стару накладну й
    // починає нову (замовлення — «Очікує перевірки»); програвший читає замовлення саме в цьому вікні.
    hook.beforeLoadOrder = async () => {
      race.winner = reissueWaybill(ctx, old.id);
      await started.promise;
      const [o] = await ctx.db.select({ status: orders.status }).from(orders).where(eq(orders.id, id));
      expect(o?.status).toBe("awaiting_review");
    };
    const loser = await reissueWaybill(ctx, old.id).catch((e: unknown) => e);
    release.resolve();
    expect(race.winner).not.toBeNull();
    const won = await race.winner!;

    expect(loser).toMatchObject({ kind: "concurrent" });
    // Активне відправлення переможця (ще «створюється») — те саме, що він створив.
    expect(won.kind).toBe("reissued");
    const lost = loser as ReissueResult;
    if (won.kind !== "reissued" || lost.kind !== "concurrent") return;
    expect(lost.active?.id).toBe(won.created.id);
    const rows = await orderShipments(id);
    expect(active(rows)).toHaveLength(1);
    expect(rows).toHaveLength(2);
    expect(rows.find((s) => s.id === old.id)?.status).toBe("cancelled");
  });

  it("another manager plainly cancelled the waybill between the two reads → 'concurrent' (nothing created)", async () => {
    const { id, shipment: old } = await withWaybill("#1003");
    const before = carrier.createCalls;
    hook.beforeLoadOrder = async () => {
      await cancelWaybill(ctx, old.id);
    };
    const r = await reissueWaybill(ctx, old.id).catch((e: unknown) => e);
    expect(r).toMatchObject({ kind: "concurrent", active: null });
    expect(carrier.createCalls).toBe(before);
    const rows = await orderShipments(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("cancelled");
  });

  it("a still-created waybill on an order outside the re-issue statuses is still refused by status", async () => {
    const { id, shipment: old } = await withWaybill("#1007");
    await ctx.db.update(orders).set({ status: "needs_correction" }).where(eq(orders.id, id));
    await expect(reissueWaybill(ctx, old.id)).rejects.toMatchObject({ code: "waybill.reissueNotAllowed" });
    expect(await orderShipments(id)).toHaveLength(1);
  });
});
