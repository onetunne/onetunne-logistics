/**
 * Етап 6, WP4: блок «Фінанси замовлення» (docs/stage6-design.md §18.4; лише власник — сторінка замовлення отримує
 * `finance = null` для працівника й тоді блок не рендериться). На телефоні згорнутий, на ПК відкритий. Рядки — нетто
 * (складники підрядком «у т.ч. …»), кожен — у валюті показу + початкові суми; відсутнє — «—» з причиною (ніколи 0);
 * прогноз — «≈» окремим числом; прибуток — «Факт» / «≈ Прогноз» / «Неможливо розрахувати: немає даних — …».
 * Дії власника (finance.manage) — POST-форми на сторінку замовлення з intent `finance.*` (один диспетчер сервера).
 */
import { Form, Link, useNavigation } from "react-router";
import type { ComponentReason, ComponentState, FinanceBasis, OrderComponent } from "~/domain/finance";
import { DISPUTE_OUTCOMES } from "~/domain/finance";
import { useLocale, useT, type TFunction } from "~/i18n";
import type { Locale } from "~/i18n/types";
import { formatDateTime, formatIsoDate, formatMoney, formatPercent } from "~/lib/format";
import { financeLabelKeys } from "~/modules/finance/core/labels";
import type { OrderFinanceCardData } from "~/modules/order-finance/card.server";
import type { CardAmount } from "~/modules/order-finance/card";
import { Badge, Banner, Button, Checkbox, ConfirmSubmitButton, DataTable, Disclosure, FormLayout, KeyValueList, Select, Stack, Text, TextField, type KeyValueItem } from "~/ui";
import { CurrencySwitch } from "~/components/finance/currency-switch";
import { MoneyValue } from "~/components/finance/money-value";
import { StateBadge } from "~/components/finance/state-badge";
import { useHref } from "~/components/shell";
import { formatRateBp } from "~/modules/partners/display";

export interface OrderFinancePanelData {
  card: OrderFinanceCardData | null;
  canManage: boolean;
  operationIds: { chargeback: string; shipping: string };
  partnerOptions: Array<{ id: string; displayName: string }>;
  today: string;
}

const DASH = "—";

function money(amount: string | null | undefined, currency: string, locale: Locale): string {
  return amount === null || amount === undefined ? DASH : formatMoney(amount, currency, locale);
}

function originalText(a: CardAmount, locale: Locale): string {
  return a.original.map((o) => formatMoney(o.amount, o.currency, locale)).join(" · ");
}

/** Сума рядка у валюті показу (MoneyValue) + стан складника. */
function AmountCell({
  amount,
  currency,
  state,
  reason,
  basis,
  forecast,
  strong,
  action,
}: {
  amount: CardAmount | null;
  currency: string;
  state?: ComponentState | null;
  reason?: ComponentReason | null;
  basis?: FinanceBasis | string | null;
  forecast?: CardAmount | null;
  strong?: boolean;
  /** Відсутнє — посилання на дію, що дає факт (§18.4). */
  action?: MissingAction | null;
}) {
  // Записи є — або відомий нуль (converted "0.00" без записів: виручку прочитано повністю, рядка немає).
  const hasActual = Boolean(amount && (amount.entries > 0 || amount.converted !== null));
  return (
    <Stack gap={1}>
      {hasActual ? (
        <MoneyValue value={amount!.converted !== null ? { amount: amount!.converted, currency } : null} original={amount!.original} emphasis={strong ? "strong" : "default"} />
      ) : forecast ? null : (
        <MoneyValue value={null} />
      )}
      {forecast && forecast.entries > 0 ? (
        <MoneyValue value={forecast.converted !== null ? { amount: forecast.converted, currency } : null} original={forecast.original} forecast emphasis={strong ? "strong" : "default"} />
      ) : null}
      {state ? <StateBadge state={state} reason={reason ?? null} basis={(basis as FinanceBasis | null) ?? null} /> : null}
      {action ? <ActionLink action={action} /> : null}
    </Stack>
  );
}

/** Дія, що дає факт відсутнього складника (§18.4: «Ввести собівартість», «Імпортувати рахунок», «Вказати номер накладної»). */
export interface MissingAction {
  to: string;
  label: string;
  /** Якір на цій самій сторінці (форма в блоці дій). */
  anchor?: boolean;
}

/** Якір форми «Номер накладної перевізника» (зовнішній номер) у блоці дій. */
export const EXTERNAL_WAYBILL_ANCHOR = "order-finance-external-waybill";

function ActionLink({ action }: { action: MissingAction }) {
  return (
    <Text as="span" variant="body-sm">
      {action.anchor ? <a href={action.to}>{action.label}</a> : <Link to={action.to}>{action.label}</Link>}
    </Text>
  );
}

/**
 * Посилання для обов'язкового складника, якого бракує (missing / partial без розбіжності звірки): собівартість без
 * вартості → «Собівартість»; доставка / мито без рахунку → імпорт рахунку; доставка без накладної → форма зовнішнього
 * номера (лише з правом дій); комісії без даних → правила комісій шлюзів.
 */
