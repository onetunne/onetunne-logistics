#!/usr/bin/env node
/**
 * E2E-перевірка етапу 5 (склад, виробництво, упаковка, підготовка замовлень) у ДЕМО в справжньому браузері
 * (Playwright/Chromium). Без Shopify й без мережі перевізника: накладні створює лише тестовий перевізник демо.
 *
 * Сценарій (детермінований — на початку скидає демо-дані):
 *  - власник, ПК 1280: залишки (фільтри модель/колір/товар/стан), надходження + повтор форми (без подвійного руху),
 *    брак (зокрема більше, ніж є), інвентаризація картки, лист інвентаризації (і відмова, якщо залишок змінився,
 *    поки рахували), масовий поріг, поріг у «Налаштування → Склад», скасування замовлення (резерв знято один раз);
 *    виробництво: нова партія → запуск → часткове надходження з браком (повтор форми, перевищення) → решта →
 *    закриття (залишок і «у виробництві» змінюються, собівартість видно);
 *    упаковка: матеріали (надходження + повтор форми), новий шаблон комплектації, перевірка шаблону на замовленні;
 *    підготовка: тестові накладні (масово), черга (фільтри, пріоритет), пакування зі скануванням (зокрема хибний
 *    товар), коробка, ручна вага/габарити, «Запаковано» → списання матеріалів, працівник; повтор «Запаковано»;
 *    масовий старт, друк документів, етикетки; передача перевізнику → списання в історії руху (повтор — без
 *    другого списання); розпакування й повторне «Запаковано» без повторного списання матеріалів;
 *    аналітика, CSV-експорт, сторінки синхронізації з Shopify (демо: нічого не надсилається);
 *    етап 5, раунд 6: аналітика свіжого демо (швидкість, запас у днях, ризики, рекомендації, «Створити партію» з
 *    кількістю) і віджети головної; ремонт і списання браку; статистика виробництва, фільтри й скасування партії;
 *    підбір коробки за габаритами (#1006) і «частина без габаритів» (#1005); шаблон на колекцію з фільтром моделі;
 *    лист комплектації й список передачі перевізнику; ручні ±1 з причиною; вага < 90 % (підтверджує лише власник);
 *    етикетки — PDF тестового перевізника; фільтр руху за моделлю/кольором; витрата матеріалу за 30 днів;
 *    «Проблеми» → «Склад» (скасування запакованого замовлення → «Повернуто на склад»);
 *  - працівник: не бачить собівартості (виробництво, рух, картка, матеріали, експорт, головна), не відкриває/не виконує
 *    дії власника (403 або відмова: партії виробництва в CSV, списання браку, підтвердження ваги), може оприбуткувати,
 *    пакувати, друкувати лист комплектації й список передачі;
 *  - телефони 320×568, 375×667, 390×844 (власник і працівник): без горизонтальної прокрутки, розмір елементів
 *    керування, надсилання форм, згорнуті «Масові дії» черги пакування;
 *  - англійська: пошук неперекладених українських рядків і сирих ключів i18n;
 *  - на кожній сторінці: помилки консолі (зокрема гідратації React #418/#423/#425), невдалі запити.
 *  Для налагодження: E2E_SKIP_PHONES=1 і E2E_SKIP_EN=1 пропускають телефони / англійську.
 *
 * Використання: зібрати й запустити демо (`npm run demo` або `npm run build && npm run start:demo`), потім
 *   BASE_URL=http://localhost:3000 SCREENSHOTS_DIR=screenshots/stage5 node scripts/e2e-stage5.mjs
 * Результат: знімки й `e2e-stage5-report.json` у SCREENSHOTS_DIR; код виходу 1, якщо є невдалі кроки.
 * Потрібен пакет `playwright` (локально або глобально) з Chromium.
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";

const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const ORIGIN = new URL(BASE).origin;
const OUT = process.env.SCREENSHOTS_DIR ?? "screenshots/stage5";
const ACTION_TIMEOUT = Number(process.env.E2E_TIMEOUT ?? 15000);

// ---------------------------------------------------------------------------
// Playwright (локальний або глобальний, як у scripts/e2e-smoke.mjs)
// ---------------------------------------------------------------------------
async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    try {
      const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
      return createRequire(path.join(globalRoot, "noop.js"))("playwright");
    } catch {
      console.error("Playwright не встановлено. Встановіть: npm i -D playwright && npx playwright install chromium");
      process.exit(2);
    }
  }
}
const { chromium } = await loadPlaywright();
// Незавершене очікування з кроку, що впав, не повинне зупиняти весь прохід.
process.on("unhandledRejection", (e) => console.log(`    ! unhandled: ${String(e?.message ?? e).split("\n")[0]}`));
fs.mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------------------
// Результати
// ---------------------------------------------------------------------------
/** @type {{name:string, viewport:string, role:string, status:"pass"|"fail"|"skipped", details:string, screenshot?:string}[]} */
const results = [];
/** @type {{role:string, viewport:string, url:string, kind:string, text:string}[]} */
const pageIssues = [];
/** Тексти, знайдені в англійській версії (неперекладене / сирі ключі). */
const i18nFindings = [];
/** Елементи керування, менші за 24×24 CSS px (WCAG 2.2 AA, 2.5.8), на телефонах. */
const tapFindings = [];

let shotIndex = 0;
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
async function shot(page, name) {
  const file = path.join(OUT, `${String(++shotIndex).padStart(3, "0")}-${slug(name)}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  return file;
}

async function step(name, meta, page, fn) {
  const checks = [];
  const ck = (cond, msg) => {
    checks.push({ ok: Boolean(cond), msg });
    console.log(`    ${cond ? "✓" : "✗"} ${msg}`);
    return Boolean(cond);
  };
  console.log(`▶ ${name} [${meta.role} ${meta.viewport}]`);
  let error = null;
  try {
    await fn(ck);
  } catch (e) {
    error = e;
    console.log(`    ✗ ERROR ${String(e?.message ?? e).split("\n")[0]}`);
  }
  const failed = checks.filter((c) => !c.ok).map((c) => c.msg);
  const status = error || failed.length > 0 ? "fail" : "pass";
  const screenshot = page ? await shot(page, `${meta.role}-${meta.viewport}-${name}`) : undefined;
  const passed = checks.filter((c) => c.ok).length;
  const details = [
    `${passed}/${checks.length} checks passed`,
    failed.length ? `FAILED: ${failed.join(" | ")}` : null,
    error ? `ERROR: ${String(error?.message ?? error).split("\n").slice(0, 3).join(" ")}` : null,
  ]
    .filter(Boolean)
    .join("; ");
  results.push({ name, viewport: meta.viewport, role: meta.role, status, details, screenshot });
  return status === "pass";
}

// ---------------------------------------------------------------------------
// Спостереження за сторінкою: помилки консолі, гідратація, невдалі запити
// ---------------------------------------------------------------------------
const HYDRATION_RE = /Minified React error #(418|423|425)|Hydration failed|hydrat|did not match|server rendered HTML/i;

function monitor(page, meta) {
  page.__expect = null; // { statuses:Set<number> } — очікувані коди (перевірка 403/400)
  const record = (url, kind, text) => pageIssues.push({ role: meta.role, viewport: meta.viewport, url, kind, text: text.slice(0, 400) });
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (page.__expect && /Failed to load resource: the server responded with a status of (\d+)/.test(text)) {
      const code = Number(text.match(/status of (\d+)/)?.[1]);
      if (page.__expect.statuses.has(code)) return;
    }
    record(page.url(), HYDRATION_RE.test(text) ? "hydration" : "console", text);
  });
  page.on("pageerror", (e) => record(page.url(), HYDRATION_RE.test(String(e)) ? "hydration" : "pageerror", String(e?.stack ?? e)));
  page.on("requestfailed", (r) => {
    const f = r.failure()?.errorText ?? "";
    // Скасовані запити (нова навігація перериває попередню, завантаження файлу) — не помилка застосунку.
    if (/ERR_ABORTED|NS_BINDING_ABORTED/.test(f)) return;
    record(r.url(), "requestfailed", `${r.method()} ${f}`);
  });
  page.on("response", (r) => {
    const s = r.status();
    if (s < 400) return;
    if (page.__expect?.statuses.has(s)) return;
    record(r.url(), "http", `${r.request().method()} ${s}`);
  });
}

async function expecting(page, statuses, fn) {
  page.__expect = { statuses: new Set(statuses) };
  try {
    return await fn();
  } finally {
    // Відповіді/повідомлення консолі можуть прийти трохи пізніше.
    await page.waitForTimeout(300);
    page.__expect = null;
  }
}

// ---------------------------------------------------------------------------
// Допоміжні дії
// ---------------------------------------------------------------------------
async function settle(page) {
  await page.waitForLoadState("networkidle", { timeout: ACTION_TIMEOUT }).catch(() => {});
}

async function go(page, p) {
  const res = await page.goto(`${BASE}${p}`, { waitUntil: "domcontentloaded" });
  await settle(page);
  return res;
}

async function setPref(context, intent, value) {
  const r = await context.request.post(`${BASE}/preferences`, {
    form: { intent, value, redirectTo: "/demo" },
    headers: { Origin: ORIGIN },
    maxRedirects: 0,
  });
  if (r.status() !== 302) throw new Error(`preferences ${intent}=${value} → ${r.status()}`);
}

/** Натиснути кнопку, що надсилає POST (з діалогом підтвердження або без), і дочекатися оновлення сторінки. */
async function submitPost(page, trigger, { confirm = false } = {}) {
  const post = page.waitForResponse((r) => r.request().method() === "POST", { timeout: ACTION_TIMEOUT }).catch(() => null);
  await trigger.click();
  if (confirm) await page.locator("dialog[open] button[type=submit]").click();
  const resp = await post;
  await settle(page);
  await page.waitForTimeout(150);
  return resp;
}

/** Натиснути кнопку GET-форми (фільтри) і дочекатися нової адреси. */
async function submitGet(page, trigger) {
  const before = page.url();
  await trigger.click();
  await page.waitForURL((u) => u.toString() !== before, { timeout: ACTION_TIMEOUT }).catch(() => {});
  await settle(page);
  // Адреса змінюється трохи раніше, ніж React показує нові дані.
  await page.waitForTimeout(250);
}

/** Клієнтський перехід (кнопка з navigate()): дочекатися адреси й елемента нової сторінки. */
async function arrive(page, urlRe, selector) {
  await page.waitForURL(urlRe, { timeout: ACTION_TIMEOUT });
  await settle(page);
  if (selector) await page.locator(selector).first().waitFor({ timeout: ACTION_TIMEOUT }).catch(() => {});
}

async function banners(page) {
  const all = await page.locator(".ot-banner").allInnerTexts();
  return all.map((t) => t.replace(/\s+/g, " ").trim()).filter((t) => !/Демонстраційний режим|Demo mode/i.test(t));
}

async function bannerText(page) {
  return (await banners(page)).join(" || ");
}

async function mainText(page) {
  return (await page.locator("main").first().innerText().catch(async () => page.locator("body").innerText())).replace(/\s+/g, " ");
}

async function noHScroll(page) {
  return page.evaluate(() => ({
    ok: document.documentElement.scrollWidth <= window.innerWidth + 1,
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    widest: (() => {
      let worst = null;
      for (const el of document.querySelectorAll("body *")) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const cs = getComputedStyle(el);
        if (cs.position === "fixed") continue;
        let p = el.parentElement;
        let clipped = false;
        while (p && p !== document.body) {
          const ps = getComputedStyle(p);
          if (/(auto|scroll|hidden|clip)/.test(ps.overflowX)) {
            clipped = true;
            break;
          }
          p = p.parentElement;
        }
        if (clipped) continue;
        if (r.right > window.innerWidth + 1 && (!worst || r.right > worst.right))
          worst = { right: Math.round(r.right), tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 60), text: (el.textContent ?? "").trim().slice(0, 50) };
      }
      return worst;
    })(),
  }));
}

/** Видимі елементи керування в <main>, менші за 24×24 px (крім посилань усередині тексту). */
async function smallTapTargets(page) {
  return page.evaluate(() => {
    const out = [];
    const sel = "main button, main a.ot-button, main [role=button], main input:not([type=hidden]), main select, main summary, main .ot-checkbox, main .ot-dt__select";
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      // Прапорці/радіо зазвичай мають більшу область натискання (label) — перевіряємо label, якщо є.
      if ((el.type === "checkbox" || el.type === "radio") && el.closest("label")) continue;
      if (el.closest("dialog:not([open])")) continue;
      if (r.width < 24 || r.height < 24) {
        out.push({
          tag: el.tagName.toLowerCase(),
          name: (el.getAttribute("aria-label") || el.textContent || el.getAttribute("name") || "").trim().slice(0, 40),
          w: Math.round(r.width),
          h: Math.round(r.height),
        });
      }
    }
    return out;
  });
}

/** Значення «Доступно / Фактично / Зарезервовано / У виробництві / Брак» з картки позиції. */
async function itemBalances(page) {
  return page.evaluate(() => {
    for (const g of document.querySelectorAll("main .ot-grid")) {
      const kids = [...g.children];
      if (kids.length !== 5) continue;
      const nums = kids.map((k) => (k.querySelector("span")?.textContent ?? "").replace(/[\s  ]/g, "").replace("−", "-"));
      if (!nums.every((n) => /^-?\d+$/.test(n))) continue;
      const [available, onHand, reserved, inProduction, defective] = nums.map(Number);
      return { available, onHand, reserved, inProduction, defective };
    }
    return null;
  });
}

/** SKU → шлях картки позиції та id варіанта (зі сторінки «Склад»). */
async function stockIndex(page) {
  await go(page, "/demo/warehouse?inactive=1");
  return page.evaluate(() => {
    const map = {};
    for (const input of document.querySelectorAll("input[name=variantIds]")) {
      const row = input.closest("tr");
      const link = row?.querySelector('a[href*="/warehouse/items/"]');
      // Мітка прапорця: «Вибрати OT-PH-BLK» / «Select OT-PH-BLK».
      const sku = (input.closest("label")?.textContent ?? "").trim().match(/(OT-[A-Z0-9-]+)$/)?.[1];
      if (sku && link) map[sku] = { variantId: input.value, href: link.getAttribute("href") };
    }
    return map;
  });
}

/** Залишки матеріалів: назва → кількість (зі сторінки матеріалів). */
async function materialStock(page) {
  await go(page, "/demo/warehouse/materials?activity=all");
  return page.evaluate(() => {
    const out = {};
    for (const row of document.querySelectorAll("main table tbody tr")) {
      const text = row.innerText.replace(/\s+/g, " ");
      const code = text.match(/(?:^|\s)([a-z][a-z0-9_]{2,})(?=\s)/)?.[1];
      const qty = text.match(/(-?\d[\d  ]*)\s(?:шт\.|м|pcs|m)(?=[\s.]|$)/)?.[1];
      if (code && qty !== undefined) out[code] = Number(qty.replace(/[\s  ]/g, ""));
    }
    return out;
  });
}

/** Ім'я input за префіксом (good./defective./reason.) у рядку з потрібним SKU. */
async function lineInputName(page, prefix, sku) {
  return page.evaluate(
    ({ prefix, sku }) => {
      for (const el of document.querySelectorAll(`input[name^="${prefix}."]`)) {
        let n = el.parentElement;
        while (n && !/OT-[A-Z0-9]/.test(n.textContent ?? "")) n = n.parentElement;
        if (n && (n.textContent ?? "").includes(sku)) return el.getAttribute("name");
      }
      return null;
    },
    { prefix, sku },
  );
}

/** Ввести код у поле сканування (як сканер: текст + Enter) і дочекатися відгуку. */
async function scanCode(page, code, expect) {
  const live = page.locator("[aria-live=assertive]").first();
  const norm = (t) => t.replace(/\s+/g, " ").trim();
  const before = norm(await live.innerText().catch(() => ""));
  const resp = page.waitForResponse((r) => r.request().method() === "POST", { timeout: ACTION_TIMEOUT }).catch(() => null);
  await page.locator("#packing-scan-code").fill(code);
  await page.locator("#packing-scan-code").press("Enter");
  await resp;
  await settle(page);
  let text = before;
  for (let i = 0; i < 25; i++) {
    text = norm(await live.innerText().catch(() => ""));
    if (expect ? expect.test(text) : text !== before) break;
    await page.waitForTimeout(200);
  }
  return text;
}

async function openDetails(page, summaryText) {
  const summary = page.locator("main summary", { hasText: summaryText }).first();
  const details = summary.locator("xpath=..");
  if (!(await details.evaluate((d) => d.open).catch(() => false))) await summary.click();
}

/**
 * Рядки таблиці DataTable за підписом (<caption>): [{ _text, «заголовок колонки»: значення }]. Значення — текст
 * .ot-dt__value (без мобільної мітки колонки) або всієї клітинки. null — таблиці з таким підписом немає.
 */
async function tableRows(page, caption) {
  return page.evaluate((caption) => {
    const norm = (s) => (s ?? "").replace(/\s+/g, " ").trim();
    const table = [...document.querySelectorAll("main table")].find((t) => norm(t.querySelector("caption")?.textContent).startsWith(caption));
    if (!table) return null;
    const heads = [...table.querySelectorAll("thead th")].map((th) => norm(th.textContent));
    return [...table.querySelectorAll("tbody tr")].map((tr) => {
      const row = { _text: norm(tr.innerText) };
      [...tr.children].forEach((cell, i) => {
        row[heads[i] || `#${i}`] = norm((cell.querySelector(".ot-dt__value") ?? cell).textContent);
      });
      return row;
    });
  }, caption);
}

