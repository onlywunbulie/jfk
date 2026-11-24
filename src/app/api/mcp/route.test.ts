import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/lib/db/testing";

// The real MCP endpoint, end to end, against a real migrated Postgres: no
// token gets a 401 that points to sign-in; a real token sees the user's own
// groups and nobody else's.
const t: TestDb = await createTestDb();
vi.mock("@/lib/db", async () => ({ db: t.db }));
vi.mock("@/lib/env", () => ({ env: () => ({ APP_URL: "http://localhost:3000" }) }));
// Starting on Base talks to the chain; here it's a stand-in that records who asked.
const startGroupOnChain = vi.fn(async (groupId: string, userId: string) =>
  startResult(groupId, userId),
);
let startResult: (groupId: string, userId: string) => unknown = () => ({ ok: true, safeAddress: "0x2a7a348bccee61c5ef6c213efc0baa05841a5a70", txHash: "0xab" });
vi.mock("@/modules/groups/onchain", () => ({ startGroupOnChain: (groupId: string, userId: string) => startGroupOnChain(groupId, userId) }));

const { POST } = await import("./route");
const { registerClient, createAuthorizationCode, exchangeCode, READ_SCOPE, GRANTED_SCOPES } = await import("@/modules/agents/oauth");
const { listWaitingDrafts } = await import("@/modules/agents/drafts");
const { createGroup, previewInvite } = await import("@/modules/groups/service");
const { setAiInGroup } = await import("@/modules/agents/connection");
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

