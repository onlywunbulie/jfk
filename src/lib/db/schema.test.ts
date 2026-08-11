import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./testing";
import { auditLogs, sessions, users } from "./schema";

let t: TestDb;

/**
 * Drizzle wraps driver errors, so the Postgres message lives on `cause`.
 * Walk the whole chain and return it joined, or fail loudly if the promise
 * resolved — a silent success here would mean the guard is gone.
 */
async function captureReason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const messages: string[] = [];
    let current: unknown = error;
    while (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
    }
    return messages.join(" | ");
  }
  throw new Error("Expected the query to be rejected, but it succeeded");
}

beforeAll(async () => {
  t = await createTestDb();
}, 60_000);

afterAll(async () => {
  await t?.close();
});

describe("migrations", () => {
  it("creates every Phase 0 table", async () => {
    const result = await t.sql(
      `select table_name from information_schema.tables
       where table_schema = 'public' order by table_name`,
    );
    const names = (result.rows as { table_name: string }[]).map(
      (r) => r.table_name,
    );
    expect(names).toEqual(
      expect.arrayContaining(["audit_logs", "login_codes", "sessions", "users"]),
    );
  });
});

describe("users", () => {
  it("rejects a duplicate email", async () => {
    await t.db.insert(users).values({ email: "dupe@jfk.test", displayName: "A" });
    await expect(
      t.db.insert(users).values({ email: "dupe@jfk.test", displayName: "B" }),
    ).rejects.toThrow();
  });

  it("assigns sortable UUIDv7 ids", async () => {
    const [first] = await t.db
      .insert(users)
      .values({ email: "order1@jfk.test", displayName: "First" })
      .returning({ id: users.id });
    const [second] = await t.db
      .insert(users)
      .values({ email: "order2@jfk.test", displayName: "Second" })
      .returning({ id: users.id });

    // Version nibble is 7, and later rows sort after earlier ones.
    expect(first.id[14]).toBe("7");
    expect(second.id > first.id).toBe(true);
  });
});

describe("sessions", () => {
  it("cascades when its user is deleted", async () => {
    const [user] = await t.db
      .insert(users)
      .values({ email: "cascade@jfk.test", displayName: "Cascade" })
      .returning({ id: users.id });

    await t.db.insert(sessions).values({
      userId: user.id,
      tokenHash: "hash-cascade",
      expiresAt: new Date(Date.now() + 60_000),
    });

    await t.db.delete(users).where(eq(users.id, user.id));

    const remaining = await t.db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, user.id));
    expect(remaining).toHaveLength(0);
  });

  it("rejects a duplicate token hash", async () => {
    const [user] = await t.db
      .insert(users)
      .values({ email: "tok@jfk.test", displayName: "Tok" })
      .returning({ id: users.id });

    const values = {
      userId: user.id,
      tokenHash: "same-token",
      expiresAt: new Date(Date.now() + 60_000),
    };
    await t.db.insert(sessions).values(values);
    await expect(t.db.insert(sessions).values(values)).rejects.toThrow();
  });
});

describe("audit_logs is append-only", () => {
  // This is the guarantee that makes every other financial control auditable.
  // If it ever regresses, the audit trail becomes unfalsifiable.
  it("accepts inserts", async () => {
    await t.db.insert(auditLogs).values({
      id: "audit-fixed-1",
      action: "test.insert",
    });
    const rows = await t.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.id, "audit-fixed-1"));
    expect(rows).toHaveLength(1);
  });

  it("blocks UPDATE", async () => {
    const reason = await captureReason(
      t.db
        .update(auditLogs)
        .set({ action: "tampered" })
        .where(eq(auditLogs.id, "audit-fixed-1")),
    );
    expect(reason).toMatch(/append-only/);
  });

  it("blocks DELETE", async () => {
    const reason = await captureReason(
      t.db.delete(auditLogs).where(eq(auditLogs.id, "audit-fixed-1")),
    );
    expect(reason).toMatch(/append-only/);
  });

  it("leaves the original row untouched after both attempts", async () => {
    const rows = await t.db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.id, "audit-fixed-1"));
    expect(rows[0].action).toBe("test.insert");
  });
});
