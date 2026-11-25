import { and, eq, inArray, notLike, sql } from "drizzle-orm";
import { z } from "zod";
import type { DbOrTx, Tx } from "~/db/client.server";
import { issues, orderChanges, orderLineItems, orders, productVariants, shipments } from "~/db/schema";
import { assertTransition, type OrderStatus } from "~/domain/order-status";
import { requirePermission, type Actor } from "~/domain/permissions";
import { ConflictError, DomainError, NotFoundError } from "~/lib/errors";
import { writeAudit } from "~/modules/audit/audit.server";
import { getSetting } from "~/modules/settings/settings.server";
import { issueFingerprint, validateOrder, type ValidationOptions } from "~/modules/validation";
import {
  SHIPPING_FIELDS,
  type AddressInput,
  type AutoFix,
  type ShippingField,
  type ValidationResult,
} from "~/modules/validation/types";
import type { ShopifySyncResult } from "~/integrations/shopify/types";
import type { ServiceContext } from "~/server/types";
import {
  SHIPPING_COLUMN,
  loadCountryRules,
  loadLineItems,
  loadOrderRow,
  shippingAddressOf,
  toValidationInput,
  type OrderRow,
} from "./repository.server";

/** Статуси, у яких на етапі 1 дозволено перевірку та редагування даних (до створення накладної). */
export const VALIDATABLE_STATUSES: readonly OrderStatus[] = ["paid", "awaiting_review", "needs_correction"];

/**
 * after_edit — ручна зміна даних САМЕ цього замовлення (закриває відмову перевізника);
 * variant_edit — повторна перевірка після зміни даних товару (відмову перевізника не закриває).
 */
export type ValidationTrigger = "manual" | "bulk" | "after_edit" | "variant_edit" | "automation" | "seed";

export interface ValidationSummary {
  orderId: string;
  status: OrderStatus;
  autoFixes: AutoFix[];
  issueCount: number;
  errorCount: number;
  blocking: boolean;
}

function columnForField(field: string): keyof OrderRow | null {
  if (field === "email") return "email";
  if (field === "contactPhone") return "contactPhone";
  if (field.startsWith("shipping.")) {
    const key = field.slice("shipping.".length) as ShippingField;
    return (SHIPPING_FIELDS as readonly string[]).includes(key) ? SHIPPING_COLUMN[key] : null;
  }
  return null;
}

/**
 * Поки накладна створюється, має невідомий результат або вже створена, дані замовлення змінювати не можна:
 * накладна містила б інші дані, ніж замовлення.
 */
async function assertNoPendingShipment(tx: DbOrTx, order: OrderRow): Promise<void> {
  const [active] = await tx
    .select({ status: shipments.status })
    .from(shipments)
    .where(and(eq(shipments.orderId, order.id), inArray(shipments.status, ["creating", "created", "unknown"])))
    .limit(1);
  if (!active) return;
  if (active.status === "creating") throw new DomainError("waybill.inProgress", 409);
  if (active.status === "unknown") throw new DomainError("waybill.resolveFirst", 409);
  throw new DomainError("order.notEditable", 409, { status: order.status });
}

/** Параметри перевірки з налаштувань: країна відправлення для тлумачення місцевих телефонів. */
export async function validationOptions(db: DbOrTx): Promise<ValidationOptions> {
  const shipper = await getSetting(db, "shipper");
  return { originCountry: shipper.countryCode || null };
}

async function bumpOrder(tx: DbOrTx, order: OrderRow, patch: Partial<typeof orders.$inferInsert>, now: Date) {
  const updated = await tx
    .update(orders)
    .set({ ...patch, version: order.version + 1, updatedAt: now })
    .where(and(eq(orders.id, order.id), eq(orders.version, order.version)))
    .returning();
  if (updated.length === 0) throw new ConflictError();
  return updated[0]!;
}

/**
 * Перевіряє замовлення в межах транзакції з блокуванням рядка:
 * зберігає однозначні автовиправлення з історією, синхронізує розділ «Проблеми»
 * (без дублікатів) і встановлює статус.
 */
