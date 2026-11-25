import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeAbiParameters, getAddress, type Hex } from "viem";
import { createTestDb, type TestDb } from "@/lib/db/testing";

// Votes on Base, against a real database, with Base replaced by a stand-in
// holding one proposal whose state each test sets. Covers the guard rails:
// no second vote, no voting after the deadline, nothing carried out unless
// it passed, and a group that isn't on Base says so.
const t: TestDb = await createTestDb();
vi.mock("@/lib/db", async () => ({ db: t.db }));
vi.mock("server-only", () => ({}));

const NOW = () => BigInt(Math.floor(Date.now() / 1000));
const AMAKA_WALLET = "0x27c73a4bdc1ca98cafb44cf33ab8c681db2bd129";
const KEMI_WALLET = "0x4596a149ac1d950ba229b208445dcb51fc84182b";
const SAFE = getAddress("0x2a7a348bccee61c5ef6c213efc0baa05841a5a70");
const TX = `0x${"cd".repeat(32)}` as Hex;

const chain = {
  onV2: true,
  contribution: 5_000_000n,
  /** status: 1 open, 2 carried out. */
  proposal: {
    action: 4,
    status: 1,
    thresholdPermille: 667,
    quorumPct: 60,
    deadline: 0n,
    eligible: 2,
    yes: 0,
    no: 0,
    abstain: 0,
    proposer: getAddress(AMAKA_WALLET),
    payload: encodeAbiParameters([{ type: "uint256" }], [2_000_000n]) as Hex,
  },
  /** 0 undecided, 1 approved, 2 rejected. */
  decision: 0,
  /** wallet (lowercase) → 0 none, 1 yes, 2 no, 3 abstain. */
  votes: {} as Record<string, number>,
  eligible: true,
  executed: [] as unknown[],
  receiptStatus: "success" as "success" | "reverted",
  /** What debtOf answers, for a wallet being voted in. */
  debt: 0n,
};

function read({ functionName, args }: { functionName: string; args?: readonly unknown[] }) {
  switch (functionName) {
    case "isModuleEnabled":
      return chain.onV2;
    case "getGroup":
      return ["0x0", chain.contribution, 3 * 86400, 60, false, [500, 667, 500, 667, 750, 667, 750, 800, 750], 1n];
    case "getProposal":
      return chain.proposal;
    case "decision":
      return chain.decision;
    case "voteOf":
      return chain.votes[String(args?.[2]).toLowerCase()] ?? 0;
    case "eligibleVoter":
      return chain.eligible;
    case "debtOf":
      return chain.debt;
    default:
      throw new Error(`unexpected read ${functionName}`);
  }
}

vi.mock("@/lib/chain/client", () => ({
  publicClient: () => ({
    readContract: async (call: { functionName: string; args?: readonly unknown[] }) => read(call),
    multicall: async ({ contracts }: { contracts: { functionName: string; args?: readonly unknown[] }[] }) => contracts.map(read),
    waitForTransactionReceipt: async () => ({ status: chain.receiptStatus, logs: [] }),
  }),
}));
vi.mock("@/lib/chain/relayer", () => ({
  relayer: () => ({
    writeContract: async (call: unknown) => {
      chain.executed.push(call);
      return TX;
    },
  }),
}));

const { readChainVotes, prepareVote, carryOut } = await import("./onchain-votes");
const { createGroup } = await import("./service");
const { users, groups, groupMembers, groupSettings } = await import("@/lib/db/schema");
const { Money } = await import("@/lib/money");
const { jfkModuleAbi } = await import("@/lib/chain/abis");
const { eq } = await import("drizzle-orm");

beforeEach(async () => {
  await t.reset();
  chain.onV2 = true;
  chain.contribution = 5_000_000n;
  chain.proposal = { ...chain.proposal, status: 1, deadline: NOW() + 86_400n, yes: 0, no: 0 };
  chain.decision = 0;
  chain.votes = {};
  chain.eligible = true;
  chain.executed = [];
  chain.receiptStatus = "success";
  chain.debt = 0n;
});

afterAll(async () => {
  await t.close();
});

