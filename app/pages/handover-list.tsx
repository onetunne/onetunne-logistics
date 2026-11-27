import type { ReactNode } from "react";
import { useLoaderData, type LoaderFunctionArgs } from "react-router";
import { TestBadge } from "~/components/status-badge";
import { useHref } from "~/components/shell";
import { requirePermission } from "~/domain/permissions";
import { useLocale, useT } from "~/i18n";
import { formatDateTime, formatWeight } from "~/lib/format";
import { MAX_HANDOVER_ORDERS } from "~/modules/packing/constants";
import { loadHandoverList, type HandoverGroup } from "~/modules/packing/handover-list.server";
import { getRequestContext } from "~/server/context.server";
import { Banner, Button, EmptyState, Page, Stack, Text } from "~/ui";

/**
 * Список посилок для передачі перевізнику (picking/handover[?ids=…]): друкований реєстр запакованих посилок із
 * накладними, що ще не передані перевізнику, — для звірки з кур'єром і підписів. Без вибору — усі запаковані;
 * з вибором — лише вибрані (решта — з причиною, чому не включено). Групування за перевізником, кожна група — з нової
 * сторінки. Нічого не змінює («Передано перевізнику» — за відстеженням або ручним підтвердженням на сторінці замовлення).
 * Мова — інтерфейсу (документ для складу й кур'єра); дані одержувача — лише країна й місто.
 */

const PRINT_CSS = `
.ot-handover__sheet { margin-bottom: var(--ot-space-5); }
.ot-handover__check { display: inline-block; width: 14px; height: 14px; border: 1.5px solid currentColor; border-radius: 2px; }
.ot-handover__signatures { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--ot-space-4); margin-top: var(--ot-space-5); }
.ot-handover__line { border-bottom: 1px solid currentColor; min-height: 28px; }
@media print {
  .ot-handover__sheet { margin: 0; break-after: page; page-break-after: always; }
  .ot-handover__sheet:last-child { break-after: auto; page-break-after: auto; }
}
`;

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  try {
    requirePermission(ctx.actor, "packing.perform");
    requirePermission(ctx.actor, "orders.view");
  } catch {
    throw new Response("Forbidden", { status: 403 });
  }
  const ids = new URL(request.url).searchParams.getAll("ids");
  const list = await loadHandoverList(ctx, ids.length > 0 ? { orderIds: ids } : {});
  return { ...list, printedAt: ctx.now() };
}

type Data = ReturnType<typeof useLoaderData<typeof loader>>;
const DASH = "—";

