/**
 * Частка браку в переліку партій і на сторінці партії форматується за мовою інтерфейсу (E2E R6: на телефоні в
 * переліку було «2 (6.7%)» з десятковою крапкою, тоді як статистика виробництва показувала «6,5 %»). Українською —
 * десяткова кома, англійською — крапка. Вигаданий товар «Defect Rate Test», партія 10 + 2 + 18 = 2 брак із 30.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { productionBatchLines, productionBatches } from "~/db/schema";
import { DICTIONARIES } from "~/i18n";
import { createBatch, receiveProduction, startProduction } from "~/modules/production/batches.server";
import type { RequestContext } from "~/server/types";
import { OWNER, createTestEnv, type TestEnv } from "../helpers";
import { insertProduct } from "../stage5/helpers";
import { esc, renderPage } from "./insights-render";

const m = vi.hoisted(() => ({ ctx: null as RequestContext | null }));
vi.mock("~/server/context.server", () => ({
  getRequestContext: async () => {
    if (!m.ctx) throw new Error("test context is not set");
    return m.ctx;
  },
}));

let env: TestEnv;
let list: typeof import("~/pages/production");
let batchPage: typeof import("~/pages/production-batch");
let batchId = "";

beforeAll(async () => {
  env = await createTestEnv();
  list = await import("~/pages/production");
  batchPage = await import("~/pages/production-batch");
  const p = await insertProduct(env.handle.db, "Defect Rate Test", [{ sku: "DR-1", color: "Black", model: "R" }]);
  const variantId = p.variantIds[0]!;
  ({ batchId } = await createBatch(env.ctx(OWNER), { title: "Defect rate", lines: [{ variantId, quantity: 30 }] }));
  const [b] = await env.handle.db.select().from(productionBatches).where(eq(productionBatches.id, batchId));
  await startProduction(env.ctx(OWNER), batchId, b!.version);
  const [line] = await env.handle.db.select().from(productionBatchLines).where(eq(productionBatchLines.batchId, batchId));
  await receiveProduction(env.ctx(OWNER), batchId, {
    idempotencyKey: globalThis.crypto.randomUUID(),
    lines: [{ batchLineId: line!.id, good: 28, defective: 2, defectReason: "подряпина" }],
  });
});
afterAll(async () => {
  await env.close();
});

const expected = (locale: "uk" | "en") =>
  esc(DICTIONARIES[locale]["production.defectValue"]!.replace("{count}", "2").replace("{rate}", locale === "uk" ? "6,7" : "6.7"));

describe("defect share is formatted for the interface language", () => {
  for (const locale of ["uk", "en"] as const) {
    it(`${locale}: batch list and batch page`, async () => {
      m.ctx = { ...env.ctx(OWNER), basePath: "/demo", locale };
      const listHtml = await renderPage({ path: "production", loader: list.loader, Component: list.default }, "/demo/production?tab=all", OWNER, locale);
      expect(listHtml).toContain(expected(locale));
      const pageHtml = await renderPage(
        { path: "production/:batchId", loader: batchPage.loader, Component: batchPage.default },
        `/demo/production/${batchId}`,
        OWNER,
        locale,
      );
      expect(pageHtml).toContain(expected(locale));
      if (locale === "uk") {
        expect(listHtml).not.toContain("6.7%");
        expect(pageHtml).not.toContain("6.7%");
      }
    });
  }
});
