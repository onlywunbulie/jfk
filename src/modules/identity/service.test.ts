import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/lib/db/testing";

// The service imports the app-wide `db` singleton; point it at a throwaway
// in-memory Postgres instead. Async factory so migrations finish before any
// test body runs.
const t: TestDb = await createTestDb();
vi.mock("@/lib/db", async () => ({ db: t.db }));

const { requestLoginCode, verifyLoginCode, normalizeEmail } = await import(
  "./service"
);
const { loginCodes, users, LOGIN_CODE_MAX_ATTEMPTS } = await import(
  "@/lib/db/schema"
);

beforeAll(() => {
  // Codes are printed to the console in email-disabled mode; keep tests quiet.
  vi.spyOn(console, "info").mockImplementation(() => {});
});

beforeEach(async () => {
  await t.db.delete(loginCodes);
  await t.db.delete(users);
});

afterAll(async () => {
  await t.close();
});

/** Pull the code out of the dev-mode response — never available in production. */
async function codeFor(email: string): Promise<string> {
  const result = await requestLoginCode(email);
  if (!result.ok) throw new Error(`request failed: ${result.reason}`);
  if (!result.devCode) throw new Error("expected a dev code");
  return result.devCode;
}

describe("normalizeEmail", () => {
  it("lowercases and trims so one person is one account", () => {
    expect(normalizeEmail("  Geoffrey@Example.COM ")).toBe("geoffrey@example.com");
  });
});

describe("requestLoginCode", () => {
  it("issues a 6-digit code", async () => {
    const code = await codeFor("geoffrey@jfk.test");
    expect(code).toMatch(/^\d{6}$/);
  });

  it("never stores the code in the clear", async () => {
    const code = await codeFor("geoffrey@jfk.test");
    const [row] = await t.db.select().from(loginCodes);
    expect(row.codeHash).not.toBe(code);
    expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("normalises the email before storing", async () => {
    await requestLoginCode("  Geoffrey@JFK.test  ");
    const [row] = await t.db.select().from(loginCodes);
    expect(row.email).toBe("geoffrey@jfk.test");
  });

  it("rate limits after 5 requests in an hour", async () => {
    for (let i = 0; i < 5; i++) await requestLoginCode("spam@jfk.test");

    const blocked = await requestLoginCode("spam@jfk.test");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.reason).toBe("rate_limited");
      expect(blocked.retryAfterMinutes).toBeGreaterThan(0);
    }
  });

  it("rate limits per email, not globally", async () => {
    for (let i = 0; i < 5; i++) await requestLoginCode("spam@jfk.test");
    const other = await requestLoginCode("chuka@jfk.test");
    expect(other.ok).toBe(true);
  });

  it("does not reveal whether the account exists", async () => {
    await t.db
      .insert(users)
      .values({ email: "known@jfk.test", displayName: "Known" });

    const known = await requestLoginCode("known@jfk.test");
    const unknown = await requestLoginCode("stranger@jfk.test");

    // Same shape, same fields — nothing to distinguish a member from a stranger.
    expect(Object.keys(known).sort()).toEqual(Object.keys(unknown).sort());
    expect(known.ok).toBe(unknown.ok);
  });
});

describe("verifyLoginCode", () => {
  it("creates the account on first successful verification", async () => {
    const code = await codeFor("geoffrey@jfk.test");
    const result = await verifyLoginCode("geoffrey@jfk.test", code);

    expect(result).toMatchObject({ ok: true, isNewUser: true });

    const [user] = await t.db.select().from(users);
    expect(user.email).toBe("geoffrey@jfk.test");
    expect(user.displayName).toBe("Geoffrey");
    expect(user.emailVerifiedAt).not.toBeNull();
  });

  it("reuses the account on subsequent sign-ins", async () => {
    const first = await verifyLoginCode(
      "geoffrey@jfk.test",
      await codeFor("geoffrey@jfk.test"),
    );
    const second = await verifyLoginCode(
      "geoffrey@jfk.test",
      await codeFor("geoffrey@jfk.test"),
    );

    expect(first).toMatchObject({ ok: true, isNewUser: true });
    expect(second).toMatchObject({ ok: true, isNewUser: false });
    if (first.ok && second.ok) expect(second.userId).toBe(first.userId);
    expect(await t.db.select().from(users)).toHaveLength(1);
  });

  it("accepts a code regardless of email casing", async () => {
    const code = await codeFor("geoffrey@jfk.test");
    const result = await verifyLoginCode("GEOFFREY@JFK.TEST", code);
    expect(result.ok).toBe(true);
  });

  it("burns the code so it cannot be replayed", async () => {
    const code = await codeFor("geoffrey@jfk.test");

    expect((await verifyLoginCode("geoffrey@jfk.test", code)).ok).toBe(true);

    const replay = await verifyLoginCode("geoffrey@jfk.test", code);
    expect(replay).toMatchObject({ ok: false, reason: "invalid" });
    // And no second account was created by the replay.
    expect(await t.db.select().from(users)).toHaveLength(1);
  });

  it("rejects a wrong code and counts the attempt", async () => {
    await codeFor("geoffrey@jfk.test");

    const result = await verifyLoginCode("geoffrey@jfk.test", "000000");
    expect(result).toMatchObject({ ok: false, reason: "invalid" });

    const [row] = await t.db.select().from(loginCodes);
    expect(row.attempts).toBe(1);
    expect(row.consumedAt).toBeNull();
  });

  it("burns the code after 5 wrong attempts", async () => {
    const code = await codeFor("geoffrey@jfk.test");

    for (let i = 0; i < LOGIN_CODE_MAX_ATTEMPTS - 1; i++) {
      expect(await verifyLoginCode("geoffrey@jfk.test", "000000")).toMatchObject({
        reason: "invalid",
      });
    }

    expect(await verifyLoginCode("geoffrey@jfk.test", "000000")).toMatchObject({
      ok: false,
      reason: "too_many_attempts",
    });

    // Even the genuine code is dead now — brute force cannot be outlasted.
    expect(await verifyLoginCode("geoffrey@jfk.test", code)).toMatchObject({
      ok: false,
      reason: "too_many_attempts",
    });
    expect(await t.db.select().from(users)).toHaveLength(0);
  });

  it("rejects an expired code", async () => {
    const code = await codeFor("geoffrey@jfk.test");
    await t.db
      .update(loginCodes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(loginCodes.email, "geoffrey@jfk.test"));

    expect(await verifyLoginCode("geoffrey@jfk.test", code)).toMatchObject({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects when no code was ever requested", async () => {
    expect(await verifyLoginCode("nobody@jfk.test", "123456")).toMatchObject({
      ok: false,
      reason: "invalid",
    });
  });

  it("uses the newest code when several were requested", async () => {
    const stale = await codeFor("geoffrey@jfk.test");
    // Ordering is by created_at; nudge the first row back so it is unambiguous.
    await t.db
      .update(loginCodes)
      .set({ createdAt: sql`now() - interval '1 minute'` })
      .where(eq(loginCodes.codeHash, (await t.db.select().from(loginCodes))[0].codeHash));

    const fresh = await codeFor("geoffrey@jfk.test");

    expect(await verifyLoginCode("geoffrey@jfk.test", stale)).toMatchObject({
      ok: false,
    });
    expect(await verifyLoginCode("geoffrey@jfk.test", fresh)).toMatchObject({
      ok: true,
    });
  });
});
