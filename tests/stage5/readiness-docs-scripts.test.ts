import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXPORT_DATASETS } from "~/modules/warehouse-analytics/params";
import { WAREHOUSE_COMMAND_NAMES } from "~/modules/warehouse/commands.server";

/**
 * S5-E2E-NPM: E2E-перевірка етапу 5 запускається npm-скриптом (не лише вручну); S5-TG / S5-FIN: документ підготовки до
 * Telegram описує кожну команду складу й кожен набір CSV-експорту (таблиці не відстають від коду).
 */
const read = (file: string) => fs.readFileSync(path.resolve(file), "utf8");

describe("npm scripts", () => {
  it("test:e2e:stage5 runs scripts/e2e-stage5.mjs (the smoke check stays test:e2e)", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["test:e2e:stage5"]).toBe("node scripts/e2e-stage5.mjs");
    expect(pkg.scripts["test:e2e"]).toBe("node scripts/e2e-smoke.mjs");
    expect(fs.existsSync(path.resolve("scripts/e2e-stage5.mjs"))).toBe(true);
  });
});

describe("docs/telegram-warehouse-readiness.md", () => {
  const doc = read("docs/telegram-warehouse-readiness.md");

  it("the command table lists every warehouse command", () => {
    for (const name of WAREHOUSE_COMMAND_NAMES) expect(doc, name).toMatch(new RegExp(`^\\| \`${name}\` \\|`, "m"));
  });

  it("the CSV table lists every export dataset; the stage-6 COGS rule is documented as planned", () => {
    for (const dataset of EXPORT_DATASETS) expect(doc, dataset).toMatch(new RegExp(`^\\| \`${dataset}\``, "m"));
    expect(doc).toMatch(/COGS\) — \*\*заплановано, не реалізовано\*\*/);
    expect(doc).toMatch(/`consume_sale` і витрати матеріалів `material_consume` \*\*не мають\*\* `unit_cost`/);
  });

  it("the COGS rule expenses a defective unit exactly once (C-R6-3): write-off adds no cost, repair is covered", () => {
    const cogs = doc.slice(doc.indexOf("#### Як етап 6 (фінанси)"), doc.indexOf("### 1.3"));
    expect(cogs).toMatch(/кожна одиниця витрачається рівно один раз/);
    // Брак із виробництва вже в середній якісних — не окремий збиток; утилізація — без нової вартості.
    expect(cogs).toMatch(/брак із виробництва \(`defective_delta` руху `receipt_production`\) окремим збитком \*\*не\*\* рахується/);
    expect(cogs).toMatch(/`defect_writeoff` \(утилізація браку\) — \*\*без нової вартості\*\*/);
    expect(cogs).toMatch(/`defect_repair` \(брак → якісні\)[^]*\*\*за нульовою вартістю\*\*/);
    expect(cogs).toMatch(/`defect_mark` \(якісні → брак\): збиток = `кількість × середня`/);
    // Старе формулювання («defect_mark / списання браку — збиток») рахувало брак двічі.
    expect(cogs).not.toMatch(/`defect_mark` \/ списання браку — збиток/);
    // Перевірка на прикладі: сума витрат = вартість партії.
    expect(cogs).toMatch(/утилізація браку — 0; продаж 9 → COGS 1000/);
  });

  it("one operationId — one operation is atomic for parallel calls (C-R6-1/2), not only a pre-check", () => {
    const commands = doc.slice(doc.indexOf("### 1.3"), doc.indexOf("### 1.4"));
    expect(commands).toMatch(/в \*\*одній транзакції під `pg_advisory_xact_lock` за `operationId`\*\*/);
    expect(commands).toMatch(/`replay` — лише для тих самих позицій і кількостей, інакше `operationReused`/);
    expect(commands).toMatch(/`warehouseCommands\.error\.batchNotFound` \/ `orderNotFound`/);
  });
});
