import type { ReactNode } from "react";
import { useLoaderData, type LoaderFunctionArgs } from "react-router";
import { useHref } from "~/components/shell";
import { requirePermission } from "~/domain/permissions";
import type { ExportReason, Incoterm } from "~/integrations/carriers/types";
import { useLocale, useT } from "~/i18n";
import { formatDateTime, formatMoney, formatWeight } from "~/lib/format";
import { PRINT_DOCUMENTS, PRIORITY_KEYS, type PrintDocument } from "~/modules/packing/constants";
import { loadPrintBatch, type PackingSlip, type PrintBatchEntry } from "~/modules/packing/documents.server";
import { parseOrderIds } from "~/modules/packing/queue-filters";
import { getRequestContext } from "~/server/context.server";
import { Banner, Button, EmptyState, Page, Stack, Text } from "~/ui";
import type { OrderPriority } from "~/db/schema";

/**
 * Масовий друк (picking/print?ids=…&docs=slip,invoice): пакувальні листи й комерційні інвойси застосунку,
 * кожен документ — з нової сторінки (одне замовлення за раз), A4. Порядок — як у черзі (пріоритет ↓, дата ↑).
 * Пакувальний лист — мовою інтерфейсу (для складу); інвойс — англійською (для митниці), як на сторінці інвойсу.
 * Друкується лише документ (стилі друку .ot-invoice-page у app/ui/styles.css + розриви сторінок нижче).
 */

