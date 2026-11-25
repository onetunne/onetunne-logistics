#!/usr/bin/env node
/**
 * Створює шаблон демо-бази (PGlite + міграції) під час збірки: build/demo-db-template.
 * Під час запуску демо копіює шаблон замість важкої ініціалізації PostgreSQL (initdb потребує ~700 МБ пам'яті,
 * відкриття готової бази — ~300 МБ). Так демо вміщується у безкоштовні хостинги з 512 МБ.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "build", "demo-db-template");

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(path.dirname(target), { recursive: true });
const client = new PGlite(target);
await migrate(drizzle(client), { migrationsFolder: path.join(root, "drizzle") });
await client.close();
console.log(`Demo DB template ready: ${path.relative(root, target)}`);
