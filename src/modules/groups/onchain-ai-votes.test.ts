import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, getAddress } from "viem";
import { createTestDb, type TestDb } from "@/lib/db/testing";

const t: TestDb = await createTestDb();
vi.mock("@/lib/db", async () => ({ db: t.db }));
vi.mock("server-only", () => ({}));

const SAFE = "0x1111111111111111111111111111111111111111";
const MODULE = "0x48bB48799153c1a420B8476EaC663C396E291655";
const RALLIED = "0x2222222222222222222222222222222222222222";
const ADE = "0x00000000000000000000000000000000000000a1";
const FAR_FUTURE = 9_999_999_999n;

/** What the fake chain says. */
const chain = {
  helper: { key: "0x0000000000000000000000000000000000000000", powers: 0, expiresAt: 0n },
  proposal: { status: 1, deadline: FAR_FUTURE },
  eligible: true,
  already: 0,
  humanOnly: false,
  sent: [] as { functionName: string; args: readonly unknown[] }[],
};

vi.mock("@/lib/chain/module", () => ({ moduleFor: async () => ({ address: MODULE, version: 3 }) }));
vi.mock("@/lib/chain/relayer", () => ({
  relayer: () => ({
    account: { address: RALLIED },
    writeContract: async (call: { functionName: string; args: readonly unknown[] }) => {
      chain.sent.push(call);
      return "0xabc";
    },
  }),
}));
vi.mock("@/lib/chain/client", () => ({
  publicClient: () => ({
    readContract: async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case "getHelper":
          return chain.helper;
        case "isOwner":
          return true;
        case "getProposal":
          return chain.proposal;
        case "eligibleVoter":
          return chain.eligible;
        case "voteOf":
          return chain.already;
        case "getGroupSettings":
          return [chain.humanOnly, 25 * 86400];
        default:
          throw new Error(`unexpected read ${functionName}`);
      }
    },
    waitForTransactionReceipt: async () => ({ status: "success" }),
  }),
}));

const { prepareAiVotes, castVoteForUser } = await import("@/modules/groups/onchain-ai-votes");
const { jfkHelperAbi } = await import("@/lib/chain/abis");
const { createGroup } = await import("@/modules/groups/service");
const { users, groups } = await import("@/lib/db/schema");
const { Money } = await import("@/lib/money");
const { eq } = await import("drizzle-orm");

beforeEach(async () => {
  await t.reset();
  Object.assign(chain, {
    helper: { key: "0x0000000000000000000000000000000000000000", powers: 0, expiresAt: 0n },
    proposal: { status: 1, deadline: FAR_FUTURE },
    eligible: true,
    already: 0,
    humanOnly: false,
    sent: [],
  });
});
afterAll(async () => {
  await t.close();
});

async function groupOnBase() {
  const [ade] = await t.db.insert(users).values({ displayName: "Ade", walletAddress: ADE }).returning();
  const { groupId } = await createGroup(ade.id, {
    name: "Ajo",
    type: "ROTATING",
    contributionAmount: Money.fromMajor(100, "USDC"),
    cadence: "MONTHLY",
    dueDay: 1,
  });
  await t.db.update(groups).set({ safeAddress: SAFE, currency: "USDC" }).where(eq(groups.id, groupId));
  return { ade: ade.id, groupId };
}

const decoded = (data: `0x${string}`) => decodeFunctionData({ abi: jfkHelperAbi, data });

describe("letting the AI vote", () => {
  it("adds the vote power and keeps automatic dues (collect)", async () => {
    const { ade, groupId } = await groupOnBase();
    chain.helper = { key: RALLIED, powers: 4, expiresAt: FAR_FUTURE };
    const prepared = await prepareAiVotes(ade, groupId, "allow");
    if (!prepared.ok) throw new Error(prepared.reason);
    const call = decoded(prepared.calls[0].data);
    expect(call.functionName).toBe("setHelper");
    expect(call.args?.[2]).toBe(4 | 2); // collect and vote
    expect(call.args?.[3]).toBe(FAR_FUTURE); // never shorter than what's there
  });

  it("stopping it keeps automatic dues, or takes the helper away if voting was all it did", async () => {
    const { ade, groupId } = await groupOnBase();
    chain.helper = { key: RALLIED, powers: 6, expiresAt: FAR_FUTURE };
    let prepared = await prepareAiVotes(ade, groupId, "remove");
    if (!prepared.ok) throw new Error(prepared.reason);
    expect(decoded(prepared.calls[0].data)).toMatchObject({ functionName: "setHelper", args: [getAddress(SAFE), RALLIED, 4, FAR_FUTURE] });

    chain.helper = { key: RALLIED, powers: 2, expiresAt: FAR_FUTURE };
    prepared = await prepareAiVotes(ade, groupId, "remove");
    if (!prepared.ok) throw new Error(prepared.reason);
    expect(decoded(prepared.calls[0].data).functionName).toBe("revokeHelper");
  });
});

describe("voting through the AI", () => {
  it("says how to allow it when the AI has no vote permission, and casts nothing", async () => {
    const { ade, groupId } = await groupOnBase();
    expect(await castVoteForUser(ade, groupId, "3", "yes")).toMatchObject({ ok: false, allowAt: "allow" });
    expect(chain.sent).toEqual([]);
  });

  it("casts the user's own vote through Rallied's key", async () => {
    const { ade, groupId } = await groupOnBase();
    chain.helper = { key: RALLIED, powers: 2, expiresAt: FAR_FUTURE };
    expect(await castVoteForUser(ade, groupId, "3", "no")).toMatchObject({ ok: true });
    expect(chain.sent).toEqual([expect.objectContaining({ functionName: "voteFor", args: [getAddress(SAFE), getAddress(ADE), 3n, 2] })]);
  });

  it("refuses a vote that's closed, already cast or not theirs", async () => {
    const { ade, groupId } = await groupOnBase();
    chain.helper = { key: RALLIED, powers: 2, expiresAt: FAR_FUTURE };
    chain.already = 1;
    expect(await castVoteForUser(ade, groupId, "3", "yes")).toMatchObject({ ok: false, reason: expect.stringContaining("already voted") });
    chain.already = 0;
    chain.eligible = false;
    expect(await castVoteForUser(ade, groupId, "3", "yes")).toMatchObject({ ok: false, reason: expect.stringContaining("isn't yours") });
    chain.eligible = true;
    chain.proposal = { status: 1, deadline: 1n };
    expect(await castVoteForUser(ade, groupId, "3", "yes")).toMatchObject({ ok: false, reason: expect.stringContaining("closed") });
    expect(chain.sent).toEqual([]);
  });
});
