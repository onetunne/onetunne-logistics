/**
 * Етап 6, WP0-UI: поле файлу UI-кіту (FileInput) і поле файлу фінансів (FinanceFileInput) — §7.3, §18.5, §18.9.
 * Справжній `<input type="file">` (iPhone «Файли»), підпис, назва файлу, підказка, помилка (aria-describedby /
 * aria-invalid / role=alert), перевірка розширення й розміру в браузері (сервер перевіряє сам), розмір «14 МБ».
 */
import { createElement as h } from "react";
import { describe, expect, it } from "vitest";
import { FinanceFileInput, formatFileSize } from "~/components/finance/file-field";
import { FileInput, acceptedExtensions, checkFile } from "~/ui";
import { CYRILLIC, attr, renderUi, textOf } from "./render";

const MB = 1024 * 1024;

describe("pure checks", () => {
  it("accepted extensions come from accept (MIME types ignored)", () => {
    expect(acceptedExtensions(".xlsx, .CSV,text/csv")).toEqual([".xlsx", ".csv"]);
    expect(acceptedExtensions(undefined)).toEqual([]);
  });

  it("wrong type and too large are detected without reading the file", () => {
    const opts = { accept: ".xlsx,.csv", maxBytes: 10 * MB };
    expect(checkFile({ name: "invoice.xlsx", size: 10 * MB }, opts)).toBeNull();
    expect(checkFile({ name: "INVOICE.CSV", size: 1 }, opts)).toBeNull();
    expect(checkFile({ name: "invoice.xlsx", size: 10 * MB + 1 }, opts)).toBe("tooLarge");
    expect(checkFile({ name: "old.xls", size: 1 }, opts)).toBe("wrongType");
    expect(checkFile({ name: "x.pdf", size: 1 }, {})).toBeNull();
  });

  it("file size: bytes, KB and MB with one decimal (uk / en)", () => {
    expect(formatFileSize(512, "uk")).toBe("512 Б");
    expect(formatFileSize(1536, "uk")).toBe("1,5 КБ");
    expect(formatFileSize(14 * MB, "uk")).toBe("14 МБ");
    expect(formatFileSize(10 * MB, "uk")).toBe("10 МБ");
    expect(formatFileSize(14_000_000, "uk")).toBe("13,4 МБ");
    expect(formatFileSize(14 * MB, "en")).toBe("14 MB");
    expect(formatFileSize(2048, "en")).toBe("2 KB");
  });
});

describe("FileInput (UI kit)", () => {
  it("renders a real file input with accept, label, status and help wired via aria-describedby", async () => {
    const html = await renderUi(() =>
      h(FileInput, {
        label: "Рахунок",
        name: "file",
        accept: ".xlsx,.csv",
        buttonLabel: "Виберіть файл",
        emptyLabel: "Файл не вибрано",
        helpText: "До 10 МБ",
        required: true,
      }),
    );
    const input = /<input[^>]*type="file"[^>]*>/.exec(html)![0];
    expect(input).toContain('name="file"');
    expect(input).toContain('accept=".xlsx,.csv"');
    expect(input).toContain('id="ot-file"');
    expect(input).toContain("required");
    expect(attr(html, /<input[^>]*type="file"[^>]*>/, "aria-describedby")).toBe("ot-file-status ot-file-help");
    expect(html).toContain('<label for="ot-file" class="ot-field__label">Рахунок');
    expect(textOf(html)).toBe("Рахунок * Виберіть файл Файл не вибрано До 10 МБ");
    expect(html).not.toContain("aria-invalid");
  });

  it("server error → aria-invalid + role=alert; a file kept between wizard steps is shown by name", async () => {
    const html = await renderUi(() =>
      h(FileInput, {
        label: "Файл",
        name: "upload",
        id: "step1-file",
        buttonLabel: "Виберіть файл",
        changeLabel: "Вибрати інший файл",
        emptyLabel: "Файл не вибрано",
        error: "Файл завеликий (14 МБ). Максимум — 10 МБ.",
        selectedFile: { name: "invoice-1234.xlsx", size: 2 * MB },
        describeFile: (f) => `${f.name} · ${f.size}`,
      }),
    );
    expect(html).toContain('aria-invalid="true"');
    expect(html).toMatch(/<p id="step1-file-error" class="ot-field__error" role="alert">/);
    expect(attr(html, /<input[^>]*type="file"[^>]*>/, "aria-describedby")).toBe("step1-file-status step1-file-error");
    expect(textOf(html)).toContain(`Вибрати інший файл invoice-1234.xlsx · ${2 * MB}`);
    expect(html).toContain("ot-field--invalid");
  });
});

describe("FinanceFileInput", () => {
  it("uk/en texts and .xlsx,.csv by default", async () => {
    const uk = await renderUi(() => h(FinanceFileInput, { label: "Рахунок або специфікація", name: "file", maxBytes: 10 * MB }));
    expect(uk).toContain('accept=".xlsx,.csv"');
    expect(textOf(uk)).toBe("Рахунок або специфікація Виберіть файл Файл не вибрано");
    const en = await renderUi(() => h(FinanceFileInput, { label: "Invoice", name: "file", selectedFile: { name: "a.csv", size: 1536 } }), { locale: "en" });
    expect(textOf(en)).toBe("Invoice Choose another file a.csv · 1.5 KB");
    expect(textOf(en)).not.toMatch(CYRILLIC);
  });
});
