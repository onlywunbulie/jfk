import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAddress, numberToHex, type Hex } from "viem";
import { createTestDb, type TestDb } from "@/lib/db/testing";

// A group's money history, against a real database, with the history API
// and Base replaced by stand-ins. Checks each payment out is counted once and
// says why it happened.
const t: TestDb = await createTestDb();
vi.mock("@/lib/db", async () => ({ db: t.db }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/chain/client", () => ({
  publicClient: () => ({
    // The only single read: which contract runs the vault (Rallied's current one).
    readContract: async () => true,
    multicall: async ({ contracts }: { contracts: unknown[] }) => contracts.map(() => ({ yes: 2, eligible: 3 })),
  }),
}));

const AMAKA = "0x27c73a4bdc1ca98cafb44cf33ab8c681db2bd129";
const KEMI = "0x4596a149ac1d950ba229b208445dcb51fc84182b";
const OUTSIDER = "0x1111111111111111111111111111111111111111";
const SAFE = getAddress("0x2a7a348bccee61c5ef6c213efc0baa05841a5a70");

const { jfkMoneyEventsAbi } = await import("@/lib/chain/abis");
type EventName = (typeof jfkMoneyEventsAbi)[number]["name"];

let logs: unknown[] = [];
let failFetch = false;
vi.stubGlobal(
  "fetch",
  vi.fn(async () => {
    if (failFetch) throw new Error("offline");
    return Response.json({ message: "OK", result: logs });
  }),
);

/** One raw log as the history API returns it: unused topics are null. */
function log(tx: number, index: number, name: EventName, args: Record<string, unknown>, data: Hex = "0x") {
  const topics = encodeEventTopics({ abi: jfkMoneyEventsAbi, eventName: name, args } as never) as Hex[];
  return {
    data,
    topics: [...topics, ...Array(4 - topics.length).fill(null)],
    timeStamp: numberToHex(1_763_388_000 + tx * 60),
    transactionHash: `0x${tx.toString(16).padStart(64, "0")}`,
    logIndex: numberToHex(index),
  };
}
const amount = (minor: bigint) => encodeAbiParameters([{ type: "uint256" }], [minor]);

const { readHistory } = await import("./onchain-history");
const { createGroup } = await import("./service");
const { users, groups, groupMembers } = await import("@/lib/db/schema");
const { Money } = await import("@/lib/money");
const { eq } = await import("drizzle-orm");

beforeEach(async () => {
  await t.reset();
  logs = [];
  failFetch = false;
});

afterAll(async () => {
  await t.close();
});

async function setup(onBase = true) {
  const [amaka] = await t.db.insert(users).values({ displayName: "Amaka", walletAddress: AMAKA }).returning();
  const [kemi] = await t.db.insert(users).values({ displayName: "Kemi", walletAddress: KEMI }).returning();
  const { groupId } = await createGroup(amaka.id, {
    name: "Test Run",
    type: "TREASURY",
    contributionAmount: Money.fromMajor(2, "USDC"),
    cadence: "MONTHLY",
    dueDay: 1,
  });
  await t.db.insert(groupMembers).values({ groupId, userId: kemi.id, role: "MEMBER", status: "ACTIVE" });
  if (onBase) await t.db.update(groups).set({ safeAddress: SAFE.toLowerCase(), currency: "USDC" }).where(eq(groups.id, groupId));
  return { amaka: amaka.id, groupId };
}

describe("a group's money history from Base", () => {
  it("names who paid in, marks the user's own rows, and says how a spend was approved", async () => {
    const { amaka, groupId } = await setup();
    logs = [
      log(1, 0, "Contributed", { safe: SAFE, member: AMAKA }, amount(2_000_000n)),
      log(2, 0, "Contributed", { safe: SAFE, member: KEMI }, amount(2_000_000n)),
      // A voted spend: Paid and ProposalExecuted in the same transaction.
      log(3, 0, "Paid", { safe: SAFE, recipient: OUTSIDER }, amount(1_500_000n)),
      log(3, 1, "ProposalExecuted", { safe: SAFE, id: 4n }, encodeAbiParameters([{ type: "uint8" }], [0])),
    ];
    const history = await readHistory(groupId, amaka);
    if (!history.ok) throw new Error(history.reason);
    expect(history.entries.map((e) => [e.what, e.inflow, e.mine])).toEqual([
      ["You paid in", true, true],
      ["Kemi paid in", true, false],
      ["Paid to 0x1111…1111", false, false],
    ]);
    expect(history.entries[2].approved).toBe("2 of 3 voted yes");
    expect(history.entries[2].amount).toContain("1.50");
  });

  it("counts a refund once, as a refund, not as a spend plus a removal", async () => {
    const { amaka, groupId } = await setup();
    logs = [
      log(5, 0, "Paid", { safe: SAFE, recipient: KEMI }, amount(4_000_000n)),
      log(5, 1, "MemberRemoved", { safe: SAFE, member: KEMI }, amount(4_000_000n)),
      log(5, 2, "ProposalExecuted", { safe: SAFE, id: 2n }, encodeAbiParameters([{ type: "uint8" }], [2])),
    ];
    const history = await readHistory(groupId, amaka);
    if (!history.ok) throw new Error(history.reason);
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]).toMatchObject({ what: "Refund to Kemi, removed by vote", inflow: false });
  });

  it("a closing share-out is one row per member, each saying why", async () => {
    const { amaka, groupId } = await setup();
    logs = [
      log(6, 0, "Paid", { safe: SAFE, recipient: AMAKA }, amount(3_000_000n)),
      log(6, 1, "Paid", { safe: SAFE, recipient: KEMI }, amount(3_000_000n)),
      log(6, 2, "GroupClosed", { safe: SAFE }, amount(6_000_000n)),
    ];
    const history = await readHistory(groupId, amaka);
    if (!history.ok) throw new Error(history.reason);
    expect(history.entries.map((e) => e.what)).toEqual(["Your share, group closed", "Kemi's share, group closed"]);
  });

  it("a vault with no history yet is an empty list, not an error", async () => {
    const { amaka, groupId } = await setup();
    logs = [];
    expect(await readHistory(groupId, amaka)).toEqual({ ok: true, entries: [] });
  });

  it("says so when the history can't be reached, and when the group isn't on Base", async () => {
    const { amaka, groupId } = await setup();
    failFetch = true;
    expect(await readHistory(groupId, amaka)).toEqual({ ok: false, reason: "unreachable" });

    await t.db.update(groups).set({ safeAddress: null }).where(eq(groups.id, groupId));
    expect(await readHistory(groupId, amaka)).toEqual({ ok: false, reason: "not_on_base" });
  });
});
