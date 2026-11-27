import type { MessageModule } from "../types";

/**
 * Розділ «Працівники»: окремі права працівника (staff_members.permission_overrides) і назви дозволів.
 * Основні тексти розділу — у shopify.ts (staff.*), тут — лише права.
 */
const messages: MessageModule = {
  uk: {
    "staff.permissions.title": "Права працівника",
    "staff.permissions.help":
      "Позначено права, які діють для цього працівника. «Типово» — права ролі «Працівник». Зміни діють з наступного відкриття застосунку працівником.",
    "staff.permissions.ownerOnly": "Лише власник (надати працівнику не можна): {list}.",
    "staff.permissions.ownerNote": "Для ролі «Власник» окремі права не застосовуються — власник має всі права.",
    "staff.permissions.default": "типово",
    "staff.permissions.customized": "змінено: {count}",
    "staff.error.ownerOnlyPermission": "Це право може мати лише власник — його не можна надати працівнику.",
    "permission.orders.view": "Перегляд замовлень",
    "permission.orders.edit": "Зміна даних замовлень",
    "permission.orders.bulk": "Масові дії із замовленнями",
    "permission.orders.cancel": "Скасування замовлень",
    "permission.waybills.create": "Створення накладних",
    "permission.waybills.manage": "Керування накладними (прив'язування, скасування)",
    "permission.problems.view": "Перегляд проблем",
    "permission.settings.view": "Перегляд налаштувань",
    "permission.settings.manage": "Зміна налаштувань",
    "permission.automation.manage": "Керування автоматизацією",
    "permission.finance.view": "Фінанси й собівартість",
    "permission.staff.manage": "Керування працівниками",
    "permission.demo.reset": "Скидання демо-даних",
    "permission.warehouse.view": "Склад: перегляд залишків і руху",
    "permission.warehouse.receive": "Склад: надходження й позначення браку",
    "permission.warehouse.adjust": "Склад: інвентаризація, списання, пороги, розбіжності з Shopify",
    "permission.production.manage": "Виробництво: створення й зміна партій",
    "permission.packing.perform": "Пакування замовлень (зокрема коробка, вага й габарити посилки)",
  },
  en: {
    "staff.permissions.title": "Staff member permissions",
    "staff.permissions.help":
      "Checked permissions apply to this staff member. «Default» marks the permissions of the Staff role. Changes apply the next time the staff member opens the app.",
    "staff.permissions.ownerOnly": "Owner only (cannot be granted to staff): {list}.",
    "staff.permissions.ownerNote": "Individual permissions do not apply to the Owner role — the owner has every permission.",
    "staff.permissions.default": "default",
    "staff.permissions.customized": "changed: {count}",
    "staff.error.ownerOnlyPermission": "Only the owner can have this permission — it cannot be granted to staff.",
    "permission.orders.view": "View orders",
    "permission.orders.edit": "Edit order data",
    "permission.orders.bulk": "Bulk order actions",
    "permission.orders.cancel": "Cancel orders",
    "permission.waybills.create": "Create waybills",
    "permission.waybills.manage": "Manage waybills (link, cancel)",
    "permission.problems.view": "View problems",
    "permission.settings.view": "View settings",
    "permission.settings.manage": "Change settings",
    "permission.automation.manage": "Manage automation",
    "permission.finance.view": "Finance and unit costs",
    "permission.staff.manage": "Manage staff",
    "permission.demo.reset": "Reset demo data",
    "permission.warehouse.view": "Warehouse: view stock and movements",
    "permission.warehouse.receive": "Warehouse: receipts and marking defects",
    "permission.warehouse.adjust": "Warehouse: stocktake, write-offs, thresholds, Shopify discrepancies",
    "permission.production.manage": "Production: create and edit batches",
    "permission.packing.perform": "Pack orders (including parcel box, weight and dimensions)",
  },
};

export default messages;