export function missingActionOf(
  component: OrderComponent,
  view: { state: ComponentState; reason: ComponentReason | null; required: boolean } | null | undefined,
  ctx: { href: (path?: string) => string; t: TFunction; canManage: boolean },
): MissingAction | null {
  if (!view || !view.required || !(view.state === "missing" || view.state === "partial") || view.reason === "reconciliation_mismatch") return null;
  const { href, t } = ctx;
  if (component === "cogs" && view.reason === "no_cost") return { to: href("finance/costs"), label: t("financeOrders.card.action.enterCost") };
  if ((component === "shipping_cost" || component === "duties_paid") && view.reason === "no_invoice") return { to: href("finance/shipping/import"), label: t("financeOrders.card.action.importInvoice") };
  if (component === "shipping_cost" && view.reason === "no_waybill" && ctx.canManage) return { to: `#${EXTERNAL_WAYBILL_ANCHOR}`, label: t("financeOrders.card.action.addWaybill"), anchor: true };
  if (component === "fees" && view.reason === "no_fee_data") return { to: href("finance/expenses"), label: t("financeOrders.actions.feeRulesLink") };
  return null;
}

function componentOf(card: OrderFinanceCardData, c: OrderComponent) {
  return card.components.find((x) => x.component === c) ?? null;
}

function Sub({ children }: { children: React.ReactNode }) {
  return (
    <Text as="span" variant="body-sm" tone="subdued">
      {children}
    </Text>
  );
}

