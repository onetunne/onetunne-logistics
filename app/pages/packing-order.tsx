import { useEffect, useReducer, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  Form,
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type Params,
} from "react-router";
import { ActionBanner, type ActionResult } from "~/components/action-banner";
import { CarrierDocumentButtons } from "~/components/carrier-documents";
import { useCan, useHref } from "~/components/shell";
import { OrderStatusBadge, TestBadge } from "~/components/status-badge";
import type { OrderPriority } from "~/db/schema";
import { isShipped } from "~/domain/order-status";
import { requirePermission } from "~/domain/permissions";
import { useLocale, useT, type TFunction } from "~/i18n";
import { countryName, formatDateTime, formatWeight } from "~/lib/format";
import { NotFoundError } from "~/lib/errors";
import {
  MANUAL_ADJUST_REASONS,
  MAX_OVERRIDE_REASON_LENGTH,
  MAX_PARCEL_DIMENSION_MM,
  MAX_PARCEL_WEIGHT_GRAMS,
  MAX_SCAN_LENGTH,
  PRIORITIES,
  PRIORITY_KEYS,
  isManualAdjustReason,
  parsePriority,
} from "~/modules/packing/constants";
import {
  adjustPackedLine,
  confirmPacked,
  recordScan,
  savePackingParcel,
  setOrderPriority,
  startPacking,
  unpackOrder,
  type ConfirmPackedResult,
  type ScanResult,
} from "~/modules/packing/packing.server";
import {
  NO_BOX,
  initialParcelForm,
  parcelPrefillMarkers,
  prefillForBox,
  reduceParcelForm,
  resolveParcelForm,
  type ParcelFormAction,
  type ParcelFormEnv,
  type ParcelFormState,
} from "~/modules/packing/parcel-form";
import { loadPackingScreen } from "~/modules/packing/view.server";
import { getRequestContext } from "~/server/context.server";
import { formString, toActionError } from "~/server/http.server";
import {
  Badge,
  Banner,
  Button,
  Card,
  Checkbox,
  ConfirmSubmitButton,
  Disclosure,
  Grid,
  InlineCode,
  KeyValueList,
  Page,
  Select,
  Stack,
  Text,
  TextField,
  Thumbnail,
  type BadgeTone,
  type KeyValueItem,
} from "~/ui";

/**
 * Екран пакування замовлення (picking/:orderId), спершу для телефона:
 * позиції з фото (модель/колір/SKU/кількість) → чекліст через сканування (сканер-клавіатура, ручне введення або
 * камера, якщо браузер підтримує BarcodeDetector) і ручні ± з причиною → коробка (рекомендована / вибір) і
 * параметри посилки (вага/габарити — ручне коригування замовлення) → «Запаковано» (лише з повним комплектом;
 * власник — з причиною) → за потреби «Розпакувати». Розбіжність посилки з накладною — попередження й шлях
 * до «Переоформити» на сторінці замовлення. Дозволи — сервер (packing.perform; пріоритет — orders.edit).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRIORITY_TONE: Record<OrderPriority, BadgeTone> = { 0: "outline", 1: "warning", 2: "critical" };

function orderIdFrom(params: Params): string {
  const id = params.orderId ?? "";
  if (!UUID_RE.test(id)) throw new Response("Not Found", { status: 404 });
  return id.toLowerCase();
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  try {
    requirePermission(ctx.actor, "packing.perform");
  } catch {
    throw new Response("Forbidden", { status: 403 });
  }
  const orderId = orderIdFrom(params);
  const screen = await loadPackingScreen(ctx, orderId).catch((e: unknown) => {
    if (e instanceof NotFoundError) throw new Response("Not Found", { status: 404 });
    throw e;
  });
  return {
    ...screen,
    countryLabel: screen.order.countryCode ? countryName(screen.order.countryCode, ctx.locale) : null,
    isDemo: ctx.mode === "demo",
    /** Підтвердити без повного комплекту — лише власник (перевіряє і сервіс). */
    canOverride: ctx.actor.role === "owner",
  };
}

type PackingActionResult = ActionResult & { feedback?: "scan" | "adjust"; sound?: "ok" | "error" };

const itemName = (l: { title: string; variantTitle: string | null }) => (l.variantTitle ? `${l.title} — ${l.variantTitle}` : l.title);

function scanResult(r: ScanResult): PackingActionResult {
  switch (r.kind) {
    case "matched":
      return {
        ok: true,
        message: "packing.scan.matched",
        params: { item: itemName(r.line), packed: r.line.packed, required: r.line.required },
        extra: r.progress.complete ? ["packing.scan.allDone"] : [],
        tone: "success",
        feedback: "scan",
        sound: "ok",
      };
    case "over_quantity":
      return { ok: false, error: "packing.scan.overQuantity", params: { item: itemName(r.line), required: r.line.required }, feedback: "scan", sound: "error" };
    case "ambiguous":
      return { ok: false, error: "packing.scan.ambiguous", params: { code: r.code }, feedback: "scan", sound: "error" };
    case "wrong_item":
      return { ok: false, error: "packing.scan.wrongItem", params: { item: itemName({ title: r.productTitle, variantTitle: r.variantTitle }), code: r.code }, feedback: "scan", sound: "error" };
    case "unknown_code":
      return { ok: false, error: "packing.scan.unknownCode", params: { code: r.code }, feedback: "scan", sound: "error" };
    case "empty":
      return { ok: false, error: "packing.scan.empty", feedback: "scan", sound: "error" };
  }
}

