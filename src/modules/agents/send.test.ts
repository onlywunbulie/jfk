import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeEventTopics, getAddress, type Hex } from "viem";
import { createTestDb, type TestDb } from "@/lib/db/testing";

// Sending a draft to a vote, against a real database, with Base replaced by
// a stand-in whose answers each test sets.
const t: TestDb = await createTestDb();
vi.mock("@/lib/db", async () => ({ db: t.db }));
vi.mock("server-only", () => ({}));

const chainState = {
  order: [] as string[],
  turn: 0,
  onV2: true,
  isOwner: true,
  receipt: null as null | { status: "success" | "reverted"; logs: { address: string; data: Hex; topics: Hex[] }[] },
};
vi.mock("@/lib/chain/client", () => ({
  publicClient: () => ({
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "isModuleEnabled") return chainState.onV2;
      if (functionName === "isOwner") return chainState.isOwner;
      if (functionName === "getGroup") return ["0x0", 0n, 3 * 86400, 60, false, [500, 667, 500, 667, 750, 667, 750, 800, 750], 0n];
      if (functionName === "getGroupSettings") return [false, 25 * 86400];
      // A rotating group on Base: Amaka has collected; Kemi still to collect.
      if (functionName === "getOrder") return [chainState.order, []];
      if (functionName === "getRotation") return [true, 1, 1, chainState.turn, 0n, 0, 0, 0n, 0n];
      throw new Error(`unexpected read ${functionName}`);
    },
    waitForTransactionReceipt: async () => chainState.receipt,
  }),
}));

const { prepareProposal, confirmProposal } = await import("./send");
const { draftSpend, draftRuleChange, draftRoleChange, draftGroupChange, listWaitingDrafts } = await import("@/modules/agents/drafts");
const { createGroup } = await import("@/modules/groups/service");
const { users, groups, groupMembers, agentDrafts } = await import("@/lib/db/schema");
const { Money } = await import("@/lib/money");
const { eq } = await import("drizzle-orm");
const { CONTRACTS } = await import("@/lib/chain/addresses");
const { jfkModuleAbi } = await import("@/lib/chain/abis");

const SAFE = getAddress("0x2a7a348bccee61c5ef6c213efc0baa05841a5a70");
const AMAKA_WALLET = "0x27c73a4bdc1ca98cafb44cf33ab8c681db2bd129";
const KEMI_WALLET = "0x4596a149ac1d950ba229b208445dcb51fc84182b";
const TX = `0x${"ab".repeat(32)}` as Hex;

beforeEach(async () => {
  await t.reset();
  Object.assign(chainState, { onV2: true, isOwner: true, receipt: null, order: [], turn: 0 });
});

afterAll(async () => {
  await t.close();
});

/** A shared-pot USDC group on Base with Amaka (owner) and Kemi. */
async function setup(onBase = true) {
  const [amaka] = await t.db.insert(users).values({ displayName: "Amaka", walletAddress: AMAKA_WALLET }).returning();
  const [kemi] = await t.db.insert(users).values({ displayName: "Kemi", walletAddress: KEMI_WALLET }).returning();
  const { groupId } = await createGroup(amaka.id, {
    name: "Detty December",
    type: "TREASURY",
    contributionAmount: Money.fromMajor(100, "USDC"),
    cadence: "MONTHLY",
    dueDay: 1,
  });
  await t.db.insert(groupMembers).values({ groupId, userId: kemi.id, role: "MEMBER", status: "ACTIVE" });
  if (onBase) {
    const { eq } = await import("drizzle-orm");
    await t.db.update(groups).set({ safeAddress: SAFE.toLowerCase(), currency: "USDC" }).where(eq(groups.id, groupId));
  }
  return { amaka: amaka.id, groupId };
}

const base = (userId: string, groupId: string) => ({ userId, groupId, madeBy: "Claude" });

function proposeArgs(data: Hex) {
  const decoded = decodeFunctionData({ abi: jfkModuleAbi, data });
  expect(decoded.functionName).toBe("propose");
  return decoded.args as unknown as [string, number, Hex];
}