function rows(card: OrderFinanceCardData, t: TFunction, locale: Locale, actionCtx: { href: (path?: string) => string; canManage: boolean }): { revenue: KeyValueItem[]; costs: KeyValueItem[] } {
  const cur = card.currency;
  const r = card.rows;
  const act = (c: OrderComponent) => missingActionOf(c, componentOf(card, c), { ...actionCtx, t });
  const revenue: KeyValueItem[] = [];
  const productSub: string[] = [];
  if (r.products.sold.entries > 0) {
    productSub.push(
      card.lastReturnOn && r.products.returned.entries > 0
        ? t("financeOrders.card.productsSubDate", { sold: originalText(r.products.sold, locale), returned: originalText(r.products.returned, locale), date: formatIsoDate(card.lastReturnOn, locale) })
        : t("financeOrders.card.productsSub", { sold: originalText(r.products.sold, locale), returned: r.products.returned.entries > 0 ? originalText(r.products.returned, locale) : DASH }),
    );
  }
  if (r.products.discounts.entries > 0) {
    productSub.push(
      card.discountCodes.length > 0
        ? t("financeOrders.card.discountsSubCodes", { before: originalText(r.products.beforeDiscounts, locale), codes: card.discountCodes.join(", "), discount: originalText(r.products.discounts, locale) })
        : t("financeOrders.card.discountsSub", { before: originalText(r.products.beforeDiscounts, locale), discount: originalText(r.products.discounts, locale) }),
    );
  }
  const rev = componentOf(card, "revenue");
  revenue.push({
    key: "products",
    label: (
      <Stack gap={1}>
        <span>{t("financeOrders.card.products")}</span>
        {productSub.map((s) => (
          <Sub key={s}>{s}</Sub>
        ))}
      </Stack>
    ),
    value: <AmountCell amount={r.products.net} currency={cur} state={rev?.state} reason={rev?.reason} basis={rev?.basis} />,
  });
  revenue.push({ key: "shippingPaid", label: t("financeOrders.card.shippingPaid"), value: <AmountCell amount={r.shippingPaid} currency={cur} /> });
  if (r.otherRevenue.entries > 0) revenue.push({ key: "other", label: t("financeOrders.card.otherRevenue"), value: <AmountCell amount={r.otherRevenue} currency={cur} /> });
  if (r.chargebackLoss.entries > 0) revenue.push({ key: "chargeback", label: t("financeOrders.card.chargebackLoss"), value: <AmountCell amount={r.chargebackLoss} currency={cur} /> });
  if (card.estimate) {
    revenue.push({
      key: "estimate",
      label: (
        <Stack gap={1}>
          <span>{t("financeOrders.card.estimate")}</span>
          <Sub>{t("financeOrders.card.estimateHint")}</Sub>
        </Stack>
      ),
      value: <MoneyValue value={card.estimate.converted !== null ? { amount: card.estimate.converted, currency: cur } : null} original={card.estimate.original} forecast />,
    });
  }

  const costs: KeyValueItem[] = [];
  const cogs = componentOf(card, "cogs");
  costs.push({
    key: "cogs",
    label: (
      <Stack gap={1}>
        <span>{t("financeOrders.card.cogs")}</span>
        {r.cogs.writtenOff.entries > 0 || r.cogs.returns.entries > 0 ? (
          <Sub>{t("financeOrders.card.cogsSub", { writtenOff: r.cogs.writtenOff.entries > 0 ? originalText(r.cogs.writtenOff, locale) : DASH, returns: r.cogs.returns.entries > 0 ? originalText(r.cogs.returns, locale) : DASH })}</Sub>
        ) : null}
      </Stack>
    ),
    value: <AmountCell amount={r.cogs.net} currency={cur} state={cogs?.state} reason={cogs?.reason} basis={cogs?.basis} forecast={cogs?.forecast} action={act("cogs")} />,
  });
  const pkg = componentOf(card, "packaging");
  costs.push({ key: "packaging", label: t("financeOrders.card.packaging"), value: <AmountCell amount={r.packaging} currency={cur} state={pkg?.state} reason={pkg?.reason} basis={pkg?.basis} forecast={pkg?.forecast} /> });
  const ship = componentOf(card, "shipping_cost");
  const carrier = card.shipping.carrierReported;
  costs.push({
    key: "shipping",
    label: (
      <Stack gap={1}>
        <span>{t("financeOrders.card.shipping")}</span>
        {carrier.length > 0 ? <Sub>{t("financeOrders.card.carrierReported", { amount: carrier.map((c) => formatMoney(c.amount, c.currency, locale)).join(" · ") })}</Sub> : null}
        {ship?.forecast ? <Sub>{t("financeOrders.card.frozenForecast")}</Sub> : null}
      </Stack>
    ),
    value: <AmountCell amount={r.shippingActual} currency={cur} state={ship?.state} reason={ship?.reason} basis={ship?.basis} forecast={ship?.forecast} action={act("shipping_cost")} />,
  });
  const duties = componentOf(card, "duties_paid");
  if (duties?.required || r.duties.entries > 0) {
    costs.push({ key: "duties", label: t("financeOrders.card.duties"), value: <AmountCell amount={r.duties} currency={cur} state={duties?.required ? duties.state : null} reason={duties?.reason} basis={duties?.basis} action={act("duties_paid")} /> });
  }
  const fees = componentOf(card, "fees");
  costs.push({ key: "fees", label: t("financeOrders.card.fees"), value: <AmountCell amount={r.fees.net} currency={cur} state={fees?.state} reason={fees?.reason} basis={fees?.basis} forecast={fees?.forecast} action={act("fees")} /> });
  const partner = componentOf(card, "partner");
  if (card.partner || r.partner.net.entries > 0 || (partner && partner.state !== "not_applicable")) {
    const p = card.partner;
    const detail = p ? [p.code, p.rateBp !== null ? formatRateBp(p.rateBp, locale) : null].filter(Boolean).join(", ") : "";
    costs.push({
      key: "partner",
      label: (
        <Stack gap={1}>
          <span>{p?.displayName ? t("financeOrders.card.partnerNamed", { name: p.displayName, detail: detail || DASH }) : t("financeOrders.card.partner")}</span>
          {r.partner.accrued.entries > 0 ? (
            <Sub>{t("financeOrders.card.partnerSub", { accrued: originalText(r.partner.accrued, locale), adjustments: r.partner.adjustments.entries > 0 ? originalText(r.partner.adjustments, locale) : DASH })}</Sub>
          ) : null}
          {p?.commissionState ? <Sub>{t(financeLabelKeys.partnerState(p.commissionState as never))}</Sub> : null}
        </Stack>
      ),
      value: <AmountCell amount={r.partner.net} currency={cur} state={partner?.state} reason={partner?.reason} basis={partner?.basis} forecast={partner?.forecast} />,
    });
  }
  if (r.otherCosts.entries > 0) costs.push({ key: "other", label: t("financeOrders.card.otherCosts"), value: <AmountCell amount={r.otherCosts} currency={cur} /> });
  return { revenue, costs };
}