export default function HandoverListPage() {
  const data = useLoaderData<typeof loader>();
  const t = useT();
  const href = useHref();
  return (
    <Page
      title={t("packing.handover.title", { count: data.total })}
      subtitle={t("packing.handover.subtitle")}
      backHref={href("picking")}
      backLabel={t("packing.print.back")}
      primaryAction={
        data.total > 0 ? (
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
              {t(data.selection ? "packing.handover.noteSelection" : "packing.handover.note")}
            </Text>
            {data.hasTest ? <Banner tone="warning">{t("packing.handover.testWarning")}</Banner> : null}
            {data.truncated ? <Banner tone="warning">{t("packing.handover.truncated", { count: MAX_HANDOVER_ORDERS })}</Banner> : null}
            {data.skipped.length > 0 ? (
              <Banner tone="warning" title={t("packing.handover.skipped", { count: data.skipped.length })}>
                <ul>
                  {data.skipped.map((s) => (
                    <li key={s.orderId}>{t("packing.labels.skippedLine", { number: s.orderNumber, reason: t(`packing.handover.reason.${s.reason}`) })}</li>
                  ))}
                </ul>
              </Banner>
            ) : null}
          </Stack>
        </div>
        {data.total === 0 ? (
          <EmptyState
            title={t("packing.handover.empty")}
            description={t("packing.handover.emptyHint")}
            action={<Button to={href("picking?tab=packed")}>{t("packing.print.back")}</Button>}
          />
        ) : (
          <div>
            {data.groups.map((g) => (
              <GroupSheet key={g.carrierCode} group={g} printedAt={data.printedAt} />
            ))}
          </div>
        )}
      </Stack>
    </Page>
  );
}

function GroupSheet({ group, printedAt }: { group: HandoverGroup; printedAt: Data["printedAt"] }) {
  const t = useT();
  const locale = useLocale();
  const test = group.parcels.some((p) => p.testMode);
  const meta: { label: string; value: ReactNode }[] = [
    { label: t("packing.handover.carrier"), value: test ? t("demo.testCarrier") : group.carrierName },
    { label: t("packing.handover.printedAt"), value: formatDateTime(printedAt, locale) },
    { label: t("packing.handover.parcels"), value: group.parcels.length },
    { label: t("packing.handover.totalWeight"), value: formatWeight(group.totalWeightGrams, locale) },
  ];
  return (
    <article className="ot-invoice ot-handover__sheet" aria-label={t("packing.handover.sheetTitle", { carrier: group.carrierName })}>
      <header className="ot-invoice__header">
        <h2 className="ot-invoice__title">
          {t("packing.handover.sheetTitle", { carrier: test ? t("demo.testCarrier") : group.carrierName })}
          {test ? (
            <>
              {" "}
              <TestBadge />
            </>
          ) : null}
        </h2>
        <dl className="ot-invoice__meta">
          {meta.map((m) => (
            <div key={m.label} className="ot-invoice__meta-row">
              <dt>{m.label}</dt>
              <dd>{m.value}</dd>
            </div>
          ))}
        </dl>
      </header>
      <div className="ot-invoice__table-wrap">
        <table className="ot-invoice__table">
          <thead>
            <tr>
              <th scope="col">✓</th>
              <th scope="col" className="ot-invoice__num">
                №
              </th>
              <th scope="col">{t("packing.handover.col.waybill")}</th>
              <th scope="col">{t("packing.handover.col.order")}</th>
              <th scope="col">{t("packing.handover.col.destination")}</th>
              <th scope="col" className="ot-invoice__num">
                {t("packing.handover.col.weight")}
              </th>
              <th scope="col">{t("packing.handover.col.packedBy")}</th>
            </tr>
          </thead>
          <tbody>
            {group.parcels.map((p, index) => (
              <tr key={p.orderId}>
                <td>
                  <span className="ot-handover__check" aria-hidden="true" />
                </td>
                <td className="ot-invoice__num">{index + 1}</td>
                <td>
                  <span className="ot-invoice__desc">{p.waybillNumber}</span>
                  {p.testMode ? <span className="ot-invoice__sub">TEST</span> : null}
                </td>
                <td>{p.orderNumber}</td>
                <td>{[p.countryCode, p.city].filter(Boolean).join(", ") || DASH}</td>
                <td className="ot-invoice__num">
                  {p.waybillWeightGrams === null ? DASH : formatWeight(p.waybillWeightGrams, locale)}
                  {p.packedWeightGrams !== null && p.packedWeightGrams !== p.waybillWeightGrams ? (
                    <span className="ot-invoice__sub">{t("packing.handover.packedWeight", { weight: formatWeight(p.packedWeightGrams, locale) })}</span>
                  ) : null}
                </td>
                <td>{p.packedByName ? `${p.packedByName}${p.packedAt ? ` · ${formatDateTime(p.packedAt, locale)}` : ""}` : DASH}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="ot-handover__signatures">
        <div>
          <p className="ot-invoice__label">{t("packing.handover.sign.handedBy")}</p>
          <div className="ot-handover__line" />
        </div>
        <div>
          <p className="ot-invoice__label">{t("packing.handover.sign.receivedBy")}</p>
          <div className="ot-handover__line" />
        </div>
        <div>
          <p className="ot-invoice__label">{t("packing.handover.sign.dateTime")}</p>
          <div className="ot-handover__line" />
        </div>
      </div>
      <p className="ot-invoice__sub">{t("packing.handover.footer")}</p>
    </article>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";
