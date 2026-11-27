import type { ReactNode } from "react";
import { useLoaderData, type LoaderFunctionArgs } from "react-router";
import { useHref } from "~/components/shell";
import { ForbiddenError, requirePermission } from "~/domain/permissions";
import { useT, type TFunction } from "~/i18n";
import type { ExportReason, Incoterm } from "~/integrations/carriers/types";
import { NotFoundError } from "~/lib/errors";
import { countryName, formatMoney, formatWeight } from "~/lib/format";
import type { CommercialInvoice, InvoiceMissingField, InvoiceParty } from "~/modules/customs/invoice";
import { loadOrderRow } from "~/modules/orders/repository.server";
import { loadOrderInvoice } from "~/modules/shipments/documents.server";
import { getRequestContext } from "~/server/context.server";
import { Banner, Button, Page, Stack, Text } from "~/ui";

/**
 * Комерційний інвойс застосунку для друку (A4): …/orders/:orderId/invoice.
 * Дані — з modules/customs/invoice (нічого не вигадується; відсутні митні дані показуються попередженням).
 * Підписи полів документа — англійською (його читає митниця країни призначення); інтерфейс навколо — через t().
 * Друкується лише сам документ (див. @media print у app/ui/styles.css).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Мова документа (гроші, вага, назви країн) — англійська незалежно від мови інтерфейсу. */
const DOC_LOCALE = "en" as const;

export async function loader({ request, params }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  try {
    requirePermission(ctx.actor, "orders.view");
  } catch {
    throw new Response("Forbidden", { status: 403 });
  }
  const raw = params.orderId ?? "";
  if (!UUID_RE.test(raw)) throw new Response("Not Found", { status: 404 });
  const orderId = raw.toLowerCase();
  try {
    // Номер замовлення для заголовка: loadOrderInvoice його не повертає (лише номер інвойсу), тому окремий
    // запит за первинним ключем — паралельно з побудовою інвойсу.
    const [invoice, order] = await Promise.all([loadOrderInvoice(ctx, orderId), loadOrderRow(ctx.db, orderId)]);
    return {
      orderId,
      orderNumber: order.orderNumber,
      invoice,
      // Назви країн — на сервері (однаковий текст під час гідратації).
      sellerCountry: invoice.seller.countryCode ? countryName(invoice.seller.countryCode, DOC_LOCALE) : null,
      buyerCountry: invoice.buyer.countryCode ? countryName(invoice.buyer.countryCode, DOC_LOCALE) : null,
    };
  } catch (e) {
    if (e instanceof NotFoundError) throw new Response("Not Found", { status: 404 });
    if (e instanceof ForbiddenError) throw new Response("Forbidden", { status: 403 });
    throw e;
  }
}

const DOC_TITLE: Record<CommercialInvoice["type"], string> = {
  commercial: "COMMERCIAL INVOICE",
  proforma: "PROFORMA INVOICE",
};

const INCOTERM_LABEL: Record<Incoterm, string> = {
  DAP: "DAP (Delivered At Place)",
  DDP: "DDP (Delivered Duty Paid)",
};

const EXPORT_REASON_LABEL: Record<ExportReason, string> = {
  sale: "Sale",
  personal: "Personal use",
  repair: "Repair",
  return: "Return",
  other: "Other",
};

const MISSING_FIELD_KEY: Record<InvoiceMissingField, string> = {
  hsCode: "field.variant.hsCode",
  countryOfOrigin: "field.variant.countryOfOrigin",
  customsDescription: "field.variant.customsDescription",
  weight: "field.variant.weightGrams",
};

const DASH = "—";

function PrintButton() {
  const t = useT();
  return (
    <Button variant="primary" className="ot-no-print" onClick={() => window.print()}>
      {t("tracking.invoice.print")}
    </Button>
  );
}

/** Відсутнє значення: прочерк, на екрані — виділений (у друці — звичайний). */
function Value({ value }: { value: ReactNode }) {
  if (value === null || value === undefined || value === "") return <span className="ot-invoice__missing">{DASH}</span>;
  return <>{value}</>;
}