function ProfitBlock({ card, t, locale, actionCtx }: { card: OrderFinanceCardData; t: TFunction; locale: Locale; actionCtx: { href: (path?: string) => string; canManage: boolean } }) {
  const p = card.profit;
  if (card.state === "excluded") return <Text>{t("financeOrders.card.profitExcluded")}</Text>;
  if (card.state === "closed_unrecognized") return <Text>{t("financeOrders.card.profitClosed")}</Text>;
  if (p.kind === "not_applicable") return <Text tone="subdued">{t("financeOrders.card.profitNotRecognized")}</Text>;
  if (p.kind === "hidden") {
    const list = p.missing.map((m) => t(financeLabelKeys.component(m.component))).join(", ");
    return (
      <Stack gap={1}>
        <Text weight="semibold">{t("financeOrders.card.profitHidden", { list: list || DASH })}</Text>
        {p.missing.map((m) => {
          if (!m.reason) return null;
          const action = missingActionOf(m.component, { state: "missing", reason: m.reason, required: true }, { ...actionCtx, t });
          return (
            <Stack key={m.component} direction="horizontal" gap={2} align="center" wrap>
              <Sub>{`${t(financeLabelKeys.component(m.component))}: ${t(financeLabelKeys.reason(m.reason))}`}</Sub>
              {action ? <ActionLink action={action} /> : null}
            </Stack>
          );
        })}
      </Stack>
    );
  }
  const amount = p.value !== null ? formatMoney(p.value, card.currency, locale) : DASH;
  // F5: будь-яке число з прогнозом має «≈» — і прибуток, і рентабельність «≈ Прогноз» (§18.4 «рентабельність ≈ 57,3 %»).
  const margin = p.margin !== null ? `${p.kind === "forecast" ? "≈ " : ""}${formatPercent(p.margin, locale)}` : DASH;
  const pending = card.components.filter((c) => c.required && c.forecast).map((c) => t(financeLabelKeys.component(c.component)));
  return (
    <Stack gap={1}>
      <Text weight="semibold" variant="heading-sm">
        {p.kind === "fact" ? t("financeOrders.card.profitFact", { amount, margin }) : t("financeOrders.card.profitForecast", { amount, margin })}
      </Text>
      {p.kind === "forecast" && pending.length > 0 ? <Sub>{t("financeOrders.card.factWhen", { list: pending.join(", ") })}</Sub> : null}
      {p.unconverted.length > 0 ? <Sub>{t("financeOrders.card.unconverted", { list: p.unconverted.map((u) => formatMoney(u.amount, u.currency, locale)).join(" · ") })}</Sub> : null}
    </Stack>
  );
}

function Header({ card, t, locale }: { card: OrderFinanceCardData; t: TFunction; locale: Locale }) {
  const basis = card.recognitionBasis ? t(financeLabelKeys.recognitionBasis(card.recognitionBasis)) : null;
  return (
    <Stack gap={2}>
      <Stack direction="horizontal" gap={2} align="center" wrap>
        {card.state === "recognized" ? <StateBadge state={card.profitState} size="md" /> : card.state !== "none" ? <StateBadge state={card.state} size="md" /> : null}
        {card.needsReview ? <Badge tone="warning">{t("financeOrders.card.needsReview")}</Badge> : null}
        <Text variant="body-sm" tone="subdued">
          {t("financeOrders.card.currency", { currency: card.currency })}
        </Text>
      </Stack>
      <CurrencySwitch current={card.currency} options={card.displayCurrencies} />
      <Text variant="body-sm" tone="subdued">
        {card.recognizedOn ? t("financeOrders.card.recognized", { date: formatIsoDate(card.recognizedOn, locale), basis: basis ?? DASH }) : t("financeOrders.card.notRecognized")}
      </Text>
      {card.reviewReasons.length > 0 ? <Sub>{card.reviewReasons.map((r) => t(financeLabelKeys.review(r))).join(" · ")}</Sub> : null}
    </Stack>
  );
}

function PaidLine({ card, t, locale }: { card: OrderFinanceCardData; t: TFunction; locale: Locale }) {
  const p = card.paid;
  if (!p) return null;
  return (
    <Stack gap={1}>
      <Text weight="semibold">
        {t("financeOrders.card.paid")}: {formatMoney(p.received, p.currency, locale)}
      </Text>
      <Sub>{t("financeOrders.card.paidDetail", { refunded: formatMoney(p.refunded, p.currency, locale), net: formatMoney(p.net, p.currency, locale) })}</Sub>
      {p.presentment ? (
        <Sub>
          {t("financeOrders.card.presentment", {
            presentment: formatMoney(p.presentment.received, p.presentment.currency, locale),
            shop: formatMoney(p.received, p.currency, locale),
            ratio: p.presentment.impliedRatio ?? DASH,
          })}
        </Sub>
      ) : null}
      {p.reconciliationMismatch ? <Sub>{t("financeOrders.card.paidMismatch")}</Sub> : !p.complete ? <Sub>{t("financeOrders.card.paidIncomplete")}</Sub> : null}
    </Stack>
  );
}

function MemoBlock({ card, t, locale }: { card: OrderFinanceCardData; t: TFunction; locale: Locale }) {
  const r = card.rows;
  const items: KeyValueItem[] = [];
  if (r.taxCollected.entries > 0) items.push({ key: "tax", label: t("financeOrders.card.taxCollected"), value: <AmountCell amount={r.taxCollected} currency={card.currency} /> });
  if (r.discountsMemo.entries > 0 || card.discountCodes.length > 0) {
    items.push({
      key: "disc",
      label: card.discountCodes.length > 0 ? t("financeOrders.card.discountsCodes", { codes: card.discountCodes.join(", ") }) : t("financeOrders.card.discounts"),
      value: <AmountCell amount={r.discountsMemo} currency={card.currency} />,
    });
  }
  if (r.giftCards.entries > 0) items.push({ key: "gift", label: t("financeOrders.card.giftCards"), value: <AmountCell amount={r.giftCards} currency={card.currency} /> });
  if (items.length === 0) return null;
  return (
    <Stack gap={1}>
      <Text weight="semibold">{t("financeOrders.card.memo")}</Text>
      <KeyValueList items={items} />
      <Text variant="body-sm" tone="subdued">
        {t("financeOrders.card.memoHint")}
      </Text>
    </Stack>
  );
}

