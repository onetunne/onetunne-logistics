#!/usr/bin/env node
/**
 * Запуск зібраної демо-версії (кросплатформно: Windows/macOS/Linux).
 * Спершу: npm run build. Дані демо зберігаються у .data/demo-db (PGlite).
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const env = {
  ...process.env,
  NODE_ENV: "production",
  DEMO_MODE: process.env.DEMO_MODE ?? "true",
  DEMO_DATA_DIR: process.env.DEMO_DATA_DIR ?? ".data/demo-db",
  PORT: process.env.PORT ?? "3000",
};

console.log(`ONE TUNNE Logistics demo → http://localhost:${env.PORT}/demo`);
// .env (якщо є) підхоплюється так само, як у `npm start`; явні змінні середовища мають пріоритет.
const child = spawn(process.execPath, ["--env-file-if-exists=.env", path.join(root, "server.mjs")], {
  env,
  stdio: "inherit",
  cwd: root,
});
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