/** A $5-a-month USDC pot with Amaka (owner) and Kemi, on Base unless asked otherwise. */
async function setup(onBase = true) {
  const [amaka] = await t.db.insert(users).values({ displayName: "Amaka", walletAddress: AMAKA_WALLET }).returning();
  const [kemi] = await t.db.insert(users).values({ displayName: "Kemi", walletAddress: KEMI_WALLET }).returning();
  const { groupId } = await createGroup(amaka.id, {
    name: "Test Run",
    type: "TREASURY",
    contributionAmount: Money.fromMajor(5, "USDC"),
    cadence: "MONTHLY",
    dueDay: 1,
  });
  await t.db.insert(groupMembers).values({ groupId, userId: kemi.id, role: "MEMBER", status: "ACTIVE" });
  if (onBase) {
    await t.db.update(groups).set({ safeAddress: SAFE.toLowerCase(), currency: "USDC" }).where(eq(groups.id, groupId));
  }
  return { amaka: amaka.id, kemi: kemi.id, groupId };
}

describe("reading votes from Base", () => {
  it("shows an open change in plain words, with who voted and what's waiting for the viewer", async () => {
    const { amaka, groupId } = await setup();
    chain.votes = { [KEMI_WALLET]: 1 };
    chain.proposal = { ...chain.proposal, yes: 1 };

    const live = await readChainVotes(groupId, amaka);
    if (!live.ok) throw new Error(live.reason);
    expect(live.votes).toHaveLength(1);
    expect(live.votes[0]).toMatchObject({
      id: "1",
      kind: "RULE",
      title: "What everyone pays",
      need: "67%",
      eligible: 2,
      yes: ["Kemi"],
      no: [],
      proposedBy: "You",
      state: "OPEN",
      mine: null,
      canVote: true,
    });
    expect(live.votes[0].change?.before).toContain("5");
    expect(live.votes[0].change?.after).toContain("2");
  });

  it("a vote the viewer already cast offers no buttons (votes can't be changed)", async () => {
    const { amaka, groupId } = await setup();
    chain.votes = { [AMAKA_WALLET]: 1 };
    const live = await readChainVotes(groupId, amaka);
    if (!live.ok) throw new Error(live.reason);
    expect(live.votes[0]).toMatchObject({ mine: "YES", canVote: false, yes: ["You"] });
  });

  it("a carried-out vote is closed and says what it changed to", async () => {
    const { amaka, groupId } = await setup();
    chain.proposal = { ...chain.proposal, status: 2 };
    chain.decision = 1;
    const live = await readChainVotes(groupId, amaka);
    if (!live.ok) throw new Error(live.reason);
    expect(live.votes[0]).toMatchObject({ state: "DONE", canVote: false, change: null });
    expect(live.votes[0].detail).toContain("2");
  });

  it("a group that isn't on Base says so instead of showing votes", async () => {
    const { amaka, groupId } = await setup(false);
    expect(await readChainVotes(groupId, amaka)).toEqual({ ok: false, reason: "not_on_base" });
  });

  it("someone outside the group sees nothing", async () => {
    const { groupId } = await setup();
    const [stranger] = await t.db.insert(users).values({ displayName: "Tunde" }).returning();
    expect(await readChainVotes(groupId, stranger.id)).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("voting", () => {
  it("hands the member's wallet exactly vote(vault, id, YES)", async () => {
    const { amaka, groupId } = await setup();
    const prepared = await prepareVote(amaka, groupId, "1", "YES");
    if (!prepared.ok) throw new Error(prepared.reason);
    expect(prepared.wallet).toBe(getAddress(AMAKA_WALLET));
    const decoded = decodeFunctionData({ abi: jfkModuleAbi, data: prepared.call.data });
    expect(decoded.functionName).toBe("vote");
    expect(decoded.args).toEqual([SAFE, 1n, 1]);
  });

  it("refuses a second vote, a closed vote, a carried-out vote, and someone who joined after it opened", async () => {
    const { amaka, groupId } = await setup();

    chain.votes = { [AMAKA_WALLET]: 1 };
    expect(await prepareVote(amaka, groupId, "1", "NO")).toMatchObject({ ok: false, reason: expect.stringContaining("already voted") });
    chain.votes = {};

    chain.proposal = { ...chain.proposal, deadline: NOW() - 1n };
    expect(await prepareVote(amaka, groupId, "1", "YES")).toMatchObject({ ok: false, reason: expect.stringContaining("closed") });
    chain.proposal = { ...chain.proposal, deadline: NOW() + 86_400n };

    chain.proposal = { ...chain.proposal, status: 2 };
    expect(await prepareVote(amaka, groupId, "1", "YES")).toMatchObject({ ok: false, reason: expect.stringContaining("carried out") });
    chain.proposal = { ...chain.proposal, status: 1 };

    chain.eligible = false;
    expect(await prepareVote(amaka, groupId, "1", "YES")).toMatchObject({ ok: false, reason: expect.stringContaining("joined after") });
  });
});

describe("carrying out a vote", () => {
  it("does nothing unless the vote passed", async () => {
    const { amaka, groupId } = await setup();
    expect(await carryOut(amaka, groupId, "1")).toEqual({ ok: false, reason: "not_passed" });
    chain.decision = 2;
    expect(await carryOut(amaka, groupId, "1")).toEqual({ ok: false, reason: "not_passed" });
    expect(chain.executed).toEqual([]);
  });

  it("runs a passed vote on Base, and Rallied's copy of the contribution follows", async () => {
    const { amaka, groupId } = await setup();
    chain.decision = 1;
    expect(await carryOut(amaka, groupId, "1")).toEqual({ ok: true, txHash: TX });
    expect(chain.executed).toEqual([expect.objectContaining({ functionName: "execute", args: [SAFE, 1n] })]);

    const [settings] = await t.db.select().from(groupSettings).where(eq(groupSettings.groupId, groupId));
    expect(settings.contributionAmount).toBe(2_000_000n);
  });

  it("leaves Rallied's copy alone when Base rejects it", async () => {
    const { amaka, groupId } = await setup();
    chain.decision = 1;
    chain.receiptStatus = "reverted";
    expect(await carryOut(amaka, groupId, "1")).toEqual({ ok: false, reason: "failed" });
    const [settings] = await t.db.select().from(groupSettings).where(eq(groupSettings.groupId, groupId));
    expect(settings.contributionAmount).toBe(5_000_000n);
  });

  it("an already carried-out vote isn't run twice", async () => {
    const { amaka, groupId } = await setup();
    chain.proposal = { ...chain.proposal, status: 2 };
    chain.decision = 1;
    expect(await carryOut(amaka, groupId, "1")).toEqual({ ok: false, reason: "already_done" });
    expect(chain.executed).toEqual([]);
  });

  it("someone outside the group can't trigger it", async () => {
    const { groupId } = await setup();
    const [stranger] = await t.db.insert(users).values({ displayName: "Tunde" }).returning();
    chain.decision = 1;
    expect(await carryOut(stranger.id, groupId, "1")).toEqual({ ok: false, reason: "not_found" });
    expect(chain.executed).toEqual([]);
  });
});

describe("adding someone who owes elsewhere", () => {
  const TOLA_WALLET = "0x00000000000000000000000000000000000070a1";

  /** Tola, in another rotating group on Base; a vote here to add her. */
  async function voteToAddTola() {
    const ids = await setup();
    const [tola] = await t.db.insert(users).values({ displayName: "Tola", walletAddress: TOLA_WALLET }).returning();
    const { groupId: other } = await createGroup(tola.id, {
      name: "Lagos Ajo",
      type: "ROTATING",
      contributionAmount: Money.fromMajor(10, "USDC"),
      cadence: "WEEKLY",
      dueDay: 1,
    });
    await t.db.update(groups).set({ safeAddress: "0x00000000000000000000000000000000000000ff", currency: "USDC" }).where(eq(groups.id, other));
    chain.proposal = { ...chain.proposal, action: 1, payload: encodeAbiParameters([{ type: "address" }], [getAddress(TOLA_WALLET)]) as Hex };
    return ids;
  }

  it("says how much they owe, but not where", async () => {
    const { amaka, groupId } = await voteToAddTola();
    chain.debt = 20_000_000n;
    const live = await readChainVotes(groupId, amaka);
    if (!live.ok) throw new Error(live.reason);
    expect(live.votes[0].warning).toBe("Tola owes $20.00 in another Rallied group. Missed rounds there aren't paid back yet.");
    expect(live.votes[0].warning).not.toContain("Lagos Ajo");
  });

  it("says nothing when they owe nothing", async () => {
    const { amaka, groupId } = await voteToAddTola();
    const live = await readChainVotes(groupId, amaka);
    if (!live.ok) throw new Error(live.reason);
    expect(live.votes[0].warning).toBeNull();
  });
});
