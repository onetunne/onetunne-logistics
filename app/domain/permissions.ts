/**
 * Ролі та дозволи. Перевіряються ЛИШЕ на сервері (loader/action), інтерфейс
 * тільки приховує недоступні дії. Фінанси, секрети й критичні налаштування — лише власник.
 */
export const PERMISSIONS = [
  "orders.view",
  "orders.edit",
  "orders.bulk",
  "orders.cancel",
  "waybills.create",
  "waybills.manage", // ручне прив'язування, підтвердження «не створено», скасування
  "problems.view",
  "settings.view",
  "settings.manage",
  "automation.manage",
  "finance.view",
  "staff.manage",
  "demo.reset",
  // Етап 5: склад, виробництво, пакування
  "warehouse.view", // залишки, історія руху, попередження, виробничі партії (перегляд)
  "warehouse.receive", // надходження з виробництва/вручну, позначення браку
  "warehouse.adjust", // ручні коригування, початкові залишки, розв'язання розбіжностей із Shopify (типово — власник)
  "production.manage", // створення й зміна виробничих партій (типово — власник)
  "packing.perform", // черга пакування, контроль комплектації, підтвердження «Запаковано»
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type Role = "owner" | "staff";

const STAFF_PERMISSIONS: readonly Permission[] = [
  "orders.view",
  "orders.edit",
  "orders.bulk",
  "waybills.create",
  "problems.view",
  "warehouse.view",
  "warehouse.receive",
  "packing.perform",
];

/**
 * Дозволи, які НІКОЛИ не можна надати працівнику через гнучкі права.
 * finance.view також відкриває поля собівартості складу/виробництва/матеріалів (етап 5).
 */
export const OWNER_ONLY_PERMISSIONS: readonly Permission[] = [
  "finance.view",
  "settings.manage",
  "automation.manage",
  "staff.manage",
];

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  owner: PERMISSIONS,
  staff: STAFF_PERMISSIONS,
};

export interface Actor {
  kind: "user" | "system";
  /** Стабільний ідентифікатор для журналу (без персональних даних). */
  id: string;
  displayName: string;
  role: Role;
  permissions: ReadonlySet<Permission>;
}

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

export function resolvePermissions(
  role: Role,
  overrides: { grant?: readonly string[]; revoke?: readonly string[] } = {},
): ReadonlySet<Permission> {
  const set = new Set<Permission>(ROLE_PERMISSIONS[role]);
  for (const p of overrides.grant ?? []) {
    if (!isPermission(p)) continue;
    if (role !== "owner" && OWNER_ONLY_PERMISSIONS.includes(p)) continue;
    set.add(p);
  }
  for (const p of overrides.revoke ?? []) {
    if (isPermission(p) && role !== "owner") set.delete(p);
  }
  return set;
}

export function makeActor(input: {
  id: string;
  displayName: string;
  role: Role;
  kind?: Actor["kind"];
  overrides?: { grant?: readonly string[]; revoke?: readonly string[] };
}): Actor {
  return {
    kind: input.kind ?? "user",
    id: input.id,
    displayName: input.displayName,
    role: input.role,
    permissions: resolvePermissions(input.role, input.overrides),
  };
}

export const SYSTEM_ACTOR: Actor = {
  kind: "system",
  id: "system",
  displayName: "System",
  role: "owner",
  permissions: new Set(PERMISSIONS),
};

export function can(actor: Actor, permission: Permission): boolean {
  return actor.permissions.has(permission);
}

export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(readonly permission: Permission) {
    super(`Forbidden: missing permission ${permission}`);
    this.name = "ForbiddenError";
  }
}

export function requirePermission(actor: Actor, permission: Permission): void {
  if (!can(actor, permission)) throw new ForbiddenError(permission);
}
