import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/lib/db/testing";

// The real MCP endpoint, end to end, against a real migrated Postgres: no
// token gets a 401 that points to sign-in; a real token sees the user's own
// groups and nobody else's.
const t: TestDb = await createTestDb();
vi.mock("@/lib/db", async () => ({ db: t.db }));
vi.mock("@/lib/env", () => ({ env: () => ({ APP_URL: "http://localhost:3000" }) }));

const { POST } = await import("./route");
const { registerClient, createAuthorizationCode, exchangeCode, READ_SCOPE } = await import("@/modules/agents/oauth");
const { createGroup } = await import("@/modules/groups/service");
const { users } = await import("@/lib/db/schema");
const { Money } = await import("@/lib/money");

const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "v".repeat(50);
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

async function tokenFor(userId: string) {
  const client = await registerClient({ name: "Claude", redirectUris: [CALLBACK] });
  if (!client.ok) throw new Error("registration failed");
  const code = await createAuthorizationCode({
    clientId: client.client.id,
    userId,
    redirectUri: CALLBACK,
    codeChallenge: CHALLENGE,
    scope: READ_SCOPE,
  });
  const tokens = await exchangeCode({ code, clientId: client.client.id, redirectUri: CALLBACK, codeVerifier: VERIFIER });
  if (!tokens.ok) throw new Error("exchange failed");
  return tokens.accessToken;
}

/** One JSON-RPC call to the endpoint, the way Claude makes it. */
async function call(token: string | null, method: string, params: unknown = {}) {
  return POST(
    new Request("http://localhost:3000/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
}

async function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
  const response = await call(token, "tools/call", { name, arguments: args });
  const body = (await response.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  const isError = body.result.isError ?? false;
  // A refusal is plain words for the AI to read; a result is JSON.
  const text = body.result.content[0].text;
  return { isError, text, data: isError ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

describe("/api/mcp", () => {
  it("answers 401 with a pointer to sign-in when there's no token", async () => {
    const response = await call(null, "tools/list");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      'resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource"',
    );
  });

  it("refuses a made-up token", async () => {
    const response = await call("rla_made-up", "tools/list");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("lists the read-only tools for a signed-in AI", async () => {
    const token = await tokenFor(await makeUser("Amaka"));
    const response = await call(token, "tools/list");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] } };
    expect(body.result.tools.map((tool) => tool.name).sort()).toEqual(["get_group", "list_groups", "list_proposals"]);
    expect(body.result.tools.every((tool) => tool.annotations?.readOnlyHint)).toBe(true);
  });

  it("shows the user's own groups, and nothing of anyone else's", async () => {
    const amaka = await makeUser("Amaka");
    const tunde = await makeUser("Tunde");
    const { groupId: mine } = await createGroup(amaka, {
      name: "Detty December",
      type: "ROTATING",
      contributionAmount: Money.fromMajor(100, "USDC"),
      cadence: "MONTHLY",
      dueDay: 1,
    });
    const { groupId: theirs } = await createGroup(tunde, {
      name: "Tunde's secret pot",
      type: "TREASURY",
      contributionAmount: Money.fromMajor(50, "USDC"),
      cadence: "WEEKLY",
      dueDay: 5,
    });

    const token = await tokenFor(amaka);

    const list = await callTool(token, "list_groups");
    const groups = list.data.groups as { group_id: string; name: string; kind: string; each_pays: string }[];
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ group_id: mine, name: "Detty December", kind: "rotating savings", each_pays: "USDC 100 every month" });

    const detail = await callTool(token, "get_group", { group_id: mine });
    expect(detail.isError).toBe(false);
    expect(detail.data).toMatchObject({ name: "Detty December", your_role: "owner" });

    // Someone else's group looks exactly like one that doesn't exist.
    const other = await callTool(token, "get_group", { group_id: theirs });
    expect(other.isError).toBe(true);
    expect(other.text).not.toContain("Tunde's secret pot");
    const proposals = await callTool(token, "list_proposals", { group_id: theirs });
    expect(proposals.isError).toBe(true);
  });
});