function EntriesTable({ card, t, locale }: { card: OrderFinanceCardData; t: TFunction; locale: Locale }) {
  if (card.entries.length === 0) return <Text tone="subdued">{t("financeOrders.card.noEntries")}</Text>;
  return (
    <DataTable
      caption={t("financeOrders.card.entries")}
      rows={card.entries}
      rowKey={(e) => e.id}
      columns={[
        { key: "date", header: t("financeOrders.entries.date"), primary: true, render: (e) => formatIsoDate(e.recognizedOn, locale) },
        { key: "category", header: t("financeOrders.entries.category"), render: (e) => t(financeLabelKeys.category(e.category as never)) },
        { key: "amount", header: t("financeOrders.entries.amount"), align: "end", render: (e) => formatMoney(e.amount, e.currency, locale) },
        { key: "converted", header: t("financeOrders.entries.converted", { currency: card.currency }), align: "end", render: (e) => money(e.converted, card.currency, locale) },
        {
          key: "rate",
          header: t("financeOrders.entries.rate"),
          render: (e) =>
            e.rate
              ? t(e.rate.fallback ? "financeOrders.entries.rateFallback" : "financeOrders.entries.rateOn", { source: t(financeLabelKeys.rateSource(e.rate.source)), date: formatIsoDate(e.rate.rateDate, locale), fxOn: formatIsoDate(e.fxOn, locale) })
              : e.currency === card.currency
                ? DASH
                : e.converted === null
                  ? t("financeOrders.entries.noRate", { fxOn: formatIsoDate(e.fxOn, locale) })
                  : formatIsoDate(e.fxOn, locale),
        },
        {
          key: "flags",
          header: t("financeOrders.entries.flags"),
          render: (e) => (
            <Stack direction="horizontal" gap={1} wrap>
              {e.isLate ? <Badge tone="warning">{t("financeOrders.entries.late", { date: formatIsoDate(e.originalOn, locale) })}</Badge> : null}
              {e.isLateCompletion ? <Badge tone="info">{t("financeOrders.entries.lateCompletion")}</Badge> : null}
              {e.reversal ? <Badge tone="outline">{t("financeOrders.entries.reversal")}</Badge> : null}
              {e.reversed ? <Badge tone="outline">{t("financeOrders.entries.reversed")}</Badge> : null}
            </Stack>
          ),
        },
      ]}
    />
  );
}

function ChecksBlock({ card, t, locale }: { card: OrderFinanceCardData; t: TFunction; locale: Locale }) {
  return (
    <Stack gap={3}>
      {card.reconciliation ? (
        <Stack gap={1}>
          <Text weight="semibold">{t("financeOrders.card.reconciliation")}</Text>
          {card.reconciliation.checks.length === 0 ? (
            <Text tone="subdued">{t("financeOrders.reconciliation.none")}</Text>
          ) : (
            <KeyValueList
              items={card.reconciliation.checks.map((c) => ({
                key: c.check,
                label: `${t(`financeOrders.reconciliation.check.${c.check}`)}${c.candidate ? ` · ${t("financeOrders.reconciliation.candidate")}` : ""}`,
                value: t(`financeOrders.reconciliation.status.${c.status}`),
              }))}
            />
          )}
        </Stack>
      ) : (
        <Text tone="subdued">{t("financeOrders.reconciliation.noFacts")}</Text>
      )}
      <Stack gap={1}>
        <Text weight="semibold">{t("financeOrders.card.discrepancies")}</Text>
        {card.discrepancies.length === 0 ? (
          <Text tone="subdued">{t("financeOrders.card.noDiscrepancies")}</Text>
        ) : (
          card.discrepancies.map((d) => (
            <Stack key={d.id} direction="horizontal" gap={2} align="center" wrap>
              <Badge tone={d.status === "open" ? (d.severity === "critical" ? "critical" : "warning") : "outline"}>{t(financeLabelKeys.discrepancyStatus(d.status))}</Badge>
              <Text>{t(financeLabelKeys.discrepancy(d.type))}</Text>
              <Sub>{formatDateTime(d.createdAt, locale)}</Sub>
            </Stack>
          ))
        )}
      </Stack>
      <Stack gap={1}>
        <Text weight="semibold">{t("financeOrders.card.disputes")}</Text>
        {card.disputes.length === 0 ? (
          <Text tone="subdued">{t("financeOrders.card.noDisputes")}</Text>
        ) : (
          card.disputes.map((d) => (
            <Text key={d.id}>
              {t("financeOrders.card.disputeRow", {
                source: t(`financeOrders.disputeSource.${d.source}`),
                outcome: t(`financeOrders.outcome.${d.outcome ?? "open"}`),
                amount: d.amount && d.currency ? formatMoney(d.amount, d.currency, locale) : DASH,
                date: d.decidedOn ? formatIsoDate(d.decidedOn, locale) : DASH,
              })}
            </Text>
          ))
        )}
      </Stack>
    </Stack>
  );
}