function confirmResult(r: ConfirmPackedResult): PackingActionResult {
  if (r.kind === "already_packed") return { ok: true, message: "packing.confirm.already", tone: "info" };
  const extra: string[] = [];
  const consumed = r.materials.lines.reduce((s, l) => s + l.consumed, 0);
  if (r.materials.alreadyConsumed) extra.push("packing.confirm.materialsAlready");
  else if (consumed > 0) extra.push("packing.confirm.materialsConsumed");
  if (r.materials.totalShortage > 0) extra.push("packing.confirm.materialsShortage");
  if (r.mismatch) extra.push("packing.confirm.mismatch");
  return {
    ok: true,
    message: r.override ? "packing.confirm.doneOverride" : "packing.confirm.done",
    params: { consumed, shortage: r.materials.totalShortage },
    extra,
    tone: r.materials.totalShortage > 0 || r.mismatch ? "warning" : "success",
  };
}

export async function action({ request, params }: ActionFunctionArgs): Promise<PackingActionResult> {
  const ctx = await getRequestContext(request);
  const orderId = orderIdFrom(params);
  try {
    requirePermission(ctx.actor, "packing.perform");
    const form = await request.formData();
    switch (formString(form, "intent")) {
      case "start": {
        const r = await startPacking(ctx, orderId);
        if (r.kind === "started") return { ok: true, message: "packing.start.started", tone: "success" };
        if (r.kind === "already_packed") return { ok: true, message: "packing.start.alreadyPacked", tone: "info" };
        return { ok: true, message: "packing.start.already", params: { name: r.startedByName ?? "—" }, tone: "info" };
      }
      case "scan":
        return scanResult(await recordScan(ctx, orderId, formString(form, "code").slice(0, 200)));
      case "adjust": {
        const raw = formString(form, "delta");
        const delta = raw === "1" ? 1 : raw === "-1" ? -1 : null;
        const reason = formString(form, "reason");
        const lineId = formString(form, "lineId");
        if (delta === null || !UUID_RE.test(lineId)) return { ok: false, error: "error.validation", feedback: "adjust" };
        if (!isManualAdjustReason(reason)) return { ok: false, error: "packing.error.reasonRequired", feedback: "adjust" };
        const r = await adjustPackedLine(ctx, orderId, lineId, delta, reason);
        if (r.kind === "below_zero") return { ok: false, error: "packing.adjust.belowZero", feedback: "adjust", sound: "error" };
        if (r.kind === "over_quantity") {
          return { ok: false, error: "packing.scan.overQuantity", params: { item: itemName(r.line), required: r.line.required }, feedback: "adjust", sound: "error" };
        }
        return {
          ok: true,
          message: "packing.adjust.done",
          params: { item: itemName(r.line), packed: r.line.packed, required: r.line.required },
          tone: "success",
          feedback: "adjust",
          sound: "ok",
        };
      }
      case "parcel": {
        // Підставлені автоматично значення (габарити коробки, розрахункова вага) не є ручним коригуванням:
        // зберігається лише введене пакувальником (parcel-form.ts).
        const values = resolveParcelForm({
          weightGrams: formString(form, "weightGrams"),
          lengthMm: formString(form, "lengthMm"),
          widthMm: formString(form, "widthMm"),
          heightMm: formString(form, "heightMm"),
          weightPrefill: formString(form, "weightPrefill"),
          dimsPrefill: formString(form, "dimsPrefill"),
        });
        const r = await savePackingParcel(ctx, orderId, {
          expectedVersion: formString(form, "version"),
          boxMaterialId: formString(form, "boxMaterialId"),
          ...values,
        });
        return {
          ok: true,
          message: r.changed.length > 0 ? "packing.parcel.saved" : "packing.parcel.noChanges",
          params: { count: r.changed.length },
          extra: r.mismatch ? ["packing.parcel.mismatch"] : [],
          tone: r.mismatch ? "warning" : r.changed.length > 0 ? "success" : "info",
        };
      }
      case "confirm": {
        const override = form.has("override") ? { override: { reason: formString(form, "overrideReason").slice(0, MAX_OVERRIDE_REASON_LENGTH) } } : {};
        return confirmResult(await confirmPacked(ctx, orderId, Number(formString(form, "version")), override));
      }
      case "unpack": {
        const r = await unpackOrder(ctx, orderId, { resetChecklist: form.has("resetChecklist") });
        if (r.kind === "not_packed") return { ok: true, message: "packing.unpack.notPacked", tone: "info" };
        const needsWaybill = r.status === "awaiting_review";
        return {
          ok: true,
          message: needsWaybill ? "packing.unpack.doneNeedsWaybill" : "packing.unpack.done",
          extra: r.materialsConsumed ? ["packing.unpack.materialsNote"] : [],
          tone: needsWaybill ? "warning" : "success",
        };
      }
      case "priority": {
        const priority = parsePriority(formString(form, "priority"));
        if (priority === null) return { ok: false, error: "packing.error.invalidPriority" };
        const r = await setOrderPriority(ctx, orderId, priority);
        return { ok: true, message: r.changed ? "packing.priority.saved" : "packing.priority.unchanged", tone: r.changed ? "success" : "info" };
      }
      default:
        return { ok: false, error: "error.generic" };
    }
  } catch (e) {
    return toActionError(e);
  }
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

type Data = ReturnType<typeof useLoaderData<typeof loader>>;
type Line = Data["lines"][number];

function useBusy() {
  const navigation = useNavigation();
  const submitting = navigation.state !== "idle" && navigation.formMethod?.toUpperCase() === "POST";
  return (intent: string) => submitting && navigation.formData?.get("intent") === intent;
}

function dimsText(d: readonly number[] | null | undefined): string | null {
  return d && d.length === 3 ? d.join(" × ") : null;
}

function priorityLabel(p: OrderPriority, t: TFunction): string {
  return t(`packing.priority.${PRIORITY_KEYS[p]}`);
}

/** Короткий сигнал (вібрація там, де підтримується) — пакувальник не дивиться на екран під час сканування. */
function signal(kind: "ok" | "error" | undefined) {
  if (!kind || typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  try {
    navigator.vibrate(kind === "error" ? [120, 60, 120] : 40);
  } catch {
    // не підтримується — без сигналу
  }
}

export default function PackingOrderPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const t = useT();
  const locale = useLocale();
  const href = useHref();
  const { order, packing, shipment } = data;
  const open = packing?.status === "in_progress" && order.status === "awaiting_picking";
  const packed = order.status === "packed" && packing?.status === "packed";
  /** Передано перевізнику або скасовано — пакування завершене, лише перегляд. */
  const closed = isShipped(order.status) || order.status === "cancelled";

  return (
    <Page
      title={t("packing.screen.title", { number: order.orderNumber })}
      subtitle={t("packing.screen.subtitle", { date: formatDateTime(order.placedAt, locale) })}
      backHref={href("picking")}
      backLabel={t("packing.screen.back")}
      titleMeta={
        <Stack as="span" direction="horizontal" gap={1} align="center" wrap>
          <OrderStatusBadge status={order.status} />
          {order.priority > 0 ? <Badge tone={PRIORITY_TONE[order.priority]}>{priorityLabel(order.priority, t)}</Badge> : null}
          {data.progress.requiredUnits > 0 ? (
            <Badge tone={data.progress.complete ? "success" : "info"}>
              {t("packing.progress.short", { packed: data.progress.packedUnits, required: data.progress.requiredUnits })}
            </Badge>
          ) : null}
        </Stack>
      }
    >
      <Stack gap={4}>
        <ActionBanner data={actionData} />
        {closed ? (
          <Banner tone="info" action={<Button to={href(`orders/${order.id}`)}>{t("packing.screen.toOrder")}</Button>}>
            {t(order.status === "cancelled" ? "packing.screen.cancelled" : "packing.screen.shipped")}
          </Banner>
        ) : data.packedWithoutWaybill ? (
          <Banner tone="warning" title={t("packing.screen.packedNoWaybill.title")} action={<Button to={href(`orders/${order.id}`)}>{t("packing.screen.toOrder")}</Button>}>
            {t("packing.screen.packedNoWaybill.body")}
          </Banner>
        ) : !shipment?.packable && !packed ? (
          <Banner tone="warning" title={t("packing.screen.noWaybill.title")} action={<Button to={href(`orders/${order.id}`)}>{t("packing.screen.toOrder")}</Button>}>
            {t("packing.screen.noWaybill.body")}
          </Banner>
        ) : null}
        {data.mismatch ? <MismatchBanner data={data} /> : null}
        <Grid columns={{ xs: 1, lg: 2 }} gap={4}>
          <Stack gap={4}>
            <StatusCard data={data} />
            {open ? <ScanCard /> : null}
            <ChecklistCard data={data} open={open} />
          </Stack>
          <Stack gap={4}>
            <MaterialsCard data={data} />
            <ParcelCard data={data} />
            {closed ? null : <ConfirmCard data={data} open={open} packed={packed} />}
          </Stack>
        </Grid>
      </Stack>
    </Page>
  );
}

function StatusCard({ data }: { data: Data }) {
  const t = useT();
  const locale = useLocale();
  const can = useCan();
  const href = useHref();
  const busy = useBusy();
  const { order, packing, shipment } = data;
  const items: KeyValueItem[] = [
    {
      key: "recipient",
      label: t("packing.screen.recipient"),
      value: [order.recipientName, order.city, data.countryLabel].filter(Boolean).join(", ") || "—",
    },
    {
      key: "waybill",
      label: t("packing.screen.waybill"),
      value: shipment?.waybillNumber ? (
        <Stack as="span" direction="horizontal" gap={1} align="center" wrap>
          <InlineCode>{shipment.waybillNumber}</InlineCode>
          <span>{shipment.testMode ? t("demo.testCarrier") : shipment.carrierName}</span>
          {shipment.testMode ? <TestBadge /> : null}
        </Stack>
      ) : (
        "—"
      ),
    },
    {
      key: "started",
      label: t("packing.screen.startedBy"),
      value: packing?.startedByName ? `${packing.startedByName} · ${formatDateTime(packing.startedAt, locale)}` : t("packing.screen.notStarted"),
    },
    ...(packing?.packedByName
      ? [{ key: "packed", label: t("packing.screen.packedBy"), value: `${packing.packedByName} · ${formatDateTime(packing.packedAt, locale)}` }]
      : []),
  ];
  return (
    <Card title={t("packing.screen.statusTitle")}>
      <Stack gap={4}>
        <KeyValueList items={items} />
        {shipment?.labelAvailable ? <CarrierDocumentButtons orderId={order.id} shipmentId={shipment.id} kinds={["label"]} /> : null}
        {shipment && !shipment.labelAvailable && shipment.testMode ? (
          <Text variant="caption" tone="subdued">
            {t("packing.labels.demoNote")}
          </Text>
        ) : null}
        {data.canStart ? (
          <Form method="post">
            <input type="hidden" name="intent" value="start" />
            <Button type="submit" variant="primary" fullWidth loading={busy("start")}>
              {t(packing ? "packing.start.resume" : "packing.start.button")}
            </Button>
          </Form>
        ) : null}
        {can("orders.edit") && order.status !== "cancelled" && !isShipped(order.status) ? (
          <Form method="post">
            <input type="hidden" name="intent" value="priority" />
            <Stack direction="horizontal" gap={2} align="end" wrap>
              <Select
                id="packing-priority"
                name="priority"
                label={t("packing.priority.label")}
                options={PRIORITIES.map((p) => ({ value: String(p), label: priorityLabel(p, t) }))}
                defaultValue={String(order.priority)}
              />
              <Button type="submit" loading={busy("priority")}>
                {t("common.save")}
              </Button>
            </Stack>
          </Form>
        ) : null}
        <Button to={href(`orders/${order.id}`)} variant="plain">
          {t("packing.screen.toOrder")}
        </Button>
      </Stack>
    </Card>
  );
}

// --- Сканування ---------------------------------------------------------------

interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorInstance {
  detect(source: HTMLVideoElement): Promise<DetectedBarcode[]>;
}
interface BarcodeDetectorClass {
  new (options?: { formats?: string[] }): BarcodeDetectorInstance;
  getSupportedFormats?: () => Promise<string[]>;
}

function barcodeDetectorClass(): BarcodeDetectorClass | null {
  if (typeof window === "undefined") return null;
  const ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorClass }).BarcodeDetector;
  return typeof ctor === "function" && typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function" ? ctor : null;
}