describe("preparing a draft to send", () => {
  it("a spend to a member becomes propose(SPEND, their wallet, the exact amount)", async () => {
    const { amaka, groupId } = await setup();
    const made = await draftSpend({ ...base(amaka, groupId), what: "Airbnb", amount: "400", paidTo: "Kemi" });
    if (!made.ok) throw new Error(made.reason);

    const prepared = await prepareProposal(amaka, made.draft.id);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.call.to).toBe(CONTRACTS.jfkModule);
    const [safe, action, payload] = proposeArgs(prepared.call.data);
    expect(safe).toBe(SAFE);
    expect(action).toBe(0);
    const [recipient, amount] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], payload);
    expect(recipient).toBe(getAddress(KEMI_WALLET));
    expect(amount).toBe(400_000_000n);
  });

  it("what everyone pays becomes CHANGE_CONTRIBUTION with the exact new amount", async () => {
    const { amaka, groupId } = await setup();
    const made = await draftRuleChange({ ...base(amaka, groupId), rule: "what_everyone_pays", value: "150" });
    if (!made.ok) throw new Error(made.reason);
    const prepared = await prepareProposal(amaka, made.draft.id);
    if (!prepared.ok) throw new Error(prepared.reason);
    const [, action, payload] = proposeArgs(prepared.call.data);
    expect(action).toBe(4);
    expect(decodeAbiParameters([{ type: "uint256" }], payload)[0]).toBe(150_000_000n);
  });

  it("the share that must vote becomes CHANGE_RULES, keeping every other rule as it is on Base", async () => {
    const { amaka, groupId } = await setup();
    const made = await draftRuleChange({ ...base(amaka, groupId), rule: "votes_count_share", value: "75" });
    if (!made.ok) throw new Error(made.reason);
    const prepared = await prepareProposal(amaka, made.draft.id);
    if (!prepared.ok) throw new Error(prepared.reason);
    const [, action, payload] = proposeArgs(prepared.call.data);
    expect(action).toBe(5);
    const [thresholds, quorum, period, humanOnly] = decodeAbiParameters(
      [{ type: "uint16[9]" }, { type: "uint8" }, { type: "uint32" }, { type: "bool" }],
      payload,
    );
    expect(thresholds).toEqual([500, 667, 500, 667, 750, 667, 750, 800, 750]);
    expect([quorum, period, humanOnly]).toEqual([75, 3 * 86400, false]);
  });

  it("removing a member becomes REMOVE_MEMBER with their wallet", async () => {
    const { amaka, groupId } = await setup();
    const made = await draftRoleChange({ ...base(amaka, groupId), change: "remove_member", memberName: "Kemi" });
    if (!made.ok) throw new Error(made.reason);
    const prepared = await prepareProposal(amaka, made.draft.id);
    if (!prepared.ok) throw new Error(prepared.reason);
    const [, action, payload] = proposeArgs(prepared.call.data);
    expect(action).toBe(2);
    expect(decodeAbiParameters([{ type: "address" }], payload)[0]).toBe(getAddress(KEMI_WALLET));
  });

  it("says plainly when something can't go on Base: Rallied-only rules, no vault, v1, not an owner", async () => {
    const { amaka, groupId } = await setup();
    const admin = await draftRoleChange({ ...base(amaka, groupId), change: "make_admin", memberName: "Kemi" });
    const due = await draftRuleChange({ ...base(amaka, groupId), rule: "due_day", value: "5" });
    if (!admin.ok || !due.ok) throw new Error("drafting failed");
    expect(await prepareProposal(amaka, admin.draft.id)).toMatchObject({ ok: false, reason: expect.stringContaining("Admins") });
    expect(await prepareProposal(amaka, due.draft.id)).toMatchObject({ ok: false, reason: expect.stringContaining("due day") });

    const spend = await draftSpend({ ...base(amaka, groupId), what: "X", amount: "1", paidTo: "Kemi" });
    if (!spend.ok) throw new Error(spend.reason);
    chainState.onV2 = false;
    expect(await prepareProposal(amaka, spend.draft.id)).toMatchObject({ ok: false, reason: expect.stringContaining("first contract") });
    chainState.onV2 = true;
    chainState.isOwner = false;
    expect(await prepareProposal(amaka, spend.draft.id)).toMatchObject({ ok: false, reason: expect.stringContaining("isn't one of this group's owners") });
  });

  it("refuses a group that isn't on Base, and someone else's draft", async () => {
    const { amaka, groupId } = await setup(false);
    const made = await draftRuleChange({ ...base(amaka, groupId), rule: "what_everyone_pays", value: "150" });
    if (!made.ok) throw new Error(made.reason);
    expect(await prepareProposal(amaka, made.draft.id)).toMatchObject({ ok: false, reason: expect.stringContaining("isn't on Base") });

    const [kemi] = await t.db.select().from(users).where((await import("drizzle-orm")).eq(users.displayName, "Kemi"));
    expect(await prepareProposal(kemi.id, made.draft.id)).toMatchObject({ ok: false });
  });
});

