import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { cx } from "./cx";
import { CloseIcon, MenuIcon, focusableWithin, lockPageScroll } from "./internal";

export interface NavItem {
  key: string;
  href: string;
  label: string;
  /** Розділ запланований на наступні етапи (показується в групі «Заплановано»). */
  planned?: boolean;
  badge?: number | string | null;
  group?: "main" | "planned";
  /** Активний лише при точному збігу шляху. Для головної (dashboard) вмикається автоматично. */
  exact?: boolean;
}

export interface AppShellLabels {
  openMenu: string;
  closeMenu: string;
  planned: string;
  /** Посилання «Перейти до вмісту» для клавіатури (показується лише при фокусі). */
  skipToContent?: string;
  /** Доступна назва навігації (за замовчуванням — назва застосунку). */
  navigation?: string;
}

export interface AppShellProps {
  appName: string;
  nav: NavItem[];
  currentPath: string;
  /** Усередині Shopify Admin: без власної бічної панелі та верхньої смуги (навігацію рендерить App Bridge). */
  embedded?: boolean;
  /** Вміст верхньої смуги праворуч (мова, тема, роль). Не показується в embedded-режимі. */
  topBar?: ReactNode;
  /**
   * Де показувати topBar на ширині < 1024px: "drawer" (за замовчуванням) — унизу висувного меню,
   * щоб не переповнювати вузьку смугу iPhone; "bar" — у верхній смузі.
   * У режимі "drawer" вміст рендериться двічі (смуга для десктопу + меню), тому не використовуйте в ньому id.
   */
  topBarMobile?: "drawer" | "bar";
  banner?: ReactNode;
  footer?: ReactNode;
  labels: AppShellLabels;
  children?: ReactNode;
}

const NAV_ID = "ot-shell-nav";
const MAIN_ID = "ot-main";
const PLANNED_HEADING_ID = "ot-shell-nav-planned";
const DESKTOP_QUERY = "(min-width: 1024px)";