export async function validateOrderInTx(
  tx: Tx,
  ctx: Pick<ServiceContext, "actor" | "now">,
  orderId: string,
  trigger: ValidationTrigger,
): Promise<ValidationSummary> {
  const now = ctx.now();
  let order = await loadOrderRow(tx, orderId, { forUpdate: true });
  if (!VALIDATABLE_STATUSES.includes(order.status)) {
    throw new DomainError("order.notValidatable", 409, { status: order.status });
  }
  await assertNoPendingShipment(tx, order);
  const items = await loadLineItems(tx, orderId);
  const rules = await loadCountryRules(tx);
  const result: ValidationResult = validateOrder(toValidationInput({ order, items }), rules, await validationOptions(tx));

  // 1) Однозначні автовиправлення → поля замовлення + історія.
  const patch: Record<string, string | null> = {};
  const appliedFixes: AutoFix[] = [];
  for (const fix of result.autoFixes) {
    const column = columnForField(fix.field);
    if (!column) continue; // валідатор не змінює дані товарів — захисна перевірка
    patch[column as string] = fix.to === "" ? null : fix.to;
    appliedFixes.push(fix);
  }
  if (appliedFixes.length > 0) {
    await tx.insert(orderChanges).values(
      appliedFixes.map((fix) => ({
        orderId,
        field: fix.field,
        oldValue: fix.from,
        newValue: fix.to,
        source: "auto_fix" as const,
        ruleId: fix.ruleId,
        reason: `autofix.${fix.ruleId}`,
        actorId: ctx.actor.id,
      })),
    );
  }

  // 2) Синхронізація проблем: нові — додати, наявні — оновити, зниклі — закрити.
  const existing = await tx
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.orderId, orderId),
        eq(issues.status, "open"),
        notLike(issues.code, "CARRIER_%"),
        notLike(issues.code, "SHOPIFY_%"),
      ),
    );
  const nextByFingerprint = new Map(result.issues.map((i) => [issueFingerprint(orderId, i), i]));
  // Відхилені менеджером попередження не повертаються при кожній повторній перевірці.
  const dismissed = await tx
    .select({ fingerprint: issues.fingerprint })
    .from(issues)
    .where(and(eq(issues.orderId, orderId), eq(issues.status, "dismissed"), eq(issues.severity, "warning")));
  for (const d of dismissed) {
    if (nextByFingerprint.get(d.fingerprint)?.severity === "warning") nextByFingerprint.delete(d.fingerprint);
  }
  for (const row of existing) {
    const next = nextByFingerprint.get(row.fingerprint);
    if (!next) {
      await tx
        .update(issues)
        .set({ status: "resolved", resolvedAt: now, resolvedBy: ctx.actor.id, resolution: "revalidated", updatedAt: now })
        .where(eq(issues.id, row.id));
    } else {
      await tx
        .update(issues)
        .set({ severity: next.severity, params: next.params, suggestion: next.suggestion, updatedAt: now })
        .where(eq(issues.id, row.id));
      nextByFingerprint.delete(row.fingerprint);
    }
  }
  if (nextByFingerprint.size > 0) {
    await tx.insert(issues).values(
      [...nextByFingerprint.entries()].map(([fingerprint, i]) => ({
        orderId,
        code: i.code,
        severity: i.severity,
        field: i.field,
        params: i.params,
        suggestion: i.suggestion,
        fingerprint,
      })),
    );
  }

  // Ручне виправлення даних вважаємо відповіддю на відмову перевізника.
  if (trigger === "after_edit") {
    await tx
      .update(issues)
      .set({ status: "resolved", resolvedAt: now, resolvedBy: ctx.actor.id, resolution: "data_corrected", updatedAt: now })
      .where(and(eq(issues.orderId, orderId), eq(issues.status, "open"), eq(issues.code, "CARRIER_REJECTED")));
  }

  // 3) Статус. Відкрита відмова перевізника також блокує (повтор з тими самими даними не має сенсу).
  const [openRejection] = await tx
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.orderId, orderId), eq(issues.status, "open"), eq(issues.code, "CARRIER_REJECTED")))
    .limit(1);
  const blocking = result.blocking || Boolean(openRejection);
  const nextStatus: OrderStatus = blocking ? "needs_correction" : "awaiting_review";
  assertTransition(order.status, nextStatus);
  order = await bumpOrder(tx, order, { ...patch, status: nextStatus, lastValidatedAt: now }, now);

  const errorCount = result.issues.filter((i) => i.severity === "error").length;
  await writeAudit(tx, ctx.actor, "order.validated", { type: "order", id: orderId }, {
    trigger,
    autoFixes: appliedFixes.map((f) => f.ruleId),
    issues: result.issues.map((i) => i.code),
    status: nextStatus,
  });

  return {
    orderId,
    status: nextStatus,
    autoFixes: appliedFixes,
    issueCount: result.issues.length,
    errorCount,
    blocking,
  };
}

