#!/usr/bin/env node
/**
 * Запуск зібраної демо-версії (кросплатформно: Windows/macOS/Linux).
 * Спершу: npm run build. Дані демо зберігаються у .data/demo-db (PGlite).
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const serveBin = path.join(path.dirname(require.resolve("@react-router/serve/package.json")), "bin.js");

const env = {
  ...process.env,
  NODE_ENV: "production",
  DEMO_MODE: process.env.DEMO_MODE ?? "true",
  DEMO_DATA_DIR: process.env.DEMO_DATA_DIR ?? ".data/demo-db",
  PORT: process.env.PORT ?? "3000",
};

console.log(`ONE TUNNE Logistics demo → http://localhost:${env.PORT}/demo`);
const child = spawn(process.execPath, [serveBin, "./build/server/index.js"], { env, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