function ScanCard() {
  const t = useT();
  const fetcher = useFetcher<typeof action>();
  const inputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  // Черга кодів: апаратний сканер може надіслати наступний код, поки попередній ще обробляється. Кожен код —
  // окремий запит по черзі (новий запит не перериває попередній, коди не склеюються в полі введення).
  const queue = useRef<string[]>([]);
  const inFlight = useRef(false);
  const [pending, setPending] = useState(0);
  const busy = fetcher.state !== "idle";
  const result = fetcher.data?.feedback === "scan" ? fetcher.data : null;

  // Автофокус лише на пристроях із мишею/клавіатурою (на телефоні не відкриваємо клавіатуру без потреби).
  useEffect(() => {
    if (window.matchMedia?.("(pointer: fine)").matches) inputRef.current?.focus();
  }, []);

  const pump = () => {
    if (inFlight.current) return;
    const next = queue.current.shift();
    setPending(queue.current.length);
    if (next === undefined) return;
    inFlight.current = true;
    fetcher.submit({ intent: "scan", code: next }, { method: "post" });
  };

  useEffect(() => {
    if (fetcher.state !== "idle") return;
    inFlight.current = false;
    pump();
    // pump читає лише refs і стабільний fetcher.submit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state]);

  useEffect(() => {
    if (fetcher.data) signal(fetcher.data.sound);
  }, [fetcher.data]);

  const submitCode = (code: string) => {
    if (!code.trim()) return;
    queue.current.push(code);
    pump();
  };

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const input = inputRef.current;
    if (!input) return;
    const code = input.value;
    // Поле очищується одразу — наступний код сканера потрапляє в порожнє поле.
    input.value = "";
    submitCode(code);
  };

  // Деякі сканери завершують код табуляцією замість Enter.
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Tab" && e.currentTarget.value.trim()) {
      e.preventDefault();
      formRef.current?.requestSubmit();
    }
  };

  return (
    <Card title={t("packing.scan.title")} description={t("packing.scan.help")}>
      <Stack gap={3}>
        <form ref={formRef} method="post" onSubmit={onSubmit}>
          <input type="hidden" name="intent" value="scan" />
          <Stack direction="horizontal" gap={2} align="end" wrap>
            <div className="ot-field" style={{ flex: "1 1 12rem", minWidth: 0 }}>
              <label className="ot-field__label" htmlFor="packing-scan-code">
                {t("packing.scan.label")}
              </label>
              <div className="ot-input-wrap">
                <input
                  ref={inputRef}
                  id="packing-scan-code"
                  name="code"
                  className="ot-input"
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="go"
                  maxLength={MAX_SCAN_LENGTH}
                  placeholder={t("packing.scan.placeholder")}
                  onKeyDown={onKeyDown}
                />
              </div>
            </div>
            {/* Кнопка не блокується під час запиту: інакше браузер не надсилає форму за Enter (сканер). */}
            <Button type="submit" variant="primary" aria-busy={busy || undefined}>
              {t("packing.scan.submit")}
            </Button>
          </Stack>
        </form>
        <div aria-live="assertive" aria-atomic="true">
          {result ? <ActionBanner data={result} /> : null}
        </div>
        {pending > 0 ? (
          <Text variant="caption" tone="subdued">
            {t("packing.scan.queued", { count: pending })}
          </Text>
        ) : null}
        <CameraScanner onCode={submitCode} />
      </Stack>
    </Card>
  );
}

