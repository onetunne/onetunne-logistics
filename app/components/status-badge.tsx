import type { OrderStatus } from "~/domain/order-status";
import { useT } from "~/i18n";
import { Badge } from "~/ui";

type Tone = "neutral" | "strong" | "outline" | "critical" | "warning" | "success" | "info";

const ORDER_TONE: Record<OrderStatus, Tone> = {
  paid: "outline",
  awaiting_review: "info",
  needs_correction: "critical",
  waybill_created: "strong",
  awaiting_picking: "neutral",
  packed: "neutral",
  handed_to_carrier: "strong",
  in_transit: "neutral",
  customs: "warning",
  delivered: "success",
  delivery_problem: "critical",
  returned: "warning",
  cancelled: "outline",
};

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  const t = useT();
  return <Badge tone={ORDER_TONE[status]}>{t(`status.${status}`)}</Badge>;
}

const SHIPMENT_TONE: Record<string, Tone> = {
  creating: "info",
  created: "strong",
  unknown: "critical",
  failed: "outline",
  cancelled: "outline",
};

export function ShipmentStatusBadge({ status }: { status: string }) {
  const t = useT();
  return <Badge tone={SHIPMENT_TONE[status] ?? "neutral"}>{t(`shipmentStatus.${status}`)}</Badge>;
}

export function SeverityBadge({ severity }: { severity: "error" | "warning" }) {
  const t = useT();
  return <Badge tone={severity === "error" ? "critical" : "warning"}>{t(`severity.${severity}`)}</Badge>;
}

/** Позначка тестових даних/операцій. */
export function TestBadge() {
  const t = useT();
  return <Badge tone="outline">{t("common.test")}</Badge>;
}