async function tokenFor(userId: string, scope: string = READ_SCOPE) {
  const client = await registerClient({ name: "Claude", redirectUris: [CALLBACK] });
  if (!client.ok) throw new Error("registration failed");
  const code = await createAuthorizationCode({
    clientId: client.client.id,
    userId,
    redirectUri: CALLBACK,
    codeChallenge: CHALLENGE,
    scope,
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

  it("accepts a request labelled with a protocol version newer than it knows (as Claude sends)", async () => {
    const token = await tokenFor(await makeUser("Amaka"));
    const response = await POST(
      new Request("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
          "mcp-protocol-version": "2026-07-28",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
    );
    expect(response.status).toBe(200);
  });

  it("lists the reading and drafting tools, marking which only read", async () => {
    const token = await tokenFor(await makeUser("Amaka"));
    const response = await call(token, "tools/list");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] } };
    const readOnly = body.result.tools.filter((tool) => tool.annotations?.readOnlyHint).map((tool) => tool.name).sort();
    const drafting = body.result.tools.filter((tool) => !tool.annotations?.readOnlyHint).map((tool) => tool.name).sort();
    expect(readOnly).toEqual(["get_group", "list_groups", "list_proposals"]);
    expect(drafting).toEqual([
      "cover_debt",
      "create_group",
      "delete_group",
      "draft_group_change",
      "draft_role_change",
      "draft_rule_change",
      "draft_spend",
      "invite_link",
      "pay_dues",
      "set_group_image",
      "set_up_auto_pay",
      "start_on_base",
      "stop_auto_pay",
      "upload_group_image",
    ]);
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
    expect(groups[0]).toMatchObject({ group_id: mine, name: "Detty December", kind: "rotating savings", each_pays: "$100.00 every month" });

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

  it("creates a group for the user and makes a working invite link for it", async () => {
    const amaka = await makeUser("Amaka");
    const token = await tokenFor(amaka, GRANTED_SCOPES);

    const created = await callTool(token, "create_group", {
      name: "Detty December",
      kind: "rotating_savings",
      amount: "100",
      how_often: "monthly",
      due_day: 1,
    });
    expect(created.isError).toBe(false);
    const groupId = created.data.group_id as string;
    expect(created.data.open_in_rallied).toBe(`http://localhost:3000/groups/${groupId}/about`);
    // Ready-to-say next steps, so the user can just answer "1" or "2".
    expect(created.data.suggested_next).toEqual(["Invite friends to Detty December", "Start Detty December on Base now (just me for now)"]);

    // It's a real group, in dollars, with the user as its starter.
    const listed = await callTool(token, "list_groups");
    expect(listed.data.groups).toEqual([
      expect.objectContaining({ group_id: groupId, kind: "rotating savings", your_role: "owner", each_pays: "$100.00 every month" }),
    ]);

    const invite = await callTool(token, "invite_link", { group_id: groupId, uses: 5 });
    expect(invite.isError).toBe(false);
    const code = String(invite.data.invite_link).split("/join/")[1];
    const preview = await previewInvite(code);
    expect(preview).toMatchObject({ groupId, groupName: "Detty December" });
  });

  it("creates a group that pays every 2 weeks, and says so when read back", async () => {
    const amaka = await makeUser("Amaka");
    const token = await tokenFor(amaka, GRANTED_SCOPES);
    const created = await callTool(token, "create_group", {
      name: "Fortnight",
      kind: "shared_pot",
      amount: "10",
      how_often: "every_2_weeks",
      due_day: 5,
    });
    expect(created.isError).toBe(false);
    const groupId = created.data.group_id as string;
    expect((await callTool(token, "list_groups")).data.groups).toEqual([expect.objectContaining({ each_pays: "$10.00 every 2 weeks" })]);
    expect((await callTool(token, "get_group", { group_id: groupId })).data).toMatchObject({ how_often: expect.stringContaining("every 2 weeks") });

    // A weekday is 1 to 7 for anything paid by the week.
    const bad = await callTool(token, "create_group", { name: "X", kind: "shared_pot", amount: "1", how_often: "every_3_weeks", due_day: 15 });
    expect(bad.isError).toBe(true);
  });

  it("won't create or invite on a read-only connection, or invite into a group the user isn't in", async () => {
    const amaka = await makeUser("Amaka");
    const tunde = await makeUser("Tunde");
    const readOnly = await tokenFor(amaka);
    const refused = await callTool(readOnly, "create_group", { name: "X", kind: "shared_pot", amount: "10", how_often: "monthly", due_day: 1 });
    expect(refused.isError).toBe(true);

    const { groupId: theirs } = await createGroup(tunde, {
      name: "Tunde's pot",
      type: "TREASURY",
      contributionAmount: Money.fromMajor(50, "USDC"),
      cadence: "MONTHLY",
      dueDay: 1,
    });
    const full = await tokenFor(amaka, GRANTED_SCOPES);
    expect((await callTool(full, "invite_link", { group_id: theirs })).isError).toBe(true);
  });

  it("starts the user's group on Base, and says plainly when it can't", async () => {
    const amaka = await makeUser("Amaka");
    const { groupId } = await createGroup(amaka, {
      name: "Test Run",
      type: "TREASURY",
      contributionAmount: Money.fromMajor(5, "USDC"),
      cadence: "MONTHLY",
      dueDay: 1,
    });

    // Not on a read-only connection.
    const readOnly = await tokenFor(amaka);
    expect((await callTool(readOnly, "start_on_base", { group_id: groupId })).isError).toBe(true);
    expect(startGroupOnChain).not.toHaveBeenCalled();

    const full = await tokenFor(amaka, GRANTED_SCOPES);
    const started = await callTool(full, "start_on_base", { group_id: groupId });
    expect(started.isError).toBe(false);
    expect(started.data).toMatchObject({ started: true, vault: "0x2a7a348bccee61c5ef6c213efc0baa05841a5a70" });
    expect(startGroupOnChain).toHaveBeenCalledWith(groupId, amaka);

    startResult = () => ({ ok: false, reason: "not_owner" });
    const refused = await callTool(full, "start_on_base", { group_id: groupId });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("Only the person who started");

    // A group the user kept their AI out of can't be started from the AI.
    startGroupOnChain.mockClear();
    await setAiInGroup(amaka, groupId, false);
    expect((await callTool(full, "start_on_base", { group_id: groupId })).isError).toBe(true);
    expect(startGroupOnChain).not.toHaveBeenCalled();
  });

  it("deletes a group that isn't on Base (its starter, confirmed), and points a group on Base to a closing vote", async () => {
    const amaka = await makeUser("Amaka");
    const token = await tokenFor(amaka, GRANTED_SCOPES);
    const { groupId } = await createGroup(amaka, {
      name: "Oops",
      type: "TREASURY",
      contributionAmount: Money.fromMajor(5, "USDC"),
      cadence: "MONTHLY",
      dueDay: 1,
    });
    // Not without the user's confirmation.
    expect((await callTool(token, "delete_group", { group_id: groupId })).isError).toBe(true);

    const closing = await callTool(token, "draft_group_change", { group_id: groupId, change: "close_group" });
    expect(closing.isError).toBe(true);
    expect(closing.text).toContain("delete");

    const deleted = await callTool(token, "delete_group", { group_id: groupId, confirmed: true });
    expect(deleted.isError).toBe(false);
    expect((await callTool(token, "list_groups")).data.groups).toEqual([]);
  });

  it("drafts only with the drafting permission, and a draft lands in Waiting", async () => {
    const amaka = await makeUser("Amaka");
    const { groupId } = await createGroup(amaka, {
      name: "Detty December",
      type: "TREASURY",
      contributionAmount: Money.fromMajor(100, "USDC"),
      cadence: "MONTHLY",
      dueDay: 1,
    });
    const args = { group_id: groupId, rule: "due_day", value: "5" };

    // An older, read-only connection is told to reconnect, and nothing is made.
    const readOnly = await tokenFor(amaka);
    const refused = await callTool(readOnly, "draft_rule_change", args);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("reconnect");
    expect(await listWaitingDrafts(amaka, groupId)).toEqual([]);

    // With drafting allowed, the draft is made and Claude gets a link to it.
    const full = await tokenFor(amaka, GRANTED_SCOPES);
    const made = await callTool(full, "draft_rule_change", args);
    expect(made.isError).toBe(false);
    expect(made.data.open_in_rallied).toBe(`http://localhost:3000/groups/${groupId}/edit-rules`);
    const waiting = await listWaitingDrafts(amaka, groupId, "RULE_CHANGE");
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ madeBy: "Claude", status: "WAITING" });
  });

  it("hides a group the user has kept their AI out of, as if it didn't exist", async () => {
    const amaka = await makeUser("Amaka");
    const pot = { type: "TREASURY" as const, contributionAmount: Money.fromMajor(50, "USDC"), cadence: "MONTHLY" as const, dueDay: 1 };
    const { groupId: visible } = await createGroup(amaka, { ...pot, name: "Detty December" });
    const { groupId: hidden } = await createGroup(amaka, { ...pot, name: "Family pot" });
    await setAiInGroup(amaka, hidden, false);

    const token = await tokenFor(amaka);
    const list = await callTool(token, "list_groups");
    const names = (list.data.groups as { group_id: string; name: string }[]).map((group) => group.group_id);
    expect(names).toEqual([visible]);
    expect((await callTool(token, "get_group", { group_id: hidden })).isError).toBe(true);
    expect((await callTool(token, "list_proposals", { group_id: hidden })).isError).toBe(true);
  });
});
