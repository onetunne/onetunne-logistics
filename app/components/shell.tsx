import { useRouteLoaderData } from "react-router";
import type { ShellData } from "./shell-types";

export type { ShellData };

/** Дані поточного макета (демо або Shopify Admin). */
export function useShell(): ShellData {
  const demo = useRouteLoaderData("routes/demo-layout") as ShellData | undefined;
  const app = useRouteLoaderData("routes/app-layout") as ShellData | undefined;
  const data = demo ?? app;
  if (!data) throw new Error("useShell() must be used inside demo/app layout");
  return data;
}

export function useCan(): (permission: string) => boolean {
  const { actor } = useShell();
  return (p) => actor.permissions.includes(p);
}

/** Шлях відносно поточного режиму: href("orders") → /demo/orders або /app/orders. */
export function useHref(): (path?: string) => string {
  const { basePath } = useShell();
  return (path = "") => (path ? `${basePath}/${path.replace(/^\//, "")}` : basePath);
}
