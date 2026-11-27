/**
 * Список передачі перевізнику (/picking/handover): рядки для підписів стоять на одній лінії. Підписи мають різну
 * довжину («Прийняв (перевізник): ПІБ, підпис» переноситься у вузькій колонці) — без вирівнювання клітинки за низом
 * лінія під довшим підписом опинялася нижче за інші (видно в E2E на ПК і телефоні). Перевірка геометрії — у
 * scripts/e2e-stage5.mjs (крок «carrier handover list»); тут — правило стилю сторінки, що її забезпечує.
 */
import fs from "node:fs";
import path from "node:path";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { Outlet, StaticRouterProvider, createStaticHandler, createStaticRouter } from "react-router";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ShellData } from "~/components/shell-types";
import type { RequestContext } from "~/server/types";
import { STAFF, createTestEnv, type TestEnv } from "../helpers";

const m = vi.hoisted(() => ({ ctx: null as RequestContext | null }));
vi.mock("~/server/context.server", () => ({
  getRequestContext: async () => {
    if (!m.ctx) throw new Error("test context is not set");
    return m.ctx;
  },
}));

let env: TestEnv;
let page: typeof import("~/pages/handover-list");

beforeAll(async () => {
  env = await createTestEnv();
  page = await import("~/pages/handover-list");
});
afterAll(async () => {
  await env.close();
});

async function render(): Promise<string> {
  m.ctx = { ...env.ctx(STAFF), mode: "demo", basePath: "/demo", locale: "uk" };
  const shell: ShellData = {
    mode: "demo",
    basePath: "/demo",
    actor: { id: STAFF.id, displayName: STAFF.displayName, role: STAFF.role, permissions: [...STAFF.permissions] },
    nav: [],
    automation: { mode: "semi", globalPause: false },
    openProblems: 0,
    demo: null,
  };
  const routes = [
    {
      id: "root",
      path: "/",
      loader: () => ({ locale: "uk" }),
      Component: Outlet,
      children: [
        {
          id: "routes/demo-layout",
          path: "demo",
          loader: () => shell,
          Component: Outlet,
          children: [{ id: "page", path: "picking/handover", loader: page.loader, Component: page.default }],
        },
      ],
    },
  ];
  const handler = createStaticHandler(routes as never);
  const context = await handler.query(new Request("http://localhost/demo/picking/handover"));
  if (context instanceof Response) throw new Error(`unexpected response ${context.status}`);
  expect(context.errors).toBeNull();
  return renderToString(h(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context }));
}

describe("handover list and pick list print layout", () => {
  it("signature cells align their lines at the bottom (labels of different length)", async () => {
    const html = await render();
    const css = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
    const rule = /\.ot-handover__sign\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/display:\s*flex/);
    expect(rule).toMatch(/flex-direction:\s*column/);
    expect(rule).toMatch(/justify-content:\s*flex-end/);
    // Кожна клітинка підпису має цей клас (три підписи).
    const source = fs.readFileSync(path.resolve("app/pages/handover-list.tsx"), "utf8");
    expect(source.match(/<div className="ot-handover__sign">/g)).toHaveLength(3);
  });

  it("pick list: on phones the item details take the full row width; materials are a checklist without bullets", () => {
    // 320 px: у колонці між фото й кількістю лишалося ~100 px — SKU й штрихкод ламалися посередині (E2E-знімок).
    const source = fs.readFileSync(path.resolve("app/pages/pick-list.tsx"), "utf8");
    const css = /const PRINT_CSS = `([\s\S]*?)`;/.exec(source)?.[1] ?? "";
    const phone = /@media \(max-width: 480px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(phone).toMatch(/\.ot-pick__meta \{ grid-column: 1 \/ -1; grid-row: 2; \}/);
    expect(phone).toMatch(/\.ot-pick__qty \{ grid-column: 3; grid-row: 1; \}/);
    expect(css).toMatch(/\.ot-pick__materials \{ list-style: none;/);
    expect(source).toContain('<ul className="ot-pick__materials">');
  });

  it("inline print CSS has no characters React escapes in <style> (the browser would not decode &gt; there)", () => {
    // React 18 SSR екранує текст <style> (> → &gt;), а браузер не розкодовує сутності в <style>: правило з «>»
    // (дочірній селектор), лапками чи «&» тихо не діяло б. Тож у вбудованих стилях сторінок друку — лише класи.
    for (const file of ["app/pages/handover-list.tsx", "app/pages/pick-list.tsx", "app/pages/print-batch.tsx"]) {
      const source = fs.readFileSync(path.resolve(file), "utf8");
      const css = /const PRINT_CSS = `([\s\S]*?)`;/.exec(source)?.[1];
      expect(css, file).toBeTruthy();
      expect(css!.match(/[<>&"']/g), file).toBeNull();
    }
  });
});