function HistoryBlock({ card, t, locale }: { card: OrderFinanceCardData; t: TFunction; locale: Locale }) {
  if (card.history.length === 0) return <Text tone="subdued">{t("financeOrders.card.noHistory")}</Text>;
  return (
    <Stack gap={2}>
      {card.history.map((h) => (
        <Stack key={h.id} gap={0}>
          <Text>
            {t(financeLabelKeys.changeEntity(h.entityType as never))} · {t(financeLabelKeys.changeAction(h.action as never))}
          </Text>
          <Sub>
            {formatDateTime(h.createdAt, locale)}
            {h.reason ? ` · ${h.reason}` : ""}
          </Sub>
        </Stack>
      ))}
    </Stack>
  );
}

function Hidden({ intent, version, extra }: { intent: string; version: number; extra?: Record<string, string> }) {
  return (
    <>
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="financeVersion" value={String(version)} />
      {extra ? Object.entries(extra).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />) : null}
    </>
  );
}

function FlagForm({ card, flag, active, label, t }: { card: OrderFinanceCardData; flag: string; active: boolean; label: string; t: TFunction }) {
  return (
    <Form method="post">
      <Hidden intent="finance.flag" version={card.version} extra={{ flag, active: active ? "0" : "1" }} />
      <FormLayout>
        <Text weight="semibold">{label}</Text>
        <TextField name="reason" label={t("financeOrders.actions.reason")} maxLength={300} required />
        <Button type="submit" variant={active ? "secondary" : "primary"}>
          {active ? t("financeOrders.actions.unset") : t("financeOrders.actions.set")}
        </Button>
      </FormLayout>
    </Form>
  );
}

/**
 * «Підтвердити суми замовлення» (§4): єдиний шлях до факту виручки без угод Shopify — показується, коли виручка
 * визнаного / відкритого замовлення «немає даних» (з «Оцінкою» або без неї: subtotal 0 при total ≠ 0 — оцінки немає),
 * або суми вже підтверджено (зміна / скасування).
 */
export function canConfirmAmounts(card: OrderFinanceCardData): boolean {
  if (card.overrides.confirmedAmounts) return true;
  const rev = card.components.find((c) => c.component === "revenue");
  return (card.state === "recognized" || card.state === "open") && rev?.state === "missing";
}

/** Поле «Товари» заповнено «Оцінкою» (валюта магазину), редаговане (§4 «заповнені оцінкою, редаговані»). */
export function estimateProducts(card: OrderFinanceCardData): string | null {
  return card.estimate?.original.find((o) => o.currency === card.shopCurrency)?.amount ?? null;
}

