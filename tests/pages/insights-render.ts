import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { Outlet, StaticRouterProvider, createStaticHandler, createStaticRouter } from "react-router";
import { expect } from "vitest";
import type { ShellData } from "~/components/shell-types";
import type { Actor } from "~/domain/permissions";

/** Маршрут сторінки для серверного рендеру (loader/action/компонент модуля сторінки). */
export interface PageRoute {
  path: string;
  loader: (args: never) => unknown;
  action?: (args: never) => unknown;
  Component: () => unknown;
}

/**
 * Серверний рендер сторінки в демо-оболонці (/demo/…) для актора й мови — без браузера. Контекст запиту
 * (getRequestContext) кожен тестовий файл підміняє сам.
 */
export async function renderPage(route: PageRoute, url: string, actor: Actor, locale: "uk" | "en" = "uk"): Promise<string> {
  const shell: ShellData = {
    mode: "demo",
    basePath: "/demo",
    actor: { id: actor.id, displayName: actor.displayName, role: actor.role, permissions: [...actor.permissions] },
    nav: [],
    automation: { mode: "semi", globalPause: false },
    openProblems: 0,
    demo: null,
  };
  const routes = [
    {
      id: "root",
      path: "/",
      loader: () => ({ locale }),
      Component: Outlet,
      children: [
        {
          id: "routes/demo-layout",
          path: "demo",
          loader: () => shell,
          Component: Outlet,
          children: [{ id: "page", path: route.path, loader: route.loader, action: route.action, Component: route.Component }],
        },
      ],
    },
  ];
  const handler = createStaticHandler(routes as never);
  const context = await handler.query(new Request(`http://localhost${url}`));
  if (context instanceof Response) throw new Error(`unexpected response ${context.status}`);
  expect(context.errors).toBeNull();
  return renderToString(h(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context }));
}

/** Текст у HTML (екранування React: & < > " '). */
export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
