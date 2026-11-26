import { useState } from "react";
import type { CarrierDocumentKind } from "~/integrations/carriers/types";
import { hasKey, useT } from "~/i18n";
import { Banner, Button, Stack } from "~/ui";
import { useHref } from "./shell";

/**
 * Кнопки документів перевізника (PDF): етикетка, комерційний інвойс перевізника, митна декларація.
 *
 * Документ завантажується через window.fetch за відносним шляхом, а не звичайним посиланням:
 * у вбудованому застосунку Shopify App Bridge додає до fetch токен сесії, а перехід за посиланням
 * у новій вкладці втратив би автентифікацію. Отриманий PDF відкривається як blob у новій вкладці
 * (або, якщо браузер заблокував вкладку, завантажується файлом).
 *
 * Перенаправлення не виконуються (redirect: "manual"): після завершення сесії демо/Shopify перенаправляє
 * на сторінку входу, і без цього HTML-сторінка входу відкрилася б як «PDF». Відкривається лише вміст
 * дозволеного типу; blob створюється заново з перевіреним типом (HTML ніколи не відкривається в origin застосунку).
 */

const SESSION_ERROR = "tracking.documents.error.session";
const GENERIC_ERROR = "tracking.documents.error.generic";
const NETWORK_ERROR = "tracking.documents.error.network";

/** Типи вмісту, які можна відкрити як документ перевізника. */
const DOCUMENT_CONTENT_TYPES: readonly string[] = ["application/pdf", "image/png"];

/** Відповідь ресурсного маршруту (текстовий код) → ключ повідомлення. */
export function documentErrorKey(status: number, body: string): string {
  const code = body.trim();
  switch (code) {
    case "document.notAvailable":
    case "carrier.not_supported":
      return "tracking.documents.error.notAvailable";
    case "carrier.rejected":
      return "tracking.documents.error.rejected";
    case "carrier.unavailable":
    case "carrier.unknown_outcome":
      return "tracking.documents.error.unavailable";
    case "carrier.auth":
      return "tracking.documents.error.auth";
    case "carrier.not_configured":
      return "tracking.documents.error.notConfigured";
  }
  if (status === 403) return "tracking.documents.error.forbidden";
  if (status === 404) return "tracking.documents.error.notFound";
  if (status === 401) return "tracking.documents.error.session";
  return "tracking.documents.error.generic";
}

/** Ім'я файлу із заголовка Content-Disposition (лише безпечні символи). */
function fileNameFrom(response: Response, fallback: string): string {
  const header = response.headers.get("Content-Disposition") ?? "";
  const match = /filename="?([A-Za-z0-9._-]+)"?/.exec(header);
  return match?.[1] ?? fallback;
}

export const REVOKE_AFTER_MS = 60_000;

export type DocumentResponseResult = { ok: true; blob: Blob; fileName: string } | { ok: false; errorKey: string };

/**
 * Відповідь ресурсного маршруту → документ або ключ помилки.
 * Перенаправлення (вхід після завершення сесії) або HTML замість документа → «Сесія завершилася»;
 * інший недозволений тип → загальна помилка.
 */
export async function readDocumentResponse(response: Response, fallbackName: string): Promise<DocumentResponseResult> {
  if (response.type === "opaqueredirect" || response.redirected) return { ok: false, errorKey: SESSION_ERROR };
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return { ok: false, errorKey: documentErrorKey(response.status, body.slice(0, 100)) };
  }
  const type = (response.headers.get("Content-Type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "text/html") return { ok: false, errorKey: SESSION_ERROR };
  if (!DOCUMENT_CONTENT_TYPES.includes(type)) return { ok: false, errorKey: GENERIC_ERROR };
  const blob = new Blob([await response.arrayBuffer()], { type });
  return { ok: true, blob, fileName: fileNameFrom(response, fallbackName) };
}

/** Отримує документ і відкриває його. Повертає ключ помилки або null (документ відкрито). */
export async function downloadCarrierDocument(url: string, fallbackName: string): Promise<string | null> {
  let result: DocumentResponseResult;
  try {
    const response = await window.fetch(url, {
      credentials: "same-origin",
      redirect: "manual",
      headers: { Accept: "application/pdf" },
    });
    result = await readDocumentResponse(response, fallbackName);
  } catch {
    return NETWORK_ERROR;
  }
  if (!result.ok) return result.errorKey;
  openBlob(result.blob, result.fileName);
  return null;
}

function openBlob(blob: Blob, fileName: string): void {
  const objectUrl = URL.createObjectURL(blob);
  // Без "noopener": інакше window.open завжди повертає null і неможливо виявити заблоковану вкладку.
  const opened = window.open(objectUrl, "_blank");
  if (!opened) {
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = fileName;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), REVOKE_AFTER_MS);
}

export function CarrierDocumentButtons({
  orderId,
  shipmentId,
  kinds,
}: {
  orderId: string;
  shipmentId: string;
  kinds: readonly CarrierDocumentKind[];
}) {
  const t = useT();
  const href = useHref();
  const [pending, setPending] = useState<CarrierDocumentKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (kinds.length === 0) return null;

  async function download(kind: CarrierDocumentKind) {
    setError(null);
    setPending(kind);
    try {
      const url = href(`orders/${orderId}/shipments/${shipmentId}/documents/${kind}`);
      const errorKey = await downloadCarrierDocument(url, `${kind}.pdf`);
      if (errorKey) setError(errorKey);
    } catch {
      setError(GENERIC_ERROR);
    } finally {
      setPending(null);
    }
  }

  return (
    <Stack gap={2}>
      <Stack direction="horizontal" gap={2}>
        {kinds.map((kind) => (
          <Button
            key={kind}
            size="sm"
            loading={pending === kind}
            disabled={pending !== null && pending !== kind}
            onClick={() => void download(kind)}
          >
            {t(`tracking.documents.kind.${kind}`)}
          </Button>
        ))}
      </Stack>
      {error ? (
        <Banner tone="critical" title={t("tracking.documents.error.title")}>
          {hasKey(error) ? t(error) : t("tracking.documents.error.generic")}
        </Banner>
      ) : null}
    </Stack>
  );
}