/** Значення колонки, заголовок якої починається з prefix (заголовки можуть мати підказки). */
const col = (row, prefix) => {
  const key = Object.keys(row ?? {}).find((k) => k.startsWith(prefix));
  return key ? row[key] : undefined;
};

/** Перше число в тексті (українська десяткова кома, пробіли між розрядами, «−»). */
const num = (s) => {
  const m = String(s ?? "")
    .replace(/[\u00a0\u202f]/g, " ")
    .replace(/(\d) (?=\d{3}\b)/g, "$1")
    .replace("−", "-")
    .match(/-?\d+(?:[.,]\d+)?/);
  return m ? Number(m[0].replace(",", ".")) : NaN;
};

/** Дата за київським часом через n днів у форматі інтерфейсу (ДД.ММ.РРРР). */
// Номер засіяної партії «у виробництві» — PB-<рік за Києвом>-0001 (seedDemoWarehouse), не прив'язуємося до 2026.
const SEEDED_BATCH = `PB-${new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric" }).format(new Date())}-0001`;
const kyivDate = (n = 0) =>
  new Intl.DateTimeFormat("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(Date.now() + n * 86_400_000));
/** Дата збігається з «сьогодні + n» (±1 день — запас на північ і округлення прогнозу). */
const isAroundDay = (text, n) => [n - 1, n, n + 1].some((d) => String(text ?? "").includes(kyivDate(d)));

/** Новий контекст браузера з роллю демо (cookie) і мовою; сторінка зі спостереженням за помилками. */
async function rolePage(role, viewport = { width: 1280, height: 900 }, locale = "uk") {
  const ctx = await browser.newContext({ viewport, locale: locale === "en" ? "en-US" : "uk-UA", acceptDownloads: true });
  await setPref(ctx, "demoRole", role);
  await setPref(ctx, "locale", locale);
  const page = await ctx.newPage();
  monitor(page, { role, viewport: `${viewport.width}x${viewport.height}` });
  page.setDefaultTimeout(ACTION_TIMEOUT);
  page.__role = role;
  return { ctx, page };
}

/** Текст картки «Перевірити на замовленні» сторінки шаблонів (без переліку шаблонів над нею). */
async function kitCheckText(page) {
  return (await page.locator("main section:has(#kits-check-order)").first().innerText().catch(() => "")).replace(/\s+/g, " ");
}

/** Позиції листа комплектації: [{ text, qty }]. */
async function pickRows(page) {
  return page.locator("main .ot-pick__row").evaluateAll((els) =>
    els.map((el) => ({ text: el.innerText.replace(/\s+/g, " ").trim(), qty: Number(el.querySelector(".ot-pick__qty")?.textContent?.trim() ?? "NaN") })),
  );
}

const today = () => new Date(Date.now() + 2 * 3600_000).toISOString().slice(0, 10);
const inDays = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const COST_RE = /собіварт|₴|\bUAH\b|unit cost|cost per/i;
/**
 * Вигадана історія демо (app/db/seed/demo-history.server.ts), уже наявна в новому демо: дві завершені партії
 * (надходження 62/57 днів тому — вчасно; 19 днів тому — із запізненням) і витрата матеріалів за 30 днів.
 * Числа — з DEMO_PRODUCTION_HISTORY / DEMO_MATERIAL_HISTORY (тест tests/stage5/seed-production-history.test.ts).
 */
const DEMO_HISTORY = {
  good90: 114, defective90: 4, completed90: 2, onTime90: 1,
  good30: 22, defective30: 1,
  boltsUsed30: 6,
  fenderBatches: 1,
  // Власник, аналітика: «Вартість запасу» — 5 товарів історії за собівартістю останнього надходження, решта — без неї.
  inventoryValue: "28 931,21 грн",
  valueMissing: "Без собівартості: 4 позиції (61 шт.)",
};

// ---------------------------------------------------------------------------
// Сценарій
// ---------------------------------------------------------------------------
const browser = await chromium.launch();
const state = {}; // ідентифікатори, знайдені під час проходу
// Запасні адреси, якщо попередній крок не вдався (щоб наступні перевірки все одно виконалися).
const packingUrl = () => state.packing1002 ?? "/demo/picking";
const packingOrderId = () => (state.packing1002 ?? "").split("/").pop() || "00000000-0000-0000-0000-000000000000";
const batchUrl = () => state.batchUrl ?? "/demo/production";
const itemHref = (sku) => state.index?.[sku]?.href ?? "/demo/warehouse";
try {
  // ======================= ВЛАСНИК, ПК 1280 =======================
  const D = { role: "owner", viewport: "1280x900" };
  const ownerCtx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "uk-UA", acceptDownloads: true });
  await setPref(ownerCtx, "demoRole", "owner");
  await setPref(ownerCtx, "locale", "uk");
  const p = await ownerCtx.newPage();
  monitor(p, D);
  p.setDefaultTimeout(ACTION_TIMEOUT);

  await step("reset demo data", D, p, async (ck) => {
    const r = await ownerCtx.request.post(`${BASE}/demo/settings`, { form: { intent: "resetDemo" }, headers: { Origin: ORIGIN } });
    ck(r.ok(), `reset accepted (${r.status()})`);
    const res = await go(p, "/demo/warehouse");
    ck(res?.status() === 200, `warehouse page 200 (${res?.status()})`);
  });

  await step("warehouse: inventory initialized", D, p, async (ck) => {
    const initButton = p.locator("form:has(input[name=intent][value=initialize]) button[aria-haspopup=dialog]");
    if ((await initButton.count()) > 0 && !(await mainText(p)).includes("Облік запущено")) {
      await submitPost(p, initButton.first(), { confirm: true });
    }
    ck((await mainText(p)).includes("Облік запущено"), "inventory accounting is started (opening balances)");
    state.index = await stockIndex(p);
    ck(Object.keys(state.index).length >= 9, `stock list has all demo variants (${Object.keys(state.index).length})`);
    ck((await p.locator("main table thead").innerText()).includes("Доступно"), "stock table shows available column");
  });

  // Свіжі демо-дані (типові налаштування): історія продажів демо (#0978–#0995, 6–85 днів тому) дає швидкість продажів,
  // запас у днях, ризики й рекомендації. Значення — до будь-яких операцій сценарію.
  await step("analytics (fresh demo): velocity, days of stock, risks, recommendations, prefilled batch", D, p, async (ck) => {
    const res = await go(p, "/demo/warehouse/analytics");
    ck(res?.status() === 200, `analytics 200 (${res?.status()})`);
    // Головне меню: «Аналітика» — звичайний пункт основної групи. Етап 6: власник (finance.view) — аналітика бізнесу
    // (/demo/analytics); працівник із warehouse.view — аналітика складу (крок меню працівника нижче).
    const menu = p.locator('nav.ot-nav > ul.ot-nav__list a[href="/demo/analytics"]');
    ck((await menu.count()) === 1 && (await menu.innerText()).includes("Аналітика"), "main menu «Аналітика» → /demo/analytics (owner, main group)");
    ck((await p.locator('nav.ot-nav .ot-nav__group a[href="/demo/analytics"]').count()) === 0, "«Аналітика» not in the planned group");
    const txt = await mainText(p);
    const risk = txt.match(/Під ризиком З них немає в наявності: (\d+) (\d+)/);
    const rec = txt.match(/Позицій до виробництва Разом ([\d\s]+?) шт\. (\d+)/);
    const unitsSold = num(txt.match(/Продано, шт\. ([\d\s]+)/)?.[1]);
    state.kpi = { atRisk: Number(risk?.[2]), out: Number(risk?.[1]), recs: Number(rec?.[2]), units: num(rec?.[1]) };
    ck(state.kpi.atRisk === 2 && state.kpi.out === 0, `KPI: 2 at risk, 0 out of stock (${JSON.stringify(state.kpi)})`);
    ck(state.kpi.recs === 2 && state.kpi.units === 40, `KPI: 2 items / 40 units to produce (${JSON.stringify(state.kpi)})`);
    const valueKpi = txt.match(/Вартість запасу.{0,120}/)?.[0] ?? "—";
    ck(valueKpi.includes(DEMO_HISTORY.inventoryValue) && valueKpi.includes(DEMO_HISTORY.valueMissing), `owner KPI «Вартість запасу» = ${DEMO_HISTORY.inventoryValue}, ${DEMO_HISTORY.valueMissing} (${valueKpi})`);

    const riskRows = (await tableRows(p, "Позиції під ризиком")) ?? [];
    const bagRisk = riskRows.find((r) => r._text.includes("OT-BG-BLK"));
    const whtRisk = riskRows.find((r) => r._text.includes("OT-PH-WHT"));
    ck(riskRows.length === 2 && bagRisk && whtRisk, `risk list: OT-BG-BLK and OT-PH-WHT (${riskRows.map((r) => r._text.slice(0, 60)).join(" | ")})`);
    ck(isAroundDay(col(bagRisk, "Закінчиться"), 22), `OT-BG-BLK runs out ≈ today+22 = ${kyivDate(22)} (${col(bagRisk, "Закінчиться")})`);
    ck(isAroundDay(col(whtRisk, "Закінчиться"), 23), `OT-PH-WHT runs out ≈ today+23 = ${kyivDate(23)} (${col(whtRisk, "Закінчиться")})`);
    const v30 = num(col(bagRisk, "Швидкість"));
    const cover = num(col(bagRisk, "Запасу на"));
    const available = num(col(bagRisk, "Доступно"));
    ck(v30 > 0 && Math.abs(cover - available / v30) <= Math.max(0.6, cover * 0.03), `days of stock = available / velocity (${available} / ${v30} ≈ ${cover} дн.)`);
    ck(/50 шт\./.test(col(whtRisk, "Надходить") ?? ""), `OT-PH-WHT: incoming 50 from the seeded batch (${col(whtRisk, "Надходить")})`);

    const recRows = (await tableRows(p, "Рекомендації виробництва")) ?? [];
    const bagRec = recRows.find((r) => r._text.includes("OT-BG-BLK"));
    const fkxRec = recRows.find((r) => r._text.includes("OT-FK-X"));
    ck(recRows.length === 2 && num(col(bagRec, "Виготовити")) === 30 && num(col(fkxRec, "Виготовити")) === 10, `recommendations: OT-BG-BLK 30, OT-FK-X 10 (${recRows.map((r) => `${r._text.slice(0, 40)}…`).join(" | ")})`);
    ck(num(col(bagRec, "Швидкість")) > 0 && /30 дн\.: \d/.test(col(bagRec, "Швидкість") ?? ""), `recommendation shows velocity (${col(bagRec, "Швидкість")})`);
    ck(/Попит за 90 дн\.: \d+/.test(col(bagRec, "Розрахунок") ?? ""), `recommendation explains the calculation (${col(bagRec, "Розрахунок")})`);

    const sales = (await tableRows(p, "Продажі за варіантами")) ?? [];
    const bagSales = sales.find((r) => r._text.includes("OT-BG-BLK"));
    const soldSum = sales.reduce((a, r) => a + num(col(r, "Продано")), 0);
    ck(sales.length >= 9 && soldSum === unitsSold, `sales by variant add up to the KPI «Продано» (${soldSum} = ${unitsSold})`);
    ck(num(col(bagSales, "Шт./день")) === v30 && num(col(bagSales, "Запасу на")) === cover, `sales row velocity/cover match the risk list (${col(bagSales, "Шт./день")}, ${col(bagSales, "Запасу на")})`);

    // «Створити партію» — форма нової партії з рекомендованою кількістю (не зберігаємо).
    const create = p.locator("main table", { has: p.locator("caption", { hasText: "Рекомендації виробництва" }) }).locator("tbody tr", { hasText: "OT-BG-BLK" }).locator("a", { hasText: "Створити партію" });
    ck((await create.count()) === 1, "«Створити партію» link in the OT-BG-BLK row");
    await create.first().click();
    await arrive(p, /\/demo\/production\/new\?/, "#batch-title");
    const u = new URL(p.url());
    const bagId = state.index["OT-BG-BLK"].variantId;
    ck(u.searchParams.get("product") && u.searchParams.get(`qty.${bagId}`) === "30", `prefilled URL: product + qty.<OT-BG-BLK>=30 (${u.pathname}${u.search})`);
    const field = p.locator(`input[name="qty.${bagId}"]`);
    await field.waitFor().catch(() => {});
    ck((await field.count()) === 1 && (await field.inputValue()) === "30", `batch form: OT-BG-BLK quantity = 30 (${await field.inputValue().catch(() => "—")})`);
  });

  await step("dashboard (fresh demo): risk / recommendation counts match analytics", D, p, async (ck) => {
    const res = await go(p, "/demo");
    ck(res?.status() === 200, `dashboard 200 (${res?.status()})`);
    const t = await mainText(p);
    const atRisk = Number(t.match(/Під ризиком закінчення (\d+)/)?.[1]);
    const recs = Number(t.match(/Потребують нової партії (\d+)/)?.[1]);
    const units = num(t.match(/Рекомендовано виготовити: ([\d\s]+)/)?.[1]);
    ck(atRisk === state.kpi?.atRisk && recs === state.kpi?.recs && units === state.kpi?.units, `dashboard ${atRisk} at risk, ${recs} items, ${units} units = analytics ${JSON.stringify(state.kpi)}`);
    ck((await p.locator('main a[href="/demo/warehouse/analytics"]', { hasText: "Відкрити аналітику" }).count()) === 1, "dashboard links to warehouse analytics");
    ck(/Попередження складу/.test(t) && /Черга пакування/.test(t) && /Активних партій/.test(t), "stock alerts, packing queue and production widgets shown");
  });

  await step("warehouse: filters by model / color / product / status", D, p, async (ck) => {
    await go(p, "/demo/warehouse");
    const form = p.locator("form[role=search]");
    await form.locator("select[name=model]").selectOption({ label: "Model S" });
    await submitGet(p, form.locator("button[type=submit]"));
    let rows = await p.locator("main table tbody tr").allInnerTexts();
    ck(rows.length === 1 && rows[0].includes("OT-FK-S"), `model=Model S → only OT-FK-S (${rows.length} rows)`);
    await go(p, "/demo/warehouse");
    await p.locator("form[role=search] select[name=color]").selectOption({ label: "Білий" });
    await submitGet(p, p.locator("form[role=search] button[type=submit]"));
    rows = await p.locator("main table tbody tr").allInnerTexts();
    ck(rows.length === 1 && rows[0].includes("OT-PH-WHT"), `color=Білий → only OT-PH-WHT (${rows.length} rows)`);
    await go(p, "/demo/warehouse");
    await p.locator("form[role=search] select[name=product]").selectOption({ label: "Тримач телефону Pro" });
    await submitGet(p, p.locator("form[role=search] button[type=submit]"));
    rows = await p.locator("main table tbody tr").allInnerTexts();
    ck(rows.length === 2 && rows.every((r) => r.includes("OT-PH-")), `product=Тримач → 2 holder variants (${rows.length})`);
    await go(p, "/demo/warehouse");
    await p.locator("main nav a", { hasText: /^Мало/ }).first().click();
    await p.waitForURL(/status=low/);
    await settle(p);
    rows = await p.locator("main table tbody tr").allInnerTexts();
    ck(rows.length >= 1 && rows.some((r) => r.includes("OT-FK-S")), `status chip «Мало» lists OT-FK-S (${rows.length})`);
    await go(p, "/demo/warehouse?q=4820000000017");
    rows = await p.locator("main table tbody tr").allInnerTexts();
    ck(rows.length === 1 && rows[0].includes("OT-PH-BLK"), "search by barcode finds the variant");
  });

  await step("item: receive stock + replayed form does not double-count", D, p, async (ck) => {
    const item = state.index["OT-PH-BLK"];
    ck(Boolean(item), "OT-PH-BLK card found");
    await go(p, item.href);
    const b0 = await itemBalances(p);
    ck(b0 !== null, `balances read (${JSON.stringify(b0)})`);
    await openDetails(p, "Надходження");
    const form = p.locator("form:has(input[name=intent][value=receive])");
    const opId = await form.locator("input[name=operationId]").inputValue();
    await form.locator("#wh-receive-qty").fill("5");
    await form.locator("#wh-receive-damaged").fill("1");
    await form.locator("#wh-receive-reason").selectOption("purchase");
    ck((await form.locator("#wh-receive-cost").count()) === 1, "owner sees unit cost field");
    await form.locator("#wh-receive-cost").fill("150");
    const currency = await form.locator("#wh-receive-currency").inputValue();
    ck(currency === "UAH", `default receipt cost currency matches warehouse/batch currency UAH (got ${currency})`);
    await form.locator("#wh-receive-currency").fill("UAH");
    await form.locator("#wh-receive-note").fill("e2e receipt");
    await submitPost(p, form.locator("button[type=submit]"));
    ck((await bannerText(p)).includes("Оприбутковано"), `success banner (${await bannerText(p)})`);
    const b1 = await itemBalances(p);
    ck(b1.onHand === b0.onHand + 5 && b1.defective === b0.defective + 1 && b1.available === b0.available + 5, `onHand +5, defective +1 (${JSON.stringify(b1)})`);
    // Повтор тієї самої форми (той самий operationId) — подвійне натискання / повтор після збою мережі.
    const replay = await p.request.post(`${BASE}${item.href}`, {
      form: { intent: "receive", operationId: opId, quantity: "5", defectiveQuantity: "1", reason: "purchase", unitCost: "150", costCurrency: "UAH", note: "e2e receipt" },
      headers: { Origin: ORIGIN },
    });
    const html = await replay.text();
    ck(replay.ok() && html.includes("вже надіслано"), `replay answered «already submitted» (${replay.status()})`);
    await go(p, item.href);
    const b2 = await itemBalances(p);
    ck(JSON.stringify(b2) === JSON.stringify(b1), `replay did not change stock (${JSON.stringify(b2)})`);
    state.phBlk = b2;
    // Демо: Shopify не оновлюється — після надходження «доступно» відрізняється від демо-значення Shopify, але
    // розбіжність не позначається ні в картці, ні в списку (лише нейтральна підказка; звірка в демо нічого не робить).
    const card = await mainText(p);
    ck(!/Розбіжність перевіряється звіркою/.test(card) && /Демо: Shopify не оновлюється/.test(card), "item card: demo hint instead of the Shopify «differs» note");
    await go(p, "/demo/warehouse");
    const body = (await p.locator("main table tbody").innerText()).replace(/\s+/g, " ");
    ck(!/розбіжність/i.test(body), "stock list (demo): no «розбіжність» marker in rows");
  });

  await step("item: mark defective + stocktake (count) on the card", D, p, async (ck) => {
    const item = state.index["OT-PH-BLK"];
    await go(p, item.href);
    const b0 = await itemBalances(p);
    await openDetails(p, "Позначити брак");
    const df = p.locator("form:has(input[name=intent][value=defect])");
    await df.locator("#wh-defect-qty").fill("2");
    await df.locator("#wh-defect-reason").selectOption("damaged_in_warehouse");
    await submitPost(p, df.locator("button[type=submit]"));
    const b1 = await itemBalances(p);
    ck(b1.onHand === b0.onHand - 2 && b1.defective === b0.defective + 2, `defect: onHand −2, defective +2 (${JSON.stringify(b1)})`);
    // Більше браку, ніж фізично є, — відмова без зміни залишку.
    await openDetails(p, "Позначити брак");
    await df.locator("#wh-defect-qty").fill(String(b1.onHand + 100));
    const disabled = await df.locator("button[type=submit]").isDisabled();
    if (!disabled) {
      await submitPost(p, df.locator("button[type=submit]"));
      ck(/Недостатньо залишку|Помилка/.test(await bannerText(p)), `defect > on hand rejected (${(await bannerText(p)).slice(0, 140)})`);
    } else ck(true, "defect > on hand: submit disabled in the form");
    // Сервер теж відхиляє (обхід інтерфейсу).
    const direct = await p.request.post(`${BASE}${item.href}`, {
      form: { intent: "defect", operationId: crypto.randomUUID(), quantity: String(b1.onHand + 100), reason: "damaged_in_warehouse" },
      headers: { Origin: ORIGIN },
    });
    ck(/Недостатньо залишку/.test(await direct.text()), "server rejects defect > on hand");
    await go(p, item.href);
    ck(JSON.stringify(await itemBalances(p)) === JSON.stringify(b1), "stock unchanged after rejected defect");
    await openDetails(p, "Інвентаризація");
    const cf = p.locator("form:has(input[name=intent][value=count])");
    const target = b1.onHand + 3;
    await cf.locator("#wh-count-qty").fill(String(target));
    await submitPost(p, cf.locator("button[aria-haspopup=dialog]"), { confirm: true });
    const b2 = await itemBalances(p);
    ck(b2.onHand === target && b2.reserved === b1.reserved, `count set onHand=${target} (${JSON.stringify(b2)})`);
    const txt = await mainText(p);
    ck(/Коригування|Інвентаризац/.test(txt) && txt.includes("Demo Owner"), "movement with actor name shown in recent movements");
    ck(COST_RE.test(txt), "owner sees cost in item movements");
  });

  await step("item: repair a defect and write off a defect (replayed write-off not applied twice)", D, p, async (ck) => {
    const item = state.index["OT-PH-BLK"];
    await go(p, item.href);
    const b0 = await itemBalances(p);
    ck(b0.defective >= 2, `item has defective units (${b0.defective})`);
    await openDetails(p, "Брак відремонтовано");
    const rf = p.locator("form:has(input[name=intent][value=repair])");
    await rf.locator("#wh-repair-qty").fill("1");
    await submitPost(p, rf.locator("button[type=submit]"));
    const b1 = await itemBalances(p);
    ck(b1.defective === b0.defective - 1 && b1.onHand === b0.onHand + 1 && b1.available === b0.available + 1, `repair: defective −1, on hand +1 (${JSON.stringify(b1)})`);
    await openDetails(p, "Списати брак");
    const wf = p.locator("form:has(input[name=intent][value=writeOff])");
    const opId = await wf.locator("input[name=operationId]").inputValue();
    await wf.locator("#wh-writeoff-qty").fill("1");
    const reason = await wf.locator("#wh-writeoff-reason").inputValue();
    await submitPost(p, wf.locator("button[aria-haspopup=dialog]"), { confirm: true });
    const b2 = await itemBalances(p);
    ck(b2.defective === b1.defective - 1 && b2.onHand === b1.onHand && b2.available === b1.available, `write-off: defective −1, on hand unchanged (${JSON.stringify(b2)})`);
    const replay = await p.request.post(`${BASE}${item.href}`, { form: { intent: "writeOff", operationId: opId, quantity: "1", reason, note: "" }, headers: { Origin: ORIGIN } });
    ck(replay.ok() && (await replay.text()).includes("вже надіслано"), `replayed write-off answered «already submitted» (${replay.status()})`);
    await go(p, item.href);
    ck(JSON.stringify(await itemBalances(p)) === JSON.stringify(b2), "replayed write-off did not change stock");
    await go(p, `/demo/warehouse/movements?item=${encodeURIComponent(item.href.split("/").pop())}`);
    const mv = await mainText(p);
    ck(mv.includes("Брак відремонтовано") && mv.includes("Списання браку"), "repair and write-off movements in history");
  });

  await step("warehouse: bulk stocktake sheet for selected items", D, p, async (ck) => {
    await go(p, "/demo/warehouse");
    await p.getByRole("checkbox", { name: "Вибрати OT-GR-BLK" }).check();
    await p.getByRole("checkbox", { name: "Вибрати OT-GR-GRY" }).check();
    await p.getByRole("link", { name: /Інвентаризація вибраних \(2\)/ }).click();
    await p.waitForURL(/view=stocktake/);
    await settle(p);
    const inputs = p.locator('input[name^="counted."]');
    await inputs.first().waitFor();
    ck((await inputs.count()) === 2, `sheet has 2 rows (${await inputs.count()})`);
    const sys = await p.locator('input[name^="expected."]').evaluateAll((els) => els.map((e) => ({ name: e.name, value: Number(e.value) })));
    for (const s of sys) await p.locator(`input[name="counted.${s.name.slice("expected.".length)}"]`).fill(String(s.value + 1));
    await submitPost(p, p.locator("#warehouse-stocktake-form button[aria-haspopup=dialog]").first(), { confirm: true });
    const txt = await bannerText(p);
    ck(/Інвентаризацію збережено|збережено|Підраховано/i.test(txt), `stocktake saved (${txt})`);
  });

  await step("warehouse: bulk low-stock threshold", D, p, async (ck) => {
    await go(p, "/demo/warehouse");
    await p.getByRole("checkbox", { name: "Вибрати OT-BG-BLK" }).check();
    await p.locator("input[name=threshold]").fill("20");
    await submitPost(p, p.locator("form:has(button[value=bulkThreshold]) button[aria-haspopup=dialog]").first(), { confirm: true });
    ck((await bannerText(p)).length > 0, `banner after threshold (${await bannerText(p)})`);
    await go(p, "/demo/warehouse?status=low");
    const rows = await p.locator("main table tbody tr").allInnerTexts();
    ck(rows.some((r) => r.includes("OT-BG-BLK")), "OT-BG-BLK now listed as low (available ≤ 20)");
  });

  await step("order cancel releases the reservation exactly once", D, p, async (ck) => {
    const bag = state.index["OT-BG-BLK"].href;
    await go(p, bag);
    const b0 = await itemBalances(p);
    await go(p, "/demo/orders");
    const orderHref = await p.getByRole("link", { name: "#1003" }).first().getAttribute("href");
    await go(p, orderHref);
    await submitPost(p, p.locator("form:has(input[name=intent][value=cancelOrder]) button[aria-haspopup=dialog]").first(), { confirm: true });
    ck((await bannerText(p)).includes("Замовлення скасовано"), "order cancelled");
    await go(p, bag);
    const b1 = await itemBalances(p);
    ck(b1.reserved === b0.reserved - 1 && b1.onHand === b0.onHand && b1.available === b0.available + 1, `reserved −1, on hand unchanged (${JSON.stringify(b0)} → ${JSON.stringify(b1)})`);
    const replay = await p.request.post(`${BASE}${orderHref}`, { form: { intent: "cancelOrder" }, headers: { Origin: ORIGIN } });
    ck(replay.status() < 500, `replayed cancel answered (${replay.status()})`);
    await go(p, bag);
    ck(JSON.stringify(await itemBalances(p)) === JSON.stringify(b1), "replayed cancel did not release twice");
  });

  await step("settings → Склад: default low-stock threshold re-evaluates alerts", D, p, async (ck) => {
    await go(p, "/demo/settings");
    const form = p.locator("form:has(input[name=intent][value=saveWarehouse])");
    ck((await form.count()) === 1, "warehouse settings section present (referenced by «Налаштування → Склад»)");
    if ((await form.count()) === 0) return;
    const original = await form.locator("input[name=lowStockThreshold]").inputValue();
    await form.locator("input[name=lowStockThreshold]").fill("15");
    await submitPost(p, form.locator("button[type=submit]").last());
    const saved = (await banners(p)).find((b) => /Налаштування збережено|Збережено\. Попередження переоцінено/.test(b));
    ck(Boolean(saved), `saved (${saved ?? (await bannerText(p)).slice(0, 140)})`);
    await go(p, "/demo/warehouse?status=low");
    let rows = await p.locator("main table tbody tr").allInnerTexts();
    ck(rows.some((r) => r.includes("OT-TR-1025")), `OT-TR-1025 (available ≈10) becomes low with default 15 (${rows.length} low)`);
    await go(p, "/demo/settings");
    await form.locator("input[name=lowStockThreshold]").fill(original);
    await submitPost(p, form.locator("button[type=submit]").last());
    await go(p, "/demo/warehouse?status=low");
    rows = await p.locator("main table tbody tr").allInnerTexts();
    ck(!rows.some((r) => r.includes("OT-TR-1025")), `restored default ${original}: OT-TR-1025 no longer low`);
  });

  await step("warehouse: stocktake sheet detects stock changed while counting", D, p, async (ck) => {
    const item = state.index["OT-TR-1025"];
    await go(p, `/demo/warehouse?view=stocktake&items=${item.variantId}`);
    const expected = Number(await p.locator(`input[name="expected.${item.variantId}"]`).inputValue());
    // Поки рахують, хтось оприбуткував 1 од. (інша вкладка / працівник).
    const other = await p.context().newPage();
    await go(other, item.href);
    await openDetails(other, "Надходження");
    const rf = other.locator("form:has(input[name=intent][value=receive])");
    await rf.locator("#wh-receive-qty").fill("1");
    await rf.locator("#wh-receive-reason").selectOption("found");
    await submitPost(other, rf.locator("button[type=submit]"));
    await other.close();
    await p.locator(`input[name="counted.${item.variantId}"]`).fill(String(expected));
    await submitPost(p, p.locator("#warehouse-stocktake-form button[aria-haspopup=dialog]").first(), { confirm: true });
    const txt = await bannerText(p);
    ck(/змінив|змінено|Помилка/i.test(txt) && !/Інвентаризацію збережено/.test(txt), `stale count rejected (${txt.slice(0, 160)})`);
    await go(p, item.href);
    const b = await itemBalances(p);
    ck(b.onHand === expected + 1, `concurrent receipt not overwritten by stale count (onHand ${b.onHand}, expected ${expected + 1})`);
  });

  // ---------------- Виробництво ----------------
  await step("production: create batch (products, models/colors, quantities, date, costs)", D, p, async (ck) => {
    await go(p, "/demo/production");
    await p.getByRole("link", { name: "Нова партія" }).first().click();
    await p.waitForURL(/\/production\/new/);
    await settle(p);
    await p.getByRole("checkbox", { name: /Тримач телефону Pro/ }).check();
    await p.getByRole("checkbox", { name: /Крило заднє/ }).check();
    await submitGet(p, p.getByRole("button", { name: "Показати сітку" }));
    state.gridUrl = new URL(p.url()).pathname + new URL(p.url()).search;
    const blk = state.index["OT-PH-BLK"].variantId;
    const fkx = state.index["OT-FK-X"].variantId;
    await p.locator(`input[name="qty.${blk}"]`).waitFor().catch(() => {});
    ck((await p.locator(`input[name="qty.${blk}"]`).count()) === 1, "grid has quantity input for OT-PH-BLK");
    ck((await p.locator(`input[name="cost.${blk}"]`).count()) === 1, "owner sees unit cost inputs in grid");
    await p.locator("#batch-title").fill("E2E batch holders + fenders");
    await p.locator("#batch-ready").fill(inDays(10));
    await p.locator("#batch-manufacturer").fill("E2E factory");
    await p.locator("#batch-extra-cost").fill("500");
    await p.locator(`input[name="qty.${blk}"]`).fill("20");
    await p.locator(`input[name="cost.${blk}"]`).fill("200");
    await p.locator(`input[name="qty.${fkx}"]`).fill("10");
    await p.locator(`input[name="cost.${fkx}"]`).fill("300");
    await submitPost(p, p.getByRole("button", { name: "Створити партію" }));
    await p.waitForURL(/\/production\/[0-9a-f-]{36}/).catch(() => {});
    state.batchUrl = new URL(p.url()).pathname;
    ck(/\/production\/[0-9a-f-]{36}$/.test(state.batchUrl), `redirected to batch page (${state.batchUrl})`);
    const txt = await mainText(p);
    ck(txt.includes("Заплановано"), "batch status: planned");
    ck(COST_RE.test(txt), "owner sees batch costs");
  });

  await step("production: start → in-production numbers on stock", D, p, async (ck) => {
    await go(p, state.batchUrl);
    await submitPost(p, p.getByRole("button", { name: "Запустити у виробництво" }), { confirm: true });
    ck((await mainText(p)).includes("У виробництві"), "status in production");
    await go(p, state.index["OT-PH-BLK"].href);
    const b = await itemBalances(p);
    state.phBlkAfterStart = b;
    ck(b.inProduction === state.phBlk.inProduction + 20, `OT-PH-BLK in production +20 (${b.inProduction})`);
  });

  await step("production: partial receipt with defect", D, p, async (ck) => {
    await go(p, state.batchUrl);
    const good = await lineInputName(p, "good", "OT-PH-BLK");
    const bad = await lineInputName(p, "defective", "OT-PH-BLK");
    const reason = await lineInputName(p, "reason", "OT-PH-BLK");
    ck(Boolean(good && bad && reason), `receipt inputs for OT-PH-BLK found (${good}, ${bad})`);
    await p.locator(`input[name="${good}"]`).fill("8");
    await p.locator(`input[name="${bad}"]`).fill("2");
    const rs = p.locator(`input[name="${reason}"]`);
    if (!(await rs.isVisible())) await rs.locator("xpath=ancestor::details[1]/summary").click();
    await rs.fill("scratches");
    const receiptKey = await p.locator("input[name=receiptKey]").inputValue();
    await submitPost(p, p.locator('button[type=submit][value="receive"]'));
    // Повтор тієї самої форми (подвійне натискання / «Назад» і повторне надсилання) — без другого надходження.
    const replay = await p.request.post(`${BASE}${state.batchUrl}`, {
      form: { receiptKey, intent: "receive", [good]: "8", [bad]: "2", [reason]: "scratches", note: "" },
      headers: { Origin: ORIGIN },
    });
    ck((await replay.text()).includes("вже записано"), `replayed receipt answered «already recorded» (${replay.status()})`);
    await go(p, state.batchUrl);
    const txt = await mainText(p);
    ck(txt.includes("Частково отримано"), `status partially received (${(await bannerText(p)).slice(0, 200)})`);
    await go(p, state.index["OT-PH-BLK"].href);
    const b = await itemBalances(p);
    const a = state.phBlkAfterStart;
    ck(b.onHand === a.onHand + 8 && b.defective === a.defective + 2 && b.inProduction === a.inProduction - 10, `stock +8 good, +2 defective, in production −10 (${JSON.stringify(b)})`);
    // Більше, ніж залишилось у виробництві, без позначки «Отримано більше» — відмова.
    await go(p, state.batchUrl);
    const good2 = await lineInputName(p, "good", "OT-PH-BLK");
    await p.locator(`input[name="${good2}"]`).fill("999");
    await submitPost(p, p.locator('button[type=submit][value="receive"]'));
    ck(/залишилось|Помилка/.test(await bannerText(p)), `over-receipt rejected (${(await bannerText(p)).slice(0, 140)})`);
    await go(p, state.index["OT-PH-BLK"].href);
    ck(JSON.stringify(await itemBalances(p)) === JSON.stringify(b), "stock unchanged after rejected over-receipt");
  });

  await step("production: receive remaining → close", D, p, async (ck) => {
    await go(p, state.batchUrl);
    await submitPost(p, p.locator('button[aria-haspopup=dialog]', { hasText: /решт|залиш/i }).first(), { confirm: true });
    ck((await mainText(p)).includes("Отримано"), `status received (${(await bannerText(p)).slice(0, 200)})`);
    const close = p.getByRole("button", { name: "Закрити партію" });
    if ((await close.count()) > 0) {
      await submitPost(p, close.first(), { confirm: true });
      ck((await mainText(p)).includes("Закрито"), "status closed");
    } else ck(false, "close button available after full receipt");
    await go(p, state.index["OT-FK-X"].href);
    const fkx = await itemBalances(p);
    ck(fkx.inProduction === 0, `OT-FK-X nothing left in production (${fkx.inProduction})`);
    await go(p, "/demo/production?tab=all");
    const list = await mainText(p);
    ck(list.includes("Собівартість") && COST_RE.test(list), "owner sees cost column in batch list");
    await go(p, state.batchUrl);
    ck(COST_RE.test(await mainText(p)), "owner sees cost per good unit on closed batch");
  });

  await step("production: statistics block counts the receipts (good, defective share, on time)", D, p, async (ck) => {
    await go(p, "/demo/production");
    const stats = async () => (await p.locator("main section", { hasText: "Статистика виробництва" }).last().innerText()).replace(/\s+/g, " ");
    let t = await stats();
    // Партія E2E: 8 якісних + 2 браку, потім решта 10 + 10 — разом 28 якісних і 2 браку; отримано до планової дати.
    // Плюс вигадана історія демо (DEMO_HISTORY): 90 днів — 114 якісних і 4 браку, 2 завершені партії (1 вчасно).
    const good = num(t.match(/([\d\s]+) Отримано якісних/)?.[1]);
    const good90 = 28 + DEMO_HISTORY.good90;
    ck(good === good90, `good units received = ${good90} (E2E 28 + demo history ${DEMO_HISTORY.good90}) (${good}; ${t.slice(0, 200)})`);
    const defective90 = 2 + DEMO_HISTORY.defective90;
    const rate90 = ((defective90 * 100) / (good90 + defective90)).toFixed(1).replace(".", ",");
    ck(
      /Брак \(частка\)/.test(t) && new RegExp(`\\b${defective90} \\(${rate90}\\s?%\\)`).test(t),
      `defective ${defective90} (${rate90} %) shown (${t.match(/[^.]{0,40}Брак \(частка\)[^.]{0,40}/)?.[0]})`,
    );
    const onTime = 1 + DEMO_HISTORY.onTime90;
    const completed = 1 + DEMO_HISTORY.completed90;
    ck(new RegExp(`${onTime} з ${completed} з плановою датою`).test(t), `${onTime} of ${completed} batches with a planned date received on time (E2E + demo history)`);
    ck(/із запізненням: 1/.test(t), "the late demo history batch is counted as late");
    ck(/Брак за моделями/.test(t) && /Брак за кольорами/.test(t) && /Model X/.test(t) && /10x2\.5/.test(t) && /Чорний/.test(t) && /Сірий/.test(t), "defects by model and by colour");
    ck(/Собівартість отриманого/.test(t), "owner sees the cost of units received");
    for (const [label, period, expected] of [["30 днів", "30", 28 + DEMO_HISTORY.good30], ["Рік", "365", good90]]) {
      await p.locator("main a", { hasText: new RegExp(`^${label}$`) }).first().click();
      await p.waitForURL(new RegExp(`stats=${period}`));
      await settle(p);
      await p.waitForTimeout(250);
      t = await stats();
      const got = num(t.match(/([\d\s]+) Отримано якісних/)?.[1]);
      ck(got === expected, `period ${label}: E2E receipts (today) + demo history in the period = ${expected} (${got})`);
    }
  });

  await step("production: list filters (model, colour, product, search) + cancel a started batch", D, p, async (ck) => {
    // Перша таблиця — перелік партій (нижче — таблиці статистики браку).
    const listRows = async () => (await p.locator("main table").first().locator("tbody tr").allInnerTexts()).map((r) => r.replace(/\s+/g, " "));
    const filter = async (field, label) => {
      await go(p, "/demo/production?tab=all");
      const f = p.locator("form[role=search]");
      if (label === null) await f.locator(`input[name=${field}]`).fill("E2E batch");
      else await f.locator(`select[name=${field}]`).selectOption({ label });
      await submitGet(p, f.locator("button[type=submit]"));
      return listRows();
    };
    let rows = await filter("model", "Model S");
    ck(rows.length === 1 && rows[0].includes(SEEDED_BATCH), `model=Model S → seeded batch only (${rows.length})`);
    rows = await filter("color", "Білий");
    ck(rows.length === 1 && rows[0].includes(SEEDED_BATCH), `colour=Білий → seeded batch only (${rows.length})`);
    rows = await filter("product", "Крило заднє");
    ck(rows.length === 2 + DEMO_HISTORY.fenderBatches, `product=Крило заднє → seeded, E2E and demo history batches with fenders (${rows.length})`);
    rows = await filter("q", null);
    ck(rows.length === 1 && rows[0].includes("E2E batch"), `search «E2E batch» → the E2E batch (${rows.length})`);

    // Нова партія → запуск → скасування: «у виробництві» повертається, надходжень немає.
    const gry = state.index["OT-GR-GRY"];
    await go(p, gry.href);
    const g0 = await itemBalances(p);
    await go(p, "/demo/production/new");
    await p.getByRole("checkbox", { name: /Грипси силіконові/ }).check();
    await submitGet(p, p.getByRole("button", { name: "Показати сітку" }));
    await p.locator(`input[name="qty.${gry.variantId}"]`).waitFor();
    await p.locator("#batch-title").fill("E2E batch to cancel");
    await p.locator("#batch-ready").fill(inDays(14));
    await p.locator(`input[name="qty.${gry.variantId}"]`).fill("5");
    await submitPost(p, p.getByRole("button", { name: "Створити партію" }));
    await p.waitForURL(/\/production\/[0-9a-f-]{36}/).catch(() => {});
    const cancelUrl = new URL(p.url()).pathname;
    await submitPost(p, p.getByRole("button", { name: "Запустити у виробництво" }), { confirm: true });
    await go(p, gry.href);
    ck((await itemBalances(p)).inProduction === g0.inProduction + 5, "started: OT-GR-GRY in production +5");
    await go(p, cancelUrl);
    await submitPost(p, p.getByRole("button", { name: "Скасувати партію" }), { confirm: true });
    ck(/Партію скасовано\. Знято з «У виробництві»: 5/.test(await bannerText(p)), `cancel banner (${(await bannerText(p)).slice(0, 160)})`);
    ck((await mainText(p)).includes("Скасовано"), "batch status: cancelled");
    ck((await p.getByRole("button", { name: "Запустити у виробництво" }).count()) === 0 && (await p.locator('button[value="receive"]').count()) === 0, "no start / receipt on a cancelled batch");
    await go(p, gry.href);
    const g1 = await itemBalances(p);
    ck(g1.inProduction === g0.inProduction && g1.onHand === g0.onHand, `cancel: in production back, on hand unchanged (${JSON.stringify(g1)})`);
    await go(p, "/demo/production?tab=cancelled");
    rows = await listRows();
    ck(rows.length === 1 && rows[0].includes("E2E batch to cancel"), `«Скасовано» tab lists the batch (${rows.length})`);
  });

  // ---------------- Упаковка ----------------
  await step("packaging: materials list + bulk receive", D, p, async (ck) => {
    const before = await materialStock(p);
    ck(Object.keys(before).length >= 9, `materials listed (${JSON.stringify(before)})`);
    state.materials0 = before;
    await go(p, "/demo/warehouse/materials");
    const form = p.locator("form:has(input[name=intent][value=stock])");
    await form.locator("select[name=operation]").selectOption("receive");
    await p.getByLabel("Кількість: Коробка L").fill("10");
    await p.getByLabel("Кількість: Болти M5 (комплект)").fill("20");
    await submitPost(p, form.locator("button[aria-haspopup=dialog]").first(), { confirm: true });
    ck((await bannerText(p)).length > 0, `banner (${await bannerText(p)})`);
    let after = await materialStock(p);
    ck(after.box_l === before.box_l + 10 && after.bolts_m5 === before.bolts_m5 + 20, `box_l +10, bolts_m5 +20 (${after.box_l}, ${after.bolts_m5})`);
    // Повтор форми з тим самим operationId — без другого надходження.
    await go(p, "/demo/warehouse/materials");
    const opId = await p.locator("form:has(input[name=intent][value=stock]) input[name=operationId]").inputValue();
    const qtyName = await p.getByLabel("Кількість: Коробка M").getAttribute("name");
    await p.getByLabel("Кількість: Коробка M").fill("5");
    await submitPost(p, form.locator("button[aria-haspopup=dialog]").first(), { confirm: true });
    const replay = await p.request.post(`${BASE}/demo/warehouse/materials`, {
      form: { intent: "stock", operationId: opId, operation: "receive", note: "", unitCost: "", costCurrency: "UAH", confirm: "1", [qtyName]: "5" },
      headers: { Origin: ORIGIN },
    });
    ck(replay.status() < 500, `replayed material receipt answered (${replay.status()})`);
    const after2 = await materialStock(p);
    ck(after2.box_m === after.box_m + 5, `box_m +5 exactly once (${after.box_m} → ${after2.box_m})`);
    after = after2;
    state.materials1 = after;
  });

  await step("packaging: create kit template", D, p, async (ck) => {
    await go(p, "/demo/warehouse/kits?edit=new");
    const form = p.locator("form:has(input[name=intent][value=createKit])");
    await form.locator("input[name=name]").fill("E2E tape kit");
    await form.locator("input[name=priority]").fill("5");
    await form.locator("select[name=appliesTo]").selectOption("all");
    await form.locator("select[name=lineMaterialId]").first().selectOption({ label: "Скотч пакувальний (tape)" });
    await form.locator("input[name=lineQuantity]").first().fill("1");
    await form.locator("select[name=linePer]").first().selectOption("order");
    await submitPost(p, form.locator("button[type=submit]"));
    ck((await mainText(p)).includes("E2E tape kit"), `kit listed (${await bannerText(p)})`);
  });

  await step("packaging: kit check on order shows auto-selected box", D, p, async (ck) => {
    await go(p, "/demo/warehouse/kits?order=%231002");
    const txt = await mainText(p);
    ck(/Коробка|Пакет-конверт/.test(txt) && /Рекомендовано|коробк/i.test(txt), "preview shows suggested box");
    ck(txt.includes("Болти M5") && txt.includes("Інструкція з монтажу"), "fender kit (bolts + instruction) applies to #1002");
    ck(txt.includes("Скотч пакувальний"), "new all-orders kit applies to #1002");
  });

  await step("packaging: automatic box by dimensions (#1006) and «part without dimensions» (#1005)", D, p, async (ck) => {
    await go(p, "/demo/warehouse/kits?order=%231006");
    let t = await kitCheckText(p);
    // OT-FK-S має габарити 280×140×60 мм: найменша коробка, що вміщує й витримує, — Коробка M.
    ck(/Коробка M \(box_m\)/.test(t) && /Підібрано за габаритами й вагою/.test(t), `#1006: Коробка M chosen by dimensions and weight (${t.match(/Коробка [^.]{0,80}\./)?.[0]})`);
    ck(/Одиниць: 1, з габаритами: 1, вага: 340/.test(t), "#1006: 1 unit with dimensions, 340 g");
    ck(t.includes("Крило Model S: скотч для кронштейна"), "#1006 (Model S, collection «Крила та захист»): the seeded collection kit with a Model S filter applies");
    await go(p, "/demo/warehouse/kits?order=%231005");
    t = await kitCheckText(p);
    ck(/Неточно: частина товарів без габаритів/.test(t), "#1005: box marked as approximate (some items without dimensions)");
    ck(/Одиниць: 3, з габаритами: 2/.test(t), "#1005: 3 units, 2 with dimensions");
    await go(p, "/demo/warehouse/kits?order=%231002");
    t = await kitCheckText(p);
    ck(/Результат|#1002/.test(t) && !t.includes("Крило Model S: скотч для кронштейна"), "#1002 (Model X, same collection): the Model S kit does not apply");
  });

  // ---------------- Підготовка замовлень ----------------
  await step("orders: bulk create test waybills (sandbox carrier)", D, p, async (ck) => {
    await go(p, "/demo/orders");
    for (const n of ["#1001", "#1002", "#1007"]) await p.getByRole("checkbox", { name: `Вибрати ${n}` }).check();
    // Накладну створюють лише для перевірених замовлень («Очікує перевірки» без проблем) — спершу масова перевірка.
    await submitPost(p, p.getByRole("button", { name: /Перевірити дані вибраних/ }).first(), { confirm: true });
    ck(/Перевірено/.test(await bannerText(p)), `bulk validation (${(await bannerText(p)).slice(0, 160)})`);
    await go(p, "/demo/orders");
    for (const n of ["#1001", "#1002", "#1007"]) await p.getByRole("checkbox", { name: `Вибрати ${n}` }).check();
    await submitPost(p, p.getByRole("button", { name: /Створити тестові накладні/ }).first(), { confirm: true });
    const txt = await bannerText(p);
    ck(/накладн/i.test(txt), `bulk waybill result (${txt.slice(0, 200)})`);
    // Демо-історія продажів (#0978–#0995, доставлені) — замовлень 34, список на 2 сторінки по 25.
    await go(p, "/demo/orders");
    const ol = await mainText(p);
    ck(/Показано 1–25 з 34/.test(ol) && /Сторінка 1 з 2/.test(ol), `orders list: 34 orders on 2 pages (${ol.match(/Показано [^ ]+ з \d+/)?.[0]})`);
    await go(p, "/demo/orders?status=delivered");
    const dl = await mainText(p);
    ck(dl.includes("#0978") && dl.includes("#0995") && /з 19\b/.test(dl), "delivered: 18 demo history orders + #0997");
    await go(p, "/demo/picking");
    const q = await mainText(p);
    ck(["#0998", "#1001", "#1002", "#1007"].every((n) => q.includes(n)), "packing queue has the 4 orders with a waybill");
    state.queueRows = await p.locator("main table tbody tr").count();
  });

  await step("picking: queue filters (priority, country, model)", D, p, async (ck) => {
    await go(p, "/demo/picking?priority=1");
    let rows = await p.locator("main table tbody tr").allInnerTexts();
    ck(rows.length === 1 && rows[0].includes("#0998"), `priority=high → #0998 (${rows.length})`);
    await go(p, "/demo/picking");
    const f = p.locator("form[method=get]").first();
    await f.locator("select[name=country]").selectOption("DE");
    await submitGet(p, f.locator("button[type=submit]"));
    rows = await p.locator("main table tbody tr").allInnerTexts();
    ck(rows.length === 1 && rows[0].includes("#1001"), `country=DE → #1001 (${rows.length})`);
    await go(p, "/demo/picking");
    const models = await p.locator("select[name=model] option").allInnerTexts();
    ck(models.some((m) => m.includes("Model X")), `model filter offers Model X (${models.join(", ")})`);
    await go(p, "/demo/picking?model=Model%20X");
    rows = await p.locator("main table tbody tr").allInnerTexts();
    ck(rows.length === 1 && rows[0].includes("#1002"), `model=Model X → #1002 (${rows.length})`);
    const colors = await p.locator("select[name=color] option").allInnerTexts();
    ck(colors.some((c) => c.includes("Чорний")), `color filter offers Чорний (${colors.join(", ")})`);
  });

  await step("picking: bulk priority → urgent order first", D, p, async (ck) => {
    await go(p, "/demo/picking");
    await p.getByRole("checkbox", { name: "Вибрати #1007" }).check();
    await p.locator("form:has(button[value=bulkPriority]) select[name=priority]").selectOption("2");
    await submitPost(p, p.locator("form:has(button[value=bulkPriority]) button[aria-haspopup=dialog]").last(), { confirm: true });
    state.packing1007 = await p.getByRole("link", { name: /#1007/ }).first().getAttribute("href");
    const first = await p.locator("main table tbody tr").first().innerText();
    ck(first.includes("#1007") && first.includes("Терміновий"), `#1007 urgent and first (${first.slice(0, 80)})`);
  });

  await step("picking: pick list for selected orders (unit totals, materials)", D, p, async (ck) => {
    await go(p, "/demo/picking");
    for (const n of ["#1001", "#1002", "#1007"]) await p.getByRole("checkbox", { name: `Вибрати ${n}` }).check();
    const btn = p.getByRole("button", { name: "Лист комплектації (3)" });
    ck((await btn.count()) === 1 && (await btn.isEnabled()), "«Лист комплектації (3)» enabled for 3 orders to pick");
    await btn.click();
    await arrive(p, /\/picking\/pick-list\?/, "main .ot-pick__list");
    const u = new URL(p.url());
    state.pickListUrl = u.pathname + u.search;
    ck(u.searchParams.getAll("ids").length === 3, `URL carries the 3 selected orders (${u.search.slice(0, 80)}…)`);
    const t = await mainText(p);
    ck(/Лист комплектації: замовлень 3/.test(t) && /Усього одиниць 4/.test(t), "title: 3 orders, 4 units in total");
    const rows = await pickRows(p);
    const grips = rows.find((r) => r.text.includes("OT-GR-BLK"));
    ck(rows.length === 3 && rows.reduce((a, r) => a + r.qty, 0) === 4, `3 lines adding up to 4 units (${rows.map((r) => `${r.qty}×${r.text.slice(0, 30)}`).join(" | ")})`);
    ck(grips?.qty === 2 && /#1001 × 1/.test(grips.text) && /#1007 × 1/.test(grips.text), `grips OT-GR-BLK: 2 = #1001 × 1 + #1007 × 1 (${grips?.text.slice(0, 120)})`);
    ck(/На полиці: \d+/.test(grips?.text ?? ""), "on-shelf stock shown per line");
    const materials = (await p.locator("main .ot-invoice__declaration li").allInnerTexts()).map((x) => x.replace(/\s+/g, " ").trim());
    ck(/Пакувальні матеріали/i.test(t) && materials.some((m) => /Наклейка з логотипом × 3/.test(m)) && materials.some((m) => /Болти M5 \(комплект\) × 1/.test(m)), `packaging materials summed (${materials.join(" | ")})`);
    // Лист лише для друку — черга не змінюється.
    await go(p, "/demo/picking?tab=awaiting_picking");
    ck((await p.locator("main table tbody tr").count()) === 0, "pick list does not start packing");
  });

  await step("packing #1002: start, scan wrong/unknown/right, box, weight/dims, confirm", D, p, async (ck) => {
    await go(p, "/demo/picking");
    await p.getByRole("link", { name: /#1002/ }).first().click();
    await p.waitForURL(/\/picking\/[0-9a-f-]{36}/);
    await settle(p);
    await p.locator("form:has(input[name=intent][value=priority]), form:has(input[name=intent][value=confirm])").first().waitFor();
    state.packing1002 = new URL(p.url()).pathname;
    await submitPost(p, p.locator("form:has(input[name=intent][value=start]) button[type=submit]"));
    ck((await bannerText(p)).includes("Пакування розпочато"), "packing started");
    let fb = await scanCode(p, "OT-PH-BLK", /немає в замовленні/);
    ck(fb.includes("Цього товару немає в замовленні"), `wrong item → mismatch error (${fb})`);
    fb = await scanCode(p, "NOPE-404", /не знайдено/);
    ck(fb.includes("не знайдено"), `unknown code → error (${fb})`);
    fb = await scanCode(p, "4820000000031", /1 з 1/);
    ck(/1 з 1|Усі товари на місці/.test(fb), `right barcode → 1/1 (${fb})`);
    fb = await scanCode(p, "OT-FK-X", /уже запаковано всі/);
    ck(fb.includes("уже запаковано всі"), `extra unit → over-quantity warning (${fb})`);
    ck(/1 \/ 1/.test(await mainText(p)), "checklist still 1/1 after the extra scan");
    const box = p.locator("#packing-box");
    const opts = await box.locator("option").allInnerTexts();
    const suggested = opts.find((o) => o.includes("★"));
    ck(Boolean(suggested), `a recommended box is marked (${suggested ?? opts.join(" / ")})`);
    // OT-FK-X без габаритів (у демо габарити мають лише OT-PH-WHT, OT-FK-S, OT-GR-GRY) — підбір лише за вагою;
    // ★ лише рекомендація, коробку обирає пакувальник (packing.server.ts defaultBoxFor). Підбір за габаритами —
    // крок «automatic box by dimensions (#1006)». Обираємо рекомендовану.
    const preselected = await box.evaluate((s) => s.options[s.selectedIndex]?.text ?? "");
    ck(/Рекомендовано ★/.test(await mainText(p)), `recommendation explained in help text (preselected: ${preselected})`);
    if (suggested) await box.selectOption({ label: suggested });
    const selected = await box.evaluate((s) => s.options[s.selectedIndex]?.text ?? "");
    state.boxName = selected.match(/(Коробка [SML]|Пакет-конверт M)/)?.[1] ?? selected;
    // Лише рекомендована коробка, без ручних змін: застосунок не має одразу вимагати переоформлення накладної.
    await submitPost(p, p.getByRole("button", { name: "Зберегти посилку" }));
    const afterBox = await bannerText(p);
    ck(!/Посилка відрізняється від накладної/.test(afterBox), `recommended box alone does not conflict with the waybill (${afterBox.slice(0, 220)})`);
    await p.locator("#packing-weight").fill("620");
    await p.locator("#packing-lengthMm").fill("310");
    await p.locator("#packing-widthMm").fill("210");
    await p.locator("#packing-heightMm").fill("130");
    await submitPost(p, p.getByRole("button", { name: "Зберегти посилку" }));
    ck(/Параметри посилки збережено/.test(await bannerText(p)), `parcel saved (${await bannerText(p)})`);
    const dialogTrigger = p.locator("form:has(input[name=intent][value=confirm]):not(:has(input[name=override])) button[aria-haspopup=dialog]");
    ck((await dialogTrigger.count()) === 1, "«Запаковано» available with full kit");
    state.confirmVersion = await p.locator("form:has(input[name=intent][value=confirm]) input[name=version]").first().inputValue();
    await submitPost(p, dialogTrigger, { confirm: true });
    const txt = await bannerText(p);
    ck(txt.includes("Замовлення запаковано"), `packed (${txt.slice(0, 250)})`);
    ck(/Списано матеріалів/.test(txt), "materials consumed message");
    const page = await mainText(p);
    ck(page.includes("Запакував") && page.includes("Demo Owner"), "packed-by worker recorded");
  });

  await step("packing #1002: materials consumed once (replayed confirm)", D, p, async (ck) => {
    const replay = await p.request.post(`${BASE}${state.packing1002}`, { form: { intent: "confirm", version: state.confirmVersion }, headers: { Origin: ORIGIN } });
    ck(replay.status() < 500, `replayed confirm answered (${replay.status()})`);
    const m = await materialStock(p);
    const m1 = state.materials1;
    ck(m.bolts_m5 === m1.bolts_m5 - 1 && m.instruction_fender === m1.instruction_fender - 1, `fender kit consumed once (bolts ${m1.bolts_m5}→${m.bolts_m5})`);
    ck(m.sticker_logo === m1.sticker_logo - 1 && m.card_thanks === m1.card_thanks - 1 && m.tape === m1.tape - 1, "order kit + E2E kit consumed once");
    const boxCode = { "Коробка S": "box_s", "Коробка M": "box_m", "Коробка L": "box_l", "Пакет-конверт M": "mailer_m" }[state.boxName];
    ck(boxCode && m[boxCode] === m1[boxCode] - 1, `selected box ${state.boxName} consumed once`);
    state.materials2 = m;
  });

  await step("picking: carrier handover list after «Запаковано» #1002 (row, signatures)", D, p, async (ck) => {
    await go(p, "/demo/picking");
    const open = p.getByRole("link", { name: "Список передачі перевізнику (1)" });
    ck((await open.count()) === 1, "queue offers the handover list for 1 packed parcel");
    await open.click();
    await arrive(p, /\/picking\/handover/, "main .ot-handover__sheet");
    let t = await mainText(p);
    ck(/Список передачі перевізнику: посилок 1/.test(t), "title: 1 parcel");
    const rows = (await p.locator("main .ot-handover__sheet tbody tr").allInnerTexts()).map((r) => r.replace(/\s+/g, " "));
    ck(rows.length === 1 && rows[0].includes("#1002") && /TEST\d+/.test(rows[0]), `row: #1002 with its test waybill (${rows[0]?.slice(0, 120)})`);
    ck(rows[0]?.includes("Demo Owner") && /PL/.test(rows[0] ?? ""), "row: packed by Demo Owner, destination PL");
    // Підписи — підзаголовки .ot-invoice__label (великі літери в CSS): порівнюємо без регістру.
    ck(["Передав (склад): ПІБ, підпис", "Прийняв (перевізник): ПІБ, підпис", "Дата й час передачі"].every((x) => t.toLowerCase().includes(x.toLowerCase())), "signature lines (handed over / received / date and time)");
    ck(/Тестові накладні \(демо\)/.test(t), "demo warning: test waybills are not handed to a real carrier");
    // Лінії для підписів — на одному рівні, навіть коли довший підпис переноситься.
    const lines = await p.locator("main .ot-handover__line").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().bottom)));
    ck(lines.length === 3 && Math.max(...lines) - Math.min(...lines) <= 1, `signature lines aligned (${lines.join(", ")})`);
    // Список лише для друку: замовлення не передано.
    await go(p, `/demo/orders/${packingOrderId()}`);
    ck((await p.getByRole("button", { name: "Передано перевізнику" }).count()) > 0, "printing the list does not hand the order over");
    // З вибраних у черзі: лише запаковані.
    await go(p, "/demo/picking");
    for (const n of ["#1001", "#1002"]) await p.getByRole("checkbox", { name: `Вибрати ${n}` }).check();
    await p.getByRole("button", { name: "Список передачі (1)" }).click();
    await arrive(p, /\/picking\/handover\?ids=/, "main .ot-handover__sheet");
    t = await mainText(p);
    const sel = (await p.locator("main .ot-handover__sheet tbody tr").allInnerTexts()).map((r) => r.replace(/\s+/g, " "));
    ck(/лише вибрані запаковані посилки/.test(t) && sel.length === 1 && sel[0].includes("#1002"), `selection: only the packed #1002 is on the sheet (${sel.length})`);
    ck(/Не включено вибраних: 1/.test(t) && /#1001[^#]*ще не запаковано/.test(t), "not-packed #1001 reported as skipped with a reason");
  });

  await step("packaging: kit template on a collection with a model filter applies to matching orders only", D, p, async (ck) => {
    await go(p, "/demo/warehouse/kits?edit=new");
    const form = p.locator("form:has(input[name=intent][value=createKit])");
    await form.locator("input[name=name]").fill("E2E Model X fenders");
    await form.locator("input[name=priority]").fill("3");
    await form.locator("select[name=appliesTo]").selectOption("collections");
    await p.getByRole("checkbox", { name: /Крила та захист/ }).check();
    await form.locator("select[name=lineMaterialId]").first().selectOption({ label: "Наклейка з логотипом (sticker_logo)" });
    await form.locator("input[name=lineQuantity]").first().fill("2");
    await form.locator("select[name=linePer]").first().selectOption("order");
    await openDetails(p, "Лише для певних моделей");
    await form.getByRole("checkbox", { name: "Model X", exact: true }).check();
    await submitPost(p, form.locator("button[type=submit]"));
    const list = async () => (await p.locator("main table tbody").first().innerText()).replace(/\s+/g, " ");
    let t = await list();
    ck(t.includes("E2E Model X fenders") && /Колекцій: 1/.test(t) && /Лише: Model X/.test(t), `kit listed: 1 collection, only Model X (${await bannerText(p)})`);
    // Замовлення з Model X у колекції — так; Model S тієї ж колекції — ні.
    await go(p, "/demo/warehouse/kits?order=%231012");
    t = await kitCheckText(p);
    ck(/Наклейка з логотипом — 3 шт\./.test(t) && t.includes("E2E Model X fenders"), `#1012 (Model X): the kit adds 2 stickers to the standard 1 (${t.match(/Наклейка з логотипом — [^А-Я]*/)?.[0]})`);
    await go(p, "/demo/warehouse/kits?order=%231006");
    t = await kitCheckText(p);
    ck(!t.includes("E2E Model X fenders") && /Наклейка з логотипом — 1 шт\./.test(t), "#1006 (Model S, same collection): the kit does not apply");
    // Фільтр списку шаблонів за моделлю.
    await go(p, "/demo/warehouse/kits");
    await p.locator("form[role=search] select[name=model]").first().selectOption({ label: "Model X" });
    await submitGet(p, p.locator("form[role=search] button[type=submit]").first());
    t = await list();
    ck(t.includes("E2E Model X fenders") && !t.includes("Крило Model S: скотч для кронштейна"), "list filter model=Model X: our kit, not the Model S kit");
    await go(p, "/demo/warehouse/kits?model=Model%20S");
    t = await list();
    ck(!t.includes("E2E Model X fenders") && t.includes("Крило Model S: скотч для кронштейна"), "list filter model=Model S: the Model S kit, not ours");
  });

  await step("picking: bulk start, bulk print documents, carrier labels", D, p, async (ck) => {
    await go(p, "/demo/picking");
    await p.getByRole("checkbox", { name: "Вибрати #1001" }).check();
    await p.getByRole("checkbox", { name: "Вибрати #1007" }).check();
    await submitPost(p, p.locator("form:has(button[value=bulkStart]) button[aria-haspopup=dialog]").first(), { confirm: true });
    ck((await bannerText(p)).length > 0, `bulk start result (${(await bannerText(p)).slice(0, 200)})`);
    await go(p, "/demo/picking?tab=awaiting_picking");
    const rows = await p.locator("main table tbody tr").allInnerTexts();
    ck(rows.length === 2, `2 orders in progress (${rows.length})`);
    await go(p, "/demo/picking");
    for (const n of ["#0998", "#1001", "#1002", "#1007"]) await p.getByRole("checkbox", { name: `Вибрати ${n}` }).check();
    await p.getByRole("button", { name: /Друк: пакувальні листи/ }).click();
    await p.waitForURL(/\/picking\/print/);
    await settle(p);
    state.printUrl = new URL(p.url()).pathname + new URL(p.url()).search;
    const printText = await mainText(p).catch(async () => (await p.locator("body").innerText()).replace(/\s+/g, " "));
    ck(["#0998", "#1001", "#1002", "#1007"].every((n) => printText.includes(n)), "print page has documents for all selected orders");
    ck(/OT-FK-X|Крило/.test(printText), "packing slip lists items");
    await shot(p, "owner-print-batch");
    await go(p, "/demo/picking");
    for (const n of ["#1001", "#1002"]) await p.getByRole("checkbox", { name: `Вибрати ${n}` }).check();
    // Тестовий перевізник демо дає зразковий PDF етикетки (test-carrier.ts): об'єднаний PDF відкривається в новій вкладці.
    const labelsResp = p.waitForResponse((r) => r.url().includes("/picking/labels"), { timeout: ACTION_TIMEOUT }).catch(() => null);
    const popup = p.context().waitForEvent("page", { timeout: ACTION_TIMEOUT }).catch(() => null);
    await p.getByRole("button", { name: "Етикетки перевізника (PDF, 2)" }).click();
    const lr = await labelsResp;
    const type = lr?.headers()["content-type"] ?? "";
    const pdf = lr ? await lr.body().catch(() => Buffer.alloc(0)) : Buffer.alloc(0);
    ck(lr?.status() === 200 && type.startsWith("application/pdf") && pdf.subarray(0, 5).toString() === "%PDF-", `labels: 200 application/pdf (${lr?.status()} ${type}, ${pdf.length} bytes)`);
    ck(lr?.headers()["x-ot-labels-included"] === "2", `labels: 2 included (${lr?.headers()["x-ot-labels-included"]})`);
    await p.locator(".ot-banner", { hasText: /Відкрито PDF з етикетками/ }).first().waitFor({ timeout: ACTION_TIMEOUT }).catch(() => {});
    const lb = await bannerText(p);
    ck(/Відкрито PDF з етикетками: 2\. Пропущено: 0\./.test(lb), `labels: success banner (${lb.slice(0, 200)})`);
    const tab = await popup;
    ck(Boolean(tab), "labels PDF opened in a new tab");
    await tab?.close().catch(() => {});
  });

  await step("packing #1007: manual ±1 needs a reason (server too)", D, p, async (ck) => {
    await go(p, state.packing1007 ?? "/demo/picking");
    await p.locator("#packing-scan-code").waitFor();
    const plus = p.getByRole("button", { name: /^Додати одну одиницю: Грипси силіконові/ });
    const minus = p.getByRole("button", { name: /^Зняти одну одиницю: Грипси силіконові/ });
    const line = p.locator("main li").filter({ has: plus });
    const badge = async () => (await line.locator(".ot-badge").first().innerText()).trim();
    const waitBadge = async (want) => {
      for (let i = 0; i < 25 && (await badge()) !== want; i++) await p.waitForTimeout(200);
      return badge();
    };
    ck((await badge()) === "0 / 1", `grips line starts at 0 / 1 (${await badge()})`);
    ck((await plus.isDisabled()) && (await minus.isDisabled()), "+1 / −1 disabled until a reason is chosen");
    // Обхід інтерфейсу без причини — відмова сервера, чекліст не змінюється.
    const lineId = await line.locator("input[name=lineId]").first().inputValue();
    const raw = await p.request.post(`${BASE}${state.packing1007}`, { form: { intent: "adjust", lineId, delta: "1", reason: "" }, headers: { Origin: ORIGIN } });
    ck(raw.status() < 500, `adjust without a reason answered (${raw.status()})`);
    await go(p, state.packing1007);
    ck((await badge()) === "0 / 1", "server rejected ±1 without a reason (still 0 / 1)");
    await p.locator("#packing-adjust-reason").selectOption("barcode_unreadable");
    const post = () => p.waitForResponse((r) => r.request().method() === "POST", { timeout: ACTION_TIMEOUT }).catch(() => null);
    let resp = post();
    await plus.click();
    await resp;
    ck((await waitBadge("1 / 1")) === "1 / 1" && (await plus.isDisabled()), "+1 with a reason → 1 / 1 (+1 then disabled)");
    resp = post();
    await minus.click();
    await resp;
    ck((await waitBadge("0 / 1")) === "0 / 1", "−1 with a reason → 0 / 1");
  });

  await step("packing #1007: weight < 90 % of goods — warning; staff cannot confirm, owner confirms", D, p, async (ck) => {
    await go(p, state.packing1007 ?? "/demo/picking");
    await p.locator("#packing-weight").fill("50");
    await submitPost(p, p.getByRole("button", { name: "Зберегти посилку" }));
    const b = await bannerText(p);
    ck(/Параметри посилки збережено|Зважена вага менша за 90 %/.test(b), `parcel saved with a low weight (${b.slice(0, 200)})`);
    let t = await mainText(p);
    ck(/Зважену вагу не буде використано для накладної/.test(t) && /менша за 90 % ваги товарів/.test(t), "warning: 50 g is below 90 % of the goods weight (90 g)");
    const confirmForm = (pg) => pg.locator("form:has(input[name=intent][value=confirmWeight])");
    ck((await confirmForm(p).count()) === 1 && /Вагу .*50.* перевірено/.test(await confirmForm(p).innerText()), "owner sees «Вагу 50 г перевірено»");
    // Працівник (окрема сесія): бачить попередження без кнопки; сервер відхиляє підтвердження.
    const { ctx: sctx, page: sp } = await rolePage("staff");
    await go(sp, state.packing1007);
    const st = await mainText(sp);
    ck(/Зважену вагу не буде використано/.test(st) && /попросіть власника підтвердити/.test(st), "staff: warning + «ask the owner»");
    ck((await confirmForm(sp).count()) === 0, "staff: no confirm button");
    const r = await expecting(sp, [403], () => sp.request.post(`${BASE}${state.packing1007}`, { form: { intent: "confirmWeight", weightGrams: "50" }, headers: { Origin: ORIGIN } }));
    const rt = await r.text();
    ck(r.status() === 403 || rt.includes("може лише власник") || rt.includes("Недостатньо прав"), `staff confirmation rejected on the server (${r.status()})`);
    await go(sp, state.packing1007);
    ck(!/Власник підтвердив зважену вагу/.test(await mainText(sp)), "still not confirmed after the staff attempt");
    await sctx.close();
    await go(p, state.packing1007);
    await submitPost(p, confirmForm(p).locator("button[aria-haspopup=dialog]"), { confirm: true });
    ck(/Вагу підтверджено/.test(await bannerText(p)), `owner confirmed (${(await bannerText(p)).slice(0, 160)})`);
    t = await mainText(p);
    ck(/Власник підтвердив зважену вагу/.test(t) && (await confirmForm(p).count()) === 0, "verified note shown, no confirm button any more");
  });

  await step("handover #1002 → sale consumption in movements history", D, p, async (ck) => {
    const orderId = packingOrderId();
    await go(p, state.index["OT-FK-X"].href);
    const before = await itemBalances(p);
    await go(p, `/demo/orders/${orderId}`);
    const handover = p.getByRole("button", { name: "Передано перевізнику" });
    ck((await handover.count()) > 0, "handover button offered (demo test carrier)");
    if ((await handover.count()) === 0) return;
    await submitPost(p, handover.first(), { confirm: true });
    ck(/Передано перевізнику/.test(await mainText(p)), `order handed over (${(await bannerText(p)).slice(0, 160)})`);
    await go(p, state.index["OT-FK-X"].href);
    const after = await itemBalances(p);
    ck(after.onHand === before.onHand - 1 && after.reserved === before.reserved - 1, `FK-X onHand −1, reserved −1 (${JSON.stringify(before)} → ${JSON.stringify(after)})`);
    await go(p, `/demo/warehouse/movements?order=${encodeURIComponent("#1002")}`);
    const mv = await mainText(p);
    ck(mv.includes("Списання (передано перевізнику)"), "consume_sale movement in history");
    ck(mv.includes("Витрата пакувальних матеріалів"), "packaging consumption movement linked to the order");
    // Після передачі переоформити накладну вже не можна — підказка «переоформіть до передачі» не має показуватися.
    await go(p, `/demo/orders/${orderId}`);
    ck(!/Переоформіть накладну до передачі/.test(await mainText(p)), "order page: no «re-issue before handover» advice after handover");
    await go(p, state.packing1002);
    ck(!/Переоформіть накладну до передачі/.test(await mainText(p)) && (await p.getByRole("link", { name: "До «Переоформити»" }).count()) === 0, "packing page: no «re-issue» advice/button after handover");
    // Повторна передача (подвійне натискання) не списує вдруге.
    const replay = await p.request.post(`${BASE}/demo/orders/${orderId}`, { form: { intent: "markHandedOver" }, headers: { Origin: ORIGIN } });
    ck(replay.status() < 500, `replayed handover answered (${replay.status()})`);
    await go(p, state.index["OT-FK-X"].href);
    const again = await itemBalances(p);
    ck(JSON.stringify(again) === JSON.stringify(after), "replayed handover did not write off twice");
  });

  await step("movements: filter by model / colour", D, p, async (ck) => {
    const rows = async () => (await p.locator("main table tbody tr").allInnerTexts()).map((r) => r.replace(/\s+/g, " "));
    await go(p, "/demo/warehouse/movements");
    const f = p.locator("form[role=search]").first();
    await f.locator("select[name=model]").selectOption({ label: "Model X" });
    await submitGet(p, f.locator("button[type=submit]"));
    ck(/[?&]model=Model(\+|%20)X/.test(p.url()), `URL keeps model=Model X (${p.url().replace(BASE, "")})`);
    let r = await rows();
    ck(r.length > 0 && r.every((x) => x.includes("Model X")) && r.some((x) => x.includes("Списання (передано перевізнику)")), `model=Model X → only OT-FK-X movements, incl. the #1002 sale (${r.length})`);
    ck(r.every((x) => !/Тримач|Грипси|Наклейка|Коробка/.test(x)), "no other products or materials");
    await go(p, "/demo/warehouse/movements");
    await f.locator("select[name=color]").selectOption({ label: "Білий" });
    await submitGet(p, f.locator("button[type=submit]"));
    r = await rows();
    ck(r.length > 0 && r.every((x) => x.includes("Тримач телефону Pro") && x.includes("Білий")), `colour=Білий → only OT-PH-WHT movements (${r.length})`);
    await go(p, "/demo/warehouse/movements?model=Model%20X&color=%D0%91%D1%96%D0%BB%D0%B8%D0%B9");
    ck((await p.locator("main table tbody tr").count()) === 0, "model AND colour of one variant: Model X + Білий → nothing");
  });

  await step("material card: «Витрачено за 30 днів» and days of stock", D, p, async (ck) => {
    await go(p, "/demo/warehouse/movements?kind=material&type=material_consume");
    const link = p.locator('main a[href*="/warehouse/items/"]', { hasText: "Болти M5" }).first();
    ck((await link.count()) === 1, "packaging consumption of bolts M5 is in the movement history");
    state.materialHref = await link.getAttribute("href");
    await go(p, state.materialHref);
    const t = await mainText(p);
    const used = num(t.match(/([\d\s]+) Витрачено за 30 днів/)?.[1] ?? t.match(/Витрачено за 30 днів ([\d\s]+)/)?.[1]);
    const boltsUsed = DEMO_HISTORY.boltsUsed30 + 1;
    ck(used === boltsUsed, `bolts used in the last 30 days = ${boltsUsed} (demo history ${DEMO_HISTORY.boltsUsed30} + #1002) (${used}; ${t.match(/.{0,30}Витрачено за 30 днів.{0,30}/)?.[0]})`);
    ck(/Вистачить на, днів/.test(t) && !/Витрат не було — прогнозу немає/.test(t), "days-of-stock forecast shown (usage exists)");
    ck(!/Доступно для продажу/.test(t) && !/Зарезервовано/.test(t), "material card without product-only figures (available / reserved)");
    await go(p, "/demo/warehouse/materials");
    const mt = (await p.locator("main table tbody tr", { hasText: "Болти M5" }).first().innerText()).replace(/\s+/g, " ");
    ck(/Вистачить на \d+/.test(mt) || /\b1 шт\./.test(mt), `materials list: usage / forecast column for bolts (${mt.slice(0, 160)})`);
  });

  await step("packing #1001: unpack and re-pack does not consume materials twice", D, p, async (ck) => {
    // #1001 ще не запаковано (почато масово) — пакуємо, розпаковуємо, пакуємо знову.
    await go(p, "/demo/picking?q=1001");
    await p.getByRole("link", { name: /#1001/ }).first().click();
    await p.waitForURL(/\/picking\/[0-9a-f-]{36}/);
    await settle(p);
    await p.locator("form:has(input[name=intent][value=priority]), form:has(input[name=intent][value=confirm])").first().waitFor();
    state.packing1001 = new URL(p.url()).pathname;
    const start = p.locator("form:has(input[name=intent][value=start]) button[type=submit]");
    if ((await start.count()) > 0) await submitPost(p, start);
    await p.locator("#packing-scan-code").waitFor();
    for (const code of ["4820000000017", "4820000000055"]) await scanCode(p, code, /1 з 1/);
    const confirm = () => p.locator("form:has(input[name=intent][value=confirm]):not(:has(input[name=override])) button[aria-haspopup=dialog]");
    await submitPost(p, confirm(), { confirm: true });
    ck((await bannerText(p)).includes("Замовлення запаковано"), "packed");
    const m1 = await materialStock(p);
    await go(p, state.packing1001);
    await submitPost(p, p.locator("form:has(input[name=intent][value=unpack]) button[aria-haspopup=dialog]"), { confirm: true });
    ck(/повернуто в комплектацію/.test(await bannerText(p)), `unpacked (${(await bannerText(p)).slice(0, 140)})`);
    if ((await confirm().count()) > 0) await submitPost(p, confirm(), { confirm: true });
    ck(/запаковано/i.test(await bannerText(p)), `re-packed (${(await bannerText(p)).slice(0, 160)})`);
    const m2 = await materialStock(p);
    ck(JSON.stringify(m1) === JSON.stringify(m2), `materials not consumed twice (${JSON.stringify(m1)} vs ${JSON.stringify(m2)})`);
  });

  await step("analytics: invalid custom period explained", D, p, async (ck) => {
    const res = await go(p, `/demo/warehouse/analytics?period=custom&from=${today()}&to=2020-01-01`);
    ck(res?.status() === 200, `page still opens (${res?.status()})`);
    ck(/Період|період/.test(await bannerText(p)) || /некорект|неправильн|раніше/i.test(await mainText(p)), `invalid period message (${(await bannerText(p)).slice(0, 140)})`);
  });

  // ---------------- Аналітика, експорт, Shopify ----------------
  await step("analytics page + filters", D, p, async (ck) => {
    const res = await go(p, "/demo/warehouse/analytics");
    ck(res?.status() === 200, "analytics 200");
    const txt = await mainText(p);
    ck(/Продано, шт\./.test(txt) && /Рекомендації виробництва/.test(txt), "KPIs and recommendations shown");
    await go(p, "/demo/warehouse/analytics?model=Model%20X");
    const rows = await p.locator("main table").last().locator("tbody tr").allInnerTexts();
    ck(rows.length > 0 && rows.every((r) => !/OT-PH-|OT-GR-/.test(r)), `model filter narrows variants (${rows.length})`);
  });

  const csvDownload = async (page, label) => {
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: ACTION_TIMEOUT }), page.getByRole("button", { name: label, exact: true }).click()]);
    const file = path.join(OUT, `${page.__role}-${dl.suggestedFilename()}`);
    await dl.saveAs(file);
    return { file, head: fs.readFileSync(file, "utf8").split(/\r?\n/)[0] ?? "" };
  };

  await step("CSV export (owner: with cost columns)", D, p, async (ck) => {
    p.__role = "owner";
    await go(p, "/demo/warehouse/analytics");
    for (const label of ["Залишки", "Рух за період", "Продажі за варіантами", "Партії виробництва"]) {
      const { file, head } = await csvDownload(p, label);
      ck(head.length > 0, `${label}: file ${path.basename(file)} header: ${head.slice(0, 120)}`);
      if (label === "Залишки") ck(head.includes("unit_cost"), "owner stock CSV has unit_cost");
      if (label === "Рух за період") ck(/unit_cost/.test(head), "owner movements CSV has unit_cost");
      if (label === "Партії виробництва") {
        ck(head.includes("batch_number") && head.includes("batch_cost_per_good_unit"), "production CSV: batch_number, batch_cost_per_good_unit");
        const body = fs.readFileSync(file, "utf8");
        ck(/PB-\d{4}-\d{4}/.test(body) && body.includes("OT-FK-X"), "production CSV has batch lines (E2E batch with OT-FK-X)");
      }
    }
    const raw = await expecting(p, [400], () => p.request.get(`${BASE}/demo/warehouse/export`));
    const body = await raw.text();
    ck(!/^[a-zA-Z]+(\.[a-zA-Z]+){2,}$/.test(body.trim()), `export without dataset gives a human message, not an i18n key (${raw.status()} «${body.slice(0, 60)}»)`);
  });

  await step("Shopify sync pages (demo: not configured, nothing sent)", D, p, async (ck) => {
    let res = await go(p, "/demo/warehouse/shopify");
    let txt = await mainText(p);
    ck(res?.status() === 200 && /Демо працює без Shopify/.test(txt), "inventory sync page explains demo has no Shopify");
    res = await go(p, "/demo/shopify");
    txt = await mainText(p);
    ck(res?.status() === 200 && /не налаштовано|Демо|demo/i.test(txt), "Shopify sync page opens in demo");
    const posts = await p.locator("main form[method=post] button[type=submit]").count();
    ck(true, `Shopify page post buttons: ${posts}`);
  });

  await ownerCtx.close();

  // ======================= ПРАЦІВНИК, ПК 1280 =======================
  const S = { role: "staff", viewport: "1280x900" };
  const staffCtx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "uk-UA", acceptDownloads: true });
  await setPref(staffCtx, "locale", "uk");
  const s = await staffCtx.newPage();
  monitor(s, S);
  s.setDefaultTimeout(ACTION_TIMEOUT);
  s.__role = "staff";

  await step("switch role to staff via shell control", S, s, async (ck) => {
    await setPref(staffCtx, "demoRole", "owner");
    await go(s, "/demo/warehouse");
    await submitPost(s, s.getByRole("button", { name: /^Працівник$/ }).first());
    await go(s, "/demo/warehouse");
    const pressed = await s.locator('button[value=staff][aria-pressed=true]').count();
    ck(pressed > 0, "staff role active");
  });

  await step("staff: main menu «Аналітика» leads to warehouse analytics (stage 6: business analytics is owner-only)", S, s, async (ck) => {
    await go(s, "/demo");
    const menu = s.locator('nav.ot-nav > ul.ot-nav__list a[href="/demo/warehouse/analytics"]');
    ck((await menu.count()) === 1 && (await menu.innerText()).includes("Аналітика"), "staff menu «Аналітика» → /demo/warehouse/analytics");
    ck((await s.locator('nav.ot-nav a[href="/demo/analytics"]').count()) === 0, "no link to business analytics for staff");
    ck((await s.locator('nav.ot-nav a[href="/demo/finance"]').count()) === 0, "no «Фінанси» for staff");
  });

  await step("staff: no costs on production list/batch, movements, item, materials", S, s, async (ck) => {
    await go(s, "/demo/production?tab=all");
    let t = await mainText(s);
    ck(!COST_RE.test(t), "production list without costs");
    ck((await s.getByRole("link", { name: "Нова партія" }).count()) === 0, "no «Нова партія» for staff");
    await go(s, state.batchUrl);
    t = await mainText(s);
    ck(!COST_RE.test(t), "batch page without costs");
    await go(s, "/demo/warehouse/movements");
    t = await mainText(s);
    ck(!COST_RE.test(t), "movements without costs");
    await go(s, state.index["OT-PH-BLK"].href);
    t = await mainText(s);
    ck(!COST_RE.test(t), "item card without costs");
    ck((await s.locator("#wh-receive-cost").count()) === 0, "no unit cost field in receipt form");
    await go(s, "/demo/warehouse/materials");
    t = await mainText(s);
    ck(!COST_RE.test(t), "materials without costs");
    await go(s, "/demo/warehouse/analytics");
    t = await mainText(s);
    ck(!/собіварт(?!ості доступні лише власнику)/i.test(t.replace("Колонки собівартості доступні лише власнику.", "")), "analytics without cost values");
    ck(!/Вартість запасу/.test(t), "analytics: no inventory value KPI for staff");
    await go(s, "/demo/production");
    t = await mainText(s);
    ck(/Статистика виробництва/.test(t) && !/Собівартість отриманого/.test(t), "production statistics without the cost of units received");
    // Головна: блок «Нові партії» (рекомендації) — для тих, хто керує виробництвом.
    await go(s, "/demo");
    t = await mainText(s);
    ck(!/Потребують нової партії|Рекомендовано виготовити/.test(t) && !COST_RE.test(t), "dashboard: no production recommendations block and no costs for staff");
  });

  await step("staff: CSV export without cost columns", S, s, async (ck) => {
    await go(s, "/demo/warehouse/analytics");
    for (const label of ["Залишки", "Рух за період"]) {
      const { head } = await csvDownload(s, label);
      ck(!/unit_cost|stock_value|cost_/.test(head), `${label}: no cost columns (${head.slice(0, 100)})`);
    }
    const r = await s.request.get(`${BASE}/demo/warehouse/export?dataset=movements`);
    const head = (await r.text()).split(/\r?\n/)[0];
    ck(!/unit_cost/.test(head), "direct export URL also hides costs");
    ck((await s.getByRole("button", { name: "Партії виробництва", exact: true }).count()) === 0, "no «Партії виробництва» (owner-only dataset) for staff");
    const prod = await expecting(s, [403], () => s.request.get(`${BASE}/demo/warehouse/export?dataset=production`));
    const prodBody = await prod.text();
    ck(prod.status() === 403 && !prodBody.includes("batch_cost_per_good_unit"), `production dataset → 403 for staff (${prod.status()})`);
  });

  await step("staff: owner-only pages are 403 or hidden", S, s, async (ck) => {
    const forbidden = async (url) => expecting(s, [403], async () => (await go(s, url))?.status());
    const prodNew = await forbidden("/demo/production/new");
    ck(prodNew === 403, `production/new → 403 (${prodNew})`);
    const editBatch = await forbidden(`${state.batchUrl}?edit=1`);
    ck(editBatch === 403 || !(await mainText(s)).includes("Зберегти"), `batch edit not available (${editBatch})`);
    const kitNew = await forbidden("/demo/warehouse/kits?edit=new");
    ck(kitNew === 403 || (await s.locator("input[name=intent][value=createKit]").count()) === 0, `kit editor not available (${kitNew})`);
    const matNew = await forbidden("/demo/warehouse/materials?edit=new");
    ck(matNew === 403 || (await s.locator("form input[name=intent][value^=create]").count()) === 0, `material editor not available (${matNew})`);
    const settings = await forbidden("/demo/settings");
    ck(settings === 403, `settings → 403 (${settings})`);
    await go(s, "/demo/warehouse?view=stocktake");
    ck((await mainText(s)).includes("Немає дозволу") || (await s.locator("form#warehouse-stocktake-form button").count()) === 0 || /дозвол|власник/i.test(await bannerText(s)), "stocktake sheet read-only for staff");
    await go(s, "/demo/orders/" + packingOrderId());
    ck((await s.getByRole("button", { name: "Передано перевізнику" }).count()) === 0, "no handover button for staff");
  });

  await step("staff: owner-only actions rejected on the server", S, s, async (ck) => {
    const post = (url, form) => s.request.post(`${BASE}${url}`, { form, headers: { Origin: ORIGIN } });
    const item = state.index["OT-PH-BLK"];
    let r = await post(item.href, { intent: "count", operationId: crypto.randomUUID(), counted: "999", expected: "" });
    ck((await r.text()).includes("Недостатньо прав"), "count (stocktake) on item → forbidden");
    r = await post("/demo/warehouse", { intent: "stocktake", operationId: crypto.randomUUID(), item: item.variantId, [`counted.${item.variantId}`]: "999" });
    ck((await r.text()).includes("Недостатньо прав"), "stocktake sheet → forbidden");
    r = await post("/demo/warehouse", { intent: "initialize" });
    ck((await r.text()).includes("Недостатньо прав"), "initialize inventory → forbidden");
    r = await expecting(s, [403], () => post("/demo/production/new", { intent: "create", title: "x" }));
    ck(r.status() === 403 || (await r.text()).includes("Недостатньо прав"), `create batch → forbidden (${r.status()})`);
    r = await post(item.href, { intent: "writeOff", operationId: crypto.randomUUID(), quantity: "1", reason: "disposed" });
    ck((await r.text()).includes("Недостатньо прав"), "write off defects → forbidden");
    r = await post(state.batchUrl, { intent: "cancel", version: "1" });
    ck((await r.text()).includes("Недостатньо прав"), "cancel batch → forbidden");
    r = await post("/demo/warehouse/kits", { intent: "createKit", name: "staff kit", appliesTo: "all", priority: "0", active: "on" });
    const kitHtml = await r.text();
    ck(!kitHtml.includes("Шаблон створено"), "create kit by staff not accepted");
    await go(s, "/demo/warehouse/kits");
    ck(!(await mainText(s)).includes("staff kit"), "no kit created by staff");
    await go(s, item.href);
    const b = await itemBalances(s);
    ck(b && b.onHand !== 999, "stock unchanged by rejected staff actions");
  });

  await step("staff: can receive stock", S, s, async (ck) => {
    const item = state.index["OT-GR-BLK"];
    await go(s, item.href);
    const b0 = await itemBalances(s);
    await openDetails(s, "Надходження");
    const form = s.locator("form:has(input[name=intent][value=receive])");
    await form.locator("#wh-receive-qty").fill("3");
    await form.locator("#wh-receive-reason").selectOption("found");
    await submitPost(s, form.locator("button[type=submit]"));
    const b1 = await itemBalances(s);
    ck(b1.onHand === b0.onHand + 3, `staff receipt +3 (${b0.onHand} → ${b1.onHand})`);
    await go(s, "/demo/warehouse/movements?type=receipt_manual");
    ck((await mainText(s)).includes("Demo Staff"), "movement recorded with staff name");
  });

  await step("staff: production receipt on seeded batch", S, s, async (ck) => {
    await go(s, "/demo/production?tab=all");
    await s.getByRole("link", { name: /PB-\d{4}-0001/ }).first().click();
    await s.waitForURL(/\/production\/[0-9a-f-]{36}/);
    await settle(s);
    await s.locator('input[name^="good."]').first().waitFor().catch(() => {});
    const good = await lineInputName(s, "good", "OT-PH-WHT");
    ck(Boolean(good), "staff sees the receipt form");
    if (!good) return;
    await s.locator(`input[name="${good}"]`).fill("1");
    await submitPost(s, s.locator('button[type=submit][value="receive"]'));
    ck((await mainText(s)).includes("Частково отримано"), `staff receipt recorded (${(await bannerText(s)).slice(0, 120)})`);
    ck(!COST_RE.test(await mainText(s)), "still no costs after receipt");
  });

  await step("staff: pack #0998 by scanning", S, s, async (ck) => {
    await go(s, "/demo/picking?q=0998");
    await s.getByRole("link", { name: /#0998/ }).first().click();
    await s.waitForURL(/\/picking\/[0-9a-f-]{36}/);
    await settle(s);
    await s.locator("form:has(input[name=intent][value=priority]), form:has(input[name=intent][value=confirm])").first().waitFor();
    const start = s.locator("form:has(input[name=intent][value=start]) button[type=submit]");
    if ((await start.count()) > 0) await submitPost(s, start);
    await s.locator("#packing-scan-code").waitFor();
    const fb = await scanCode(s, "OT-LT-STD", /1 з 1/);
    ck(/Усі товари на місці|1 з 1/.test(fb), `all items scanned (${fb})`);
    const trigger = s.locator("form:has(input[name=intent][value=confirm]):not(:has(input[name=override])) button[aria-haspopup=dialog]");
    await submitPost(s, trigger, { confirm: true });
    const t = await mainText(s);
    ck((await bannerText(s)).includes("Замовлення запаковано") && t.includes("Demo Staff"), "packed by Demo Staff");
    ck(!COST_RE.test(t), "packing page without costs");
  });

  await step("staff: pick list and carrier handover list", S, s, async (ck) => {
    await go(s, "/demo/picking");
    for (const n of ["#0998", "#1007"]) await s.getByRole("checkbox", { name: `Вибрати ${n}` }).check();
    await s.getByRole("button", { name: "Список передачі (1)" }).click();
    await arrive(s, /\/picking\/handover\?ids=/, "main .ot-handover__sheet");
    let t = await mainText(s);
    const rows = (await s.locator("main .ot-handover__sheet tbody tr").allInnerTexts()).map((r) => r.replace(/\s+/g, " "));
    ck(rows.length === 1 && rows[0].includes("#0998") && rows[0].includes("Demo Staff"), `handover: #0998 packed by Demo Staff (${rows[0]?.slice(0, 120)})`);
    ck(t.toLowerCase().includes("прийняв (перевізник): піб, підпис") && !COST_RE.test(t), "signature lines, no costs");
    await go(s, "/demo/picking");
    await s.getByRole("checkbox", { name: "Вибрати #1007" }).check();
    await s.getByRole("button", { name: "Лист комплектації (1)" }).click();
    await arrive(s, /\/picking\/pick-list\?ids=/, "main .ot-pick__list");
    t = await mainText(s);
    const picks = await pickRows(s);
    ck(/Лист комплектації: замовлень 1/.test(t) && picks.length === 1 && picks[0].qty === 1 && picks[0].text.includes("OT-GR-BLK"), `pick list: #1007 → 1 × OT-GR-BLK (${picks.map((x) => x.text.slice(0, 60)).join(" | ")})`);
    ck(/Пакувальні матеріали/i.test(t) && !COST_RE.test(t), "materials section, no costs");
  });

  await staffCtx.close();

  // ======================= ТЕЛЕФОНИ =======================
  const phones = [
    { w: 320, h: 568 },
    { w: 375, h: 667 },
    { w: 390, h: 844 },
  ];
  const mobileScreens = (role) => [
    ["dashboard", "/demo"],
    ["warehouse", "/demo/warehouse"],
    ["warehouse-item", itemHref("OT-PH-BLK")],
    ["movements", "/demo/warehouse/movements"],
    ["stocktake-sheet", "/demo/warehouse?view=stocktake"],
    ["production", "/demo/production?tab=all"],
    ["production-batch", batchUrl()],
    ...(role === "owner" ? [["production-grid", state.gridUrl ?? "/demo/production/new"]] : []),
    ["picking", "/demo/picking"],
    ["packing-order", packingUrl()],
    ["packing-in-progress", state.packing1007 ?? "/demo/picking"],
    ["print", state.printUrl ?? "/demo/picking"],
    ["pick-list", state.pickListUrl ?? "/demo/picking/pick-list"],
    ["handover", "/demo/picking/handover"],
    ["materials", "/demo/warehouse/materials"],
    ["material-item", state.materialHref ?? "/demo/warehouse/materials"],
    ["kits", "/demo/warehouse/kits?order=%231002"],
    ["analytics", "/demo/warehouse/analytics"],
    ["inventory-sync", "/demo/warehouse/shopify"],
    ["problems", "/demo/problems"],
  ];
  for (const role of process.env.E2E_SKIP_PHONES ? [] : ["owner", "staff"]) {
    for (const ph of phones) {
      const M = { role, viewport: `${ph.w}x${ph.h}` };
      const ctx = await browser.newContext({ viewport: { width: ph.w, height: ph.h }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: "uk-UA" });
      await setPref(ctx, "demoRole", role);
      await setPref(ctx, "locale", "uk");
      const m = await ctx.newPage();
      monitor(m, M);
      m.setDefaultTimeout(ACTION_TIMEOUT);
      await step("mobile: key stage-5 screens fit the viewport", M, null, async (ck) => {
        for (const [name, url] of mobileScreens(role)) {
          const res = await go(m, url);
          ck(res?.status() === 200, `${name}: 200 (${res?.status()})`);
          const h = await noHScroll(m);
          ck(h.ok, `${name}: no horizontal scroll (${h.scrollWidth}/${h.innerWidth}${h.widest ? ` widest: ${JSON.stringify(h.widest)}` : ""})`);
          const small = await smallTapTargets(m);
          if (small.length) tapFindings.push({ role, viewport: M.viewport, screen: name, count: small.length, sample: small.slice(0, 6) });
          await m.screenshot({ path: path.join(OUT, `m-${role}-${ph.w}-${name}.png`), fullPage: true }).catch(() => {});
        }
      });
      if (ph.w === 320 && role === "owner") {
        await step("mobile: filter form (collapsed on phone) submits", M, m, async (ck) => {
          await go(m, "/demo/warehouse");
          const summary = m.locator("main details.ot-disclosure--collapse-mobile > summary").first();
          ck(!(await m.locator("form[role=search] select[name=model]").isVisible()), "filters collapsed on phone");
          await summary.click();
          await m.locator("form[role=search] select[name=model]").selectOption({ label: "Model X" });
          await submitGet(m, m.locator("form[role=search] button[type=submit]"));
          const rows = await m.locator("main table tbody tr").allInnerTexts();
          ck(rows.length === 1 && rows[0].includes("OT-FK-X"), `filter applied on phone (${rows.length})`);
        });
      }
      if ((ph.w === 390 && role === "owner") || (ph.w === 320 && role === "staff")) {
        await step("mobile: picking bulk actions collapsed; open «Масові дії» → pick list", M, m, async (ck) => {
          await go(m, "/demo/picking");
          const details = m.locator("#packing-bulk-form details").first();
          const summary = details.locator("summary").first();
          ck((await details.count()) === 1 && !(await details.evaluate((d) => d.open)), "bulk actions collapsed on phone");
          ck(!(await m.getByRole("button", { name: /^Лист комплектації/ }).isVisible()), "bulk buttons hidden until opened");
          await m.getByRole("checkbox", { name: "Вибрати #1007" }).check();
          ck(/Масові дії · вибрано: 1/.test(await summary.innerText()), `summary shows the selection (${(await summary.innerText()).trim()})`);
          ck((await m.locator("#packing-bulk-form [aria-live=polite]").innerText()).includes("Вибрано: 1"), "selection announced in the live region");
          await summary.click();
          const pick = m.getByRole("button", { name: "Лист комплектації (1)" });
          ck(await pick.isVisible(), "bulk buttons visible after opening «Масові дії»");
          const h = await noHScroll(m);
          ck(h.ok, `opened bulk actions fit (${h.scrollWidth}/${h.innerWidth}${h.widest ? ` widest: ${JSON.stringify(h.widest)}` : ""})`);
          const small = await smallTapTargets(m);
          if (small.length) tapFindings.push({ role, viewport: M.viewport, screen: "picking-bulk-open", count: small.length, sample: small.slice(0, 6) });
          await m.screenshot({ path: path.join(OUT, `m-${role}-${ph.w}-picking-bulk-open.png`), fullPage: true }).catch(() => {});
          await pick.click();
          await arrive(m, /\/picking\/pick-list\?ids=/, "main .ot-pick__list");
          ck(/Лист комплектації: замовлень 1/.test(await mainText(m)), "pick list opened from the phone");
          const h2 = await noHScroll(m);
          ck(h2.ok, `pick list fits the phone (${h2.scrollWidth}/${h2.innerWidth})`);
          // Деталі позиції (SKU, штрихкод, розклад) — на всю ширину рядка, а не у вузькій колонці між фото й кількістю.
          const geo = await m.evaluate(() => {
            const row = document.querySelector("main .ot-pick__row")?.getBoundingClientRect();
            const meta = document.querySelector("main .ot-pick__meta")?.getBoundingClientRect();
            const ul = document.querySelector("main .ot-pick__materials");
            return { row: row?.width ?? 0, meta: meta?.width ?? 0, bullets: ul ? getComputedStyle(ul).listStyleType : "missing" };
          });
          ck(geo.meta >= geo.row * 0.8, `pick row details use the row width (${Math.round(geo.meta)}/${Math.round(geo.row)} px)`);
          ck(geo.bullets === "none", `materials: checkboxes without list bullets (${geo.bullets})`);
        });
      }
      if (ph.w === 375 && role === "staff") {
        await step("mobile: staff receipt + packing scan on iPhone SE", M, m, async (ck) => {
          const item = state.index["OT-LT-STD"];
          await go(m, item.href);
          const b0 = await itemBalances(m);
          await openDetails(m, "Надходження");
          const form = m.locator("form:has(input[name=intent][value=receive])");
          await form.locator("#wh-receive-qty").fill("1");
          await form.locator("#wh-receive-reason").selectOption("found");
          await form.locator("button[type=submit]").scrollIntoViewIfNeeded();
          await submitPost(m, form.locator("button[type=submit]"));
          const b1 = await itemBalances(m);
          ck(b1.onHand === b0.onHand + 1, `receipt submitted on phone (${b0.onHand} → ${b1.onHand})`);
          await go(m, "/demo/picking?q=1007");
          await m.getByRole("link", { name: /#1007/ }).first().click();
          await m.waitForURL(/\/picking\/[0-9a-f-]{36}/);
          await settle(m);
          await m.locator("form:has(input[name=intent][value=priority]), form:has(input[name=intent][value=confirm])").first().waitFor();
          const start = m.locator("form:has(input[name=intent][value=start]) button[type=submit]");
          if ((await start.count()) > 0) await submitPost(m, start);
          await m.locator("#packing-scan-code").waitFor();
          await m.locator("#packing-scan-code").tap();
          const fb = await scanCode(m, "OT-GR-BLK", /1 з 1/);
          ck(/1 з 1|Усі товари/.test(fb), `scan from phone (${fb})`);
          const h = await noHScroll(m);
          ck(h.ok, `packing page no horizontal scroll after scan (${h.scrollWidth}/${h.innerWidth})`);
        });
      }
      await ctx.close();
    }
  }

  // ======================= АНГЛІЙСЬКА =======================
  const E = { role: "owner", viewport: "1280x900" };
  const enCtx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  await setPref(enCtx, "demoRole", "owner");
  await setPref(enCtx, "locale", "en");
  const e = await enCtx.newPage();
  monitor(e, { ...E, viewport: "1280x900-en" });
  // Демо-дані (назви товарів, матеріалів, шаблонів, партій) — українською за задумом; їх не вважаємо неперекладеним.
  const DATA = [
    "Тримач телефону Pro", "Крило заднє", "Грипси силіконові", "Сумка на кермо Mini", "Комплект світла LED", "Покришка 10x2.5",
    "Чорний", "Білий", "Чорні", "Сірі", "Сірий", "Чорна", "Стандарт", "Коробка S", "Коробка M", "Коробка L", "Пакет-конверт M",
    "Наклейка з логотипом", "Інструкція з монтажу крила", "Візитка «Дякуємо»", "Болти M5 (комплект)", "Скотч пакувальний",
    "Стандартний комплект", "Крило: болти та інструкція", "Тримачі білі та крила Model S", "Демо-виробник", "Основний склад",
    // Вигадана історія виробництва демо (назви партій, примітка, причини браку в примітках рухів).
    "Грипси й тримачі чорні", "Крила Model X і покришки", "DEMO · історія виробництва", "Потертості на поверхні",
    "Тріщина кріплення", "Деформація кронштейна",
    // Етап 5: вигадані колекції й шаблони «на колекцію».
    "Крила та захист", "Аксесуари на кермо", "Шини та колеса", "Світло та безпека", "Шини: фіксація скотчем",
    "Крило Model S: скотч для кронштейна",
    // Відправник у демо-налаштуваннях (дані, не інтерфейс).
    "ONE TUNNE (демо)", "вул. Демонстраційна, 1", "Київ", "Склад Київ (демо)", "Тестове відділення №1",
  ].sort((a, b) => b.length - a.length);
  const enScreens = [
    ["dashboard", "/demo"],
    ["warehouse", "/demo/warehouse"],
    ["warehouse-item", itemHref("OT-PH-BLK")],
    ["material-item", null],
    ["movements", "/demo/warehouse/movements"],
    ["stocktake", "/demo/warehouse?view=stocktake"],
    ["production", "/demo/production?tab=all"],
    ["production-batch", batchUrl()],
    ["production-new", state.gridUrl ?? "/demo/production/new"],
    ["picking", "/demo/picking?tab=all"],
    ["packing-order", packingUrl()],
    ["packing-in-progress", state.packing1007 ?? "/demo/picking"],
    ["settings-warehouse", "/demo/settings"],
    ["print", null],
    ["pick-list", state.pickListUrl ?? "/demo/picking/pick-list"],
    ["handover", "/demo/picking/handover"],
    ["materials", "/demo/warehouse/materials"],
    ["material-item-usage", state.materialHref ?? null],
    ["materials-edit", "/demo/warehouse/materials?edit=new"],
    ["kits", "/demo/warehouse/kits?order=%231002"],
    ["kits-edit", "/demo/warehouse/kits?edit=new"],
    ["analytics", "/demo/warehouse/analytics"],
    ["inventory-sync", "/demo/warehouse/shopify"],
    ["order-detail", `/demo/orders/${packingOrderId()}`],
    ["problems", "/demo/problems"],
  ];
  if (!process.env.E2E_SKIP_EN) await step("English locale: stage-5 pages have no untranslated Ukrainian / raw keys", E, null, async (ck) => {
    await go(e, "/demo/warehouse/movements?kind=material");
    const matHref = await e.locator('main a[href*="/warehouse/items/"]').first().getAttribute("href");
    await go(e, "/demo/picking");
    for (const n of ["#1001", "#1002"]) await e.getByRole("checkbox", { name: `Select ${n}` }).check().catch(() => {});
    await e.getByRole("button", { name: /^Print/ }).click().catch(() => {});
    await e.waitForURL(/picking\/print/, { timeout: 5000 }).catch(() => {});
    const printUrl = new URL(e.url()).pathname + new URL(e.url()).search;
    for (const entry of enScreens) {
      const [name] = entry;
      const url = entry[1] ?? (name === "material-item" ? matHref : name === "print" ? printUrl : null);
      if (!url) continue;
      await go(e, url);
      const found = await e.evaluate((DATA) => {
        const out = [];
        const root = document.querySelector("main") ?? document.body;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const strip = (s) => {
          let r = s;
          for (const d of DATA) r = r.split(d).join("");
          return r;
        };
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const t = (n.textContent ?? "").trim();
          if (!t) continue;
          if (n.parentElement?.closest("script, style")) continue;
          if (/[А-Яа-яІіЇїЄєҐґ]/.test(strip(t))) out.push({ kind: "cyrillic", text: t.slice(0, 120) });
          if (/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9_]+){2,}$/.test(t)) out.push({ kind: "raw-key", text: t });
        }
        for (const el of root.querySelectorAll("[placeholder], [aria-label], [title]")) {
          for (const a of ["placeholder", "aria-label", "title"]) {
            const v = el.getAttribute(a);
            if (v && /[А-Яа-яІіЇїЄєҐґ]/.test(strip(v))) out.push({ kind: `attr:${a}`, text: v.slice(0, 120) });
          }
        }
        for (const o of root.querySelectorAll("option")) {
          const v = o.textContent ?? "";
          if (/[А-Яа-яІіЇїЄєҐґ]/.test(strip(v))) out.push({ kind: "option", text: v.slice(0, 120) });
        }
        return out;
      }, DATA);
      const uniq = [...new Map(found.map((f) => [`${f.kind}|${f.text}`, f])).values()];
      if (uniq.length) i18nFindings.push({ screen: name, url, items: uniq.slice(0, 25), total: uniq.length });
      ck(uniq.length === 0, `${name}: ${uniq.length === 0 ? "translated" : `${uniq.length} suspicious: ${uniq.slice(0, 4).map((u) => `[${u.kind}] ${u.text}`).join(" ; ")}`}`);
      await e.screenshot({ path: path.join(OUT, `en-${name}.png`), fullPage: true }).catch(() => {});
    }
  });
  await enCtx.close();

  // ======================= ВЛАСНИК: «Проблеми» → «Склад» =======================
  // Наприкінці (змінює стан #1001): скасування вже запакованого замовлення відкриває складське попередження.
  const { ctx: finalCtx, page: f } = await rolePage("owner");
  await step("Problems: «Склад» category after cancelling a packed order; «Повернуто на склад» resolves it", D, f, async (ck) => {
    await go(f, state.packing1001 ?? "/demo/picking");
    ck(/Запаковано/.test(await mainText(f)), "#1001 is packed");
    await go(f, "/demo/orders?q=1001");
    const orderHref = await f.getByRole("link", { name: "#1001" }).first().getAttribute("href");
    await go(f, orderHref);
    await submitPost(f, f.locator("form:has(input[name=intent][value=cancelOrder]) button[aria-haspopup=dialog]").first(), { confirm: true });
    ck((await bannerText(f)).includes("Замовлення скасовано"), `packed #1001 cancelled (${(await bannerText(f)).slice(0, 120)})`);
    await go(f, "/demo/problems");
    const chip = f.locator("main a", { hasText: /^Склад · \d+$/ });
    ck((await chip.count()) === 1 && /Склад · 1/.test(await chip.innerText()), `category chip «Склад · 1» (${await chip.innerText().catch(() => "—")})`);
    await chip.click();
    await f.waitForURL(/category=warehouse/);
    await settle(f);
    await f.waitForTimeout(250);
    let t = await mainText(f);
    ck(t.includes("#1001") && /скасовано після пакування/i.test(t), `«Склад»: #1001 cancelled after packing (${t.match(/#1001.{0,120}/)?.[0]})`);
    await go(f, "/demo/problems?source=warehouse");
    ck((await mainText(f)).includes("#1001"), "source «Склад (пакування)» lists #1001");
    await go(f, state.packing1001);
    t = await mainText(f);
    ck(/Замовлення скасовано після пакування/.test(t), "packing screen: unpack and return to shelf warning");
    await submitPost(f, f.locator("form:has(input[name=intent][value=returned]) button[aria-haspopup=dialog]"), { confirm: true });
    ck(/Позначено: товар повернуто на склад/.test(await bannerText(f)), `«Повернуто на склад» recorded (${(await bannerText(f)).slice(0, 120)})`);
    await go(f, "/demo/problems?category=warehouse");
    ck(!(await mainText(f)).includes("#1001"), "warning closed: no open «Склад» problem for #1001");
    await go(f, "/demo/problems?tab=resolved&category=warehouse");
    ck((await mainText(f)).includes("#1001"), "resolved tab lists #1001");
  });
  await finalCtx.close();
} finally {
  await browser.close();
}

