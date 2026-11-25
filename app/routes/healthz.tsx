import { sql } from "drizzle-orm";
import { getEnv } from "~/lib/env.server";

/** Контроль стану застосунку (для хостингу/моніторингу). Без внутрішніх деталей. */
export async function loader() {
  const env = getEnv();
  const checks: Record<string, "ok" | "error" | "disabled"> = {};
  try {
    if (env.DEMO_MODE) {
      const { getDemoRuntime } = await import("~/server/demo-runtime.server");
      await (await getDemoRuntime()).handle.db.execute(sql`select 1`);
      checks.demoDb = "ok";
    } else checks.demoDb = "disabled";
  } catch {
    checks.demoDb = "error";
  }
  try {
    if (env.DATABASE_URL) {
      const { getProductionRuntime } = await import("~/server/production-runtime.server");
      await (await getProductionRuntime()).handle.db.execute(sql`select 1`);
      checks.db = "ok";
    } else checks.db = "disabled";
  } catch {
    checks.db = "error";
  }
  const ok = !Object.values(checks).includes("error");
  return Response.json({ status: ok ? "ok" : "degraded", checks }, { status: ok ? 200 : 503 });
}