function Party({ heading, party, country, showTaxId }: { heading: string; party: InvoiceParty; country: string | null; showTaxId: boolean }) {
  const title = party.company ?? party.name;
  return (
    <section className="ot-invoice__party">
      <h3 className="ot-invoice__label">{heading}</h3>
      <p className="ot-invoice__party-name">
        <Value value={title} />
      </p>
      {party.company && party.name ? <p>Contact: {party.name}</p> : null}
      {party.addressLines.map((line, index) => (
        <p key={index}>{line}</p>
      ))}
      <p>
        <Value value={party.countryCode ? `${country ?? party.countryCode} (${party.countryCode})` : null} />
      </p>
      {showTaxId ? (
        <p>
          Tax ID: <Value value={party.taxId} />
        </p>
      ) : null}
      {party.eori ? <p>EORI: {party.eori}</p> : null}
      {party.ioss ? <p>IOSS: {party.ioss}</p> : null}
      {party.phone ? <p>Phone: {party.phone}</p> : null}
      {party.email ? <p>Email: {party.email}</p> : null}
    </section>
  );
}

function missingLines(invoice: CommercialInvoice, t: TFunction): string[] {
  const byPosition = new Map<number, InvoiceMissingField[]>();
  for (const m of invoice.missing) byPosition.set(m.position, [...(byPosition.get(m.position) ?? []), m.field]);
  return [...byPosition.entries()].map(([position, fields]) =>
    t("tracking.invoice.missing.line", {
      position,
      item: invoice.lines.find((l) => l.position === position)?.title ?? String(position),
      fields: fields.map((f) => t(MISSING_FIELD_KEY[f])).join(", "),
    }),
  );
}

