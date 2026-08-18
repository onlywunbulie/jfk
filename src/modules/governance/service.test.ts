import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/lib/db/testing";
import { Money } from "@/lib/money";
import { ForbiddenError } from "@/lib/auth/policy";

const t: TestDb = await createTestDb();
vi.mock("@/lib/db", async () => ({ db: t.db }));

const governance = await import("./service");
const groupsService = await import("@/modules/groups/service");
const ledger = await import("@/modules/ledger/service");
const { simulateContribution } = await import("@/modules/payments/simulate");
const { reconcileLedger } = await import("@/modules/ledger/reconcile");
const { users, proposals, votes, groupSettings } = await import(
  "@/lib/db/schema"
);

/** Four friends, ₦50,000 each, ₦200,000 in the treasury. */
async function seedFundedGroup() {
  const ids: string[] = [];
  for (const name of ["geoffrey", "chuka", "tunde", "amaka"]) {
    const [user] = await t.db
      .insert(users)
      .values({ email: `${name}@jfk.test`, displayName: name })
      .returning({ id: users.id });
    ids.push(user.id);
  }

  const { groupId } = await groupsService.createGroup(ids[0], {
    name: "JFK Empire",
    type: "TREASURY",
    contributionAmount: Money.fromMajor(50_000),
    cadence: "MONTHLY",
    dueDay: 1,
  });

  const invite = await groupsService.createInvite(groupId, ids[0], { maxUses: 5 });
  if (!invite.ok) throw new Error("invite failed");
  for (const id of ids.slice(1)) await groupsService.acceptInvite(invite.code, id);

  for (const id of ids) await simulateContribution({ groupId, userId: id });

  return { groupId, ids };
}

beforeEach(async () => {
  await t.reset();
});

afterAll(async () => {
  await t.close();
});

// ---------------------------------------------------------------------------

