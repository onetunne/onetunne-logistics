#!/usr/bin/env node
/**
 * Робочий HTTP-сервер (замість react-router-serve).
 * Головна відмінність: довіра до HTTPS-проксі хостингу (Render, Fly, Shopify hosting),
 * щоб React Router бачив справжній протокол https://. Без цього перевірка Origin
 * (захист від CSRF) відхиляла б усі форми за проксі.
 * Журнал запитів — без query-рядків (там можуть бути пошукові запити з персональними даними).
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import compression from "compression";
import { createRequestHandler } from "@react-router/express";

const root = path.dirname(fileURLToPath(import.meta.url));
const build = await import(pathToFileURL(path.join(root, "build/server/index.js")).href);

/**
 * За замовчуванням проксі НЕ довіряємо (локальний запуск / Wi-Fi): інакше клієнт міг би підробити IP.
 * На хостингу (Render, Fly, …) задайте TRUST_PROXY=1 — це вже зроблено в render.yaml.
 */
function trustProxySetting(value) {
  if (value === undefined || value === "") return false;
  if (/^\d+$/.test(value)) return Number(value);
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", trustProxySetting(process.env.TRUST_PROXY));
app.use(compression());

app.use((req, res, next) => {
  const started = Date.now();
  res.on("finish", () => {
    if (req.path.startsWith("/assets/")) return;
    // Токен у шляху зворотного виклику Shopify Checkout — секрет: у журнал не записується.
    const logPath = req.path.replace(/\/carrier-service\/[^/]+/g, "/carrier-service/[hidden]");
    console.log(`${req.method} ${logPath} ${res.statusCode} ${Date.now() - started}ms`);
  });
  next();
});

app.use("/assets", express.static(path.join(root, "build/client/assets"), { immutable: true, maxAge: "1y" }));
app.use(express.static(path.join(root, "build/client"), { maxAge: "1h" }));
app.use(
  createRequestHandler({
    build,
    mode: process.env.NODE_ENV,
    getLoadContext: (req) => ({ clientIp: req.ip ?? null }),
  }),
);

const port = Number(process.env.PORT || 3000);
const server = app.listen(port, "0.0.0.0", () => {
  console.log(`ONE TUNNE Logistics: http://localhost:${port}`);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