/**
 * Камера — лише якщо браузер має BarcodeDetector і доступ до камери (Chrome на Android тощо). У Safari на iOS
 * BarcodeDetector зазвичай вимкнено, у вбудованій адмінці Shopify доступ до камери може бути заборонено —
 * тоді кнопка не показується або з'являється пояснення; сканер і ручне введення працюють завжди.
 */
function CameraScanner({ onCode }: { onCode: (code: string) => void }) {
  const t = useT();
  const [supported, setSupported] = useState<boolean | null>(null);
  const [active, setActive] = useState(false);
  const [error, setError] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;

  useEffect(() => {
    setSupported(barcodeDetectorClass() !== null);
  }, []);

  useEffect(() => {
    if (!active) return;
    const Detector = barcodeDetectorClass();
    if (!Detector) return;
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer: number | undefined;
    let last = { value: "", at: 0 };
    void (async () => {
      try {
        const formats = await Detector.getSupportedFormats?.().catch(() => undefined);
        const detector = new Detector(formats && formats.length > 0 ? { formats } : undefined);
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        if (stopped) return;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        const tick = async () => {
          if (stopped) return;
          try {
            const codes = await detector.detect(video);
            const value = codes[0]?.rawValue?.trim();
            const now = Date.now();
            // Той самий код — не частіше ніж раз на 2 с (щоб одна одиниця не зарахувалася кілька разів).
            if (value && (value !== last.value || now - last.at > 2000)) {
              last = { value, at: now };
              onCodeRef.current(value);
            }
          } catch {
            // кадр не розпізнано — пробуємо наступний
          }
          timer = window.setTimeout(() => void tick(), 300);
        };
        void tick();
      } catch {
        if (!stopped) {
          setError(true);
          setActive(false);
        }
      }
    })();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [active]);

  if (supported === null) return null;
  if (!supported) {
    return (
      <Text variant="caption" tone="subdued">
        {t("packing.camera.unsupported")}
      </Text>
    );
  }
  return (
    <Stack gap={2}>
      <Stack direction="horizontal" gap={2} wrap>
        <Button
          onClick={() => {
            setError(false);
            setActive((v) => !v);
          }}
        >
          {t(active ? "packing.camera.stop" : "packing.camera.start")}
        </Button>
      </Stack>
      {active ? (
        <video
          ref={videoRef}
          muted
          playsInline
          aria-label={t("packing.camera.videoLabel")}
          style={{ width: "100%", maxWidth: "28rem", borderRadius: "8px", background: "#000" }}
        />
      ) : null}
      {error ? (
        <Text variant="caption" tone="critical">
          {t("packing.camera.error")}
        </Text>
      ) : null}
    </Stack>
  );
}

// --- Чекліст ------------------------------------------------------------------

function ChecklistCard({ data, open }: { data: Data; open: boolean }) {
  const t = useT();
  const [reason, setReason] = useState("");
  const { progress } = data;
  return (
    <Card
      title={t("packing.checklist.title")}
      description={t("packing.checklist.summary", { packed: progress.packedUnits, required: progress.requiredUnits, lines: progress.totalLines })}
    >
      <Stack gap={3}>
        {open && data.lines.length > 0 ? (
          <Select
            id="packing-adjust-reason"
            name="reason"
            label={t("packing.adjust.reasonLabel")}
            placeholder={t("packing.adjust.reasonPlaceholder")}
            options={MANUAL_ADJUST_REASONS.map((r) => ({ value: r, label: t(`packing.adjust.reason.${r}`) }))}
            value={reason}
            onChange={(e) => setReason(e.currentTarget.value)}
            helpText={t("packing.adjust.reasonHelp")}
          />
        ) : null}
        {data.lines.length === 0 ? <Text tone="subdued">{t("packing.checklist.empty")}</Text> : null}
        <Stack as="ul" gap={3}>
          {data.lines.map((line) => (
            <ChecklistLine key={line.id} line={line} open={open} reason={reason} />
          ))}
        </Stack>
        {data.staleUnits > 0 ? (
          <Banner tone="warning">{t("packing.checklist.stale", { count: data.staleUnits })}</Banner>
        ) : null}
        {progress.over.length > 0 ? <Banner tone="warning">{t("packing.checklist.over", { count: progress.overUnits })}</Banner> : null}
        {data.otherLines.length > 0 ? (
          <Stack gap={1}>
            <Text variant="body-sm" weight="semibold">
              {t("packing.checklist.otherTitle")}
            </Text>
            {data.otherLines.map((l) => (
              <Text key={l.id} variant="body-sm" tone="subdued">
                {t("packing.checklist.otherLine", { title: l.title, quantity: l.quantity })}
              </Text>
            ))}
          </Stack>
        ) : null}
      </Stack>
    </Card>
  );
}

function ChecklistLine({ line, open, reason }: { line: Line; open: boolean; reason: string }) {
  const t = useT();
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const complete = line.packed === line.required;
  const over = line.packed > line.required;
  const tone: BadgeTone = over ? "critical" : complete ? "success" : line.packed > 0 ? "info" : "outline";
  const error = fetcher.state === "idle" && fetcher.data && !fetcher.data.ok ? fetcher.data : null;

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) signal(fetcher.data.sound);
  }, [fetcher.state, fetcher.data]);

  const traits = [line.model ? t("packing.line.model", { value: line.model }) : null, line.color ? t("packing.line.color", { value: line.color }) : null].filter(Boolean);
  return (
    <Stack as="li" gap={2}>
      <Stack direction="horizontal" gap={3} align="start" wrap={false}>
        <Thumbnail src={line.imageUrl} alt={line.title} size="lg" />
        <Stack gap={1}>
          <Text weight="semibold">{line.title}</Text>
          {line.variantTitle ? <Text variant="body-sm">{line.variantTitle}</Text> : null}
          {traits.length > 0 ? (
            <Text variant="body-sm" tone="subdued">
              {traits.join(" · ")}
            </Text>
          ) : null}
          <Text variant="caption" tone="subdued">
            {[line.sku ? t("packing.line.sku", { value: line.sku }) : null, line.barcode ? t("packing.line.barcode", { value: line.barcode }) : null]
              .filter(Boolean)
              .join(" · ") || t("packing.line.noCodes")}
          </Text>
          <Stack direction="horizontal" gap={2} align="center" wrap>
            <Badge tone={tone}>{t("packing.line.qty", { packed: line.packed, required: line.required })}</Badge>
            {complete ? <Text variant="caption">{t("packing.line.complete")}</Text> : null}
          </Stack>
        </Stack>
      </Stack>
      {open ? (
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="adjust" />
          <input type="hidden" name="lineId" value={line.id} />
          <input type="hidden" name="reason" value={reason} />
          <Stack direction="horizontal" gap={2} align="center" wrap>
            <Button
              type="submit"
              name="delta"
              value="-1"
              size="sm"
              disabled={!reason || busy || line.packed === 0}
              aria-label={t("packing.adjust.minus", { item: line.title })}
            >
              −1
            </Button>
            <Button
              type="submit"
              name="delta"
              value="1"
              size="sm"
              disabled={!reason || busy || line.packed >= line.required}
              aria-label={t("packing.adjust.plus", { item: line.title })}
            >
              +1
            </Button>
            {!reason ? (
              <Text variant="caption" tone="subdued">
                {t("packing.adjust.chooseReason")}
              </Text>
            ) : null}
          </Stack>
          {error ? <ActionBanner data={error} /> : null}
        </fetcher.Form>
      ) : null}
    </Stack>
  );
}