export async function validateOrderById(
  ctx: ServiceContext,
  orderId: string,
  trigger: ValidationTrigger = "manual",
): Promise<ValidationSummary> {
  requirePermission(ctx.actor, "orders.edit");
  return ctx.db.transaction((tx) => validateOrderInTx(tx, ctx, orderId, trigger));
}

export interface BulkResult<T> {
  ok: T[];
  failed: { orderId: string; error: string }[];
}

/** Масова перевірка: послідовно, кожне замовлення у власній транзакції. */
export async function validateOrders(ctx: ServiceContext, orderIds: string[]): Promise<BulkResult<ValidationSummary>> {
  requirePermission(ctx.actor, "orders.bulk");
  const out: BulkResult<ValidationSummary> = { ok: [], failed: [] };
  for (const id of [...new Set(orderIds)].slice(0, 200)) {
    try {
      out.ok.push(await ctx.db.transaction((tx) => validateOrderInTx(tx, ctx, id, "bulk")));
    } catch (e) {
      out.failed.push({ orderId: id, error: e instanceof DomainError ? e.code : "error.generic" });
    }
  }
  return out;
}

export async function listOrderIdsByStatus(db: DbOrTx, statuses: OrderStatus[]): Promise<string[]> {
  const rows = await db.select({ id: orders.id }).from(orders).where(inArray(orders.status, statuses));
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Ручне виправлення даних
// ---------------------------------------------------------------------------

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((v) => v.trim().replace(/\s+/g, " "))
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();

export const orderDataPatchSchema = z.object({
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().max(300).optional(),
  email: optionalText(160),
  contactPhone: optionalText(40),
  shipping: z
    .object({
      firstName: optionalText(80),
      lastName: optionalText(80),
      company: optionalText(120),
      address1: optionalText(200),
      address2: optionalText(200),
      city: optionalText(120),
      province: optionalText(120),
      postalCode: optionalText(20),
      countryCode: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^([A-Z]{2})?$/)
        .transform((v) => (v === "" ? null : v))
        .nullable()
        .optional(),
      phone: optionalText(40),
    })
    .partial()
    .default({}),
});

export type OrderDataPatch = z.input<typeof orderDataPatchSchema>;

export interface UpdateOrderResult {
  changedFields: string[];
  sync: ShopifySyncResult | null;
  validation: ValidationSummary | null;
}

/**
 * Ручне виправлення контактів/адреси: оптимістичне блокування за версією,
 * історія (початкове → нове значення, причина), повторна перевірка, синхронізація з Shopify.
 */
export async function updateOrderData(ctx: ServiceContext, orderId: string, input: OrderDataPatch): Promise<UpdateOrderResult> {
  requirePermission(ctx.actor, "orders.edit");
  const patch = orderDataPatchSchema.parse(input);
  const now = ctx.now();

  const { changedFields, order, validation } = await ctx.db.transaction(async (tx) => {
    const current = await loadOrderRow(tx, orderId, { forUpdate: true });
    if (current.version !== patch.expectedVersion) throw new ConflictError();
    if (!VALIDATABLE_STATUSES.includes(current.status)) {
      throw new DomainError("order.notEditable", 409, { status: current.status });
    }
    await assertNoPendingShipment(tx, current);
    const updates: Record<string, string | null> = {};
    const changes: { field: string; oldValue: string | null; newValue: string | null }[] = [];
    const consider = (field: string, column: keyof OrderRow, next: string | null | undefined) => {
      if (next === undefined) return;
      const prev = (current[column] as string | null) ?? null;
      if (prev === next) return;
      updates[column as string] = next;
      changes.push({ field, oldValue: prev, newValue: next });
    };
    consider("email", "email", patch.email);
    consider("contactPhone", "contactPhone", patch.contactPhone);
    for (const f of SHIPPING_FIELDS) consider(`shipping.${f}`, SHIPPING_COLUMN[f], patch.shipping[f]);

    if (changes.length === 0) return { changedFields: [] as string[], order: current, validation: null };

    await tx.insert(orderChanges).values(
      changes.map((c) => ({
        orderId,
        field: c.field,
        oldValue: c.oldValue,
        newValue: c.newValue,
        source: "manual" as const,
        reason: patch.reason || null,
        actorId: ctx.actor.id,
      })),
    );
    await bumpOrder(tx, current, updates, now);
    await writeAudit(tx, ctx.actor, "order.data_corrected", { type: "order", id: orderId }, {
      fields: changes.map((c) => c.field),
    });
    const validation = await validateOrderInTx(tx, ctx, orderId, "after_edit");
    const order = await loadOrderRow(tx, orderId);
    return { changedFields: changes.map((c) => c.field), order, validation };
  });

  const sync = changedFields.length > 0 ? await syncOrderToShopify(ctx, order, changedFields) : null;
  return { changedFields, sync, validation };
}

