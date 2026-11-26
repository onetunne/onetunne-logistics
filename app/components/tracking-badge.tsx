import type { TrackingStatus } from "~/integrations/carriers/types";
import { useT } from "~/i18n";
import { Badge, type BadgeTone, type TimelineTone } from "~/ui";

/**
 * Статус відстеження посилки (нормалізований TrackingStatus адаптера перевізника).
 * «created» — накладну створено, але посилку ще НЕ передано: не називаємо це відправленням.
 */
export const TRACKING_TONE: Record<TrackingStatus, BadgeTone> = {
  created: "outline",
  accepted: "strong",
  in_transit: "neutral",
  customs: "warning",
  out_for_delivery: "info",
  delivered: "success",
  failed_attempt: "critical",
  returned: "warning",
  lost: "critical",
  exception: "critical",
  cancelled: "warning",
  unknown: "neutral",
};

export const TRACKING_STATUSES = Object.keys(TRACKING_TONE) as TrackingStatus[];

export function isTrackingStatus(value: unknown): value is TrackingStatus {
  return typeof value === "string" && Object.hasOwn(TRACKING_TONE, value);
}

/** Тон події в хронології відстеження. */
export function trackingTimelineTone(status: TrackingStatus): TimelineTone {
  switch (TRACKING_TONE[status]) {
    case "success":
      return "success";
    case "critical":
      return "critical";
    case "warning":
      return "warning";
    default:
      return "default";
  }
}

/** Позначка статусу відстеження; null — перевізника ще не опитували. */
export function TrackingStatusBadge({ status, size }: { status: TrackingStatus | null; size?: "sm" | "md" }) {
  const t = useT();
  if (!status) {
    return (
      <Badge tone="outline" size={size}>
        {t("tracking.status.none")}
      </Badge>
    );
  }
  return (
    <Badge tone={TRACKING_TONE[status]} size={size}>
      {t(`tracking.status.${status}`)}
    </Badge>
  );
}
