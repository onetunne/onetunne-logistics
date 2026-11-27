/**
 * Значення переліків модуля «Упаковка» без імпорту схеми БД (схема тягне drizzle у клієнтський код сторінок).
 * Збіг зі схемою (app/db/schema.ts) перевіряється на рівні типів нижче: новий вид/одиниця в схемі без оновлення
 * тут — помилка компіляції.
 */
import type { MaterialUnit, PackagingMaterialKind } from "~/db/schema";

export const MATERIAL_KINDS = ["box", "mailer", "sticker", "instruction", "card", "bolt", "filler", "tape", "other"] as const satisfies readonly PackagingMaterialKind[];
export const UNITS = ["pcs", "m", "kg"] as const satisfies readonly MaterialUnit[];
export const KIT_SCOPES = ["all", "products"] as const;
export const KIT_PER = ["order", "item"] as const;

type Exhaustive<All, Listed> = [Exclude<All, Listed>] extends [never] ? true : false;
const kindsComplete: Exhaustive<PackagingMaterialKind, (typeof MATERIAL_KINDS)[number]> = true;
const unitsComplete: Exhaustive<MaterialUnit, (typeof UNITS)[number]> = true;
void kindsComplete;
void unitsComplete;
