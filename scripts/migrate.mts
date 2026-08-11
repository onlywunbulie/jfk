/**
 * Apply pending migrations.
 *
 * Handles both drivers so `pnpm db:migrate` means the same thing locally
 * (PGlite) and against a real server (Neon). Run it after `pnpm db:generate`
 * and after reviewing the generated SQL by hand — never auto-push to prod.
 */
import { config } from "dotenv";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import postgres from "postgres";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import { isEmbeddedUrl, resolveDataDir } from "../src/lib/db/embedded.js";

config({ path: ".env.local" });
config({ path: ".env" });

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Copy .env.example to .env.local.");
  process.exit(1);
}

const migrationsFolder = "./src/lib/db/migrations";

if (isEmbeddedUrl(url)) {
  const dataDir = resolveDataDir(url);
  const client = new PGlite(dataDir);
  await migratePglite(drizzlePglite(client), { migrationsFolder });
  await client.close();
  console.log(`✓ Migrations applied to embedded Postgres at ${dataDir}`);
} else {
  // A dedicated single-connection client: migrations must run serially, and
  // this one is closed as soon as they finish.
  const client = postgres(url, { max: 1 });
  await migratePostgres(drizzlePostgres(client), { migrationsFolder });
  await client.end();
  console.log("✓ Migrations applied to remote Postgres");
}
