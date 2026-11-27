import type { Permission } from "./permissions";

/** 18 розділів інтерфейсу. implemented=false → сторінка «Заплановано» без складної логіки. */
export interface SectionDef {
  key: string;
  /** Шлях відносно basePath ("" — головна). */
  path: string;
  implemented: boolean;
  /** Етап, на якому розділ буде реалізовано повністю. */
  stage: number;
  /** Потрібний дозвіл для перегляду. */
  permission?: Permission;
}

export const SECTIONS: readonly SectionDef[] = [
  { key: "dashboard", path: "", implemented: true, stage: 1 },
  { key: "orders", path: "orders", implemented: true, stage: 2, permission: "orders.view" },
  { key: "products", path: "products", implemented: true, stage: 3, permission: "orders.view" },
  { key: "waybills", path: "waybills", implemented: true, stage: 3, permission: "orders.view" },
  { key: "shipping", path: "shipping", implemented: false, stage: 3 },
  { key: "picking", path: "picking", implemented: false, stage: 5 },
  { key: "tracking", path: "tracking", implemented: false, stage: 3 },
  { key: "problems", path: "problems", implemented: true, stage: 4, permission: "problems.view" },
  { key: "returns", path: "returns", implemented: false, stage: 6 },
  { key: "warehouse", path: "warehouse", implemented: false, stage: 5 },
  { key: "production", path: "production", implemented: false, stage: 5 },
  { key: "finance", path: "finance", implemented: false, stage: 6, permission: "finance.view" },
  { key: "analytics", path: "analytics", implemented: false, stage: 6 },
  { key: "assistant", path: "assistant", implemented: false, stage: 7 },
  { key: "development", path: "development", implemented: false, stage: 9 },
  { key: "countryRules", path: "country-rules", implemented: true, stage: 4, permission: "orders.view" },
  { key: "staff", path: "staff", implemented: true, stage: 2 },
  { key: "settings", path: "settings", implemented: true, stage: 1, permission: "settings.view" },
];

export const PLANNED_SECTION_PATHS = SECTIONS.filter((s) => !s.implemented).map((s) => s.path);

export function sectionByPath(path: string): SectionDef | undefined {
  return SECTIONS.find((s) => s.path === path);
}

export function sectionHref(basePath: string, section: Pick<SectionDef, "path">): string {
  return section.path ? `${basePath}/${section.path}` : basePath;
}