function ActionsBlock({ data, t }: { data: OrderFinancePanelData; t: TFunction }) {
  const card = data.card!;
  const href = useHref();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const ov = card.overrides;
  const lastDispute = card.disputes[card.disputes.length - 1] ?? null;
  return (
    <Stack gap={3}>
      <Disclosure summary={t("financeOrders.actions.shippingCost")}>
        <Form method="post">
          <Hidden intent="finance.shippingCost" version={card.version} extra={{ operationId: data.operationIds.shipping }} />
          <FormLayout>
            <Select
              name="category"
              label={t("financeOrders.actions.costKind")}
              options={[
                { value: "shipping_cost", label: t(financeLabelKeys.category("shipping_cost")) },
                { value: "duties_paid", label: t(financeLabelKeys.category("duties_paid")) },
              ]}
            />
            <TextField name="amount" label={t("financeOrders.actions.amount")} inputMode="decimal" required />
            <TextField name="currency" label={t("financeOrders.actions.currency")} defaultValue={card.reportingCurrency} maxLength={3} required />
            <TextField name="date" type="date" label={t("financeOrders.actions.date")} defaultValue={data.today} required />
            <TextField name="description" label={t("financeOrders.actions.description")} maxLength={200} />
            <Button type="submit" variant="primary" disabled={busy}>
              {t("financeOrders.actions.save")}
            </Button>
          </FormLayout>
        </Form>
      </Disclosure>
      <Disclosure summary={t("financeOrders.actions.externalWaybill")}>
        <Form method="post" id={EXTERNAL_WAYBILL_ANCHOR}>
          <Hidden intent="finance.externalWaybill" version={card.version} />
          <FormLayout>
            <TextField name="number" label={t("financeOrders.actions.waybillNumber")} maxLength={60} required />
            <Text variant="body-sm" tone="subdued">
              {t("financeOrders.actions.externalWaybillHint")}
            </Text>
            <Button type="submit" disabled={busy}>
              {t("financeOrders.actions.save")}
            </Button>
          </FormLayout>
        </Form>
      </Disclosure>
      <Disclosure summary={t("financeOrders.actions.marks")}>
        <Stack gap={3}>
          <FlagForm card={card} flag="recipient_pays" active={ov.recipientPays} label={t("financeOrders.flag.recipient_pays")} t={t} />
          <FlagForm card={card} flag="no_shipping_cost" active={ov.noShippingCost} label={t("financeOrders.flag.no_shipping_cost")} t={t} />
          <FlagForm card={card} flag="fees_zero_confirmed" active={ov.feesZeroConfirmed} label={t("financeOrders.flag.fees_zero_confirmed")} t={t} />
          <FlagForm card={card} flag="packaging_accounted_in_total" active={ov.packagingAccountedInTotal} label={t("financeOrders.flag.packaging_accounted_in_total")} t={t} />
          <Link to={href("finance/expenses")}>{t("financeOrders.actions.feeRulesLink")}</Link>
        </Stack>
      </Disclosure>
      <Disclosure summary={t("financeOrders.actions.partner")}>
        <Form method="post">
          <Hidden intent="finance.partner" version={card.version} />
          <FormLayout>
            <Select
              name="partnerId"
              label={t("financeOrders.actions.partnerSelect")}
              options={[{ value: "", label: t("financeOrders.actions.partnerNone") }, ...data.partnerOptions.map((p) => ({ value: p.id, label: p.displayName }))]}
            />
            <Select
              name="mode"
              label={t("financeOrders.actions.partnerMode")}
              options={[
                { value: "manual", label: t("financeOrders.actions.partnerManual") },
                { value: "auto", label: t("financeOrders.actions.partnerAuto") },
              ]}
            />
            <TextField name="reason" label={t("financeOrders.actions.reason")} maxLength={300} required />
            <Button type="submit" disabled={busy}>
              {t("financeOrders.actions.save")}
            </Button>
          </FormLayout>
        </Form>
      </Disclosure>
      <Disclosure summary={t("financeOrders.actions.chargeback")}>
        <Form method="post">
          <Hidden
            intent="finance.chargeback"
            version={card.version}
            extra={{ operationId: data.operationIds.chargeback, ...(lastDispute ? { disputeId: lastDispute.id, disputeVersion: String(lastDispute.version) } : {}) }}
          />
          <FormLayout>
            <Text variant="body-sm" tone="subdued">
              {lastDispute ? t("financeOrders.actions.chargebackEditing") : t("financeOrders.actions.chargebackNew")}
            </Text>
            <TextField name="amount" label={t("financeOrders.actions.chargebackAmount")} inputMode="decimal" defaultValue={lastDispute?.amount ?? ""} />
            <TextField name="recovered" label={t("financeOrders.actions.chargebackRecovered")} inputMode="decimal" defaultValue={lastDispute?.recoveredAmount ?? ""} />
            <TextField name="currency" label={t("financeOrders.actions.currency")} defaultValue={lastDispute?.currency ?? card.shopCurrency} maxLength={3} required />
            <TextField name="fee" label={t("financeOrders.actions.chargebackFee")} inputMode="decimal" defaultValue={lastDispute?.fee ?? ""} />
            <TextField name="feeCurrency" label={t("financeOrders.actions.chargebackFeeCurrency")} defaultValue={lastDispute?.feeCurrency ?? card.shopCurrency} maxLength={3} />
            <Select
              name="outcome"
              label={t("financeOrders.actions.chargebackOutcome")}
              defaultValue={lastDispute?.outcome ?? ""}
              options={[{ value: "", label: t("financeOrders.outcome.open") }, ...DISPUTE_OUTCOMES.map((o) => ({ value: o, label: t(`financeOrders.outcome.${o}`) }))]}
            />
            <TextField name="decidedOn" type="date" label={t("financeOrders.actions.chargebackDate")} defaultValue={lastDispute?.decidedOn ?? ""} />
            <Checkbox name="vatReducible" label={t("financeOrders.actions.chargebackVat")} defaultChecked={lastDispute?.vatReducible ?? false} />
            <Checkbox name="fullPartnerCancellation" label={t("financeOrders.actions.chargebackCancelPartner")} defaultChecked={lastDispute?.fullPartnerCancellation ?? false} />
            <TextField name="reason" label={t("financeOrders.actions.reasonOptional")} maxLength={300} />
            <Button type="submit" variant="primary" disabled={busy}>
              {t("financeOrders.actions.save")}
            </Button>
          </FormLayout>
        </Form>
      </Disclosure>
      {canConfirmAmounts(card) ? (
        <Disclosure summary={t("financeOrders.actions.confirmAmounts")}>
          <Stack gap={3}>
            <Form method="post">
              <Hidden intent="finance.confirmAmounts" version={card.version} />
              <FormLayout>
                <Text variant="body-sm" tone="subdued">
                  {t("financeOrders.actions.confirmAmountsHint")}
                </Text>
                <TextField name="products" label={t("financeOrders.actions.confirmProducts", { currency: card.shopCurrency })} inputMode="decimal" defaultValue={ov.confirmedAmounts?.products ?? estimateProducts(card) ?? ""} required />
                <TextField name="shipping" label={t("financeOrders.actions.confirmShipping", { currency: card.shopCurrency })} inputMode="decimal" defaultValue={ov.confirmedAmounts?.shipping ?? ""} required />
                <TextField name="reason" label={t("financeOrders.actions.reason")} maxLength={300} required />
                <Button type="submit" variant="primary" disabled={busy}>
                  {t("financeOrders.actions.save")}
                </Button>
              </FormLayout>
            </Form>
            {ov.confirmedAmounts ? (
              <Form method="post">
                <Hidden intent="finance.clearAmounts" version={card.version} />
                <FormLayout>
                  <TextField name="reason" label={t("financeOrders.actions.reason")} maxLength={300} required />
                  <ConfirmSubmitButton title={t("financeOrders.actions.clearAmounts")} message={t("financeOrders.actions.clearAmountsConfirm")} confirmLabel={t("financeOrders.actions.clearAmounts")} cancelLabel={t("financeOrders.actions.cancel")}>
                    {t("financeOrders.actions.clearAmounts")}
                  </ConfirmSubmitButton>
                </FormLayout>
              </Form>
            ) : null}
          </Stack>
        </Disclosure>
      ) : null}
      <Stack direction="horizontal" gap={2} wrap>
        <Link to={`${href("finance/expenses")}?add=expense&category=other_expense&order=${encodeURIComponent(card.orderNumber)}#expense-form`}>{t("financeOrders.actions.addExpense")}</Link>
        <Form method="post">
          <Hidden intent="finance.recalculate" version={card.version} />
          <Button type="submit" size="sm" disabled={busy}>
            {t("financeOrders.actions.recalculate")}
          </Button>
        </Form>
        <Form method="post">
          <Hidden intent="finance.resyncShopify" version={card.version} />
          <Button type="submit" size="sm" disabled={busy}>
            {t("financeOrders.actions.resyncShopify")}
          </Button>
        </Form>
      </Stack>
    </Stack>
  );
}