// --- Матеріали, посилка, підтвердження ----------------------------------------

function MaterialsCard({ data }: { data: Data }) {
  const t = useT();
  return (
    <Card title={t("packing.materials.title")} description={t("packing.materials.help")}>
      {data.materials.length === 0 ? (
        <Text tone="subdued">{t("packing.materials.none")}</Text>
      ) : (
        <Stack as="ul" gap={2}>
          {data.materials.map((m) => (
            <Stack as="li" key={m.materialId} direction="horizontal" gap={2} align="center" justify="between" wrap>
              <Stack gap={0}>
                <Text variant="body-sm" weight="semibold">
                  {m.name}
                </Text>
                <Text variant="caption" tone="subdued">
                  {m.isBox ? t("packing.materials.box") : t("packing.materials.kit")} · {m.code}
                </Text>
              </Stack>
              <Stack as="span" direction="horizontal" gap={1} align="center">
                <Badge tone="strong">{t("packing.materials.qty", { quantity: m.required })}</Badge>
                {m.onHand < m.required && !data.materialsConsumed ? (
                  <Badge tone="warning" size="sm">
                    {t("packing.materials.short", { onHand: m.onHand })}
                  </Badge>
                ) : null}
              </Stack>
            </Stack>
          ))}
        </Stack>
      )}
      {data.materialsConsumed ? (
        <Text variant="caption" tone="subdued">
          {t("packing.materials.consumedNote")}
        </Text>
      ) : null}
    </Card>
  );
}