// ---------------------------------------------------------------------------
// Звіт
// ---------------------------------------------------------------------------
const hydration = pageIssues.filter((i) => i.kind === "hydration");
results.push({
  name: "no console errors / hydration errors / failed requests on any page",
  viewport: "all",
  role: "all",
  status: pageIssues.length === 0 ? "pass" : "fail",
  details: pageIssues.length === 0 ? "none" : `${pageIssues.length} issues (${hydration.length} hydration): ${pageIssues.slice(0, 6).map((i) => `[${i.role} ${i.viewport} ${i.kind}] ${i.url.replace(BASE, "")} ${i.text.slice(0, 140)}`).join(" | ")}`,
});
results.push({
  name: "tap targets ≥ 24×24 px on phones",
  viewport: "phones",
  role: "all",
  status: tapFindings.length === 0 ? "pass" : "fail",
  details: tapFindings.length === 0 ? "none" : tapFindings.slice(0, 8).map((f) => `${f.role} ${f.viewport} ${f.screen}: ${f.count} (${f.sample.map((s) => `${s.tag}«${s.name}» ${s.w}×${s.h}`).join(", ")})`).join(" | "),
});

const report = { base: BASE, finishedAt: new Date().toISOString(), results, pageIssues, i18nFindings, tapFindings };
fs.writeFileSync(path.join(OUT, "e2e-stage5-report.json"), JSON.stringify(report, null, 2));
const failed = results.filter((r) => r.status === "fail");
console.log(`\n${results.length - failed.length}/${results.length} steps passed. Report: ${path.resolve(OUT, "e2e-stage5-report.json")}`);
for (const f of failed) console.log(`  ✗ [${f.role} ${f.viewport}] ${f.name}: ${f.details}`);
process.exit(failed.length ? 1 : 0);