/** Передає підтверджені зміни в Shopify (у демо — пропускається, запит не надсилається). */
async function syncOrderToShopify(ctx: ServiceContext, order: OrderRow, changedFields: string[]): Promise<ShopifySyncResult> {
  let result: ShopifySyncResult = { status: "skipped", reason: "not_linked" };
  try {
    if (changedFields.some((f) => f.startsWith("shipping."))) {
      result = await ctx.shopify.updateOrderShippingAddress(order.shopifyOrderId, shippingAddressOf(order));
    }
    if (changedFields.includes("email") || changedFields.includes("contactPhone")) {
      const r = await ctx.shopify.updateOrderContact(order.shopifyOrderId, { email: order.email, phone: order.contactPhone });
      if (result.status !== "failed") result = r;
    }
  } catch {
    result = { status: "failed", error: "shopify.syncFailed" };
  }
  await writeAudit(ctx.db, ctx.actor, "order.shopify_sync", { type: "order", id: order.id }, {
    status: result.status,
    ...(result.status === "skipped" ? { reason: result.reason } : {}),
  });
  return result;
}

// ---------------------------------------------------------------------------
// Пропозиції та проблеми
// ---------------------------------------------------------------------------

/** Підтвердження менеджером одного з запропонованих варіантів виправлення. */
export async function acceptSuggestion(ctx: ServiceContext, issueId: string, candidate: string): Promise<ValidationSummary> {
  requirePermission(ctx.actor, "orders.edit");
  const { summary, field } = await ctx.db.transaction(async (tx) => {
    const [issue] = await tx.select().from(issues).where(eq(issues.id, issueId)).for("update");
    if (!issue || !issue.orderId) throw new NotFoundError("issue");
    if (issue.status !== "open" || !issue.suggestion) throw new DomainError("issue.notActionable", 409);
    if (!issue.suggestion.candidates.includes(candidate)) throw new DomainError("issue.invalidCandidate", 400);
    const column = columnForField(issue.suggestion.field);
    if (!column) throw new DomainError("issue.notActionable", 409);

    const order = await loadOrderRow(tx, issue.orderId, { forUpdate: true });
    if (!VALIDATABLE_STATUSES.includes(order.status)) throw new DomainError("order.notEditable", 409, { status: order.status });
    await assertNoPendingShipment(tx, order);
    await tx.insert(orderChanges).values({
      orderId: order.id,
      field: issue.suggestion.field,
      oldValue: (order[column] as string | null) ?? null,
      newValue: candidate,
      source: "suggestion_accepted",
      reason: `issue.${issue.code}.title`,
      actorId: ctx.actor.id,
    });
    await bumpOrder(tx, order, { [column]: candidate }, ctx.now());
    await tx
      .update(issues)
      .set({ status: "resolved", resolvedAt: ctx.now(), resolvedBy: ctx.actor.id, resolution: "suggestion_accepted" })
      .where(eq(issues.id, issue.id));
    await writeAudit(tx, ctx.actor, "issue.suggestion_accepted", { type: "issue", id: issue.id }, { code: issue.code });
    return { summary: await validateOrderInTx(tx, ctx, order.id, "after_edit"), field: issue.suggestion.field };
  });
  // Підтверджене виправлення передається в Shopify так само, як ручне (у демо — пропускається).
  await syncOrderToShopify(ctx, await loadOrderRow(ctx.db, summary.orderId), [field]);
  return summary;
}

/** Попередження (warning) можна відхилити; помилки (error) потрібно виправити. */
export async function dismissIssue(ctx: ServiceContext, issueId: string): Promise<void> {
  requirePermission(ctx.actor, "orders.edit");
  await ctx.db.transaction(async (tx) => {
    const [issue] = await tx.select().from(issues).where(eq(issues.id, issueId)).for("update");
    if (!issue) throw new NotFoundError("issue");
    if (issue.status !== "open") return;
    // Помилки даних потрібно виправити. Виняток — відмова перевізника: менеджер може свідомо повторити без змін.
    const carrierRejection = issue.code === "CARRIER_REJECTED";
    if (issue.severity !== "warning" && !carrierRejection) throw new DomainError("issue.cannotDismissError", 409);
    await tx
      .update(issues)
      .set({ status: "dismissed", resolvedAt: ctx.now(), resolvedBy: ctx.actor.id, resolution: "dismissed" })
      .where(eq(issues.id, issue.id));
    await writeAudit(tx, ctx.actor, "issue.dismissed", { type: "issue", id: issue.id }, { code: issue.code });
    if (carrierRejection && issue.orderId) {
      const order = await loadOrderRow(tx, issue.orderId, { forUpdate: true });
      if (VALIDATABLE_STATUSES.includes(order.status)) await validateOrderInTx(tx, ctx, order.id, "manual");
    }
  });
}

