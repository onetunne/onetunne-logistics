import type { ReactNode } from "react";
import { useLoaderData, type LoaderFunctionArgs } from "react-router";
import { useHref } from "~/components/shell";
import { requirePermission } from "~/domain/permissions";
import { useLocale, useT } from "~/i18n";
import { formatDateTime } from "~/lib/format";
import { MAX_PICK_LIST_ORDERS } from "~/modules/packing/constants";
import { loadPickList, type PickListItem } from "~/modules/packing/pick-list.server";
import { getRequestContext } from "~/server/context.server";
import { Badge, Banner, Button, EmptyState, Page, Stack, Text, Thumbnail } from "~/ui";

/**
 * Зведений лист комплектації (picking/pick-list?ids=…): що зібрати з полиць одним обходом для вибраних замовлень
 * черги — сума одиниць кожного варіанта (фото, модель, колір, SKU, штрихкод), залишок на полиці, розклад по
 * замовленнях і пакувальні матеріали. Спершу для телефона (картки рядків, великі кількості), друкується на A4.
 * Нічого не змінює; контроль комплектації — скануванням на екрані пакування. Дозвіл — packing.perform (персональних
 * даних покупця немає).
 */

const PRINT_CSS = `
.ot-pick__list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--ot-space-3); }
.ot-pick__row { display: grid; grid-template-columns: auto 1fr auto; gap: var(--ot-space-3); align-items: start; padding: var(--ot-space-3); border: 1px solid var(--ot-color-border); border-radius: 8px; break-inside: avoid; page-break-inside: avoid; }
.ot-pick__qty { font-size: 1.5rem; font-weight: 700; line-height: 1; text-align: end; min-width: 3ch; }
.ot-pick__check { display: inline-block; width: 18px; height: 18px; border: 1.5px solid currentColor; border-radius: 3px; margin-top: 2px; }
.ot-pick__meta { overflow-wrap: anywhere; }
.ot-pick__materials { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--ot-space-1); }
@media (max-width: 480px) {
  .ot-pick__meta { grid-column: 1 / -1; grid-row: 2; }
  .ot-pick__qty { grid-column: 3; grid-row: 1; }
}
@media print {
  .ot-pick__row { padding: 6px 8px; gap: 8px; }
  .ot-pick__qty { font-size: 1.15rem; }
}
`;

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  try {
    requirePermission(ctx.actor, "packing.perform");
  } catch {
    throw new Response("Forbidden", { status: 403 });
  }
  const ids = new URL(request.url).searchParams.getAll("ids");
  const list = await loadPickList(ctx, ids);
  return { ...list, printedAt: ctx.now() };
}

