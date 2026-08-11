import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "./schema";

/**
 * A throwaway database for tests: real Postgres, in memory, migrated from the
 * same SQL files production runs.
 *
 * This is what makes the financial invariants testable without a server or a
 * container — the ledger's constraints, triggers and transaction semantics are
 * exercised for real, not mocked. Phase 2 leans on this heavily.
 */
export async function createTestDb() {
  const client = new PGlite("memory://");
  const db = drizzle(client, { schema, casing: "snake_case" });

  await migrate(db, { migrationsFolder: "./src/lib/db/migrations" });

  return {
    db,
    client,
    /** Raw SQL escape hatch for asserting on constraints and triggers. */
    sql: (query: string) => client.query(query),
    close: () => client.close(),
  };
}

export type TestDb = Awaited<ReturnType<typeof createTestDb>>;
