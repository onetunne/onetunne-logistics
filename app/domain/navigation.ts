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
  /**
   * Уже реалізована частина в іншому розділі, на яку веде сторінка «Заплановано» (напр. «Аналітика» етапу 6 →
   * «Склад» → «Аналітика» етапу 5). Показується лише з дозволом `permission`.
   */
  related?: { path: string; labelKey: string; descriptionKey: string; permission?: Permission };
  /**
   * Пункт меню веде одразу на `related` (з дозволом related.permission) і стоїть серед реалізованих розділів: розділ ще
   * заплановано, але його готову частину видно з меню без проміжної сторінки. Сторінка «Заплановано» лишається за
   * прямим шляхом (опис решти розділу); без дозволу — звичайний запланований пункт.
   */
  navToRelated?: boolean;
}

export const SECTIONS: readonly SectionDef[] = [
  { key: "dashboard", path: "", implemented: true, stage: 1 },
  { key: "orders", path: "orders", implemented: true, stage: 2, permission: "orders.view" },
  { key: "products", path: "products", implemented: true, stage: 3, permission: "orders.view" },
  { key: "waybills", path: "waybills", implemented: true, stage: 3, permission: "orders.view" },
  { key: "shipping", path: "shipping", implemented: false, stage: 3 },
  { key: "picking", path: "picking", implemented: true, stage: 5, permission: "packing.perform" },
  { key: "tracking", path: "tracking", implemented: false, stage: 3 },
  { key: "problems", path: "problems", implemented: true, stage: 4, permission: "problems.view" },
  { key: "returns", path: "returns", implemented: false, stage: 6 },
  { key: "warehouse", path: "warehouse", implemented: true, stage: 5, permission: "warehouse.view" },
  { key: "production", path: "production", implemented: true, stage: 5, permission: "warehouse.view" },
  { key: "finance", path: "finance", implemented: false, stage: 6, permission: "finance.view" },
  {
    key: "analytics",
    path: "analytics",
    implemented: false,
    stage: 6,
    related: {
      path: "warehouse/analytics",
      labelKey: "warehouseAnalytics.planned.link",
      descriptionKey: "warehouseAnalytics.planned.description",
      permission: "warehouse.view",
    },
    // Аналітика складу (етап 5) готова — пункт меню веде туди; фінансова аналітика (етап 6) — на сторінці «Заплановано».
    navToRelated: true,
  },
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

/** Куди веде пункт меню розділу для користувача з цими дозволами і чи показувати його як запланований. */
export interface NavTarget {
  /** Шлях відносно basePath. */
  path: string;
  planned: boolean;
}

export function navTarget(section: SectionDef, can: (permission: Permission) => boolean): NavTarget {
  const related = section.related;
  if (!section.implemented && section.navToRelated && related && (!related.permission || can(related.permission))) {
    return { path: related.path, planned: false };
  }
  return { path: section.path, planned: !section.implemented };
}

/**
 * Пункт меню розділу (href з basePath + planned) — одне правило для даних оболонки (server/shell.server.ts →
 * вбудоване меню Shopify Admin NavMenu) і макета (components/layout.tsx). Ідемпотентне: для пункту, що вже веде на
 * related, результат той самий.
 */
export function navLink(basePath: string, section: SectionDef, can: (permission: Permission) => boolean): { href: string; planned: boolean } {
  const target = navTarget(section, can);
  return { href: sectionHref(basePath, target), planned: target.planned };
}
