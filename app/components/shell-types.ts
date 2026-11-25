import type { AutomationMode } from "~/modules/settings/schema";

/** Дані макета (demo-layout / app-layout), доступні всім сторінкам через useShell(). */
export interface ShellData {
  mode: "demo" | "production";
  basePath: "/demo" | "/app";
  actor: { id: string; displayName: string; role: "owner" | "staff"; permissions: string[] };
  nav: { key: string; href: string; planned: boolean; stage: number; badge: number | null }[];
  automation: { mode: AutomationMode; globalPause: boolean };
  openProblems: number;
  demo: { passwordProtected: boolean } | null;
  apiKey?: string;
}
