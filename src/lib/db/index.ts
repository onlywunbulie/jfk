import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import postgres from "postgres";
import { PGlite } from "@electric-sql/pglite";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { env } from "@/lib/env";
import { isEmbeddedUrl, resolveDataDir } from "./embedded";
import * as schema from "./schema";

/**
 * Database client.
 *
 * Two drivers, one interface, chosen by the URL scheme:
 *
 *   file:./.data/jfk        → PGlite, real Postgres compiled to WASM, running
 *                             in this process. No daemon, no install. This is
 *                             the local development and test default.
 *   postgresql://…          → postgres.js against a real server (Neon in
 *                             production).
 *
 * Both are genuinely Postgres, so transactions, constraints and plpgsql
 * triggers behave the same in dev and prod — which matters, because the ledger
 * leans on all three.
 *
 * PGlite is single-connection and in-process. Fine for a friend group in dev;
 * never point production at it.
 */
declare global {
  var __jfkDb: Database | undefined;
}

/**
 * The shared supertype of both drivers.
 *
 * Deliberately not a union of the two concrete types: a union degrades method
 * signatures, and `tx.insert(...).returning(...)` inside a transaction stops
 * type-checking. Every caller wants the common Postgres surface anyway.
 */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

/** A transaction handle — what module services accept so they compose. */
export type Transaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

function createClient(): Database {
  const url = env().DATABASE_URL;

  if (isEmbeddedUrl(url)) {
    if (env().NODE_ENV === "production") {
      throw new Error(
        "DATABASE_URL points at embedded PGlite in production. " +
          "Set a real postgresql:// connection string.",
      );
    }
    return drizzlePglite(new PGlite(resolveDataDir(url)), {
      schema,
      casing: "snake_case",
    });
  }

  const client = postgres(url, {
    max: env().NODE_ENV === "production" ? 10 : 3,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  return drizzlePostgres(client, { schema, casing: "snake_case" });
}

function resolveDb(): Database {
  const existing = globalThis.__jfkDb;
  if (existing) return existing;

  const created = createClient();
  // Cached across dev-mode module reloads so editing a file doesn't leak pools.
  if (env().NODE_ENV !== "production") globalThis.__jfkDb = created;
  return created;
}

/**
 * The database handle.
 *
 * Lazily constructed behind a proxy: nothing connects, validates env, or
 * touches the filesystem until a query actually runs. `next build` imports
 * every module to collect page data, and a connection opened at module load
 * would make the build require a live database it never queries.
 */
export const db: Database = new Proxy({} as Database, {
  get(_target, property) {
    const instance = resolveDb();
    const value = Reflect.get(instance, property, instance);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});

export { schema };
