import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/lib/db/testing";

// A real, migrated, in-memory Postgres: the sign-in rules are tested against
// the actual tables and their constraints, not mocks.
const t: TestDb = await createTestDb();
vi.mock("@/lib/db", async () => ({ db: t.db }));

const { registerClient, createAuthorizationCode, exchangeCode, refreshTokens, verifyAccessToken, revokeAllForUser, isAllowedRedirect, pkceMatches, READ_SCOPE } =
  await import("./oauth");
const { users, oauthClients, oauthCodes, oauthTokens } = await import("@/lib/db/schema");

const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "a".repeat(20) + "-verifier-" + "b".repeat(20);
const CHALLENGE = createHash("sha256").update(VERIFIER, "ascii").digest("base64url");

let userId: string;
let clientId: string;

beforeEach(async () => {
  await t.db.delete(oauthTokens);
  await t.db.delete(oauthCodes);
  await t.db.delete(oauthClients);
  await t.db.delete(users);
  const [user] = await t.db.insert(users).values({ displayName: "Amaka" }).returning();
  userId = user.id;
  const registered = await registerClient({ name: "Claude", redirectUris: [CLAUDE_CALLBACK] });
  if (!registered.ok) throw new Error("registration failed");
  clientId = registered.client.id;
});

afterAll(async () => {
  await t.close();
});

async function freshCode(overrides: { redirectUri?: string; now?: Date } = {}) {
  return createAuthorizationCode({
    clientId,
    userId,
    redirectUri: overrides.redirectUri ?? CLAUDE_CALLBACK,
    codeChallenge: CHALLENGE,
    scope: READ_SCOPE,
    now: overrides.now,
  });
}

describe("registering an AI app", () => {
  it("accepts https return addresses and localhost for testing", () => {
    expect(isAllowedRedirect(CLAUDE_CALLBACK)).toBe(true);
    expect(isAllowedRedirect("http://localhost:6274/callback")).toBe(true);
  });

  it("refuses plain http elsewhere, fragments, and non-URLs", () => {
    expect(isAllowedRedirect("http://evil.example/cb")).toBe(false);
    expect(isAllowedRedirect("https://claude.ai/cb#x")).toBe(false);
    expect(isAllowedRedirect("javascript:alert(1)")).toBe(false);
    expect(isAllowedRedirect("not a url")).toBe(false);
  });

  it("refuses registration with no, too many, or bad return addresses", async () => {
    expect(await registerClient({ name: "X", redirectUris: [] })).toEqual({ ok: false, reason: "invalid_redirect_uri" });
    expect(await registerClient({ name: "X", redirectUris: "https://a.example" })).toEqual({ ok: false, reason: "invalid_redirect_uri" });
    expect(await registerClient({ name: "X", redirectUris: ["http://evil.example/cb"] })).toEqual({ ok: false, reason: "invalid_redirect_uri" });
    const eleven = Array.from({ length: 11 }, (_, i) => `https://a.example/${i}`);
    expect(await registerClient({ name: "X", redirectUris: eleven })).toEqual({ ok: false, reason: "invalid_redirect_uri" });
  });

  it("gives a nameless app a plain name rather than trusting an empty one", async () => {
    const result = await registerClient({ name: "   ", redirectUris: [CLAUDE_CALLBACK] });
    expect(result.ok && result.client.name).toBe("An AI app");
  });
});

describe("PKCE", () => {
  it("matches the S256 challenge of its own verifier only", () => {
    expect(pkceMatches(VERIFIER, CHALLENGE)).toBe(true);
    expect(pkceMatches(VERIFIER + "x", CHALLENGE)).toBe(false);
    expect(pkceMatches("short", CHALLENGE)).toBe(false);
  });
});

