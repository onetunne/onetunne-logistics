/**
 * Етап 6: збереження незмінних знімків звітів (docs/stage6-design.md §13.1). Знімок — лише агрегати (без персональних
 * даних і імен партнерів), `rates_used` (id, джерело, дата, версія, rate_per_unit кожного використаного рядка fx_rates),
 * `data_sha256` — SHA-256 канонічного JSON (ключі за абеткою, без generatedAt верхнього рівня). Повторне формування
 * того самого (вид, початок, валюта) — version + 1 під блокуванням (гонка знімків → унікальні версії, §20.3).
 * Знімки закриття місяця (WP6) і ручні/за розкладом (WP10) зберігаються ЛИШЕ цією функцією.
 */
import { createHash } from "node:crypto";
import { and, eq, max } from "drizzle-orm";
import type { Tx } from "~/db/client.server";
import { financeReportSnapshots } from "~/db/schema";
import { REPORT_KINDS, SNAPSHOT_SOURCES, type ReportKind, type SnapshotSource } from "~/domain/finance";
import type { Actor } from "~/domain/permissions";
import { parseIsoDate } from "~/lib/periods";
import { isSupportedCurrency } from "~/lib/decimal";
import type { RateFound } from "~/modules/fx/rate-for.server";
import { requireFinance } from "./access.server";
import { writeFinanceChange } from "./change-log.server";
import { lockFinanceOperation } from "./locks.server";
import { DEFAULT_STORE_ID } from "./store.server";

/** Канонічний JSON: ключі об'єктів за абеткою; undefined пропускається; верхній generatedAt не входить у хеш. */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown, top: boolean): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x, false));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        if (top && k === "generatedAt") continue;
        const x = (v as Record<string, unknown>)[k];
        if (x === undefined) continue;
        out[k] = walk(x, false);
      }
      return out;
    }
    if (typeof v === "bigint") return v.toString();
    return v;
  };
  return JSON.stringify(walk(value, true));
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Рядок rates_used знімка / експорту. */
export interface RateUsed {
  id: string;
  source: string;
  currency: string;
  effectiveDate: string;
  version: number;
  ratePerUnit: string;
}

export function ratesUsedFrom(found: readonly RateFound[]): RateUsed[] {
  return found
    .filter((r): r is RateFound & { rateId: string; version: number } => r.rateId !== null && r.version !== null)
    .map((r) => ({ id: r.rateId, source: r.source, currency: r.currency, effectiveDate: r.rateDate, version: r.version, ratePerUnit: r.ratePerUnit }))
    .sort((a, b) => a.currency.localeCompare(b.currency) || a.effectiveDate.localeCompare(b.effectiveDate) || a.id.localeCompare(b.id));
}

export interface SaveSnapshotInput {
  kind: ReportKind;
  periodFrom: string;
  periodTo: string;
  reportingCurrency: string;
  source: SnapshotSource;
  isFinal: boolean;
  schemaVersion: number;
  /** Агрегати звіту (buildReportData, WP8) — JSON-серіалізовані. */
  data: unknown;
  ratesUsed: readonly RateUsed[];
  storeId?: string;
}

/** Зберігає знімок (у транзакції викликача). Актор — власник або SYSTEM_ACTOR (finance.manage + роль owner). */
export async function saveReportSnapshot(
  tx: Tx,
  actor: Actor,
  input: SaveSnapshotInput,
): Promise<{ id: string; version: number; dataSha256: string }> {
  requireFinance({ actor }, "manage");
  if (!(REPORT_KINDS as readonly string[]).includes(input.kind)) throw new RangeError("kind");
  if (!(SNAPSHOT_SOURCES as readonly string[]).includes(input.source)) throw new RangeError("source");
  if (!parseIsoDate(input.periodFrom) || !parseIsoDate(input.periodTo) || input.periodFrom > input.periodTo) throw new RangeError("period");
  if (!isSupportedCurrency(input.reportingCurrency)) throw new RangeError("reportingCurrency");
  if (!Number.isSafeInteger(input.schemaVersion) || input.schemaVersion < 1) throw new RangeError("schemaVersion");
  const storeId = input.storeId ?? DEFAULT_STORE_ID;
  // Зберігаються самі дані (разом із generatedAt); хеш — від канонічного JSON без generatedAt.
  const data = JSON.parse(JSON.stringify(input.data, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))) as unknown;
  const dataSha256 = sha256Hex(canonicalJson(data));
  await lockFinanceOperation(tx, `snapshot|${storeId}|${input.kind}|${input.periodFrom}|${input.reportingCurrency}`);
  const [current] = await tx
    .select({ v: max(financeReportSnapshots.version) })
    .from(financeReportSnapshots)
    .where(
      and(
        eq(financeReportSnapshots.storeId, storeId),
        eq(financeReportSnapshots.kind, input.kind),
        eq(financeReportSnapshots.periodFrom, input.periodFrom),
        eq(financeReportSnapshots.reportingCurrency, input.reportingCurrency),
      ),
    );
  const version = Number(current?.v ?? 0) + 1;
  const [row] = await tx
    .insert(financeReportSnapshots)
    .values({
      storeId,
      kind: input.kind,
      periodFrom: input.periodFrom,
      periodTo: input.periodTo,
      reportingCurrency: input.reportingCurrency,
      source: input.source,
      isFinal: input.isFinal,
      schemaVersion: input.schemaVersion,
      data,
      ratesUsed: [...input.ratesUsed],
      dataSha256,
      version,
      generatedBy: actor.id,
    })
    .returning({ id: financeReportSnapshots.id });
  await writeFinanceChange(tx, actor, {
    entityType: "report_snapshot",
    entityId: row!.id,
    action: "create",
    after: {
      kind: input.kind,
      periodFromDate: input.periodFrom,
      periodToDate: input.periodTo,
      reportingCurrency: input.reportingCurrency,
      version,
      isFinal: input.isFinal,
      source: input.source,
      dataSha256,
    },
    storeId,
  });
  return { id: row!.id, version, dataSha256 };
}
