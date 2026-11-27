import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { collections, packagingMaterials, productCollections, productVariants, products } from "~/db/schema";
import { makeActor, type Actor } from "~/domain/permissions";
import { DICTIONARIES } from "~/i18n";
import { movementHistory } from "~/modules/inventory/ledger.server";
import { createKitTemplate } from "~/modules/packaging/kits.server";
import type { RequestContext } from "~/server/types";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";
import { apply, insertProduct, stockItemFor } from "../stage5/helpers";
import { esc, renderPage } from "./insights-render";

/**
 * S5-FILTER (R6): журнал руху фільтрується за моделлю й кольором варіанта (ті самі значення й точний збіг, що в переліку
 * залишків), шаблони комплектації — за кольором (разом із моделлю). Контекст запиту підмінено; база — PGlite або
 * TEST_DATABASE_URL з демо-даними. Тестовий товар «Filter Test» (вигадані дані):
 *   FT-A Red/M1, FT-B Blue/M1, FT-C Red/M2 — по одному надходженню.
 */
const m = vi.hoisted(() => ({ ctx: null as RequestContext | null }));
vi.mock("~/server/context.server", () => ({
  getRequestContext: async () => {
    if (!m.ctx) throw new Error("test context is not set");
    return m.ctx;
  },
}));

let env: TestEnv;
let historyPage: typeof import("~/pages/warehouse-movements");
let kitsPage: typeof import("~/pages/kits");
const ids = { product: "", a: "", b: "", c: "", stockA: "", stockB: "", stockC: "" };
const tpl = { all: "", own: "", blue: "", m2: "" };

function setContext(actor: Actor = OWNER) {
  m.ctx = { ...env.ctx(actor), basePath: "/demo", locale: "uk" };
}

beforeAll(async () => {
  env = await createTestEnv();
  historyPage = await import("~/pages/warehouse-movements");
  kitsPage = await import("~/pages/kits");
  const db = env.handle.db;
  const p = await insertProduct(db, "Filter Test", [
    { sku: "FT-A", color: "Red", model: "M1" },
    { sku: "FT-B", color: "Blue", model: "M1" },
    { sku: "FT-C", color: "Red", model: "M2" },
  ]);
  ids.product = p.productId;
  [ids.a, ids.b, ids.c] = p.variantIds as [string, string, string];
  ids.stockA = await stockItemFor(db, ids.a);
  ids.stockB = await stockItemFor(db, ids.b);
  ids.stockC = await stockItemFor(db, ids.c);
  for (const [i, stockItemId] of [ids.stockA, ids.stockB, ids.stockC].entries()) {
    await apply(db, { stockItemId, type: "receipt_manual", idempotencyKey: `ft-receipt-${i}`, onHandDelta: 5, reason: "purchase" });
  }
  // Шаблони комплектації цього товару: без фільтра, власний фільтр «Blue», власний фільтр моделі «M2».
  const [material] = await db.select({ id: packagingMaterials.id }).from(packagingMaterials).limit(1);
  const line = { materialId: material!.id, quantity: "1", per: "order" as const };
  const make = async (name: string, extra: { models?: string[]; colors?: string[] }) =>
    (await createKitTemplate(env.ctx(OWNER), { name, appliesTo: "products", priority: "1", active: true, lines: [line], productIds: [ids.product], ...extra })).id;
  tpl.own = await make("FT: без фільтра", {});
  tpl.blue = await make("FT: синій", { colors: ["Blue"] });
  tpl.m2 = await make("FT: модель M2", { models: ["M2"] });
});
afterAll(async () => {
  await env.close();
});
beforeEach(() => setContext());

const loadHistory = (search = "") =>
  historyPage.loader({ request: new Request(`http://localhost/demo/warehouse/movements${search}`), params: {}, context: {} } as never);
const loadKits = (search = "") =>
  kitsPage.loader({ request: new Request(`http://localhost/demo/warehouse/kits${search}`), params: {}, context: {} } as never);
const ftSkus = (rows: Array<{ sku: string | null }>) =>
  rows
    .map((r) => r.sku)
    .filter((s): s is string => Boolean(s?.startsWith("FT-")))
    .sort();