describe("exchanging a sign-in code", () => {
  it("gives tokens that act for the user who approved", async () => {
    const code = await freshCode();
    const result = await exchangeCode({ code, clientId, redirectUri: CLAUDE_CALLBACK, codeVerifier: VERIFIER });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scope).toBe(READ_SCOPE);
    expect(await verifyAccessToken(result.accessToken)).toMatchObject({ userId, clientId, scope: READ_SCOPE });
  });

  it("works once: the same code can't be exchanged twice", async () => {
    const code = await freshCode();
    const input = { code, clientId, redirectUri: CLAUDE_CALLBACK, codeVerifier: VERIFIER };
    expect((await exchangeCode(input)).ok).toBe(true);
    expect(await exchangeCode(input)).toEqual({ ok: false, reason: "invalid_grant" });
  });

  it("refuses the wrong verifier, the wrong app, or the wrong return address", async () => {
    expect(
      await exchangeCode({ code: await freshCode(), clientId, redirectUri: CLAUDE_CALLBACK, codeVerifier: "z".repeat(43) }),
    ).toEqual({ ok: false, reason: "invalid_grant" });
    expect(
      await exchangeCode({ code: await freshCode(), clientId: "someone-else", redirectUri: CLAUDE_CALLBACK, codeVerifier: VERIFIER }),
    ).toEqual({ ok: false, reason: "invalid_grant" });
    expect(
      await exchangeCode({ code: await freshCode(), clientId, redirectUri: "https://claude.ai/other", codeVerifier: VERIFIER }),
    ).toEqual({ ok: false, reason: "invalid_grant" });
  });

  it("refuses a code older than five minutes", async () => {
    const issued = new Date("2026-11-13T10:00:00Z");
    const code = await freshCode({ now: issued });
    const later = new Date(issued.getTime() + 5 * 60 * 1000 + 1);
    expect(await exchangeCode({ code, clientId, redirectUri: CLAUDE_CALLBACK, codeVerifier: VERIFIER, now: later })).toEqual({
      ok: false,
      reason: "invalid_grant",
    });
  });

  it("stores only hashes, never the raw code or tokens", async () => {
    const code = await freshCode();
    const result = await exchangeCode({ code, clientId, redirectUri: CLAUDE_CALLBACK, codeVerifier: VERIFIER });
    if (!result.ok) throw new Error("exchange failed");
    const [codeRow] = await t.db.select().from(oauthCodes);
    const [tokenRow] = await t.db.select().from(oauthTokens);
    expect(codeRow.codeHash).not.toBe(code);
    expect(tokenRow.accessHash).not.toBe(result.accessToken);
    expect(tokenRow.refreshHash).not.toBe(result.refreshToken);
  });
});

describe("access tokens", () => {
  async function connect() {
    const result = await exchangeCode({ code: await freshCode(), clientId, redirectUri: CLAUDE_CALLBACK, codeVerifier: VERIFIER });
    if (!result.ok) throw new Error("exchange failed");
    return result;
  }

  it("expire after an hour", async () => {
    const { accessToken } = await connect();
    const later = new Date(Date.now() + 60 * 60 * 1000 + 1000);
    expect(await verifyAccessToken(accessToken, later)).toBeNull();
  });

  it("refresh into a new pair, and the old refresh token stops working", async () => {
    const first = await connect();
    const second = await refreshTokens({ refreshToken: first.refreshToken, clientId });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(await verifyAccessToken(second.accessToken)).toMatchObject({ userId });
    expect(await verifyAccessToken(first.accessToken)).toBeNull();
    expect(await refreshTokens({ refreshToken: first.refreshToken, clientId })).toEqual({ ok: false, reason: "invalid_grant" });
  });

  it("can't be refreshed by a different app", async () => {
    const { refreshToken } = await connect();
    expect(await refreshTokens({ refreshToken, clientId: "someone-else" })).toEqual({ ok: false, reason: "invalid_grant" });
  });

  it("stop working the moment the user disconnects", async () => {
    const { accessToken, refreshToken } = await connect();
    await revokeAllForUser(userId);
    expect(await verifyAccessToken(accessToken)).toBeNull();
    expect(await refreshTokens({ refreshToken, clientId })).toEqual({ ok: false, reason: "invalid_grant" });
  });

  it("aren't valid for an unknown token", async () => {
    expect(await verifyAccessToken("rla_not-a-real-token")).toBeNull();
  });
});
