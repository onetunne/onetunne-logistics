import type { Actor } from "~/domain/permissions";
import type { DbOrTx } from "~/db/client.server";
import { auditLog } from "~/db/schema";
import { redact } from "~/lib/logger.server";

/**
 * Технічний журнал критичних дій. details — лише ідентифікатори/коди, без персональних даних
 * (додатково проходить через redact як захисна сітка).
 */
export async function writeAudit(
  db: DbOrTx,
  actor: Actor,
  action: string,
  entity: { type: string; id?: string | null },
  details: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(auditLog).values({
    actorType: actor.kind,
    actorId: actor.id,
    action,
    entityType: entity.type,
    entityId: entity.id ?? null,
    details: redact(details) as Record<string, unknown>,
  });
}