export default function PickListPage() {
  const data = useLoaderData<typeof loader>();
  const t = useT();
  const locale = useLocale();
  const href = useHref();
  const meta: { label: string; value: ReactNode }[] = [
    { label: t("packing.pickList.printedAt"), value: formatDateTime(data.printedAt, locale) },
    { label: t("packing.pickList.orders"), value: data.included.length },
    { label: t("packing.pickList.totalUnits"), value: data.totalUnits },
  ];
  return (
    <Page
      title={t("packing.pickList.title", { count: data.included.length })}
      subtitle={t("packing.pickList.subtitle")}
      backHref={href("picking")}
      backLabel={t("packing.print.back")}
      primaryAction={
        data.items.length > 0 ? (
          <Button variant="primary" className="ot-no-print" onClick={() => window.print()}>
            {t("packing.print.print")}
          </Button>
        ) : undefined
      }
      className="ot-invoice-page"
    >
      <style>{PRINT_CSS}</style>
      <Stack gap={4}>
        <div className="ot-no-print">
          <Stack gap={3}>
            <Text variant="body-sm" tone="subdued">
              {t("packing.pickList.note")}
            </Text>
            {data.truncated ? <Banner tone="warning">{t("packing.pickList.truncated", { count: MAX_PICK_LIST_ORDERS })}</Banner> : null}
            {data.missing > 0 ? <Banner tone="warning">{t("packing.print.missing", { count: data.missing })}</Banner> : null}
            {data.skipped.length > 0 ? (
              <Banner tone="warning" title={t("packing.pickList.skipped", { count: data.skipped.length })}>
                <ul>
                  {data.skipped.map((s) => (
                    <li key={s.orderId}>{t("packing.labels.skippedLine", { number: s.orderNumber, reason: t(`packing.pickList.reason.${s.reason}`) })}</li>
                  ))}
                </ul>
              </Banner>
            ) : null}
          </Stack>
        </div>
        {data.linesPending.length > 0 ? <Banner tone="critical">{t("packing.pickList.linesPending", { list: data.linesPending.join(", ") })}</Banner> : null}
        {data.items.length === 0 ? (
          <EmptyState
            title={t("packing.pickList.empty")}
            description={t("packing.pickList.emptyHint")}
            action={<Button to={href("picking")}>{t("packing.print.back")}</Button>}
          />
        ) : (
          <article className="ot-invoice" aria-label={t("packing.pickList.title", { count: data.included.length })}>
            <header className="ot-invoice__header">
              <h2 className="ot-invoice__title">{t("packing.pickList.title", { count: data.included.length })}</h2>
              <dl className="ot-invoice__meta">
                {meta.map((m) => (
                  <div key={m.label} className="ot-invoice__meta-row">
                    <dt>{m.label}</dt>
                    <dd>{m.value}</dd>
                  </div>
                ))}
              </dl>
            </header>
            <ol className="ot-pick__list">
              {data.items.map((item) => (
                <PickRow key={item.variantId} item={item} />
              ))}
            </ol>
            {data.otherLines.length > 0 ? (
              <p className="ot-invoice__sub">
                {t("packing.pickList.otherLines", { list: data.otherLines.map((l) => `${l.orderNumber}: ${l.title} × ${l.quantity}`).join(", ") })}
              </p>
            ) : null}
            {data.materials.length > 0 ? (
              <section className="ot-invoice__declaration">
                <h3 className="ot-invoice__label">{t("packing.pickList.materials")}</h3>
                {/* Маркер пункту — квадратик для позначки (без крапки списку). */}
                <ul className="ot-pick__materials">
                  {data.materials.map((m) => (
                    <li key={m.materialId}>
                      <span className="ot-pick__check" aria-hidden="true" /> {m.name} × {m.quantity}
                      {m.isBox ? ` (${t("packing.materials.box")})` : ""}
                      {m.onHand < m.quantity ? ` — ${t("packing.pickList.short", { count: m.quantity - Math.max(0, m.onHand) })}` : ""}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </article>
        )}
      </Stack>
    </Page>
  );
}

function PickRow({ item }: { item: PickListItem }) {
  const t = useT();
  const traits = [item.model, item.color].filter(Boolean).join(" · ");
  const codes = [item.sku ? t("packing.line.sku", { value: item.sku }) : null, item.barcode ? t("packing.line.barcode", { value: item.barcode }) : null]
    .filter(Boolean)
    .join(" · ");
  const short = item.onHand !== null && item.onHand < item.quantity ? item.quantity - Math.max(0, item.onHand) : 0;
  return (
    <li className="ot-pick__row">
      <Stack direction="horizontal" gap={2} align="start" wrap={false}>
        <span className="ot-pick__check" aria-hidden="true" />
        <Thumbnail src={item.imageUrl} alt={item.productTitle} size="md" />
      </Stack>
      <Stack gap={1} className="ot-pick__meta">
        <Text weight="semibold">{item.productTitle}</Text>
        {item.variantTitle ? <Text variant="body-sm">{item.variantTitle}</Text> : null}
        {traits ? (
          <Text variant="body-sm" tone="subdued">
            {traits}
          </Text>
        ) : null}
        <Text variant="caption" tone="subdued">
          {codes || t("packing.line.noCodes")}
        </Text>
        <Text variant="caption">
          {t("packing.pickList.col.distribution")}: {item.orders.map((o) => t("packing.pickList.ordersLine", { number: o.orderNumber, quantity: o.quantity })).join(", ")}
        </Text>
        <Stack direction="horizontal" gap={1} align="center" wrap>
          <Text as="span" variant="caption" tone="subdued">
            {t("packing.pickList.col.onHand")}: {item.onHand === null ? t("packing.pickList.untracked") : item.onHand}
          </Text>
          {short > 0 ? (
            <Badge tone="warning" size="sm">
              {t("packing.pickList.short", { count: short })}
            </Badge>
          ) : null}
        </Stack>
      </Stack>
      <span className="ot-pick__qty" aria-label={`${t("packing.pickList.col.qty")}: ${item.quantity}`}>
        {item.quantity}
      </span>
    </li>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";
