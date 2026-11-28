/** Етап 6 (заглушка ядра → WP0-UI): міні-графік. Заглушка показує лише текстову альтернативу. */
import { VisuallyHidden } from "~/ui";
import type { SparklineProps } from "./contracts";

export function Sparkline({ label }: SparklineProps) {
  return <VisuallyHidden>{label}</VisuallyHidden>;
}
