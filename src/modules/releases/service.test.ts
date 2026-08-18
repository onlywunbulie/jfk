import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/lib/db/testing";
import { Money } from "@/lib/money";
import { ForbiddenError } from "@/lib/auth/policy";

const t: TestDb = await createTestDb();
vi.mock("@/lib/db", async () => ({ db: t.db }));

const releases = await import("./service");
const governance = await import("@/modules/governance/service");
const groupsService = await import("@/modules/groups/service");
const ledger = await import("@/modules/ledger/service");
const { simulateContribution } = await import("@/modules/payments/simulate");
const { reconcileLedger } = await import("@/modules/ledger/reconcile");
const { users, proposals, fundReleases } = await import("@/lib/db/schema");

/** Four friends, ₦200,000 in the treasury, one approved ₦120,000 proposal. */
async function seedApprovedProposal() {
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

  const created = await governance.createProposal(ids[0], {
    groupId,
    title: "Buy a generator",
    reason: "The office keeps losing power",
    amount: Money.fromMajor(120_000),
    destination: "Ade's Electricals",
  });
  if (!created.ok) throw new Error("proposal failed");

  for (const id of ids.slice(0, 3)) {
    await governance.castVote(created.proposalId, id, "YES");
  }

  return { groupId, ids, proposalId: created.proposalId };
}

beforeEach(async () => {
  await t.reset();
});

afterAll(async () => {
  await t.close();
});

// ---------------------------------------------------------------------------

