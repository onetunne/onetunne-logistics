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
 *  - працівник: не бачить собівартості (виробництво, рух, картка, матеріали, експорт), не відкриває/не виконує дії
 *    власника (403 або відмова), може оприбуткувати й пакувати;
 *  - телефони 320×568, 375×667, 390×844 (власник і працівник): без горизонтальної прокрутки, розмір елементів
 *    керування, надсилання форм;
 *  - англійська: пошук неперекладених українських рядків і сирих ключів i18n;
 *  - на кожній сторінці: помилки консолі (зокрема гідратації React #418/#423/#425), невдалі запити.
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

const today = () => new Date(Date.now() + 2 * 3600_000).toISOString().slice(0, 10);
const inDays = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const COST_RE = /собіварт|₴|\bUAH\b|unit cost|cost per/i;

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
    // Підбір лише за вагою (у демо-товарів немає габаритів) — ★ лише рекомендація, коробку обирає пакувальник
    // (задокументовано в packing.server.ts defaultBoxFor). Обираємо рекомендовану.
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
    // Тестовий перевізник етикеток не має: маршрут відповідає 409 з поясненням (очікувано).
    await expecting(p, [409], async () => {
      await p.getByRole("button", { name: /Етикетки перевізника/ }).click();
      await p.locator(".ot-banner", { hasText: /Етикетк/ }).first().waitFor({ timeout: ACTION_TIMEOUT }).catch(() => {});
    });
    const lb = await bannerText(p);
    ck(/етикет/i.test(lb), `labels: understandable result in demo (${lb.slice(0, 200)})`);
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
    for (const label of ["Залишки", "Рух за період", "Продажі за варіантами"]) {
      const { file, head } = await csvDownload(p, label);
      ck(head.length > 0, `${label}: file ${path.basename(file)} header: ${head.slice(0, 120)}`);
      if (label === "Залишки") ck(head.includes("unit_cost"), "owner stock CSV has unit_cost");
      if (label === "Рух за період") ck(/unit_cost/.test(head), "owner movements CSV has unit_cost");
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

  await staffCtx.close();

  // ======================= ТЕЛЕФОНИ =======================
  const phones = [
    { w: 320, h: 568 },
    { w: 375, h: 667 },
    { w: 390, h: 844 },
  ];
  const mobileScreens = (role) => [
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
    ["materials", "/demo/warehouse/materials"],
    ["kits", "/demo/warehouse/kits?order=%231002"],
    ["analytics", "/demo/warehouse/analytics"],
    ["inventory-sync", "/demo/warehouse/shopify"],
  ];
  for (const role of ["owner", "staff"]) {
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
    // Етап 5: вигадані колекції й шаблони «на колекцію».
    "Крила та захист", "Аксесуари на кермо", "Шини та колеса", "Світло та безпека", "Шини: фіксація скотчем",
    "Крило Model S: скотч для кронштейна",
    // Відправник у демо-налаштуваннях (дані, не інтерфейс).
    "ONE TUNNE (демо)", "вул. Демонстраційна, 1", "Київ", "Склад Київ (демо)", "Тестове відділення №1",
  ].sort((a, b) => b.length - a.length);
  const enScreens = [
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
    ["materials", "/demo/warehouse/materials"],
    ["materials-edit", "/demo/warehouse/materials?edit=new"],
    ["kits", "/demo/warehouse/kits?order=%231002"],
    ["kits-edit", "/demo/warehouse/kits?edit=new"],
    ["analytics", "/demo/warehouse/analytics"],
    ["inventory-sync", "/demo/warehouse/shopify"],
    ["order-detail", `/demo/orders/${packingOrderId()}`],
  ];
  await step("English locale: stage-5 pages have no untranslated Ukrainian / raw keys", E, null, async (ck) => {
    await go(e, "/demo/warehouse/movements?kind=material");
    const matHref = await e.locator('main a[href*="/warehouse/items/"]').first().getAttribute("href");
    await go(e, "/demo/picking");
    for (const n of ["#1001", "#1002"]) await e.getByRole("checkbox", { name: `Select ${n}` }).check().catch(() => {});
    await e.getByRole("button", { name: /^Print/ }).click().catch(() => {});
    await e.waitForURL(/picking\/print/, { timeout: 5000 }).catch(() => {});
    const printUrl = new URL(e.url()).pathname + new URL(e.url()).search;
    for (const entry of enScreens) {
      const [name] = entry;
      const url = entry[1] ?? (name === "material-item" ? matHref : printUrl);
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
