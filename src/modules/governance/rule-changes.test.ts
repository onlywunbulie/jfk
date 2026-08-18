import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/lib/db/testing";
import { Money } from "@/lib/money";

const t: TestDb = await createTestDb();
vi.mock("@/lib/db", async () => ({ db: t.db }));

const governance = await import("./service");
const groupsService = await import("@/modules/groups/service");
const ledger = await import("@/modules/ledger/service");
const { reconcileLedger } = await import("@/modules/ledger/reconcile");
const { users, groupMembers } = await import("@/lib/db/schema");

/**
 * Proposals that change the group rather than move money.
 *
 * Until these existed the app could tell you an action needed a vote and then
 * give you no way to hold one — a locked door with no key. These cover the
 * four kinds that are actually reachable, and the guards that survive a passed
 * vote.
 */

/** Three members, so two For votes settle a 66.7% bar immediately. */
async function seedTrio() {
  const ids: string[] = [];
  for (const name of ["geoffrey", "chuka", "tunde"]) {
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
  if (!invite.ok) throw new Error("setup failed");
  for (const id of ids.slice(1)) await groupsService.acceptInvite(invite.code, id);

  return { groupId, ids };
}

async function passIt(proposalId: string, voters: string[]) {
  for (const id of voters) await governance.castVote(proposalId, id, "YES");
}

beforeEach(async () => {
  await t.reset();
});

afterAll(async () => {
  await t.close();
});

describe("changing the contribution", () => {
  it("takes effect once the group agrees", async () => {
    const { groupId, ids } = await seedTrio();

    const created = await governance.createProposal(ids[0], {
      groupId,
      title: "Raise the contribution",
      reason: "We want to hit the target sooner",
      kind: "CHANGE_CONTRIBUTION",
      payload: {
        kind: "CHANGE_CONTRIBUTION",
        amountMinor: Money.fromMajor(80_000).minor.toString(),
        cadence: "WEEKLY",
        dueDay: 3,
      },
    });
    expect(created).toMatchObject({ ok: true, action: "CHANGE_CONTRIBUTION" });
    if (!created.ok) return;

    // Nothing moves while the vote is still running.
    let detail = await groupsService.getGroupDetail(groupId, ids[0]);
    expect(detail!.contributionAmount.format()).toBe("₦50,000.00");

    await passIt(created.proposalId, ids.slice(0, 2));

    detail = await groupsService.getGroupDetail(groupId, ids[0]);
    expect(detail!.contributionAmount.format()).toBe("₦80,000.00");
    expect(detail!.cadence).toBe("WEEKLY");
    expect(detail!.dueDay).toBe(3);
  });

  it("does nothing when the group votes it down", async () => {
    const { groupId, ids } = await seedTrio();
    const created = await governance.createProposal(ids[0], {
      groupId,
      title: "Raise the contribution",
      reason: "...",
      kind: "CHANGE_CONTRIBUTION",
      payload: {
        kind: "CHANGE_CONTRIBUTION",
        amountMinor: Money.fromMajor(80_000).minor.toString(),
        cadence: "MONTHLY",
        dueDay: 1,
      },
    });
    if (!created.ok) return;

    for (const id of ids) await governance.castVote(created.proposalId, id, "NO");

    const detail = await groupsService.getGroupDetail(groupId, ids[0]);
    expect(detail!.contributionAmount.format()).toBe("₦50,000.00");
  });
});

describe("changing a threshold", () => {
  it("is judged against CHANGE_GOVERNANCE, not against the rule it edits", async () => {
    const { groupId, ids } = await seedTrio();

    const created = await governance.createProposal(ids[0], {
      groupId,
      title: "Make big spends harder",
      reason: "Large withdrawals should need more of us",
      kind: "CHANGE_THRESHOLD",
      payload: {
        kind: "CHANGE_THRESHOLD",
        action: "FUND_RELEASE_LARGE",
        thresholdPermille: 800,
      },
    });
    if (!created.ok) return;

    const view = await governance.getProposal(created.proposalId, ids[0]);
    expect(view!.thresholdPermille).toBe(750);

    await passIt(created.proposalId, ids);

    const detail = await groupsService.getGroupDetail(groupId, ids[0]);
    const large = detail!.governance.find((r) => r.action === "FUND_RELEASE_LARGE");
    expect(large!.thresholdPermille).toBe(800);
  });

  it("clamps a value that would hand the treasury to a minority", async () => {
    const { groupId, ids } = await seedTrio();

    const created = await governance.createProposal(ids[0], {
      groupId,
      title: "Sneaky",
      reason: "Lower the bar to almost nothing",
      kind: "CHANGE_THRESHOLD",
      payload: {
        kind: "CHANGE_THRESHOLD",
        action: "FUND_RELEASE_SMALL",
        thresholdPermille: 10,
      },
    });
    if (!created.ok) return;
    await passIt(created.proposalId, ids);

    const detail = await groupsService.getGroupDetail(groupId, ids[0]);
    const small = detail!.governance.find((r) => r.action === "FUND_RELEASE_SMALL");
    // Even a passed vote cannot set a 1% bar.
    expect(small!.thresholdPermille).toBe(500);
  });
});

describe("changing who is in the group", () => {
  it("removes a member, keeping their history", async () => {
    const { groupId, ids } = await seedTrio();

    const created = await governance.createProposal(ids[0], {
      groupId,
      title: "Remove tunde",
      reason: "He has moved away and stopped contributing",
      kind: "REMOVE_MEMBER",
      payload: { kind: "REMOVE_MEMBER", userId: ids[2], displayName: "tunde" },
    });
    expect(created).toMatchObject({ ok: true, action: "REMOVE_MEMBER" });
    if (!created.ok) return;

    await passIt(created.proposalId, ids.slice(0, 2));

    const members = await groupsService.listMembers(groupId, ids[0]);
    expect(members!.map((m) => m.userId)).not.toContain(ids[2]);

    // The row survives so contribution history stays attached.
    const rows = await t.db
      .select()
      .from(groupMembers)
      .where(eq(groupMembers.userId, ids[2]));
    expect(rows[0].status).toBe("REMOVED");
  });

  it("demotes an admin rather than ejecting them", async () => {
    const { groupId, ids } = await seedTrio();
    await groupsService.grantAdmin(groupId, ids[0], ids[1]);

    const created = await governance.createProposal(ids[0], {
      groupId,
      title: "Remove chuka as admin",
      reason: "Rotating who holds the keys",
      kind: "REMOVE_ADMIN",
      payload: { kind: "REMOVE_ADMIN", userId: ids[1], displayName: "chuka" },
    });
    if (!created.ok) return;
    await passIt(created.proposalId, ids);

    const members = await groupsService.listMembers(groupId, ids[0]);
    const chuka = members!.find((m) => m.userId === ids[1]);
    // Still in the group, just without the powers.
    expect(chuka).toBeDefined();
    expect(chuka!.role).toBe("MEMBER");
  });
});

describe("how a rule change ends", () => {
  it("finishes outright, with no payout step left over", async () => {
    const { groupId, ids } = await seedTrio();
    const created = await governance.createProposal(ids[0], {
      groupId,
      title: "Raise the bar for removals",
      reason: "...",
      kind: "CHANGE_THRESHOLD",
      payload: {
        kind: "CHANGE_THRESHOLD",
        action: "REMOVE_MEMBER",
        thresholdPermille: 800,
      },
    });
    if (!created.ok) return;
    await passIt(created.proposalId, ids);

    const view = await governance.getProposal(created.proposalId, ids[0]);
    // EXECUTED, not APPROVED — nothing is waiting on a human.
    expect(view!.status).toBe("EXECUTED");
    expect(view!.outcomeReason).toMatch(/applied/);
  });

  it("reserves no money", async () => {
    const { groupId, ids } = await seedTrio();
    const created = await governance.createProposal(ids[0], {
      groupId,
      title: "Change a threshold",
      reason: "...",
      kind: "CHANGE_THRESHOLD",
      payload: {
        kind: "CHANGE_THRESHOLD",
        action: "DISSOLVE_GROUP",
        thresholdPermille: 900,
      },
    });
    if (!created.ok) return;
    await passIt(created.proposalId, ids);

    const balances = await ledger.getGroupBalances(groupId);
    expect(balances.locked.isZero()).toBe(true);
    expect((await reconcileLedger(t.db)).clean).toBe(true);
  });
});
