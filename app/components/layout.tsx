import { Outlet, useLocation } from "react-router";
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
      nav={shell.nav.map((n) => ({
        key: n.key,
        href: n.href,
        label: t(`nav.${n.key}`),
        planned: n.planned,
        badge: n.badge,
        group: n.planned ? "planned" : "main",
      }))}
      labels={{ openMenu: t("common.openMenu"), closeMenu: t("common.closeMenu"), planned: t("common.planned") }}
      topBar={<ShellControls />}
      banner={banner}
      footer={embedded ? <ShellControls /> : null}
    >
      <Outlet />
    </AppShell>
  );
}