function ParcelCard({ data }: { data: Data }) {
  const t = useT();
  const locale = useLocale();
  const { packing, parcel, waybillParcel } = data;
  // Після «Розпакувати» без накладної («Очікує перевірки») посилку можна задати до створення нової накладної.
  const editable = Boolean(packing) && ["awaiting_review", "waybill_created", "awaiting_picking", "packed"].includes(data.order.status);
  // Після збереження (інші збережені значення / коробка) форма з'являється заново з новими значеннями;
  // сканування (нова версія пакування) форму не скидає — введене, але ще не збережене, лишається.
  const formKey = [packing?.id ?? "", packing?.boxMaterialId ?? "", parcel.savedWeightGrams, parcel.savedDimsMm?.join("x") ?? "", parcel.saved].join("|");
  return (
    <Card title={t("packing.parcel.title")} description={t("packing.parcel.help")}>
      <Stack gap={3}>
        {waybillParcel && (waybillParcel.weightGrams || waybillParcel.dimsMm) ? (
          <Text variant="body-sm" tone="subdued">
            {t("packing.parcel.waybillValues", {
              weight: formatWeight(waybillParcel.weightGrams, locale),
              dims: dimsText(waybillParcel.dimsMm) ?? "—",
            })}
          </Text>
        ) : null}
        {!editable ? (
          isShipped(data.order.status) || data.order.status === "cancelled" ? null : (
            <Text tone="subdued">{t("packing.parcel.startFirst")}</Text>
          )
        ) : (
          <ParcelForm key={formKey} data={data} />
        )}
      </Stack>
    </Card>
  );
}

/**
 * Форма посилки: вага й габарити підставляються з вибраної коробки (габарити) і розрахунку (товари + тара);
 * зміна коробки оновлює поля, яких пакувальник не змінював. Підставлене не зберігається як ручне коригування —
 * сервер отримує підказки (weightPrefill/dimsPrefill) і зберігає лише введене (parcel-form.ts).
 */
