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

    /**
     * Multi-statement SQL, including explicit BEGIN/COMMIT.
     *
     * `query` uses a prepared statement and rejects more than one command, so
     * anything testing deferred constraints — which only fire at COMMIT — has
     * to go through here.
     */
    exec: (script: string) => client.exec(script),

    /**
     * Empty every table between tests.
     *
     * TRUNCATE rather than DELETE because `audit_logs` refuses row-level
     * DELETE — the append-only trigger is doing exactly its job. TRUNCATE
     * does not fire row triggers, which is the standard escape hatch.
     *
     * Production's application role must therefore never hold TRUNCATE on
     * `audit_logs` or the ledger; only migrations should.
     */
    reset: async () => {
      const result = await client.query<{ tablename: string }>(
        `select tablename from pg_tables where schemaname = 'public'`,
      );
      const tables = result.rows
        .map((r) => `"${r.tablename}"`)
        .filter((name) => !name.includes("__drizzle"));
      if (tables.length === 0) return;
      await client.query(`TRUNCATE ${tables.join(", ")} CASCADE`);
    },

    close: () => client.close(),
  };
}

export type TestDb = Awaited<ReturnType<typeof createTestDb>>;