// ---------------------------------------------------------------------------
// Автоматизація, скасування, дані товарів (демо)
// ---------------------------------------------------------------------------

export async function setOrderAutomationPaused(ctx: ServiceContext, orderId: string, paused: boolean): Promise<void> {
  requirePermission(ctx.actor, "orders.edit");
  await ctx.db.transaction(async (tx) => {
    const order = await loadOrderRow(tx, orderId, { forUpdate: true });
    if (order.automationPaused === paused) return;
    await bumpOrder(tx, order, { automationPaused: paused }, ctx.now());
    await writeAudit(tx, ctx.actor, paused ? "order.automation_paused" : "order.automation_resumed", {
      type: "order",
      id: orderId,
    });
  });
}

export type AutomationDecision =
  | { run: true; mode: "semi" | "auto" }
  | { run: false; reason: "manual_mode" | "global_pause" | "order_paused" };

export async function automationDecision(db: DbOrTx, order: Pick<OrderRow, "automationPaused">): Promise<AutomationDecision> {
  const automation = await getSetting(db, "automation");
  if (automation.globalPause) return { run: false, reason: "global_pause" };
  if (order.automationPaused) return { run: false, reason: "order_paused" };
  if (automation.mode === "manual") return { run: false, reason: "manual_mode" };
  return { run: true, mode: automation.mode };
}

export const variantCustomsSchema = z.object({
  weightGrams: z.coerce.number().int().min(1).max(30000).nullable(),
  hsCode: z
    .string()
    .trim()
    .max(20)
    .transform((v) => (v === "" ? null : v))
    .nullable(),
  countryOfOrigin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^([A-Z]{2})?$/)
    .transform((v) => (v === "" ? null : v))
    .nullable(),
  customsDescription: z
    .string()
    .trim()
    .max(200)
    .transform((v) => (v === "" ? null : v))
    .nullable(),
});

/**
 * Демо: редагування митних даних товару (імітує зміну в Shopify).
 * У робочій версії характеристики товарів редагуються в Shopify і синхронізуються (етап 2).
 */
export async function updateVariantCustomsData(
  ctx: ServiceContext,
  variantId: string,
  input: z.input<typeof variantCustomsSchema>,
): Promise<{ revalidated: number }> {
  requirePermission(ctx.actor, "orders.edit");
  if (ctx.mode !== "demo") throw new DomainError("product.editInShopify", 409);
  const data = variantCustomsSchema.parse(input);
  const affected = await ctx.db.transaction(async (tx) => {
    const [variant] = await tx.select().from(productVariants).where(eq(productVariants.id, variantId)).for("update");
    if (!variant) throw new NotFoundError("variant");
    await tx
      .update(productVariants)
      .set({ ...data, updatedAt: ctx.now() })
      .where(eq(productVariants.id, variantId));
    await writeAudit(tx, ctx.actor, "product.customs_updated", { type: "variant", id: variantId }, {
      fields: Object.keys(data),
    });
    const rows = await tx
      .selectDistinct({ id: orders.id })
      .from(orderLineItems)
      .innerJoin(orders, eq(orderLineItems.orderId, orders.id))
      .where(and(eq(orderLineItems.variantId, variantId), inArray(orders.status, [...VALIDATABLE_STATUSES])));
    return rows.map((r) => r.id);
  });
  let revalidated = 0;
  for (const id of affected) {
    try {
      await ctx.db.transaction((tx) => validateOrderInTx(tx, ctx, id, "variant_edit"));
      revalidated++;
    } catch (e) {
      // Замовлення з накладною в процесі/на розгляді не перевіряються повторно.
      if (!(e instanceof DomainError)) throw e;
    }
  }
  return { revalidated };
}

export async function countOrdersWithStatus(db: DbOrTx, status: OrderStatus): Promise<number> {
  const [row] = await db.select({ c: sql<number>`count(*)::int` }).from(orders).where(eq(orders.status, status));
  return Number(row?.c ?? 0);
}

export type { Actor };