function ParcelForm({ data }: { data: Data }) {
  const t = useT();
  const locale = useLocale();
  const busy = useBusy();
  const actionData = useActionData<typeof action>();
  const fieldErrors = actionData && !actionData.ok ? actionData.fieldErrors : undefined;
  const err = (name: string) => (fieldErrors?.[name] ? t(fieldErrors[name]!) : null);
  const { packing, parcel, suggestion } = data;
  const boxLocked = packing?.status === "packed";
  const env: ParcelFormEnv = { boxes: data.boxes, goodsWeightGrams: parcel.goodsWeightGrams, defaultTareGrams: parcel.defaultTareGrams };
  const [state, dispatch] = useReducer(
    (s: ParcelFormState, a: ParcelFormAction) => reduceParcelForm(env, s, a),
    null,
    () => initialParcelForm(env, { boxId: packing?.boxMaterialId ?? null, weightGrams: parcel.savedWeightGrams, dimsMm: parcel.savedDimsMm }),
  );
  const markers = parcelPrefillMarkers(env, state);
  const prefill = prefillForBox(env, state.boxId);
  const options = [
    { value: NO_BOX, label: t("packing.parcel.noBox") },
    ...data.boxes.map((b) => ({
      value: b.id,
      label: [
        b.id === suggestion.boxId ? `★ ${b.name}` : b.name,
        dimsText(b.innerDimsMm) ? `${dimsText(b.innerDimsMm)} ${t("packing.unit.mm")}` : null,
        t("packing.parcel.boxStock", { onHand: b.onHand }),
        b.active ? null : t("packing.parcel.boxInactive"),
      ]
        .filter(Boolean)
        .join(" · "),
    })),
  ];
  const suggestionText = suggestion.boxId
    ? t("packing.parcel.suggested", { name: suggestion.name ?? "", reason: t(`packing.parcel.reason.${suggestion.reason}`) })
    : t("packing.parcel.noSuggestion", { reason: t(`packing.parcel.reason.${suggestion.reason}`) });
  const savedWeightShown = parcel.savedWeightGrams !== null && state.weight.trim() === String(parcel.savedWeightGrams);
  const weightHelp = !state.weightManual
    ? prefill.weightGrams
      ? t("packing.parcel.estimateHint", { weight: formatWeight(prefill.weightGrams, locale) })
      : t("packing.parcel.weighHint")
    : savedWeightShown
      ? t("packing.parcel.savedHint")
      : prefill.weightGrams
        ? t("packing.parcel.manualEstimateHint", { weight: formatWeight(prefill.weightGrams, locale) })
        : t("packing.parcel.manualHint");
  return (
    <Form method="post">
      <input type="hidden" name="intent" value="parcel" />
      <input type="hidden" name="version" value={packing?.version ?? 0} />
      <input type="hidden" name="weightPrefill" value={markers.weightPrefill} />
      <input type="hidden" name="dimsPrefill" value={markers.dimsPrefill} />
      {boxLocked ? <input type="hidden" name="boxMaterialId" value={packing?.boxMaterialId ?? NO_BOX} /> : null}
      <Stack gap={3}>
        <Select
          id="packing-box"
          name={boxLocked ? "boxMaterialIdLocked" : "boxMaterialId"}
          label={t("packing.parcel.box")}
          options={options}
          value={state.boxId}
          onChange={(e) => dispatch({ type: "box", boxId: e.currentTarget.value })}
          disabled={boxLocked}
          helpText={boxLocked ? t("packing.parcel.boxLocked") : suggestionText}
          error={err("boxMaterialId")}
        />
        <Stack gap={1}>
          <TextField
            id="packing-weight"
            name="weightGrams"
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_PARCEL_WEIGHT_GRAMS}
            step={1}
            label={t("packing.parcel.weight")}
            suffix={t("packing.unit.g")}
            value={state.weight}
            onChange={(e) => dispatch({ type: "weight", value: e.currentTarget.value })}
            helpText={weightHelp}
            error={err("weightGrams")}
          />
          {state.weightManual && prefill.weightGrams ? (
            <div>
              <Button variant="plain" size="sm" onClick={() => dispatch({ type: "useEstimate" })}>
                {t("packing.parcel.useEstimate")}
              </Button>
            </div>
          ) : null}
        </Stack>
        <Grid columns={{ xs: 3 }} gap={2}>
          {(["lengthMm", "widthMm", "heightMm"] as const).map((name, index) => (
            <TextField
              key={name}
              id={`packing-${name}`}
              name={name}
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_PARCEL_DIMENSION_MM}
              step={1}
              label={t(`packing.parcel.${name}`)}
              suffix={t("packing.unit.mm")}
              value={state.dims[index]}
              onChange={(e) => dispatch({ type: "dim", index: index as 0 | 1 | 2, value: e.currentTarget.value })}
              error={err(name)}
            />
          ))}
        </Grid>
        {state.dimsManual ? (
          <Stack direction="horizontal" gap={2} align="center" wrap>
            <Text variant="caption" tone="subdued">
              {t("packing.parcel.dimsManual")}
            </Text>
            {prefill.dimsMm ? (
              <Button variant="plain" size="sm" onClick={() => dispatch({ type: "useBoxDims" })}>
                {t("packing.parcel.useBoxDims")}
              </Button>
            ) : null}
          </Stack>
        ) : prefill.dimsMm ? (
          <Text variant="caption" tone="subdued">
            {t("packing.parcel.dimsFromBox")}
          </Text>
        ) : null}
        <Text variant="caption" tone="subdued">
          {t("packing.parcel.usageNote")}
        </Text>
        <Button type="submit" loading={busy("parcel")}>
          {t("packing.parcel.save")}
        </Button>
      </Stack>
    </Form>
  );
}

function MismatchBanner({ data }: { data: Data }) {
  const t = useT();
  const locale = useLocale();
  const can = useCan();
  const href = useHref();
  const m = data.mismatch!;
  const canReissue = can("waybills.manage") && can("waybills.create");
  const packed = data.order.status === "packed";
  return (
    <Banner
      tone="warning"
      title={t("packing.mismatch.title")}
      action={canReissue ? <Button to={href(`orders/${data.order.id}`)}>{t("packing.mismatch.toReissue")}</Button> : undefined}
    >
      {m.weight ? (
        <p>{t("packing.mismatch.weight", { waybill: formatWeight(m.weight.waybillGrams, locale), packed: formatWeight(m.weight.packedGrams, locale) })}</p>
      ) : null}
      {m.dims ? <p>{t("packing.mismatch.dims", { waybill: dimsText(m.dims.waybillMm) ?? "—", packed: dimsText(m.dims.packedMm) ?? "—" })}</p> : null}
      <p>{t(packed ? "packing.mismatch.packedHint" : "packing.mismatch.hint")}</p>
      {!canReissue ? <p>{t("packing.mismatch.askManager")}</p> : null}
    </Banner>
  );
}