/** Блок «Фінанси замовлення» (лише власник; працівнику сторінка не передає даних — блок не рендериться). */
export function OrderFinanceCard({ data }: { data: OrderFinancePanelData }) {
  const t = useT();
  const locale = useLocale();
  const href = useHref();
  const card = data.card;
  const actionCtx = { href, canManage: data.canManage };
  if (!card) {
    return (
      <Disclosure summary={t("financeOrders.card.title")} collapsedOnMobile className="ot-order-finance">
        <Text tone="subdued">{t("financeOrders.card.empty")}</Text>
      </Disclosure>
    );
  }
  const { revenue, costs } = rows(card, t, locale, actionCtx);
  if (card.testOrder && !card.includesTestOrders) {
    return (
      <Disclosure summary={t("financeOrders.card.title")} collapsedOnMobile className="ot-order-finance">
        <Banner tone="info">{t("financeOrders.card.testOrder")}</Banner>
      </Disclosure>
    );
  }
  return (
    <Disclosure summary={t("financeOrders.card.title")} collapsedOnMobile className="ot-order-finance">
      <Stack gap={4}>
        {card.testOrder && card.includesTestOrders ? <Banner tone="warning">{t("financeOrders.card.testIncluded")}</Banner> : null}
        <Header card={card} t={t} locale={locale} />
        <PaidLine card={card} t={t} locale={locale} />
        <Stack gap={1}>
          <Text weight="semibold">{t("financeOrders.card.revenue")}</Text>
          <KeyValueList items={revenue} />
        </Stack>
        <Stack gap={1}>
          <Text weight="semibold">{t("financeOrders.card.costs")}</Text>
          <KeyValueList items={costs} />
        </Stack>
        <Stack gap={1}>
          <Text weight="semibold">{t("financeOrders.card.profit")}</Text>
          <ProfitBlock card={card} t={t} locale={locale} actionCtx={actionCtx} />
        </Stack>
        <MemoBlock card={card} t={t} locale={locale} />
        <Disclosure summary={t("financeOrders.card.how")}>
          <Stack gap={1}>
            <Text>{t("financeOrders.card.howText1")}</Text>
            <Text>{t("financeOrders.card.howText2")}</Text>
            <Text>{t("financeOrders.card.howText3")}</Text>
          </Stack>
        </Disclosure>
        <Disclosure summary={t("financeOrders.card.entries")}>
          <EntriesTable card={card} t={t} locale={locale} />
        </Disclosure>
        <Disclosure summary={t("financeOrders.card.checks")}>
          <ChecksBlock card={card} t={t} locale={locale} />
        </Disclosure>
        <Disclosure summary={t("financeOrders.card.history")}>
          <HistoryBlock card={card} t={t} locale={locale} />
        </Disclosure>
        {data.canManage ? (
          <Stack gap={2}>
            <Text weight="semibold">{t("financeOrders.actions.title")}</Text>
            <ActionsBlock data={data} t={t} />
          </Stack>
        ) : null}
      </Stack>
    </Disclosure>
  );
}