describe("confirming it was sent", () => {
  function proposalOpenedLog(proposer: string, safe = SAFE) {
    const topics = encodeEventTopics({ abi: jfkModuleAbi, eventName: "ProposalOpened", args: { safe, id: 3n, proposer: getAddress(proposer) } });
    const data = encodeAbiParameters([{ type: "uint8" }, { type: "uint16" }, { type: "uint64" }], [0, 500, 1_800_000_000n]);
    return { address: CONTRACTS.jfkModule, data, topics: topics as Hex[] };
  }

  it("reads Base for the proposal by this member on this vault, then marks the draft sent", async () => {
    const { amaka, groupId } = await setup();
    const made = await draftSpend({ ...base(amaka, groupId), what: "Airbnb", amount: "400", paidTo: "Kemi" });
    if (!made.ok) throw new Error(made.reason);
    chainState.receipt = { status: "success", logs: [proposalOpenedLog(AMAKA_WALLET)] };

    expect(await confirmProposal(amaka, made.draft.id, TX)).toEqual({ ok: true, proposalId: "3", groupId: made.draft.groupId });
    expect(await listWaitingDrafts(amaka, groupId)).toEqual([]);
    const [row] = await t.db.select().from(agentDrafts);
    expect(row.status).toBe("SENT");
    expect(row.details).toMatchObject({ sent: { txHash: TX, proposalId: "3" } });
  });

  it("doesn't take the browser's word: a failed transaction, or someone else's proposal, isn't a send", async () => {
    const { amaka, groupId } = await setup();
    const made = await draftSpend({ ...base(amaka, groupId), what: "Airbnb", amount: "400", paidTo: "Kemi" });
    if (!made.ok) throw new Error(made.reason);

    chainState.receipt = { status: "reverted", logs: [] };
    expect(await confirmProposal(amaka, made.draft.id, TX)).toMatchObject({ ok: false });

    chainState.receipt = { status: "success", logs: [proposalOpenedLog(KEMI_WALLET)] };
    expect(await confirmProposal(amaka, made.draft.id, TX)).toMatchObject({ ok: false });

    expect(await listWaitingDrafts(amaka, groupId)).toHaveLength(1);
  });
});