function ConfirmCard({ data, open, packed }: { data: Data; open: boolean; packed: boolean }) {
  const t = useT();
  const locale = useLocale();
  const busy = useBusy();
  const { progress, packing } = data;
  if (packed && packing) {
    return (
      <Card title={t("packing.confirm.title")}>
        <Stack gap={3}>
          <Banner tone="success">{t("packing.confirm.packedBy", { name: packing.packedByName ?? "—", time: formatDateTime(packing.packedAt, locale) })}</Banner>
          <Form method="post">
            <input type="hidden" name="intent" value="unpack" />
            <Stack gap={3}>
              <Checkbox id="packing-reset-checklist" name="resetChecklist" label={t("packing.unpack.reset")} />
              <ConfirmSubmitButton
                loading={busy("unpack")}
                title={t("packing.unpack.title")}
                confirmLabel={t("packing.unpack.confirm")}
                cancelLabel={t("common.cancel")}
                message={
                  <Stack gap={2}>
                    <Text>{t("packing.unpack.body")}</Text>
                    <Text weight="semibold">{t("packing.unpack.materials")}</Text>
                  </Stack>
                }
              >
                {t("packing.unpack.button")}
              </ConfirmSubmitButton>
            </Stack>
          </Form>
        </Stack>
      </Card>
    );
  }
  if (!open || !packing) {
    return (
      <Card title={t("packing.confirm.title")}>
        <Text tone="subdued">{t(data.order.status === "packed" ? "packing.confirm.packedOutside" : "packing.confirm.startFirst")}</Text>
      </Card>
    );
  }
  const materialsPreview = data.materials.map((m) => t("packing.confirm.materialLine", { name: m.name, quantity: m.required })).join(", ");
  /** Коробку не вибрано (неточний підбір не підставляється) — пакувальник має бачити, що коробка не спишеться. */
  const noBox = !packing.boxMaterialId && data.boxes.length > 0 && !data.materialsConsumed;
  return (
    <Card title={t("packing.confirm.title")}>
      <Stack gap={3}>
        <Text>{t("packing.confirm.progress", { packed: progress.packedUnits, required: progress.requiredUnits })}</Text>
        {noBox ? (
          <Text variant="body-sm" tone="subdued">
            {t("packing.confirm.noBox")}
          </Text>
        ) : null}
        <Form method="post">
          <input type="hidden" name="intent" value="confirm" />
          <input type="hidden" name="version" value={packing.version} />
          {progress.complete ? (
            <ConfirmSubmitButton
              variant="primary"
              fullWidth
              loading={busy("confirm")}
              title={t("packing.confirm.dialogTitle", { number: data.order.orderNumber })}
              confirmLabel={t("packing.confirm.confirm")}
              cancelLabel={t("common.cancel")}
              message={
                <Stack gap={2}>
                  <Text>{t("packing.confirm.dialogBody")}</Text>
                  <Text weight="semibold">
                    {data.materialsConsumed
                      ? t("packing.confirm.dialogMaterialsAlready")
                      : materialsPreview
                        ? t("packing.confirm.dialogMaterials", { list: materialsPreview })
                        : t("packing.confirm.dialogNoMaterials")}
                  </Text>
                  {noBox ? <Text>{t("packing.confirm.noBox")}</Text> : null}
                  {data.mismatch ? <Text>{t("packing.confirm.dialogMismatch")}</Text> : null}
                  <Text variant="body-sm" tone="subdued">
                    {t("packing.confirm.notShipped")}
                  </Text>
                </Stack>
              }
            >
              {t("packing.confirm.button")}
            </ConfirmSubmitButton>
          ) : (
            <Stack gap={2}>
              <Button variant="primary" fullWidth disabled>
                {t("packing.confirm.button")}
              </Button>
              <Text variant="body-sm" tone="subdued">
                {t("packing.confirm.incomplete")}
              </Text>
            </Stack>
          )}
        </Form>
        {!progress.complete && data.canOverride ? (
          <Disclosure summary={t("packing.override.summary")}>
            <Form method="post">
              <input type="hidden" name="intent" value="confirm" />
              <input type="hidden" name="version" value={packing.version} />
              <input type="hidden" name="override" value="1" />
              <Stack gap={3}>
                <Text variant="body-sm">{t("packing.override.help")}</Text>
                <TextField
                  id="packing-override-reason"
                  name="overrideReason"
                  label={t("packing.override.reason")}
                  multiline={2}
                  maxLength={MAX_OVERRIDE_REASON_LENGTH}
                  required
                />
                <ConfirmSubmitButton
                  variant="critical"
                  loading={busy("confirm")}
                  title={t("packing.override.title")}
                  confirmLabel={t("packing.override.confirm")}
                  cancelLabel={t("common.cancel")}
                  message={<Text>{t("packing.override.body", { packed: progress.packedUnits, required: progress.requiredUnits })}</Text>}
                >
                  {t("packing.override.button")}
                </ConfirmSubmitButton>
              </Stack>
            </Form>
          </Disclosure>
        ) : null}
      </Stack>
    </Card>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";
