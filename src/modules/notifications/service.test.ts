import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/lib/db/testing";

const t: TestDb = await createTestDb();
vi.mock("@/lib/db", async () => ({ db: t.db }));
vi.mock("server-only", () => ({}));

/**
 * What Base says, per test. The readers are replaced, not the chain client:
 * these tests are about which notices come out and how often, not decoding.
 */
const chain = {
  type: "TREASURY" as "TREASURY" | "ROTATING",
  votes: [] as Record<string, unknown>[],
  dues: { ok: false } as Record<string, unknown>,
  autopayOn: false,
  rotation: { ok: false } as Record<string, unknown>,
};
const pushed: { endpoint: string; title: string }[] = [];
let pushOutcome: "sent" | "gone" = "sent";

vi.mock("@/modules/groups/service", () => ({
  getGroupDetail: async (groupId: string) => ({ id: groupId, name: "Ajo Test", type: chain.type, safeAddress: "0xsafe" }),
  listMembers: async () => [],
  listGroupsForUser: async () => [{ id: GROUP, safeAddress: "0xsafe" }],
  listGroupsOnBaseWithMembers: async (only?: string) => [{ groupId: only ?? GROUP, userIds: [ADA, BAYO] }],
}));
vi.mock("@/modules/groups/onchain-votes", () => ({
  readChainVotes: async (_group: string, userId: string) => ({
    ok: true,
    votes: chain.votes.map((vote) => ({ ...vote, proposedBy: vote.proposer === userId ? "You" : "Ada" })),
  }),
}));
vi.mock("@/modules/groups/onchain-dues", () => ({ readDues: async () => chain.dues }));
vi.mock("@/modules/groups/onchain-autopay", () => ({
  autopayStatus: async () => (chain.autopayOn ? { on: true } : { on: false, why: "never_set_up" }),
}));
vi.mock("@/modules/groups/onchain-rotation", () => ({ readRotation: async () => chain.rotation }));
vi.mock("@/modules/notifications/push", () => ({
  sendPush: async (device: { endpoint: string }, message: { title: string }) => {
    pushed.push({ endpoint: device.endpoint, title: message.title });
    return pushOutcome;
  },
}));

const { users, groups, notifications, pushSubscriptions } = await import("@/lib/db/schema");
const { checkGroup, checkUser, listNotifications, markAllRead, saveDevice } = await import("@/modules/notifications/service");

const [ada] = await t.db.insert(users).values({ displayName: "Ada" }).returning();
const [bayo] = await t.db.insert(users).values({ displayName: "Bayo" }).returning();
const ADA = ada.id;
const BAYO = bayo.id;
const [group] = await t.db.insert(groups).values({ name: "Ajo Test", ownerId: ADA, safeAddress: "0xsafe" }).returning();
const GROUP = group.id;

const NOW = new Date("2026-11-25T07:00:00Z");
const inDays = (days: number) => new Date(NOW.getTime() + days * 86_400_000).toISOString();

function vote(overrides: Record<string, unknown> = {}) {
  return {
    id: "7",
    title: "Spend $40.00",
    closes: "Fri 28 Nov",
    deadline: inDays(3),
    state: "OPEN",
    canVote: true,
    proposer: ADA,
    yes: [],
    no: [],
    ...overrides,
  };
}

beforeEach(async () => {
  await t.db.delete(notifications);
  await t.db.delete(pushSubscriptions);
  Object.assign(chain, { type: "TREASURY", votes: [], dues: { ok: false }, autopayOn: false, rotation: { ok: false } });
  pushed.length = 0;
  pushOutcome = "sent";
});

afterAll(async () => {
  await t.close();
});

const titles = async (userId: string) => (await listNotifications(userId)).map((row) => row.title);