describe("creating a proposal", () => {
  it("opens a vote and snapshots the rules", async () => {
    const { groupId, ids } = await seedFundedGroup();

    const result = await governance.createProposal(ids[0], {
      groupId,
      title: "Buy a generator",
      reason: "The office keeps losing power",
      amount: Money.fromMajor(120_000),
      destination: "Chuka's supplier",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const view = await governance.getProposal(result.proposalId, ids[0]);
    expect(view).toMatchObject({
      title: "Buy a generator",
      status: "OPEN",
      eligibleVoterCount: 4,
      createdByName: "geoffrey",
    });
    expect(view!.amount!.format()).toBe("₦120,000.00");
  });

  it("picks the higher threshold for a large withdrawal", async () => {
    const { groupId, ids } = await seedFundedGroup();

    // ₦120,000 of ₦200,000 is 60% — well over the 20% "large" line.
    const large = await governance.createProposal(ids[0], {
      groupId,
      title: "Big spend",
      reason: "...",
      amount: Money.fromMajor(120_000),
    });
    // ₦20,000 is 10% — routine.
    const small = await governance.createProposal(ids[0], {
      groupId,
      title: "Small spend",
      reason: "...",
      amount: Money.fromMajor(20_000),
    });

    expect(large).toMatchObject({ ok: true, action: "FUND_RELEASE_LARGE" });
    expect(small).toMatchObject({ ok: true, action: "FUND_RELEASE_SMALL" });

    if (!large.ok || !small.ok) return;
    const largeView = await governance.getProposal(large.proposalId, ids[0]);
    const smallView = await governance.getProposal(small.proposalId, ids[0]);

    expect(largeView!.thresholdPermille).toBe(667);
    expect(smallView!.thresholdPermille).toBe(500);
  });

  it("refuses to propose more than the group has", async () => {
    const { groupId, ids } = await seedFundedGroup();

    const result = await governance.createProposal(ids[0], {
      groupId,
      title: "Too much",
      reason: "...",
      amount: Money.fromMajor(500_000),
    });

    expect(result).toMatchObject({ ok: false, reason: "insufficient_funds" });
  });

  it("refuses a non-member", async () => {
    const { groupId } = await seedFundedGroup();
    const [stranger] = await t.db
      .insert(users)
      .values({ email: "stranger@jfk.test", displayName: "Stranger" })
      .returning({ id: users.id });

    const result = await governance.createProposal(stranger.id, {
      groupId,
      title: "Give me money",
      reason: "...",
      amount: Money.fromMajor(1_000),
    });

    expect(result).toMatchObject({ ok: false, reason: "not_a_member" });
  });

  it("respects the members-can-propose setting", async () => {
    const { groupId, ids } = await seedFundedGroup();
    await t.db
      .update(groupSettings)
      .set({ membersCanPropose: false })
      .where(eq(groupSettings.groupId, groupId));

    // amaka is a plain member.
    await expect(
      governance.createProposal(ids[3], {
        groupId,
        title: "Nope",
        reason: "...",
        amount: Money.fromMajor(1_000),
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // The owner still can.
    const owner = await governance.createProposal(ids[0], {
      groupId,
      title: "Fine",
      reason: "...",
      amount: Money.fromMajor(1_000),
    });
    expect(owner.ok).toBe(true);
  });
});

describe("voting", () => {
  async function openProposal(amount = Money.fromMajor(120_000)) {
    const { groupId, ids } = await seedFundedGroup();
    const result = await governance.createProposal(ids[0], {
      groupId,
      title: "Buy a generator",
      reason: "The office keeps losing power",
      amount,
      destination: "Supplier",
    });
    if (!result.ok) throw new Error("setup failed");
    return { groupId, ids, proposalId: result.proposalId };
  }

  it("records a vote and reports what is still needed", async () => {
    const { ids, proposalId } = await openProposal();

    const result = await governance.castVote(proposalId, ids[0], "YES");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.outcome.decision).toBe("undecided");

    const view = await governance.getProposal(proposalId, ids[0]);
    expect(view!.tally).toEqual({ yes: 1, no: 0, abstain: 0 });
    expect(view!.yourVote).toBe("YES");
  });

  it("lets a member change their mind without double-counting", async () => {
    const { ids, proposalId } = await openProposal();

    await governance.castVote(proposalId, ids[0], "YES");
    await governance.castVote(proposalId, ids[0], "NO");

    const view = await governance.getProposal(proposalId, ids[0]);
    expect(view!.tally).toEqual({ yes: 0, no: 1, abstain: 0 });
    expect(await t.db.select().from(votes)).toHaveLength(1);
  });

  it("refuses a vote from someone outside the group", async () => {
    const { proposalId } = await openProposal();
    const [stranger] = await t.db
      .insert(users)
      .values({ email: "stranger@jfk.test", displayName: "Stranger" })
      .returning({ id: users.id });

    const result = await governance.castVote(proposalId, stranger.id, "YES");
    expect(result).toMatchObject({ ok: false, reason: "not_a_member" });
  });

  it("refuses a vote after the deadline", async () => {
    const { ids, proposalId } = await openProposal();
    await t.db
      .update(proposals)
      .set({ closesAt: new Date(Date.now() - 1000) })
      .where(eq(proposals.id, proposalId));

    const result = await governance.castVote(proposalId, ids[0], "YES");
    expect(result).toMatchObject({ ok: false, reason: "closed" });
  });

  it("hides a proposal from people outside the group entirely", async () => {
    const { proposalId } = await openProposal();
    const [stranger] = await t.db
      .insert(users)
      .values({ email: "stranger@jfk.test", displayName: "Stranger" })
      .returning({ id: users.id });

    expect(await governance.getProposal(proposalId, stranger.id)).toBeNull();
  });
});

describe("the worked example from the brief", () => {
  it("approves a spend and reserves the money the moment it passes", async () => {
    const { groupId, ids } = await seedFundedGroup();

    const before = await ledger.getGroupBalances(groupId);
    expect(before.available.format()).toBe("₦200,000.00");

    const created = await governance.createProposal(ids[0], {
      groupId,
      title: "Purchase X",
      reason: "For the group",
      amount: Money.fromMajor(120_000),
      destination: "Vendor",
    });
    if (!created.ok) throw new Error("setup failed");

    // Money must not move while the vote is running.
    expect((await ledger.getGroupBalances(groupId)).available.format()).toBe(
      "₦200,000.00",
    );

    // Three of four vote yes — 75%, clearing the 66.7% bar.
    await governance.castVote(created.proposalId, ids[0], "YES");
    await governance.castVote(created.proposalId, ids[1], "YES");
    const decisive = await governance.castVote(created.proposalId, ids[2], "YES");

    expect(decisive.ok && decisive.outcome.decision).toBe("approved");

    const view = await governance.getProposal(created.proposalId, ids[0]);
    expect(view!.status).toBe("APPROVED");

    // The money is now fenced off: available drops, locked rises, total same.
    const after = await ledger.getGroupBalances(groupId);
    expect(after.available.format()).toBe("₦80,000.00");
    expect(after.reserved.format()).toBe("₦120,000.00");
    expect(after.total.format()).toBe("₦200,000.00");

    expect((await reconcileLedger(t.db)).clean).toBe(true);
  });

  it("rejects it when the group votes it down, and touches nothing", async () => {
    const { groupId, ids } = await seedFundedGroup();

    const created = await governance.createProposal(ids[0], {
      groupId,
      title: "Purchase X",
      reason: "For the group",
      amount: Money.fromMajor(120_000),
    });
    if (!created.ok) throw new Error("setup failed");

    await governance.castVote(created.proposalId, ids[0], "YES");
    await governance.castVote(created.proposalId, ids[1], "NO");
    await governance.castVote(created.proposalId, ids[2], "NO");

    const view = await governance.getProposal(created.proposalId, ids[0]);
    expect(view!.status).toBe("REJECTED");

    const balances = await ledger.getGroupBalances(groupId);
    expect(balances.available.format()).toBe("₦200,000.00");
    expect(balances.reserved.isZero()).toBe(true);
  });
});

describe("two proposals cannot spend the same money", () => {
  it("approves the first and refuses to fund the second", async () => {
    const { groupId, ids } = await seedFundedGroup();

    // Two proposals, each for ₦120,000, against a ₦200,000 treasury.
    const first = await governance.createProposal(ids[0], {
      groupId,
      title: "First",
      reason: "...",
      amount: Money.fromMajor(120_000),
    });
    const second = await governance.createProposal(ids[0], {
      groupId,
      title: "Second",
      reason: "...",
      amount: Money.fromMajor(120_000),
    });
    if (!first.ok || !second.ok) throw new Error("setup failed");

    // Both pass their votes.
    for (const id of ids.slice(0, 3)) {
      await governance.castVote(first.proposalId, id, "YES");
    }
    for (const id of ids.slice(0, 3)) {
      await governance.castVote(second.proposalId, id, "YES");
    }

    const firstView = await governance.getProposal(first.proposalId, ids[0]);
    const secondView = await governance.getProposal(second.proposalId, ids[0]);

    expect(firstView!.status).toBe("APPROVED");
    // The vote passed, but the money was gone — and the group is told so.
    expect(secondView!.status).toBe("REJECTED");
    expect(secondView!.outcomeReason).toMatch(/no longer available/);

    // Only one reservation exists, and the books still balance.
    const balances = await ledger.getGroupBalances(groupId);
    expect(balances.reserved.format()).toBe("₦120,000.00");
    expect(balances.available.format()).toBe("₦80,000.00");
    expect((await reconcileLedger(t.db)).clean).toBe(true);
  });
});

describe("closing at the deadline", () => {
  it("expires a proposal nobody voted on", async () => {
    const { groupId, ids } = await seedFundedGroup();
    const created = await governance.createProposal(ids[0], {
      groupId,
      title: "Ignored",
      reason: "...",
      amount: Money.fromMajor(10_000),
    });
    if (!created.ok) throw new Error("setup failed");

    await t.db
      .update(proposals)
      .set({ closesAt: new Date(Date.now() - 1000) })
      .where(eq(proposals.id, created.proposalId));

    const outcome = await governance.evaluateProposal(created.proposalId);
    expect(outcome).toMatchObject({ decision: "rejected", reason: "quorum_missed" });

    const view = await governance.getProposal(created.proposalId, ids[0]);
    expect(view!.status).toBe("EXPIRED");
    expect(view!.outcomeReason).toMatch(/Not enough members voted/);
  });

  it("finds proposals that need closing", async () => {
    const { groupId, ids } = await seedFundedGroup();
    const created = await governance.createProposal(ids[0], {
      groupId,
      title: "Old",
      reason: "...",
      amount: Money.fromMajor(10_000),
    });
    if (!created.ok) throw new Error("setup failed");

    expect(await governance.findProposalsToClose()).toHaveLength(0);

    await t.db
      .update(proposals)
      .set({ closesAt: new Date(Date.now() - 1000) })
      .where(eq(proposals.id, created.proposalId));

    expect(await governance.findProposalsToClose()).toHaveLength(1);
  });
});

describe("snapshots make the vote fair", () => {
  it("counts against the membership as it was when the vote opened", async () => {
    const { groupId, ids } = await seedFundedGroup();

    const created = await governance.createProposal(ids[0], {
      groupId,
      title: "Purchase X",
      reason: "...",
      amount: Money.fromMajor(120_000),
    });
    if (!created.ok) throw new Error("setup failed");

    // Someone joins mid-vote. They must not change the maths.
    const [latecomer] = await t.db
      .insert(users)
      .values({ email: "late@jfk.test", displayName: "Late" })
      .returning({ id: users.id });
    const invite = await groupsService.createInvite(groupId, ids[0]);
    if (!invite.ok) throw new Error("invite failed");
    await groupsService.acceptInvite(invite.code, latecomer.id);

    const view = await governance.getProposal(created.proposalId, ids[0]);
    // Still four, not five.
    expect(view!.eligibleVoterCount).toBe(4);

    // And three yes votes still decide it, as they would have at the start.
    for (const id of ids.slice(0, 3)) {
      await governance.castVote(created.proposalId, id, "YES");
    }
    const settled = await governance.getProposal(created.proposalId, ids[0]);
    expect(settled!.status).toBe("APPROVED");
  });

  it("ignores a threshold change made after the vote opened", async () => {
    const { groupId, ids } = await seedFundedGroup();
    const created = await governance.createProposal(ids[0], {
      groupId,
      title: "Purchase X",
      reason: "...",
      amount: Money.fromMajor(120_000),
    });
    if (!created.ok) throw new Error("setup failed");

    // Move the goalposts to 90% mid-vote.
    const { governanceRules } = await import("@/lib/db/schema");
    await t.db
      .update(governanceRules)
      .set({ thresholdPermille: 900 })
      .where(eq(governanceRules.groupId, groupId));

    for (const id of ids.slice(0, 3)) {
      await governance.castVote(created.proposalId, id, "YES");
    }

    // 75% still passes, because 66.7% was the deal when people voted.
    const view = await governance.getProposal(created.proposalId, ids[0]);
    expect(view!.thresholdPermille).toBe(667);
    expect(view!.status).toBe("APPROVED");
  });
});

describe("listing", () => {
  it("shows the group's proposals with your own vote marked", async () => {
    const { groupId, ids } = await seedFundedGroup();
    const created = await governance.createProposal(ids[0], {
      groupId,
      title: "Purchase X",
      reason: "...",
      amount: Money.fromMajor(10_000),
    });
    if (!created.ok) throw new Error("setup failed");
    await governance.castVote(created.proposalId, ids[1], "YES");

    const forVoter = await governance.listProposals(groupId, ids[1]);
    expect(forVoter).toHaveLength(1);
    expect(forVoter![0].yourVote).toBe("YES");

    const forOther = await governance.listProposals(groupId, ids[2]);
    expect(forOther![0].yourVote).toBeNull();
  });

  it("returns null for a non-member", async () => {
    const { groupId } = await seedFundedGroup();
    const [stranger] = await t.db
      .insert(users)
      .values({ email: "stranger@jfk.test", displayName: "Stranger" })
      .returning({ id: users.id });

    expect(await governance.listProposals(groupId, stranger.id)).toBeNull();
  });
});