describe("movement history: model and colour filters (S5-FILTER)", () => {
  it("ledger movementHistory narrows by variant model and colour (rows and total agree; materials excluded)", async () => {
    const db = env.handle.db;
    const m1 = await movementHistory(db, { models: ["M1"] });
    expect(m1.rows.map((r) => r.sku).sort()).toEqual(["FT-A", "FT-B"]);
    expect(m1.total).toBe(2);
    const red = await movementHistory(db, { colors: ["Red"] });
    expect(red.rows.map((r) => r.sku).sort()).toEqual(["FT-A", "FT-C"]);
    expect(red.total).toBe(2);
    const both = await movementHistory(db, { models: ["M1"], colors: ["Red"] });
    expect(both).toMatchObject({ total: 1, rows: [expect.objectContaining({ sku: "FT-A" })] });
    // Рухи матеріалів не мають варіанта — під фільтр моделі/кольору не підпадають.
    expect((await movementHistory(db, { colors: ["Red"], kind: "material" })).total).toBe(0);
    // Точний збіг, як у переліку залишків.
    expect((await movementHistory(db, { colors: ["red"] })).total).toBe(0);
  });

  it("the page loader parses ?model / ?color, offers the stock-list values and counts them as active filters", async () => {
    for (const actor of [OWNER, STAFF]) {
      setContext(actor);
      const all = await loadHistory();
      expect(all.options.models).toEqual(expect.arrayContaining(["M1", "M2", "Model S", "Model X"]));
      expect(all.options.colors).toEqual(expect.arrayContaining(["Red", "Blue", "Чорний"]));
      expect(all.filters).toMatchObject({ model: null, color: null });

      const m1 = await loadHistory("?model=M1");
      expect(ftSkus(m1.rows)).toEqual(["FT-A", "FT-B"]);
      expect(m1.rows.every((r) => r.sku === "FT-A" || r.sku === "FT-B")).toBe(true);
      expect(m1).toMatchObject({ total: 2, isFiltered: true, filters: { model: "M1", color: null } });

      const redM2 = await loadHistory("?model=M2&color=Red");
      expect(redM2).toMatchObject({ total: 1, rows: [expect.objectContaining({ sku: "FT-C" })] });
    }
  });

  it("a value not in the stock list (e.g. an archived product) stays selectable and simply finds nothing", async () => {
    const data = await loadHistory("?color=Archived%20Green");
    expect(data.options.colors).toContain("Archived Green");
    expect(data).toMatchObject({ total: 0, rows: [], isFiltered: true });
  });

  it("renders both selects with the chosen values (uk + en labels) and keeps them in pagination links", async () => {
    const route = { path: "warehouse/movements", loader: historyPage.loader, Component: historyPage.default };
    for (const locale of ["uk", "en"] as const) {
      m.ctx = { ...env.ctx(OWNER), basePath: "/demo", locale };
      const html = await renderPage(route as never, "/demo/warehouse/movements?model=M1&color=Blue", OWNER, locale);
      expect(html).toContain('id="wh-history-model"');
      expect(html).toContain('id="wh-history-color"');
      expect(html).toContain(esc(DICTIONARIES[locale]["warehouse.filters.model"]!));
      expect(html).toContain(esc(DICTIONARIES[locale]["warehouse.filters.allColors"]!));
      expect(html).toMatch(/<option value="M1" selected="">M1<\/option>/);
      expect(html).toMatch(/<option value="Blue" selected="">Blue<\/option>/);
      // Два активні фільтри в підсумку панелі фільтрів.
      expect(html).toContain(esc(DICTIONARIES[locale]["warehouse.filters.titleActive"]!.replace("{count}", "2")));
    }
  });
});

