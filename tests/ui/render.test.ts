import { createElement as h, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import {
  AppShell,
  Badge,
  Banner,
  Button,
  Card,
  Checkbox,
  ConfirmSubmitButton,
  DataTable,
  Disclosure,
  EmptyState,
  Grid,
  KeyValueList,
  Page,
  Pagination,
  Select,
  Spinner,
  Stack,
  Tabs,
  Text,
  TextField,
  Thumbnail,
  Timeline,
  cx,
  findActiveNavKey,
  type DataTableColumn,
  type NavItem,
} from "~/ui";

function render(element: ReactElement, path = "/demo"): string {
  return renderToString(h(MemoryRouter, { initialEntries: [path] }, element));
}

const NAV: NavItem[] = [
  { key: "dashboard", href: "/demo", label: "Головна" },
  { key: "orders", href: "/demo/orders", label: "Замовлення" },
  { key: "problems", href: "/demo/problems", label: "Проблеми", badge: 3 },
  { key: "picking", href: "/demo/picking", label: "Комплектація", planned: true },
  { key: "finance", href: "/demo/finance", label: "Фінанси", group: "planned" },
];

const LABELS = { openMenu: "Відкрити меню", closeMenu: "Закрити меню", planned: "Заплановано" };

interface SampleOrder {
  id: string;
  name: string;
  customer: string;
  total: string;
  note: string;
}

// Вигадані тестові дані.
const ROWS: SampleOrder[] = [
  { id: "o1", name: "#1001", customer: "Тест Клієнт", total: "1 200,00 ₴", note: "демо" },
  { id: "o2", name: "#1002", customer: "Demo Customer", total: "€45.00", note: "sample" },
];

const COLUMNS: Array<DataTableColumn<SampleOrder>> = [
  { key: "name", header: "Замовлення", render: (r) => r.name, primary: true },
  { key: "customer", header: "Клієнт", render: (r) => r.customer },
  { key: "total", header: "Сума", render: (r) => r.total, align: "end" },
  { key: "note", header: "Примітка", render: (r) => r.note, hideOnMobile: true },
];

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("findActiveNavKey", () => {
  it("matches nested paths but dashboard root only exactly", () => {
    expect(findActiveNavKey(NAV, "/demo")).toBe("dashboard");
    expect(findActiveNavKey(NAV, "/demo/")).toBe("dashboard");
    expect(findActiveNavKey(NAV, "/demo/orders")).toBe("orders");
    expect(findActiveNavKey(NAV, "/demo/orders/o1?tab=history")).toBe("orders");
    expect(findActiveNavKey(NAV, "/demo/ordersx")).toBeNull();
    expect(findActiveNavKey(NAV, "/demo/unknown")).toBeNull();
  });

  it("prefers the longest matching href", () => {
    const nav: NavItem[] = [
      { key: "orders", href: "/app/orders", label: "A" },
      { key: "archive", href: "/app/orders/archive", label: "B" },
    ];
    expect(findActiveNavKey(nav, "/app/orders/archive/5")).toBe("archive");
    expect(findActiveNavKey(nav, "/app/orders/5")).toBe("orders");
  });

  it("treats the common base path as exact-only root even without the dashboard key", () => {
    const nav: NavItem[] = [
      { key: "home", href: "/app", label: "Home" },
      { key: "orders", href: "/app/orders", label: "Orders" },
      { key: "settings", href: "/app/settings", label: "Settings" },
    ];
    expect(findActiveNavKey(nav, "/app")).toBe("home");
    expect(findActiveNavKey(nav, "/app/hidden-section")).toBeNull();
    expect(findActiveNavKey([{ ...nav[1]!, exact: true }], "/app/orders/1")).toBeNull();
  });
});

describe("cx", () => {
  it("joins truthy classes", () => {
    expect(cx("a", false, null, undefined, "", "b", { c: true, d: false })).toBe("a b c");
  });
});

describe("UI kit SSR rendering", () => {
  it("renders AppShell + Page + DataTable + ConfirmSubmitButton", () => {
    const html = render(
      h(
        AppShell,
        {
          appName: "ONE TUNNE Logistics",
          nav: NAV,
          currentPath: "/demo/orders/o1",
          labels: { ...LABELS, skipToContent: "Перейти до вмісту" },
          topBar: h("span", null, "TOPBAR-SLOT"),
          banner: h(Banner, { tone: "warning", title: "Демо-режим" }),
          footer: "FOOTER",
        },
        h(
          Page,
          {
            title: "Замовлення",
            subtitle: "Підзаголовок",
            backHref: "/demo",
            backLabel: "Назад",
            titleMeta: h(Badge, { tone: "info" }, "Тест"),
            primaryAction: h(Button, { variant: "primary", to: "/demo/orders/new" }, "Створити"),
          },
          h(
            "form",
            { method: "post", id: "bulk" },
            h(DataTable<SampleOrder>, {
              columns: COLUMNS,
              rows: ROWS,
              rowKey: (r) => r.id,
              rowHref: (r) => `/demo/orders/${r.id}`,
              caption: "Список замовлень",
              selection: {
                name: "orderId",
                value: (r) => r.id,
                label: (r) => `Вибрати ${r.name}`,
                formId: "bulk",
                allLabel: "Вибрати все",
              },
            }),
            h(
              ConfirmSubmitButton,
              {
                title: "Скасувати замовлення?",
                message: "Дію не можна скасувати.",
                confirmLabel: "Підтвердити",
                cancelLabel: "Скасувати",
                variant: "critical",
                name: "intent",
                value: "bulk-cancel",
              },
              "Скасувати вибрані",
            ),
          ),
        ),
      ),
      "/demo/orders/o1",
    );

    // Каркас: навігація, групи, активний пункт, кнопка меню.
    for (const label of ["Головна", "Замовлення", "Проблеми", "Комплектація", "Фінанси"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('class="ot-shell__sidebar"');
    expect(html).toContain('id="ot-shell-nav"');
    expect(html).toContain('aria-controls="ot-shell-nav"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Відкрити меню"');
    expect(html).toContain("ot-nav__heading");
    expect(count(html, 'class="ot-nav__planned"')).toBe(2);
    expect(html).toMatch(/href="\/demo\/orders"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/demo\/orders"/);
    expect(count(html, 'aria-current="page"')).toBe(1);
    expect(html).toContain('<span class="ot-nav__badge">3</span>');
    // topBar: у смузі (десктоп) і в меню (мобільний).
    expect(count(html, "TOPBAR-SLOT")).toBe(2);
    expect(html).toContain('class="ot-shell__drawer-extra"');
    expect(html).toContain("FOOTER");
    expect(html).toContain('href="#ot-main"');
    expect(html).toContain('role="status"');

    // Сторінка
    expect(html).toContain('<h1 class="ot-page__title">Замовлення</h1>');
    expect(html).toContain('aria-label="Назад"');
    expect(html).toContain('href="/demo/orders/new"');

    // Таблиця (десктоп) + мобільні картки (підписи колонок у кожній комірці).
    expect(html).toContain('<table class="ot-dt__table">');
    expect(html).toContain("<caption");
    expect(count(html, 'class="ot-dt__row"')).toBe(2);
    expect(count(html, '<span class="ot-dt__label">Клієнт</span>')).toBe(2);
    expect(html).toContain("ot-dt__cell--hide-mobile");
    expect(html).toContain('<th scope="row"');
    expect(html).toContain('href="/demo/orders/o1"');
    expect(html).toContain('class="ot-dt__link"');
    expect(count(html, 'name="orderId"')).toBe(2);
    expect(html).toContain('value="o2"');
    expect(html).toContain('form="bulk"');
    expect(html).toContain("Вибрати #1001");

    // Підтвердження: тригер type=button, діалог з submit name/value.
    expect(html).toContain('<dialog class="ot-dialog"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toMatch(/<button type="submit" name="intent" value="bulk-cancel"/);
    expect(html).toContain("ot-button--critical");
    expect(html).not.toContain("<dialog open");
  });

  it("can keep topBar in the mobile bar only", () => {
    const html = render(
      h(AppShell, {
        appName: "ONE TUNNE Logistics",
        nav: NAV,
        currentPath: "/demo",
        topBar: "TOPBAR-SLOT",
        topBarMobile: "bar",
        labels: LABELS,
      }),
    );
    expect(count(html, "TOPBAR-SLOT")).toBe(1);
    expect(html).not.toContain("ot-shell__drawer-extra");
    expect(html).toMatch(/href="\/demo"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/demo"/);
  });

  it("embedded mode renders only banner + content", () => {
    const html = render(
      h(
        AppShell,
        {
          appName: "ONE TUNNE Logistics",
          nav: NAV,
          currentPath: "/app",
          embedded: true,
          topBar: "TOPBAR-SLOT",
          labels: LABELS,
          banner: h(Banner, { tone: "info" }, "BANNER"),
        },
        h("p", null, "CONTENT"),
      ),
      "/app",
    );
    expect(html).toContain("BANNER");
    expect(html).toContain("CONTENT");
    expect(html).not.toContain("ot-shell__sidebar");
    expect(html).not.toContain("ot-shell__topbar");
    expect(html).not.toContain("TOPBAR-SLOT");
    expect(html).not.toContain("Замовлення");
  });

  it("renders empty state when there are no rows", () => {
    const html = render(
      h(DataTable<SampleOrder>, {
        columns: COLUMNS,
        rows: [],
        rowKey: (r) => r.id,
        emptyState: h(EmptyState, { title: "Немає замовлень", description: "Спробуйте змінити фільтри" }),
      }),
    );
    expect(html).toContain("Немає замовлень");
    expect(html).not.toContain("<table");
  });

  it("wires form field labels, help and errors", () => {
    const html = render(
      h(
        Stack,
        { gap: 4 },
        h(TextField, {
          label: "Телефон",
          name: "shipping[phone]",
          type: "tel",
          defaultValue: null,
          error: "Невірний номер",
          helpText: "Міжнародний формат",
          required: true,
        }),
        h(Select, {
          label: "Країна",
          name: "country",
          options: [
            { value: "UA", label: "Україна" },
            { value: "PL", label: "Польща" },
          ],
          defaultValue: "PL",
        }),
        h(Checkbox, { label: "Погоджуюсь", name: "agree", value: "yes", helpText: "Обов’язково" }),
      ),
    );
    expect(html).toContain('id="ot-shipping-phone"');
    expect(html).toContain('for="ot-shipping-phone"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="ot-shipping-phone-error ot-shipping-phone-help"');
    expect(html).toContain('id="ot-shipping-phone-error"');
    expect(html).toContain("required");
    expect(html).toContain('for="ot-country"');
    expect(html).toMatch(/<option value="PL" selected="">Польща<\/option>/);
    expect(html).toContain('id="ot-agree-yes"');
    expect(html).toContain('aria-describedby="ot-agree-yes-help"');
  });

  it("renders remaining components without crashing", () => {
    const html = render(
      h(
        Grid,
        { columns: { xs: 1, md: 2, lg: 3 } },
        h(Card, { title: "Картка", description: "Опис", actions: h(Button, { size: "sm" }, "Дія") }, "Вміст"),
        h(Card, { padded: false }, h(Text, { variant: "heading-md", tone: "subdued" }, "Заголовок")),
        h(Banner, { tone: "critical", title: "Помилка" }, "Деталі"),
        h(Button, { loading: true }, "Зберегти"),
        h(Button, { to: "/demo/x", disabled: true }, "Вимкнено"),
        h(Tabs, {
          ariaLabel: "Статуси",
          selected: "all",
          items: [
            { key: "all", label: "Усі", href: "?status=all", count: 12 },
            { key: "paid", label: "Оплачено", href: "?status=paid", count: null },
          ],
        }),
        h(KeyValueList, { items: [{ label: "Вага", value: "1,2 кг" }] }),
        h(Thumbnail, { alt: "Товар", size: "sm" }),
        h(Thumbnail, { alt: "Товар", src: "/demo-images/sample.png" }),
        h(Pagination, { prevHref: null, nextHref: "?page=2", label: "Сторінка 1 з 2", prevLabel: "Попередня", nextLabel: "Наступна" }),
        h(Pagination, { prevHref: null, nextHref: null, prevLabel: "P", nextLabel: "N" }),
        h(Timeline, {
          items: [
            { id: "e1", title: "Створено", time: "10:00", tone: "success" },
            { id: "e2", title: "Помилка", time: "10:05", tone: "critical", description: "Перевізник відхилив" },
          ],
        }),
        h(Spinner, { label: "Завантаження…" }),
      ),
    );
    expect(html).toContain("ot-grid--xs-1 ot-grid--md-2 ot-grid--lg-3");
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Вимкнено/);
    expect(html).toContain('aria-label="Статуси"');
    expect(html).toContain('<span class="ot-tabs__count">12</span>');
    expect(html).toContain("<dl");
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('role="img"');
    expect(html).toContain('rel="next"');
    expect(html).toContain('aria-disabled="true"');
    expect(count(html, "ot-pagination\"")).toBe(1);
    expect(html).toContain("ot-timeline__item--critical");
    expect(html).toContain("Завантаження…");
  });
});

describe("Checkbox submits 'on' when checked (stage 4 regression)", () => {
  it("renders no value attribute unless a value is given", async () => {
    const { Checkbox } = await import("~/ui");
    const plain = renderToString(h(Checkbox, { label: "x", name: "shippingEnabled", defaultChecked: true }));
    expect(plain).not.toMatch(/value=/);
    const withValue = renderToString(h(Checkbox, { label: "x", name: "ids", value: "abc" }));
    expect(withValue).toMatch(/value="abc"/);
  });
});

describe("Disclosure", () => {
  it("collapsedOnMobile: open in SSR markup but hidden on phones until hydration (no flash), shared CSS classes", () => {
    const html = renderToString(h(Disclosure, { summary: "Фільтри", collapsedOnMobile: true }, h("p", null, "body")));
    expect(html).toMatch(/<details class="ot-disclosure ot-disclosure--collapse-mobile" open="">/);
    expect(html).not.toContain("data-ready");
    expect(html).toContain('<summary class="ot-disclosure__summary">');
    expect(html).toContain('<div class="ot-disclosure__content"><p>body</p></div>');
    expect(html).not.toContain("<style"); // без вбудованого CSS у сторінках
  });

  it("plain disclosure follows defaultOpen and is ready immediately", () => {
    const closed = renderToString(h(Disclosure, { summary: "S" }, "x"));
    expect(closed).toMatch(/<details class="ot-disclosure" data-ready="">/);
    expect(renderToString(h(Disclosure, { summary: "S", defaultOpen: true }, "x"))).toContain('open=""');
  });
});

describe("mobile CSS contracts (app/ui/styles.css)", () => {
  it("tap targets, badge wrapping in cards, tab and invoice scroll hints", async () => {
    const fs = await import("node:fs");
    const css = fs.readFileSync("app/ui/styles.css", "utf8");
    expect(css).toMatch(/details > summary \{[^}]*min-height: 44px;[^}]*cursor: pointer;/);
    expect(css).toMatch(/\.ot-dt__cell \.ot-badge \{[^}]*white-space: normal;/);
    expect(css).toMatch(/\.ot-card__title a \{[^}]*display: inline-block;[^}]*padding-block: 10px;[^}]*margin-block: -10px;/);
    expect(css).toMatch(/\.ot-tabs__list\[data-fade="end"\] \{[^}]*mask-image/);
    expect(css).toMatch(/@media \(max-width: 599\.98px\) \{[^@]*\.ot-invoice__scroll-hint \{\s*display: block;/);
  });
});