describe("the gate: no release without an approved proposal", () => {
  it("refuses a proposal still being voted on", async () => {
    const { groupId, ids } = await seedApprovedProposal();

    const open = await governance.createProposal(ids[0], {
      groupId,
      title: "Still voting",
      reason: "...",
      amount: Money.fromMajor(10_000),
    });
    if (!open.ok) throw new Error("setup failed");

    const result = await releases.executeRelease(open.proposalId, ids[0]);
    expect(result).toMatchObject({ ok: false, reason: "not_approved" });
    expect(await t.db.select().from(fundReleases)).toHaveLength(0);
  });

  it("refuses a rejected proposal", async () => {
    const { groupId, ids } = await seedApprovedProposal();

    const doomed = await governance.createProposal(ids[0], {
      groupId,
      title: "Doomed",
      reason: "...",
      amount: Money.fromMajor(10_000),
    });
    if (!doomed.ok) throw new Error("setup failed");
    for (const id of ids) await governance.castVote(doomed.proposalId, id, "NO");

    const result = await releases.executeRelease(doomed.proposalId, ids[0]);
    expect(result).toMatchObject({ ok: false, reason: "not_approved" });
  });

  it("cannot be represented in the database without a proposal", async () => {
    const { groupId } = await seedApprovedProposal();

    // proposal_id is NOT NULL — the promise is schema, not convention.
    await expect(
      t.sql(`
        insert into fund_releases (id, group_id, amount, destination)
        values ('sneaky', '${groupId}', 100000, 'Me')
      `),
    ).rejects.toThrow();
  });

  it("allows only one release per proposal", async () => {
    const { proposalId, ids } = await seedApprovedProposal();
    await releases.executeRelease(proposalId, ids[0], { manual: true });

    const second = await releases.executeRelease(proposalId, ids[0], {
      manual: true,
    });
    expect(second).toMatchObject({ ok: false, reason: "already_released" });
    expect(await t.db.select().from(fundReleases)).toHaveLength(1);
  });

  it("refuses a plain member, even on an approved proposal", async () => {
    const { proposalId, ids } = await seedApprovedProposal();
    // amaka is a MEMBER, not an admin.
    await expect(
      releases.executeRelease(proposalId, ids[3]),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses someone outside the group entirely", async () => {
    const { proposalId } = await seedApprovedProposal();
    const [stranger] = await t.db
      .insert(users)
      .values({ email: "stranger@jfk.test", displayName: "Stranger" })
      .returning({ id: users.id });

    const result = await releases.executeRelease(proposalId, stranger.id);
    expect(result).toMatchObject({ ok: false, reason: "not_a_member" });
  });
});

describe("a successful payout", () => {
  it("takes the money out of locked and off the platform", async () => {
    const { groupId, proposalId, ids } = await seedApprovedProposal();

    // The vote already reserved it.
    const before = await ledger.getGroupBalances(groupId);
    expect(before.available.format()).toBe("₦80,000.00");
    expect(before.reserved.format()).toBe("₦120,000.00");

    const result = await releases.executeRelease(proposalId, ids[0], {
      manual: true,
    });
    expect(result.ok).toBe(true);

    const after = await ledger.getGroupBalances(groupId);
    expect(after.available.format()).toBe("₦80,000.00");
    expect(after.reserved.isZero()).toBe(true);
    expect(after.total.format()).toBe("₦80,000.00");

    expect((await reconcileLedger(t.db)).clean).toBe(true);
  });

  it("marks the proposal executed and records who did it", async () => {
    const { proposalId, ids } = await seedApprovedProposal();
    await releases.executeRelease(proposalId, ids[0], { manual: true });

    const [proposal] = await t.db
      .select()
      .from(proposals)
      .where(eq(proposals.id, proposalId));
    expect(proposal.status).toBe("EXECUTED");
    expect(proposal.executedAt).not.toBeNull();

    const release = await releases.getReleaseForProposal(proposalId);
    expect(release).toMatchObject({
      status: "EXECUTED",
      destination: "Ade's Electricals",
      executedByName: "geoffrey",
      recordedManually: true,
    });
  });

  it("shows in the group's transaction history", async () => {
    const { groupId, proposalId, ids } = await seedApprovedProposal();
    await releases.executeRelease(proposalId, ids[0], { manual: true });

    const entries = await ledger.listEntries(ledger.groupReserved(groupId));
    const payout = entries.find((e) => e.type === "PAYOUT");
    expect(payout).toBeDefined();
    expect(payout!.amount.format()).toBe("-₦120,000.00");
  });
});

describe("a failed payout", () => {
  it("returns the money to available, exactly as it was", async () => {
    const { groupId, proposalId, ids } = await seedApprovedProposal();

    const result = await releases.executeRelease(proposalId, ids[0], {
      simulateFailure: true,
    });
    expect(result).toMatchObject({ ok: false, reason: "transfer_failed" });

    // The reservation is handed straight back.
    const after = await ledger.getGroupBalances(groupId);
    expect(after.available.format()).toBe("₦200,000.00");
    expect(after.reserved.isZero()).toBe(true);
    expect(after.total.format()).toBe("₦200,000.00");

    expect((await reconcileLedger(t.db)).clean).toBe(true);
  });

  it("leaves the proposal approved so the group need not vote again", async () => {
    const { proposalId, ids } = await seedApprovedProposal();
    await releases.executeRelease(proposalId, ids[0], { simulateFailure: true });

    const [proposal] = await t.db
      .select()
      .from(proposals)
      .where(eq(proposals.id, proposalId));

    expect(proposal.status).toBe("APPROVED");
    expect(proposal.outcomeReason).toMatch(/Payout failed/);
  });

  it("records the failure rather than hiding it", async () => {
    const { proposalId, ids } = await seedApprovedProposal();
    await releases.executeRelease(proposalId, ids[0], { simulateFailure: true });

    const release = await releases.getReleaseForProposal(proposalId);
    expect(release).toMatchObject({ status: "FAILED" });
    expect(release!.failureReason).toMatch(/declined/);
  });

  it("refuses a silent second attempt, and says why", async () => {
    const { groupId, proposalId, ids } = await seedApprovedProposal();

    await releases.executeRelease(proposalId, ids[0], { simulateFailure: true });

    // The money went back to available, where another proposal could claim it.
    // Re-spending it later without asking the group again would be wrong, so
    // a retry means a new proposal.
    const retry = await releases.executeRelease(proposalId, ids[0], {
      manual: true,
    });

    expect(retry).toMatchObject({ ok: false, reason: "already_released" });
    if (!retry.ok) expect(retry.message).toMatch(/new proposal/);

    // Nothing moved, and the books are sound.
    const balances = await ledger.getGroupBalances(groupId);
    expect(balances.available.format()).toBe("₦200,000.00");
    expect(balances.total.format()).toBe("₦200,000.00");
    expect((await reconcileLedger(t.db)).clean).toBe(true);
  });

  it("lets the group approve a fresh proposal and pay that one out", async () => {
    const { groupId, proposalId, ids } = await seedApprovedProposal();
    await releases.executeRelease(proposalId, ids[0], { simulateFailure: true });

    const second = await governance.createProposal(ids[0], {
      groupId,
      title: "Buy a generator (second attempt)",
      reason: "The first transfer was declined",
      amount: Money.fromMajor(120_000),
      destination: "Ade's Electricals",
    });
    if (!second.ok) throw new Error("setup failed");
    for (const id of ids.slice(0, 3)) {
      await governance.castVote(second.proposalId, id, "YES");
    }

    const result = await releases.executeRelease(second.proposalId, ids[0], {
      manual: true,
    });

    expect(result.ok).toBe(true);
    const balances = await ledger.getGroupBalances(groupId);
    expect(balances.total.format()).toBe("₦80,000.00");
    expect((await reconcileLedger(t.db)).clean).toBe(true);
  });
});

describe("listing releases", () => {
  it("shows the group's payouts", async () => {
    const { groupId, proposalId, ids } = await seedApprovedProposal();
    await releases.executeRelease(proposalId, ids[0], { manual: true });

    const list = await releases.listReleases(groupId, ids[0]);
    expect(list).toHaveLength(1);
    expect(list![0]).toMatchObject({
      status: "EXECUTED",
      proposalTitle: "Buy a generator",
    });
  });

  it("hides them from non-members", async () => {
    const { groupId } = await seedApprovedProposal();
    const [stranger] = await t.db
      .insert(users)
      .values({ email: "stranger@jfk.test", displayName: "Stranger" })
      .returning({ id: users.id });

    expect(await releases.listReleases(groupId, stranger.id)).toBeNull();
  });
});

describe("the whole JFK Empire story, end to end", () => {
  it("collects, locks, votes, pays out and reconciles clean", async () => {
    const { groupId, proposalId, ids } = await seedApprovedProposal();

    // ₦200,000 collected, ₦120,000 approved and reserved.
    expect((await ledger.getGroupBalances(groupId)).total.format()).toBe(
      "₦200,000.00",
    );

    const result = await releases.executeRelease(proposalId, ids[0], {
      manual: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.amount.format()).toBe("₦120,000.00");

    const final = await ledger.getGroupBalances(groupId);
    expect(final.total.format()).toBe("₦80,000.00");
    expect(final.available.format()).toBe("₦80,000.00");
    expect(final.reserved.isZero()).toBe(true);

    const report = await reconcileLedger(t.db);
    expect(report.clean).toBe(true);
    expect(report.findings).toEqual([]);
  });
});