export default function OrderInvoicePage() {
  const { invoice, orderId, orderNumber, sellerCountry, buyerCountry } = useLoaderData<typeof loader>();
  const t = useT();
  const href = useHref();
  const money = (amount: string) => formatMoney(amount, invoice.currency, DOC_LOCALE);
  const weight = (grams: number | null) => (grams === null ? null : formatWeight(grams, DOC_LOCALE));
  const units = invoice.lines.reduce((sum, l) => sum + l.quantity, 0);
  const docTitle = DOC_TITLE[invoice.type];
  const missing = missingLines(invoice, t);

  const meta: { label: string; value: ReactNode }[] = [
    { label: "Invoice No.", value: invoice.number },
    { label: "Invoice date", value: invoice.date },
    { label: "Order No.", value: orderNumber },
    { label: "Waybill / AWB No.", value: invoice.waybillNumber },
    { label: "Incoterms", value: INCOTERM_LABEL[invoice.incoterm] },
    { label: "Reason for export", value: EXPORT_REASON_LABEL[invoice.exportReason] },
    { label: "Currency", value: invoice.currency },
  ];

  return (
    <Page
      title={t("tracking.invoice.title", { number: invoice.number })}
      subtitle={t("tracking.invoice.subtitle", { order: orderNumber })}
      backHref={href(`orders/${orderId}`)}
      backLabel={t("tracking.invoice.back")}
      primaryAction={<PrintButton />}
      className="ot-invoice-page"
    >
      {missing.length > 0 ? (
        <Banner
          tone="warning"
          className="ot-no-print"
          title={t("tracking.invoice.missing.title")}
          action={<Button to={href(`orders/${orderId}`)}>{t("tracking.invoice.missing.action")}</Button>}
        >
          <p>{t("tracking.invoice.missing.body")}</p>
          <ul>
            {missing.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Banner>
      ) : null}
      <Stack gap={1} className="ot-no-print">
        <Text variant="body-sm" tone="subdued">
          {t("tracking.invoice.note")}
        </Text>
        {!invoice.waybillNumber ? (
          <Text variant="body-sm" tone="subdued">
            {t("tracking.invoice.noWaybill")}
          </Text>
        ) : null}
      </Stack>

      <article className="ot-invoice" aria-label={docTitle} lang="en">
        <header className="ot-invoice__header">
          <h2 className="ot-invoice__title">{docTitle}</h2>
          <dl className="ot-invoice__meta">
            {meta.map((m) => (
              <div key={m.label} className="ot-invoice__meta-row">
                <dt>{m.label}</dt>
                <dd>
                  <Value value={m.value} />
                </dd>
              </div>
            ))}
          </dl>
        </header>

        <div className="ot-invoice__parties">
          <Party heading="Seller / Exporter" party={invoice.seller} country={sellerCountry} showTaxId />
          <Party heading="Buyer / Consignee" party={invoice.buyer} country={buyerCountry} showTaxId={false} />
        </div>

        <p className="ot-invoice__scroll-hint" aria-hidden="true">
          {t("tracking.invoice.scrollHint")}
        </p>
        <div className="ot-invoice__table-wrap">
          <table className="ot-invoice__table">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Description of goods</th>
                <th scope="col">HS code</th>
                <th scope="col">Origin</th>
                <th scope="col" className="ot-invoice__num">
                  Qty
                </th>
                <th scope="col" className="ot-invoice__num">
                  Unit value
                </th>
                <th scope="col" className="ot-invoice__num">
                  Total value
                </th>
                <th scope="col" className="ot-invoice__num">
                  Unit weight
                </th>
                <th scope="col" className="ot-invoice__num">
                  Total weight
                </th>
              </tr>
            </thead>
            <tbody>
              {invoice.lines.map((l) => (
                <tr key={l.position}>
                  <td>{l.position}</td>
                  <td>
                    <span className="ot-invoice__desc">{l.description}</span>
                    {l.descriptionLocal ? <span className="ot-invoice__sub">{l.descriptionLocal}</span> : null}
                    {l.material ? <span className="ot-invoice__sub">Material: {l.material}</span> : null}
                    {l.sku ? <span className="ot-invoice__sub">SKU: {l.sku}</span> : null}
                  </td>
                  <td>
                    <Value value={l.hsCode} />
                  </td>
                  <td>
                    <Value value={l.countryOfOrigin} />
                  </td>
                  <td className="ot-invoice__num">{l.quantity}</td>
                  <td className="ot-invoice__num">{money(l.unitValue)}</td>
                  <td className="ot-invoice__num">{money(l.lineValue)}</td>
                  <td className="ot-invoice__num">
                    <Value value={weight(l.unitWeightGrams)} />
                  </td>
                  <td className="ot-invoice__num">
                    <Value value={weight(l.lineWeightGrams)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <dl className="ot-invoice__totals">
          <div className="ot-invoice__meta-row">
            <dt>Total quantity</dt>
            <dd>{units}</dd>
          </div>
          <div className="ot-invoice__meta-row">
            <dt>Goods total</dt>
            <dd>{money(invoice.goodsTotal)}</dd>
          </div>
          <div className="ot-invoice__meta-row">
            <dt>Shipping charge</dt>
            <dd>{money(invoice.shippingCharge)}</dd>
          </div>
          <div className="ot-invoice__meta-row ot-invoice__grand">
            <dt>Total ({invoice.currency})</dt>
            <dd>{money(invoice.total)}</dd>
          </div>
          <div className="ot-invoice__meta-row">
            <dt>Total net weight</dt>
            <dd>
              <Value value={invoice.totalWeightGrams > 0 ? weight(invoice.totalWeightGrams) : null} />
            </dd>
          </div>
        </dl>

        <section className="ot-invoice__declaration">
          <p>
            I declare that the information on this invoice is true and correct and that the contents of this shipment are as
            stated above.
          </p>
          <div className="ot-invoice__signature">
            <div>
              <span className="ot-invoice__line" />
              <span className="ot-invoice__label">Name</span>
            </div>
            <div>
              <span className="ot-invoice__line" />
              <span className="ot-invoice__label">Signature</span>
            </div>
            <div>
              <span className="ot-invoice__line" />
              <span className="ot-invoice__label">Date</span>
            </div>
          </div>
        </section>
      </article>
    </Page>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";