describe("kit templates: colour filter together with model (S5-FILTER)", () => {
  const names = async (search: string) => (await loadKits(search)).templates.map((t) => t.name).filter((n) => n.startsWith("FT:") || n === "Стандартний комплект").sort();

  it("offers colours of the catalogue and of templates; filters by own colour filter or the target's variants", async () => {
    const data = await loadKits();
    expect(data.colors).toEqual(expect.arrayContaining(["Red", "Blue", "Чорний", "Білий"]));
    expect(data.filters.color).toBe("");
    // «Усі товари» (демо «Стандартний комплект») — будь-який колір; власний фільтр «Blue» — лише Blue;
    // модель M2 — лише варіанти M2 (FT-C червоний).
    expect(await names("?color=Red")).toEqual(["FT: без фільтра", "FT: модель M2", "Стандартний комплект"]);
    expect(await names("?color=Blue")).toEqual(["FT: без фільтра", "FT: синій", "Стандартний комплект"]);
    // Порівняння без регістру й зайвих пробілів — як у розрахунку комплектації.
    expect(await names("?color=%20blue%20")).toEqual(["FT: без фільтра", "FT: синій", "Стандартний комплект"]);
    // Модель і колір — одного варіанта: синього M2 немає.
    expect(await names("?color=Blue&model=M2")).toEqual(["Стандартний комплект"]);
    expect(await names("?color=Red&model=M1")).toEqual(["FT: без фільтра", "Стандартний комплект"]);
    // Демо-шаблони товарів/колекцій без кольорових варіантів не підходять кольору.
    const black = (await loadKits("?color=%D0%A7%D0%BE%D1%80%D0%BD%D0%B8%D0%B9")).templates.map((t) => t.name);
    expect(black).toContain("Стандартний комплект");
    expect(black).not.toContain("Шини: фіксація скотчем");
    expect((await loadKits("?color=Blue")).isFiltered).toBe(true);
  });

  it("model-only filtering is unchanged for the demo templates", async () => {
    const byModel = async (q: string) =>
      (await loadKits(q)).templates
        .map((t) => t.name)
        .filter((n) => !n.startsWith("FT:"))
        .sort();
    expect(await byModel("?model=Model%20X")).toEqual(["Крило: болти та інструкція", "Стандартний комплект"]);
    expect(await byModel("?model=Model%20S")).toHaveLength(3);
    expect(await byModel("?model=10x2.5&applies=collections")).toEqual(["Шини: фіксація скотчем"]);
  });

  it("staff (read-only) can filter by colour too; the colour select and the order-check hidden field are rendered", async () => {
    setContext(STAFF);
    expect(await names("?color=Blue")).toEqual(["FT: без фільтра", "FT: синій", "Стандартний комплект"]);
    const route = { path: "warehouse/kits", loader: kitsPage.loader, action: kitsPage.action, Component: kitsPage.default };
    const html = await renderPage(route as never, "/demo/warehouse/kits?color=Blue", STAFF);
    expect(html).toContain('id="kits-filter-color"');
    expect(html).toContain(esc(DICTIONARIES.uk["packaging.filters.anyColor"]!));
    expect(html).toMatch(/<option value="Blue" selected="">Blue<\/option>/);
    expect(html).toContain('<input type="hidden" name="color" value="Blue"/>');
  });

  it("NEW-2: a hand-typed value (other case/spaces) or one no longer offered stays selected, so re-applying keeps it", async () => {
    const route = { path: "warehouse/kits", loader: kitsPage.loader, action: kitsPage.action, Component: kitsPage.default };
    // ?color=blue — фільтр нормалізований (Blue), поле показує варіант «Blue», а не «Усі кольори»; так само для моделі.
    const lower = await loadKits("?color=%20blue%20&model=m1");
    expect(lower.selected).toEqual({ model: "M1", color: "Blue" });
    expect(lower.colors.filter((c) => c.toLowerCase() === "blue")).toEqual(["Blue"]);
    const html = await renderPage(route as never, "/demo/warehouse/kits?color=blue&model=m1", OWNER);
    expect(html).toMatch(/<option value="Blue" selected="">Blue<\/option>/);
    expect(html).toMatch(/<option value="M1" selected="">M1<\/option>/);
    // Значення, якого немає ні в каталозі, ні в шаблонах (стара закладка) — додається й лишається вибраним.
    const gone = await loadKits("?color=Archived%20Teal&model=Old%20Model");
    expect(gone.selected).toEqual({ model: "Old Model", color: "Archived Teal" });
    expect(gone.colors).toContain("Archived Teal");
    expect(gone.models).toContain("Old Model");
    const goneHtml = await renderPage(route as never, "/demo/warehouse/kits?color=Archived%20Teal&model=Old%20Model", OWNER);
    expect(goneHtml).toMatch(/<option value="Archived Teal" selected="">Archived Teal<\/option>/);
    expect(goneHtml).toMatch(/<option value="Old Model" selected="">Old Model<\/option>/);
    // Без фільтра — нічого не вибрано й зайвих варіантів немає.
    const none = await loadKits();
    expect(none.selected).toEqual({ model: "", color: "" });
    expect(none.colors).not.toContain("Archived Teal");
  });

  it("403 without warehouse.view", async () => {
    setContext(makeActor({ id: "x", displayName: "X", role: "staff", overrides: { revoke: ["warehouse.view"] } }));
    await expect(loadKits("?color=Blue")).rejects.toMatchObject({ status: 403 });
    await expect(loadHistory("?color=Blue")).rejects.toMatchObject({ status: 403 });
  });
});

