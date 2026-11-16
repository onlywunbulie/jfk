import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/lib/db/testing";

// The user's AI connection, against a real migrated Postgres: whether it's
// live, Disconnect, and keeping it out of one group.
const t: TestDb = await createTestDb();
vi.mock("@/lib/db", async () => ({ db: t.db }));

const { getAiConnection, setAiInGroup, aiAllowedInGroup, aiOptedOutGroups } = await import("./connection");
const { registerClient, createAuthorizationCode, exchangeCode, revokeAllForUser, READ_SCOPE } = await import("./oauth");
const { createGroup } = await import("@/modules/groups/service");
const { users } = await import("@/lib/db/schema");
const { Money } = await import("@/lib/money");

const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "c".repeat(50);
const CHALLENGE = createHash("sha256").update(VERIFIER, "ascii").digest("base64url");

beforeEach(async () => {
  await t.reset();
});

afterAll(async () => {
  await t.close();
});

async function makeUser(name: string) {
  const [user] = await t.db.insert(users).values({ displayName: name }).returning();
  return user.id;
}

async function connect(userId: string) {
  const client = await registerClient({ name: "Claude", redirectUris: [CALLBACK] });
  if (!client.ok) throw new Error("registration failed");
  const code = await createAuthorizationCode({ clientId: client.client.id, userId, redirectUri: CALLBACK, codeChallenge: CHALLENGE, scope: READ_SCOPE });
  const tokens = await exchangeCode({ code, clientId: client.client.id, redirectUri: CALLBACK, codeVerifier: VERIFIER });
  if (!tokens.ok) throw new Error("exchange failed");
}

const POT = { name: "Detty December", type: "TREASURY" as const, contributionAmount: Money.fromMajor(100, "USDC"), cadence: "MONTHLY" as const, dueDay: 1 };

describe("the user's AI connection", () => {
  it("is null until an AI app is approved", async () => {
    expect(await getAiConnection(await makeUser("Amaka"))).toBeNull();
  });

  it("shows the app's name once connected", async () => {
    const amaka = await makeUser("Amaka");
    await connect(amaka);
    expect(await getAiConnection(amaka)).toMatchObject({ appName: "Claude" });
  });

  it("is gone after Disconnect", async () => {
    const amaka = await makeUser("Amaka");
    await connect(amaka);
    await revokeAllForUser(amaka);
    expect(await getAiConnection(amaka)).toBeNull();
  });

  it("is someone else's business: one user's connection isn't another's", async () => {
    const amaka = await makeUser("Amaka");
    const tunde = await makeUser("Tunde");
    await connect(amaka);
    expect(await getAiConnection(tunde)).toBeNull();
  });
});

describe("keeping the AI out of one group", () => {
  it("is allowed by default, and can be switched off and back on", async () => {
    const amaka = await makeUser("Amaka");
    const { groupId } = await createGroup(amaka, POT);
    expect(await aiAllowedInGroup(amaka, groupId)).toBe(true);

    expect(await setAiInGroup(amaka, groupId, false)).toEqual({ ok: true });
    expect(await aiAllowedInGroup(amaka, groupId)).toBe(false);
    expect(await aiOptedOutGroups(amaka)).toEqual(new Set([groupId]));

    expect(await setAiInGroup(amaka, groupId, true)).toEqual({ ok: true });
    expect(await aiAllowedInGroup(amaka, groupId)).toBe(true);
  });

  it("switching off twice is harmless", async () => {
    const amaka = await makeUser("Amaka");
    const { groupId } = await createGroup(amaka, POT);
    await setAiInGroup(amaka, groupId, false);
    expect(await setAiInGroup(amaka, groupId, false)).toEqual({ ok: true });
  });

  it("only works for groups the user is in", async () => {
    const amaka = await makeUser("Amaka");
    const tunde = await makeUser("Tunde");
    const { groupId } = await createGroup(tunde, POT);
    expect(await setAiInGroup(amaka, groupId, false)).toEqual({ ok: false, reason: "not_member" });
  });
});