/** Розриви сторінок і відступи між аркушами (лише для цієї сторінки). */
const PRINT_CSS = `
.ot-print-batch__sheet { margin-bottom: var(--ot-space-5); }
.ot-print-batch__thumb { width: 40px; height: 40px; object-fit: cover; border-radius: 4px; vertical-align: middle; }
.ot-print-batch__check { display: inline-block; width: 14px; height: 14px; border: 1.5px solid currentColor; border-radius: 2px; }
@media print {
  .ot-print-batch__sheet { margin: 0; break-after: page; page-break-after: always; }
  .ot-print-batch__sheet:last-child { break-after: auto; page-break-after: auto; }
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
  const params = new URL(request.url).searchParams;
  const ids = parseOrderIds(params.getAll("ids"), 1000);
  const requested = (params.get("docs") ?? "").split(",").filter((d): d is PrintDocument => (PRINT_DOCUMENTS as readonly string[]).includes(d));
  const docs: PrintDocument[] = requested.length > 0 ? [...new Set(requested)] : [...PRINT_DOCUMENTS];
  const batch = ids.length > 0 ? await loadPrintBatch(ctx, ids, docs, ctx.locale) : { entries: [], missing: 0, truncated: false };
  return { ids, docs, ...batch };
}

type Data = ReturnType<typeof useLoaderData<typeof loader>>;

const INCOTERM_LABEL: Record<Incoterm, string> = { DAP: "DAP (Delivered At Place)", DDP: "DDP (Delivered Duty Paid)" };
const EXPORT_REASON_LABEL: Record<ExportReason, string> = { sale: "Sale", personal: "Personal use", repair: "Repair", return: "Return", other: "Other" };
const DASH = "—";

function Value({ value }: { value: ReactNode }) {
  if (value === null || value === undefined || value === "") return <span className="ot-invoice__missing">{DASH}</span>;
  return <>{value}</>;
}

export default function PrintBatchPage() {
  const data = useLoaderData<typeof loader>();
  const t = useT();
  const href = useHref();
  const idsQuery = data.ids.map((id) => `ids=${encodeURIComponent(id)}`).join("&");
  const docsHref = (docs: readonly PrintDocument[]) => `${href("picking/print")}?${idsQuery}&docs=${docs.join(",")}`;
  const only = (d: PrintDocument) => data.docs.length === 1 && data.docs[0] === d;
  const both = data.docs.length === PRINT_DOCUMENTS.length;

  return (
    <Page
      title={t("packing.print.title", { count: data.entries.length })}
      subtitle={t("packing.print.subtitle")}
      backHref={href("picking")}
      backLabel={t("packing.print.back")}
      primaryAction={
        data.entries.length > 0 ? (
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
            <Stack direction="horizontal" gap={2} wrap>
              <Button size="sm" variant={both ? "primary" : "secondary"} to={docsHref(PRINT_DOCUMENTS)}>
                {t("packing.print.docs.both")}
              </Button>
              <Button size="sm" variant={only("slip") ? "primary" : "secondary"} to={docsHref(["slip"])}>
                {t("packing.print.docs.slip")}
              </Button>
              <Button size="sm" variant={only("invoice") ? "primary" : "secondary"} to={docsHref(["invoice"])}>
                {t("packing.print.docs.invoice")}
              </Button>
            </Stack>
            <Text variant="body-sm" tone="subdued">
              {t("packing.print.note")}
            </Text>
            {data.truncated ? <Banner tone="warning">{t("packing.print.truncated", { count: data.entries.length })}</Banner> : null}
            {data.missing > 0 ? <Banner tone="warning">{t("packing.print.missing", { count: data.missing })}</Banner> : null}
          </Stack>
        </div>
        {data.entries.length === 0 ? (
          <EmptyState
            title={t("packing.print.empty")}
            description={t("packing.print.emptyHint")}
            action={<Button to={href("picking")}>{t("packing.print.back")}</Button>}
          />
        ) : (
          <div>
            {data.entries.flatMap((entry, index) => sheets(entry, index))}
          </div>
        )}
      </Stack>
    </Page>
  );
}

function sheets(entry: PrintBatchEntry, index: number): ReactNode[] {
  const out: ReactNode[] = [];
  if (entry.slip) out.push(<SlipSheet key={`slip-${index}`} slip={entry.slip} />);
  if (entry.invoice) out.push(<InvoiceSheet key={`invoice-${index}`} invoice={entry.invoice} />);
  return out;
}

function SlipSheet({ slip }: { slip: PackingSlip }) {
  const t = useT();
  const locale = useLocale();
  const units = slip.lines.reduce((s, l) => s + l.quantity, 0);
  const meta: { label: string; value: ReactNode }[] = [
    { label: t("packing.slip.order"), value: slip.orderNumber },
    { label: t("packing.slip.placed"), value: formatDateTime(slip.placedAt, locale) },
    { label: t("packing.slip.priority"), value: t(`packing.priority.${PRIORITY_KEYS[slip.priority as OrderPriority] ?? "normal"}`) },
    {
      label: t("packing.slip.waybill"),
      value: slip.waybillNumber ? `${slip.waybillNumber}${slip.testMode ? ` (${t("common.test")})` : ""}` : null,
    },
    { label: t("packing.slip.carrier"), value: slip.testMode ? t("demo.testCarrier") : slip.carrierName },
  ];
  return (
    <article className="ot-invoice ot-print-batch__sheet" aria-label={t("packing.slip.title", { number: slip.orderNumber })}>
      <header className="ot-invoice__header">
        <h2 className="ot-invoice__title">{t("packing.slip.title", { number: slip.orderNumber })}</h2>
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
        <section className="ot-invoice__party">
          <h3 className="ot-invoice__label">{t("packing.slip.recipient")}</h3>
          <p className="ot-invoice__party-name">
            <Value value={slip.recipient.name} />
          </p>
          <p>{[slip.recipient.postalCode, slip.recipient.city].filter(Boolean).join(" ") || DASH}</p>
          <p>{slip.recipient.countryName ? `${slip.recipient.countryName} (${slip.recipient.countryCode})` : DASH}</p>
        </section>
        <section className="ot-invoice__party">
          <h3 className="ot-invoice__label">{t("packing.slip.packing")}</h3>
          <p>{t("packing.slip.startedBy", { name: slip.startedByName ?? DASH })}</p>
          <p>{t("packing.slip.packedBy", { name: slip.packedByName ?? DASH })}</p>
        </section>
      </div>
      <div className="ot-invoice__table-wrap">
        <table className="ot-invoice__table">
          <thead>
            <tr>
              <th scope="col">✓</th>
              <th scope="col">{t("packing.slip.item")}</th>
              <th scope="col">{t("packing.slip.sku")}</th>
              <th scope="col" className="ot-invoice__num">
                {t("packing.slip.qty")}
              </th>
            </tr>
          </thead>
          <tbody>
            {slip.lines.map((l) => (
              <tr key={l.id}>
                <td>
                  <span className="ot-print-batch__check" aria-hidden="true" />
                </td>
                <td>
                  <Stack as="span" direction="horizontal" gap={2} align="center" wrap={false}>
                    {l.imageUrl ? <img className="ot-print-batch__thumb" src={l.imageUrl} alt="" loading="lazy" /> : null}
                    <span>
                      <span className="ot-invoice__desc">{l.title}</span>
                      {l.variantTitle ? <span className="ot-invoice__sub">{l.variantTitle}</span> : null}
                      {l.model || l.color ? <span className="ot-invoice__sub">{[l.model, l.color].filter(Boolean).join(" · ")}</span> : null}
                    </span>
                  </Stack>
                </td>
                <td>
                  <Value value={l.sku} />
                </td>
                <td className="ot-invoice__num">{l.quantity}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="ot-invoice__totals">
        <div className="ot-invoice__meta-row">
          <dt>{t("packing.slip.totalUnits")}</dt>
          <dd>{units}</dd>
        </div>
      </dl>
      {slip.otherLines.length > 0 ? (
        <p className="ot-invoice__sub">
          {t("packing.slip.otherLines", { list: slip.otherLines.map((l) => `${l.title} × ${l.quantity}`).join(", ") })}
        </p>
      ) : null}
      <section className="ot-invoice__declaration">
        <h3 className="ot-invoice__label">{t("packing.slip.addToParcel")}</h3>
        {slip.materials.length === 0 ? (
          <p>{t("packing.slip.noMaterials")}</p>
        ) : (
          <ul>
            {slip.materials.map((m) => (
              <li key={m.code}>
                <span className="ot-print-batch__check" aria-hidden="true" /> {m.name} × {m.quantity}
                {m.isBox ? ` (${t("packing.materials.box")})` : ""}
              </li>
            ))}
          </ul>
        )}
        {slip.note ? <p>{t("packing.slip.note", { note: slip.note })}</p> : null}
      </section>
    </article>
  );
}

function InvoiceSheet({ invoice: entry }: { invoice: NonNullable<PrintBatchEntry["invoice"]> }) {
  const invoice = entry.data;
  const money = (amount: string) => formatMoney(amount, invoice.currency, "en");
  const weight = (grams: number | null) => (grams === null ? null : formatWeight(grams, "en"));
  const units = invoice.lines.reduce((sum, l) => sum + l.quantity, 0);
  const title = invoice.type === "proforma" ? "PROFORMA INVOICE" : "COMMERCIAL INVOICE";
  const meta: { label: string; value: ReactNode }[] = [
    { label: "Invoice No.", value: invoice.number },
    { label: "Invoice date", value: invoice.date },
    { label: "Waybill / AWB No.", value: invoice.waybillNumber },
    { label: "Incoterms", value: INCOTERM_LABEL[invoice.incoterm] },
    { label: "Reason for export", value: EXPORT_REASON_LABEL[invoice.exportReason] },
    { label: "Currency", value: invoice.currency },
  ];
  const party = (heading: string, p: typeof invoice.seller, country: string | null, showTaxId: boolean) => (
    <section className="ot-invoice__party">
      <h3 className="ot-invoice__label">{heading}</h3>
      <p className="ot-invoice__party-name">
        <Value value={p.company ?? p.name} />
      </p>
      {p.company && p.name ? <p>Contact: {p.name}</p> : null}
      {p.addressLines.map((line, i) => (
        <p key={i}>{line}</p>
      ))}
      <p>
        <Value value={p.countryCode ? `${country ?? p.countryCode} (${p.countryCode})` : null} />
      </p>
      {showTaxId ? (
        <p>
          Tax ID: <Value value={p.taxId} />
        </p>
      ) : null}
      {p.eori ? <p>EORI: {p.eori}</p> : null}
      {p.ioss ? <p>IOSS: {p.ioss}</p> : null}
      {p.phone ? <p>Phone: {p.phone}</p> : null}
      {p.email ? <p>Email: {p.email}</p> : null}
    </section>
  );
  return (
    <article className="ot-invoice ot-print-batch__sheet" aria-label={title} lang="en">
      <header className="ot-invoice__header">
        <h2 className="ot-invoice__title">{title}</h2>
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
        {party("Seller / Exporter", invoice.seller, entry.sellerCountry, true)}
        {party("Buyer / Consignee", invoice.buyer, entry.buyerCountry, false)}
      </div>
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
          I declare that the information on this invoice is true and correct and that the contents of this shipment are as stated
          above.
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
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";