describe("kit templates: removed variants and deleted products do not match the filter (R6F-4)", () => {
  it("a colour or model carried only by removed variants (or a deleted product) matches neither product nor collection targets", async () => {
    const db = env.handle.db;
    // Вигадані товари: «Filter Removed» — варіант Removed Ivory видалено в Shopify (removed_at), Live Onyx — наявний;
    // «Filter Deleted» — товар видалено в Shopify (status DELETED). Обидва — у колекції «Filter Removed Collection».
    const removed = await insertProduct(db, "Filter Removed", [
      { sku: "FR-IVORY", color: "Removed Ivory", model: "RM1" },
      { sku: "FR-ONYX", color: "Live Onyx", model: "RM1" },
      { sku: "FR-GONE", color: "Live Onyx", model: "RM-GONE" },
    ]);
    const [ivory, , gone] = removed.variantIds as [string, string, string];
    await db.update(productVariants).set({ removedAt: new Date() }).where(inArray(productVariants.id, [ivory, gone]));
    const deleted = await insertProduct(db, "Filter Deleted", [{ sku: "FD-TEAL", color: "Deleted Teal", model: "DM1" }]);
    await db.update(products).set({ status: "DELETED" }).where(eq(products.id, deleted.productId));
    const [collection] = await db.insert(collections).values({ title: "Filter Removed Collection", handle: "filter-removed" }).returning({ id: collections.id });
    await db.insert(productCollections).values([
      { productId: removed.productId, collectionId: collection!.id },
      { productId: deleted.productId, collectionId: collection!.id },
    ]);
    const [material] = await db.select({ id: packagingMaterials.id }).from(packagingMaterials).limit(1);
    const line = { materialId: material!.id, quantity: "1", per: "order" as const };
    const owner = env.ctx(OWNER);
    await createKitTemplate(owner, { name: "FR: товар", appliesTo: "products", priority: "1", active: true, lines: [line], productIds: [removed.productId] });
    await createKitTemplate(owner, { name: "FR: видалений товар", appliesTo: "products", priority: "1", active: true, lines: [line], productIds: [deleted.productId] });
    await createKitTemplate(owner, { name: "FR: колекція", appliesTo: "collections", priority: "1", active: true, lines: [line], collectionIds: [collection!.id] });

    const fr = async (search: string) => (await loadKits(search)).templates.map((t) => t.name).filter((n) => n.startsWith("FR:")).sort();
    // Наявний варіант — шаблони товару й колекції підходять.
    expect(await fr("?color=Live%20Onyx")).toEqual(["FR: колекція", "FR: товар"]);
    expect(await fr("?model=RM1")).toEqual(["FR: колекція", "FR: товар"]);
    // Колір/модель лише видалених варіантів — не підходять (ні товар, ні колекція).
    expect(await fr("?color=Removed%20Ivory")).toEqual([]);
    expect(await fr("?model=RM-GONE")).toEqual([]);
    expect(await fr("?model=RM1&color=Removed%20Ivory")).toEqual([]);
    // Видалений товар — жоден його варіант не рахується.
    expect(await fr("?color=Deleted%20Teal")).toEqual([]);
    expect(await fr("?model=DM1")).toEqual([]);
    // «Усі товари» (демо «Стандартний комплект») — без змін.
    expect((await loadKits("?color=Removed%20Ivory")).templates.map((t) => t.name)).toContain("Стандартний комплект");
    // Варіанти полів фільтра — лише наявні варіанти каталогу.
    const all = await loadKits();
    expect(all.colors).toContain("Live Onyx");
    expect(all.colors).not.toContain("Removed Ivory");
    expect(all.colors).not.toContain("Deleted Teal");
    expect(all.models).toContain("RM1");
    expect(all.models).not.toContain("RM-GONE");
    expect(all.models).not.toContain("DM1");
  });
});
