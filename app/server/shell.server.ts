import { SECTIONS, sectionHref } from "~/domain/navigation";
import { can } from "~/domain/permissions";
import { countOpenIssues } from "~/modules/orders/repository.server";
import { getSetting } from "~/modules/settings/settings.server";
import { getEnv } from "~/lib/env.server";
import type { ShellData } from "~/components/shell-types";
import type { RequestContext } from "./types";

export async function buildShellData(ctx: RequestContext): Promise<ShellData> {
  const [automation, problems] = await Promise.all([getSetting(ctx.db, "automation"), countOpenIssues(ctx.db)]);
  return {
    mode: ctx.mode,
    basePath: ctx.basePath,
    actor: {
      id: ctx.actor.id,
      displayName: ctx.actor.displayName,
      role: ctx.actor.role,
      permissions: [...ctx.actor.permissions],
    },
    nav: SECTIONS.filter((s) => !s.permission || can(ctx.actor, s.permission)).map((s) => ({
      key: s.key,
      href: sectionHref(ctx.basePath, s),
      planned: !s.implemented,
      stage: s.stage,
      badge: s.key === "problems" && problems.total > 0 ? problems.total : null,
    })),
    automation,
    openProblems: problems.total,
    demo: ctx.mode === "demo" ? { passwordProtected: Boolean(getEnv().DEMO_PASSWORD) } : null,
  };
}
