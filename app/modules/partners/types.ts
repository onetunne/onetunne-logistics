/**
 * Етап 6, WP7: типи партнерської програми (переліки — app/domain/finance.ts, ядро). Чистий модуль.
 */
import type {
  ATTRIBUTION_SOURCES,
  ATTRIBUTION_STATUSES,
  COMMISSION_EVENT_KINDS,
  PARTNER_CODE_SOURCES,
  PARTNER_KINDS,
  PARTNER_STATUSES,
  PAYOUT_METHODS,
} from "~/domain/finance";

export type PartnerKind = (typeof PARTNER_KINDS)[number];
export type PartnerStatus = (typeof PARTNER_STATUSES)[number];
export type PartnerCodeSource = (typeof PARTNER_CODE_SOURCES)[number];
export type AttributionSource = (typeof ATTRIBUTION_SOURCES)[number];
export type AttributionStatus = (typeof ATTRIBUTION_STATUSES)[number];
export type CommissionEventKind = (typeof COMMISSION_EVENT_KINDS)[number];
export type PayoutMethod = (typeof PAYOUT_METHODS)[number];

/** Сума з валютою (десятковий рядок, 2 знаки). */
export interface Money {
  amount: string;
  currency: string;
}
