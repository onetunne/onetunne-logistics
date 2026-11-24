import { defineConfig } from "drizzle-kit";

// Генерація SQL-міграцій зі схеми: `npm run db:generate`.
// Міграції застосовуються автоматично під час запуску застосунку (app/db/migrate.server.ts).
export default defineConfig({
  dialect: "postgresql",
  schema: "./app/db/schema.ts",
  out: "./drizzle",
});