describe("sending the proposals beyond spends", () => {
  const RULES = [{ type: "uint16[9]" }, { type: "uint8" }, { type: "uint32" }, { type: "bool" }] as const;

  it("closing the group becomes propose(CLOSE_GROUP) with nothing else", async () => {
    const { amaka, groupId } = await setup();
    const made = await draftGroupChange({ ...base(amaka, groupId), change: "close_group" });
    if (!made.ok) throw new Error(made.reason);
    const prepared = await prepareProposal(amaka, made.draft.id);
    if (!prepared.ok) throw new Error(prepared.reason);
    const [, action, payload] = proposeArgs(prepared.call.data);
    expect([action, payload]).toEqual([6, "0x"]);
  });

  it("adding someone becomes propose(ADD_MEMBER, their wallet)", async () => {
    const { amaka, groupId } = await setup();
    const made = await draftRoleChange({ ...base(amaka, groupId), change: "add_member", memberName: "Tunde", wallet: "0x1111111111111111111111111111111111111111" });
    if (!made.ok) throw new Error(made.reason);
    const prepared = await prepareProposal(amaka, made.draft.id);
    if (!prepared.ok) throw new Error(prepared.reason);
    const [, action, payload] = proposeArgs(prepared.call.data);
    expect(action).toBe(1);
    expect(decodeAbiParameters([{ type: "address" }], payload)[0]).toBe(getAddress("0x1111111111111111111111111111111111111111"));
  });

  it("a lost wallet becomes propose(REPLACE_MEMBER, old wallet, new wallet)", async () => {
    const { amaka, groupId } = await setup();
    const made = await draftRoleChange({ ...base(amaka, groupId), change: "replace_wallet", memberName: "Kemi", wallet: "0x2222222222222222222222222222222222222222" });
    if (!made.ok) throw new Error(made.reason);
    const prepared = await prepareProposal(amaka, made.draft.id);
    if (!prepared.ok) throw new Error(prepared.reason);
    const [, action, payload] = proposeArgs(prepared.call.data);
    expect(action).toBe(3);
    expect(decodeAbiParameters([{ type: "address" }, { type: "address" }], payload)).toEqual([
      getAddress(KEMI_WALLET),
      getAddress("0x2222222222222222222222222222222222222222"),
    ]);
  });

  it("a decision's share changes only that slot (both for the rules, which also guard moving contracts); vote days change only the period", async () => {
    const { amaka, groupId } = await setup();
    const share = await draftRuleChange({ ...base(amaka, groupId), rule: "share_needed", decision: "changing_the_rules", value: "90" });
    if (!share.ok) throw new Error(share.reason);
    const p1 = await prepareProposal(amaka, share.draft.id);
    if (!p1.ok) throw new Error(p1.reason);
    const [thresholds, quorum, period] = decodeAbiParameters(RULES, proposeArgs(p1.call.data)[2]);
    expect([...thresholds]).toEqual([500, 667, 500, 667, 750, 667, 900, 800, 900]);
    expect([quorum, period]).toEqual([60, 3 * 86400]);

    const days = await draftRuleChange({ ...base(amaka, groupId), rule: "vote_days", value: "7" });
    if (!days.ok) throw new Error(days.reason);
    const p2 = await prepareProposal(amaka, days.draft.id);
    if (!p2.ok) throw new Error(p2.reason);
    const [unchanged, , newPeriod] = decodeAbiParameters(RULES, proposeArgs(p2.call.data)[2]);
    expect([...unchanged]).toEqual([500, 667, 500, 667, 750, 667, 750, 800, 750]);
    expect(newPeriod).toBe(7 * 86400);
  });
});

describe("sending a new payout order", () => {
  /** A waiting order draft: Kemi, then Amaka, both still to collect. */
  async function orderDraft() {
    const { amaka, groupId } = await setup();
    const members = await t.db.select().from(groupMembers).where(eq(groupMembers.groupId, groupId));
    const memberOf = async (wallet: string) => {
      const [user] = await t.db.select().from(users).where(eq(users.walletAddress, wallet));
      return members.find((m) => m.userId === user.id)!.id;
    };
    const [draft] = await t.db
      .insert(agentDrafts)
      .values({
        userId: amaka,
        groupId,
        kind: "GROUP_CHANGE",
        madeBy: "Claude",
        details: {
          change: "change_order",
          label: "Change the payout order",
          detail: "",
          order: [
            { memberId: await memberOf(KEMI_WALLET), name: "Kemi" },
            { memberId: await memberOf(AMAKA_WALLET), name: "Amaka" },
          ],
        },
      })
      .returning();
    return { amaka, draftId: draft.id };
  }

  it("becomes propose(CHANGE_ORDER) with their wallets, in the new order", async () => {
    const { amaka, draftId } = await orderDraft();
    chainState.order = [AMAKA_WALLET, KEMI_WALLET];
    chainState.turn = 0;
    const prepared = await prepareProposal(amaka, draftId);
    if (!prepared.ok) throw new Error(prepared.reason);
    const [safe, action, payload] = proposeArgs(prepared.call.data);
    expect(safe).toBe(SAFE);
    expect(action).toBe(8);
    expect(decodeAbiParameters([{ type: "address[]" }], payload)[0]).toEqual([getAddress(KEMI_WALLET), getAddress(AMAKA_WALLET)]);
  });

  it("refuses once who's still to collect has changed on Base", async () => {
    const { amaka, draftId } = await orderDraft();
    // Amaka has since collected: only Kemi is still to collect.
    chainState.order = [AMAKA_WALLET, KEMI_WALLET];
    chainState.turn = 1;
    expect(await prepareProposal(amaka, draftId)).toMatchObject({ ok: false, reason: expect.stringContaining("has changed on Base") });
  });
});
