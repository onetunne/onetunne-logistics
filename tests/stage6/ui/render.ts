/**
 * Етап 6, WP0-UI: серверний рендер фінансових компонентів у справжньому маршрутизаторі (корінь з мовою + демо-оболонка),
 * як сторінки в tests/pages/insights-render.ts, але без loader-а сторінки. Лише SSR (середовище Vitest — node).
 */
import { createElement as h, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { Outlet, StaticRouterProvider, createStaticHandler, createStaticRouter } from "react-router";
import type { ShellData } from "~/components/shell-types";

export type TestLocale = "uk" | "en";

const SHELL: ShellData = {
  mode: "demo",
  basePath: "/demo",
  actor: { id: "owner-1", displayName: "Власник", role: "owner", permissions: ["finance.view", "finance.manage"] },
  nav: [],
  automation: { mode: "semi", globalPause: false },
  openProblems: 0,
  demo: null,
};

/** SSR компонента за адресою `url` (параметри запиту доступні useLocation) і мовою. */
export async function renderUi(element: () => ReactElement, opts: { locale?: TestLocale; url?: string } = {}): Promise<string> {
  const locale = opts.locale ?? "uk";
  const url = opts.url ?? "/demo/finance";
  const pagePath = new URL(`http://localhost${url}`).pathname.replace(/^\/demo\/?/, "") || "finance";
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
          loader: () => SHELL,
          Component: Outlet,
          children: [{ id: "page", path: pagePath, Component: () => element() }],
        },
      ],
    },
  ];
  const handler = createStaticHandler(routes as never);
  const context = await handler.query(new Request(`http://localhost${url}`));
  if (context instanceof Response) throw new Error(`unexpected response ${context.status}`);
  if (context.errors) throw new Error(`render errors: ${JSON.stringify(context.errors)}`);
  return renderToString(h(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context, hydrate: false }));
}

/** Видимий текст HTML (теги → пробіли, сутності React розкодовано, нерозривні пробіли → пробіл). */
export function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/[  ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Текст без вмісту елементів із класом ot-visually-hidden (лише видимий користувачу). */
export function visibleText(html: string): string {
  return textOf(html.replace(/<span class="ot-visually-hidden"[^>]*>[^<]*<\/span>/g, " "));
}

export const CYRILLIC = /[А-Яа-яІіЇїЄєҐґ]/;

/** Значення атрибута першого збігу. */
export function attr(html: string, selectorRe: RegExp, name: string): string | null {
  const m = selectorRe.exec(html);
  if (!m) return null;
  const tag = m[0];
  const a = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return a ? a[1]! : null;
}

export function count(haystack: string, needle: string | RegExp): number {
  if (typeof needle === "string") return haystack.split(needle).length - 1;
  return [...haystack.matchAll(new RegExp(needle.source, needle.flags.includes("g") ? needle.flags : `${needle.flags}g`))].length;
}
