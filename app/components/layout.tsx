import { Outlet, useLocation } from "react-router";
import { SECTIONS, navLink } from "~/domain/navigation";
import { useT } from "~/i18n";
import { AppShell, Banner } from "~/ui";
import { useShell } from "./shell";
import { ShellControls } from "./shell-controls";

/** Спільний макет для демо та вбудованого режиму. */
export function LayoutBody({ embedded }: { embedded: boolean }) {
  const t = useT();
  const shell = useShell();
  const location = useLocation();
  const banner = (
    <>
      {shell.mode === "demo" ? (
        <Banner tone="info" title={t("demo.banner.title")}>
          {t("demo.banner.body")}
        </Banner>
      ) : null}
      {shell.automation.globalPause ? (
        <Banner tone="warning" title={t("dashboard.automation.pausedTitle")}>
          {t("dashboard.automation.pausedBody")}
        </Banner>
      ) : null}
    </>
  );
  return (
    <AppShell
      appName={t("app.name")}
      embedded={embedded}
      currentPath={location.pathname}
      nav={shell.nav.map((n) => {
        // Запланований розділ із готовою частиною (navToRelated, напр. «Аналітика» → аналітика складу) — звичайний пункт,
        // що веде туди, для користувачів з її дозволом (navLink; ті самі дозволи перевіряє сервер на сторінці). Правило
        // те саме, що в даних оболонки для меню Shopify Admin, тож уже обчислений пункт не змінюється.
        const section = SECTIONS.find((s) => s.key === n.key);
        const link = section?.navToRelated ? navLink(shell.basePath, section, (p) => shell.actor.permissions.includes(p)) : null;
        const planned = link ? link.planned : n.planned;
        return {
          key: n.key,
          href: link ? link.href : n.href,
          label: t(`nav.${n.key}`),
          planned,
          badge: n.badge,
          group: planned ? ("planned" as const) : ("main" as const),
        };
      })}
      labels={{ openMenu: t("common.openMenu"), closeMenu: t("common.closeMenu"), planned: t("common.planned") }}
      topBar={<ShellControls />}
      banner={banner}
      footer={embedded ? <ShellControls /> : null}
    >
      <Outlet />
    </AppShell>
  );
}