describe("checking a group", () => {
  it("tells everyone but the proposer about a new vote, once", async () => {
    chain.votes = [vote()];
    await checkGroup(GROUP, NOW);
    await checkGroup(GROUP, NOW);

    expect(await titles(BAYO)).toEqual(["New vote in Ajo Test"]);
    expect(await titles(ADA)).toEqual([]);
  });

  it("reminds on the last day only those who haven't voted", async () => {
    chain.votes = [vote({ deadline: inDays(0.5), proposer: "someone else" })];
    await checkGroup(GROUP, NOW);
    expect(await titles(BAYO)).toContain("Last day to vote in Ajo Test");

    await t.db.delete(notifications);
    chain.votes = [vote({ deadline: inDays(0.5), canVote: false, proposer: "someone else" })];
    await checkGroup(GROUP, NOW);
    expect(await titles(BAYO)).toEqual([]);
  });

  it("reports a result while it's fresh, and not old ones", async () => {
    chain.votes = [
      vote({ id: "8", state: "DONE", canVote: false, deadline: inDays(-1), yes: ["Ada", "Bayo"] }),
      vote({ id: "3", state: "FAILED", canVote: false, deadline: inDays(-10) }),
    ];
    await checkGroup(GROUP, NOW);
    const rows = await listNotifications(BAYO);
    expect(rows.map((row) => [row.title, row.body])).toEqual([["Passed in Ajo Test", "Spend $40.00: 2 yes, 0 no."]]);
  });

  it("reminds about dues by hand, but not with automatic dues on", async () => {
    chain.dues = { ok: true, contribution: "$10.00", you: { paidThisPeriod: null, canPay: true }, members: [{ isYou: true, paidIn: "$20.00" }] };
    await checkGroup(GROUP, NOW);
    expect(await titles(BAYO)).toEqual(["Your Ajo Test dues are due"]);

    await t.db.delete(notifications);
    chain.autopayOn = true;
    await checkGroup(GROUP, NOW);
    expect(await titles(BAYO)).toEqual([]);
  });

  it("tells the member whose turn was paid, and who owes", async () => {
    chain.type = "ROTATING";
    chain.rotation = {
      ok: true,
      cycle: 1,
      lastPayout: { userId: BAYO, round: 1, paid: 30_000_000n, at: new Date(NOW.getTime() - 3_600_000) },
      order: [
        { userId: ADA, debt: 10_000_000n },
        { userId: BAYO, debt: 0n },
      ],
      joining: [],
    };
    await checkGroup(GROUP, NOW);
    expect(await titles(BAYO)).toEqual(["You collected $30.00"]);
    expect(await titles(ADA)).toEqual(["You owe $10.00 in Ajo Test"]);
  });
});

describe("alerts", () => {
  it("sends new notices to each of the member's devices, and only new ones", async () => {
    await saveDevice(BAYO, { endpoint: "https://push.example/phone", p256dh: "k", auth: "a" });
    await saveDevice(BAYO, { endpoint: "https://push.example/laptop", p256dh: "k", auth: "a" });
    chain.votes = [vote()];

    const first = await checkGroup(GROUP, NOW);
    const second = await checkGroup(GROUP, NOW);

    expect(first.pushed).toBe(2);
    expect(second.pushed).toBe(0);
    expect(pushed.map((p) => p.endpoint).sort()).toEqual(["https://push.example/laptop", "https://push.example/phone"]);
    const [row] = await listNotifications(BAYO);
    expect(row.pushedAt).not.toBeNull();
  });

  it("forgets a device its browser has dropped", async () => {
    await saveDevice(BAYO, { endpoint: "https://push.example/gone", p256dh: "k", auth: "a" });
    pushOutcome = "gone";
    chain.votes = [vote()];
    await checkGroup(GROUP, NOW);
    expect(await t.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, BAYO))).toEqual([]);
  });

  it("moves a browser to whoever subscribed on it last", async () => {
    await saveDevice(ADA, { endpoint: "https://push.example/shared", p256dh: "k", auth: "a" });
    await saveDevice(BAYO, { endpoint: "https://push.example/shared", p256dh: "k2", auth: "a2" });
    const rows = await t.db.select().from(pushSubscriptions);
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(BAYO);
  });
});

describe("the bell and Claude", () => {
  it("marks everything read once opened", async () => {
    chain.votes = [vote()];
    await checkGroup(GROUP, NOW);
    await markAllRead(BAYO, NOW);
    expect((await listNotifications(BAYO)).every((row) => row.readAt !== null)).toBe(true);
  });

  it("checkUser returns what applies now, even if it was already recorded", async () => {
    chain.votes = [vote()];
    await checkGroup(GROUP, NOW);
    const run = await checkUser(BAYO, NOW);
    expect(run.created).toBe(0);
    expect(run.current.map((notice) => notice.key)).toEqual([`vote-opened:${GROUP}:7`]);
  });
});