function normalizePath(path: string): string {
  const bare = path.split(/[?#]/)[0] ?? "";
  const trimmed = bare.length > 1 ? bare.replace(/\/+$/, "") : bare;
  return trimmed || "/";
}

export function isNavItemPlanned(item: NavItem): boolean {
  return item.planned === true || item.group === "planned";
}

/**
 * Ключ активного пункту меню: currentPath дорівнює href або починається з href + "/".
 * Корінь (key "dashboard", "/" або базовий шлях, від якого відгалужуються всі інші пункти) — лише точний збіг.
 * Якщо підходять кілька пунктів — перемагає найдовший href.
 */
export function findActiveNavKey(nav: readonly NavItem[], currentPath: string): string | null {
  const path = normalizePath(currentPath);
  const hrefs = nav.map((item) => normalizePath(item.href));
  let bestKey: string | null = null;
  let bestLength = -1;
  for (const [index, item] of nav.entries()) {
    const href = hrefs[index] ?? "/";
    const others = hrefs.filter((_, j) => j !== index);
    // Базовий шлях усієї навігації (напр. "/demo", від якого відгалужуються всі інші пункти).
    const isBase = others.length >= 2 && others.every((other) => other.startsWith(`${href}/`));
    const isRoot = item.key === "dashboard" || href === "/" || isBase;
    const exact = item.exact ?? isRoot;
    const matches = path === href || (!exact && path.startsWith(`${href}/`));
    if (matches && href.length > bestLength) {
      bestKey = item.key;
      bestLength = href.length;
    }
  }
  return bestKey;
}

/**
 * Каркас застосунку.
 * - ≥ 1024px: фіксована ліва панель 240px з навігацією + верхня смуга (якщо є topBar).
 * - < 1024px: липка верхня смуга з назвою і кнопкою меню; меню — висувна панель (overlay),
 *   закривається кліком по посиланню, Escape, кліком по підкладці; прокрутка сторінки заблокована.
 * - embedded: лише банер, вміст і футер (навігацію рендерить Shopify Admin).
 */
export function AppShell({
  appName,
  nav,
  currentPath,
  embedded = false,
  topBar,
  topBarMobile = "drawer",
  banner,
  footer,
  labels,
  children,
}: AppShellProps) {
  const [open, setOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);

  const closeDrawer = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) window.requestAnimationFrame(() => menuButtonRef.current?.focus());
  }, []);

  // Після навігації меню закривається.
  useEffect(() => {
    setOpen(false);
  }, [currentPath]);

  useEffect(() => {
    if (!open) return;
    const unlock = lockPageScroll();
    closeButtonRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDrawer(true);
        return;
      }
      // Пастка фокусу всередині відкритої панелі.
      if (event.key === "Tab" && drawerRef.current) {
        const items = focusableWithin(drawerRef.current);
        const first = items[0];
        const last = items[items.length - 1];
        if (!first || !last) return;
        const active = document.activeElement;
        if (event.shiftKey && (active === first || !drawerRef.current.contains(active))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (active === last || !drawerRef.current.contains(active))) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);

    // Перехід на десктопну ширину — панель стає статичною, закриваємо drawer.
    const media = window.matchMedia(DESKTOP_QUERY);
    const onMedia = () => {
      if (media.matches) setOpen(false);
    };
    media.addEventListener("change", onMedia);

    return () => {
      unlock();
      document.removeEventListener("keydown", onKeyDown);
      media.removeEventListener("change", onMedia);
    };
  }, [open, closeDrawer]);

  if (embedded) {
    return (
      <div className="ot-shell ot-shell--embedded">
        <div className="ot-shell__main">
          {banner ? <div className="ot-shell__banner">{banner}</div> : null}
          <main id={MAIN_ID} className="ot-shell__content" tabIndex={-1}>
            {children}
          </main>
          {footer ? <footer className="ot-shell__footer">{footer}</footer> : null}
        </div>
      </div>
    );
  }

  const activeKey = findActiveNavKey(nav, currentPath);
  const mainItems = nav.filter((item) => !isNavItemPlanned(item));
  const plannedItems = nav.filter(isNavItemPlanned);

  const renderItem = (item: NavItem) => {
    const active = item.key === activeKey;
    const planned = isNavItemPlanned(item);
    const hasBadge = item.badge !== undefined && item.badge !== null && item.badge !== "";
    return (
      <li key={item.key} className="ot-nav__item">
        <Link
          to={item.href}
          className={cx("ot-nav__link", active && "is-active", planned && "ot-nav__link--planned")}
          aria-current={active ? "page" : undefined}
          onClick={() => setOpen(false)}
        >
          <span className="ot-nav__label">{item.label}</span>
          {hasBadge ? <span className="ot-nav__badge">{item.badge}</span> : null}
          {planned ? <span className="ot-nav__planned">{labels.planned}</span> : null}
        </Link>
      </li>
    );
  };

  return (
    <div className={cx("ot-shell", open && "ot-shell--drawer-open")}>
      {labels.skipToContent ? (
        <a className="ot-skip-link" href={`#${MAIN_ID}`}>
          {labels.skipToContent}
        </a>
      ) : null}

      {open ? <div className="ot-shell__overlay" aria-hidden="true" onClick={() => closeDrawer(true)} /> : null}

      <aside
        ref={drawerRef}
        id={NAV_ID}
        className={cx("ot-shell__sidebar", open && "is-open")}
        role={open ? "dialog" : undefined}
        aria-modal={open ? true : undefined}
        aria-label={open ? (labels.navigation ?? appName) : undefined}
      >
        <div className="ot-shell__sidebar-header">
          <span className="ot-shell__brand">{appName}</span>
          <button
            ref={closeButtonRef}
            type="button"
            className="ot-shell__icon-button ot-shell__close-button"
            aria-label={labels.closeMenu}
            onClick={() => closeDrawer(true)}
          >
            <CloseIcon />
          </button>
        </div>
        <nav className="ot-nav" aria-label={labels.navigation ?? appName}>
          {mainItems.length > 0 ? <ul className="ot-nav__list">{mainItems.map(renderItem)}</ul> : null}
          {plannedItems.length > 0 ? (
            <div className="ot-nav__group">
              <p className="ot-nav__heading" id={PLANNED_HEADING_ID}>
                {labels.planned}
              </p>
              <ul className="ot-nav__list" aria-labelledby={PLANNED_HEADING_ID}>
                {plannedItems.map(renderItem)}
              </ul>
            </div>
          ) : null}
        </nav>
        {topBar && topBarMobile === "drawer" ? <div className="ot-shell__drawer-extra">{topBar}</div> : null}
      </aside>

      <div className="ot-shell__main">
        <header
          className={cx(
            "ot-shell__topbar",
            !topBar && "ot-shell__topbar--bare",
            topBar && topBarMobile === "drawer" && "ot-shell__topbar--slot-desktop",
          )}
        >
          <button
            ref={menuButtonRef}
            type="button"
            className="ot-shell__icon-button ot-shell__menu-button"
            aria-label={open ? labels.closeMenu : labels.openMenu}
            aria-expanded={open}
            aria-controls={NAV_ID}
            onClick={() => (open ? closeDrawer(false) : setOpen(true))}
          >
            <MenuIcon />
          </button>
          <span className="ot-shell__topbar-name">{appName}</span>
          {topBar ? <div className="ot-shell__topbar-slot">{topBar}</div> : null}
        </header>
        {banner ? <div className="ot-shell__banner">{banner}</div> : null}
        <main id={MAIN_ID} className="ot-shell__content" tabIndex={-1}>
          {children}
        </main>
        {footer ? <footer className="ot-shell__footer">{footer}</footer> : null}
      </div>
    </div>
  );
}
