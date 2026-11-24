import type { LoaderFunctionArgs } from "react-router";
import { LayoutBody } from "~/components/layout";
import { getRequestContext } from "~/server/context.server";
import { buildShellData } from "~/server/shell.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  return buildShellData(ctx);
}

export default function DemoLayout() {
  return <LayoutBody embedded={false} />;
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";
