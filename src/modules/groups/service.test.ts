import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/lib/db/testing";
import { Money } from "@/lib/money";
import { ForbiddenError, can } from "@/lib/auth/policy";

const t: TestDb = await createTestDb();
vi.mock("@/lib/db", async () => ({ db: t.db }));

const service = await import("./service");
const { users, groupMembers, groupInvites, governanceRules, auditLogs } =
  await import("@/lib/db/schema");

/** Create a user and return their id. */
async function makeUser(name: string): Promise<string> {
  const [user] = await t.db
    .insert(users)
    .values({ email: `${name}@jfk.test`, displayName: name })
    .returning({ id: users.id });
  return user.id;
}

const EMPIRE = {
  name: "JFK Empire",
  type: "TREASURY" as const,
  contributionAmount: Money.fromMajor(50_000),
  cadence: "MONTHLY" as const,
  dueDay: 1,
};

beforeEach(async () => {
  await t.reset();
});

afterAll(async () => {
  await t.close();
});

describe("createGroup", () => {
  it("creates the group, settings, governance and owner membership atomically", async () => {
    const owner = await makeUser("geoffrey");
    const { groupId } = await service.createGroup(owner, EMPIRE);

    const detail = await service.getGroupDetail(groupId, owner);
    expect(detail).toMatchObject({
      name: "JFK Empire",
      type: "TREASURY",
      role: "OWNER",
      memberCount: 1,
      cadence: "MONTHLY",
    });
    expect(detail!.contributionAmount.format()).toBe("₦50,000.00");
  });

  it("seeds all nine governance defaults", async () => {
    const owner = await makeUser("geoffrey");
    const { groupId } = await service.createGroup(owner, EMPIRE);

    const rules = await t.db
      .select()
      .from(governanceRules)
      .where(eq(governanceRules.groupId, groupId));

    expect(rules).toHaveLength(9);
    const byAction = Object.fromEntries(
      rules.map((r) => [r.action, r.thresholdPermille]),
    );
    // The JFK Empire example: a large withdrawal needs 66.7%.
    expect(byAction.FUND_RELEASE_LARGE).toBe(667);
    expect(byAction.DISSOLVE_GROUP).toBe(800);
    expect(byAction.CHANGE_GOVERNANCE).toBe(750);
  });

  it("gives each group its own copy of the rules", async () => {
    const owner = await makeUser("geoffrey");
    const a = await service.createGroup(owner, EMPIRE);
    const b = await service.createGroup(owner, { ...EMPIRE, name: "Family Ajo" });

    await t.db
      .update(governanceRules)
      .set({ thresholdPermille: 900 })
      .where(
        and(
          eq(governanceRules.groupId, a.groupId),
          eq(governanceRules.action, "DISSOLVE_GROUP"),
        ),
      );

    const detailB = await service.getGroupDetail(b.groupId, owner);
    const dissolveB = detailB!.governance.find(
      (g) => g.action === "DISSOLVE_GROUP",
    );
    expect(dissolveB!.thresholdPermille).toBe(800);
  });

  it("writes an audit record", async () => {
    const owner = await makeUser("geoffrey");
    const { groupId } = await service.createGroup(owner, EMPIRE);

    const [entry] = await t.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.groupId, groupId));

    expect(entry.action).toBe("group.created");
    expect(entry.actorId).toBe(owner);
    // BigInt amounts must survive JSON serialisation.
    expect(JSON.parse(entry.after!).contributionAmount).toBe("5000000");
  });

  it("puts the creator first in a rotating group's order", async () => {
    const owner = await makeUser("geoffrey");
    const { groupId } = await service.createGroup(owner, {
      ...EMPIRE,
      type: "ROTATING",
      name: "Office Ajo",
    });

    const members = await service.listMembers(groupId, owner);
    expect(members![0].rotationPosition).toBe(1);
  });

  it("leaves rotation order null for a treasury group", async () => {
    const owner = await makeUser("geoffrey");
    const { groupId } = await service.createGroup(owner, EMPIRE);
    const members = await service.listMembers(groupId, owner);
    expect(members![0].rotationPosition).toBeNull();
  });
});

describe("invites", () => {
  async function setup() {
    const owner = await makeUser("geoffrey");
    const { groupId } = await service.createGroup(owner, EMPIRE);
    return { owner, groupId };
  }

  it("lets an admin create an invite and a stranger preview it", async () => {
    const { owner, groupId } = await setup();
    const invite = await service.createInvite(groupId, owner);
    expect(invite.ok).toBe(true);
    if (!invite.ok) return;

    const preview = await service.previewInvite(invite.code);
    expect(preview).toMatchObject({
      groupId,
      groupName: "JFK Empire",
      groupType: "TREASURY",
      memberCount: 1,
    });
    expect(preview!.contributionAmount.format({ compact: true })).toBe("₦50,000");
  });

  it("refuses to let a plain member create invites", async () => {
    const { owner, groupId } = await setup();
    const invite = await service.createInvite(groupId, owner);
    if (!invite.ok) throw new Error("setup failed");

    const chuka = await makeUser("chuka");
    await service.acceptInvite(invite.code, chuka);

    await expect(service.createInvite(groupId, chuka)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("adds the joiner as a MEMBER, not an admin", async () => {
    const { owner, groupId } = await setup();
    const invite = await service.createInvite(groupId, owner);
    if (!invite.ok) throw new Error("setup failed");

    const chuka = await makeUser("chuka");
    const result = await service.acceptInvite(invite.code, chuka);

    expect(result).toMatchObject({ ok: true, groupId, alreadyMember: false });
    const members = await service.listMembers(groupId, owner);
    expect(members!.find((m) => m.userId === chuka)!.role).toBe("MEMBER");
  });

  it("is idempotent for someone already in the group", async () => {
    const { owner, groupId } = await setup();
    const invite = await service.createInvite(groupId, owner, { maxUses: 5 });
    if (!invite.ok) throw new Error("setup failed");

    const chuka = await makeUser("chuka");
    await service.acceptInvite(invite.code, chuka);
    const second = await service.acceptInvite(invite.code, chuka);

    expect(second).toMatchObject({ ok: true, alreadyMember: true });
    expect((await service.listMembers(groupId, owner))!).toHaveLength(2);
  });

  it("honours maxUses and cannot be over-redeemed", async () => {
    const { owner, groupId } = await setup();
    const invite = await service.createInvite(groupId, owner, { maxUses: 1 });
    if (!invite.ok) throw new Error("setup failed");

    const chuka = await makeUser("chuka");
    const tunde = await makeUser("tunde");

    expect((await service.acceptInvite(invite.code, chuka)).ok).toBe(true);
    expect(await service.acceptInvite(invite.code, tunde)).toMatchObject({
      ok: false,
      reason: "exhausted",
    });
    expect(await service.previewInvite(invite.code)).toBeNull();
  });

  it("ties an email-scoped invite to that person only", async () => {
    const { owner, groupId } = await setup();
    const invite = await service.createInvite(groupId, owner, {
      email: "Chuka@JFK.test",
    });
    if (!invite.ok) throw new Error("setup failed");

    const tunde = await makeUser("tunde");
    expect(await service.acceptInvite(invite.code, tunde)).toMatchObject({
      ok: false,
      reason: "wrong_email",
    });

    const chuka = await makeUser("chuka");
    expect((await service.acceptInvite(invite.code, chuka)).ok).toBe(true);
  });

  it("rejects expired and revoked invites", async () => {
    const { owner, groupId } = await setup();

    const expired = await service.createInvite(groupId, owner);
    if (!expired.ok) throw new Error("setup failed");
    await t.db
      .update(groupInvites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(groupInvites.code, expired.code));

    const revoked = await service.createInvite(groupId, owner);
    if (!revoked.ok) throw new Error("setup failed");
    await service.revokeInvite(groupId, revoked.code, owner);

    const chuka = await makeUser("chuka");
    expect(await service.acceptInvite(expired.code, chuka)).toMatchObject({
      reason: "expired",
    });
    expect(await service.acceptInvite(revoked.code, chuka)).toMatchObject({
      reason: "revoked",
    });
    expect(await service.previewInvite(expired.code)).toBeNull();
    expect(await service.previewInvite(revoked.code)).toBeNull();
  });

  it("does not let a removed member rejoin through a link", async () => {
    const owner = await makeUser("geoffrey");
    const { groupId } = await service.createGroup(owner, EMPIRE);
    const invite = await service.createInvite(groupId, owner, { maxUses: 5 });
    if (!invite.ok) throw new Error("setup failed");

    const chuka = await makeUser("chuka");
    await service.acceptInvite(invite.code, chuka);
    // Two-member group, so removal is an admin action rather than a vote.
    await service.removeMember(groupId, owner, chuka);

    expect(await service.acceptInvite(invite.code, chuka)).toMatchObject({
      ok: false,
      reason: "removed",
    });
  });

  it("assigns the next rotation slot to each joiner", async () => {
    const owner = await makeUser("geoffrey");
    const { groupId } = await service.createGroup(owner, {
      ...EMPIRE,
      type: "ROTATING",
    });
    const invite = await service.createInvite(groupId, owner, { maxUses: 5 });
    if (!invite.ok) throw new Error("setup failed");

    await service.acceptInvite(invite.code, await makeUser("chuka"));
    await service.acceptInvite(invite.code, await makeUser("tunde"));

    const members = await service.listMembers(groupId, owner);
    expect(members!.map((m) => m.rotationPosition)).toEqual([1, 2, 3]);
  });
});

describe("roles", () => {
  async function groupOfThree() {
    const owner = await makeUser("geoffrey");
    const { groupId } = await service.createGroup(owner, EMPIRE);
    const invite = await service.createInvite(groupId, owner, { maxUses: 5 });
    if (!invite.ok) throw new Error("setup failed");

    const chuka = await makeUser("chuka");
    const tunde = await makeUser("tunde");
    await service.acceptInvite(invite.code, chuka);
    await service.acceptInvite(invite.code, tunde);
    return { owner, chuka, tunde, groupId };
  }

  it("lets the owner grant admin", async () => {
    const { owner, chuka, groupId } = await groupOfThree();
    expect(await service.grantAdmin(groupId, owner, chuka)).toEqual({ ok: true });

    const members = await service.listMembers(groupId, owner);
    expect(members!.find((m) => m.userId === chuka)!.role).toBe("ADMIN");
  });

  it("refuses an admin trying to make another admin", async () => {
    const { owner, chuka, tunde, groupId } = await groupOfThree();
    await service.grantAdmin(groupId, owner, chuka);

    await expect(
      service.grantAdmin(groupId, chuka, tunde),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("records the role change in the audit log", async () => {
    const { owner, chuka, groupId } = await groupOfThree();
    await service.grantAdmin(groupId, owner, chuka);

    const entries = await t.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "member.role_changed"));

    expect(entries).toHaveLength(1);
    expect(JSON.parse(entries[0].before!)).toEqual({ role: "MEMBER" });
    expect(JSON.parse(entries[0].after!)).toEqual({ role: "ADMIN" });
  });
});

describe("removal and leaving", () => {
  it("requires a proposal to remove someone once the group hits three", async () => {
    const owner = await makeUser("geoffrey");
    const { groupId } = await service.createGroup(owner, EMPIRE);
    const invite = await service.createInvite(groupId, owner, { maxUses: 5 });
    if (!invite.ok) throw new Error("setup failed");

    const chuka = await makeUser("chuka");
    const tunde = await makeUser("tunde");
    await service.acceptInvite(invite.code, chuka);
    await service.acceptInvite(invite.code, tunde);

    // Three active members — this is the governed path now.
    await expect(
      service.removeMember(groupId, owner, chuka),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("lets a member leave, and stops the owner from doing so", async () => {
    const owner = await makeUser("geoffrey");
    const { groupId } = await service.createGroup(owner, EMPIRE);
    const invite = await service.createInvite(groupId, owner);
    if (!invite.ok) throw new Error("setup failed");
    const chuka = await makeUser("chuka");
    await service.acceptInvite(invite.code, chuka);

    expect(await service.leaveGroup(groupId, chuka)).toEqual({ ok: true });
    expect(await service.leaveGroup(groupId, owner)).toEqual({
      ok: false,
      reason: "owner_must_transfer",
    });

    const members = await service.listMembers(groupId, owner);
    expect(members).toHaveLength(1);
  });

  it("keeps the membership row so history stays attached", async () => {
    const owner = await makeUser("geoffrey");
    const { groupId } = await service.createGroup(owner, EMPIRE);
    const invite = await service.createInvite(groupId, owner);
    if (!invite.ok) throw new Error("setup failed");
    const chuka = await makeUser("chuka");
    await service.acceptInvite(invite.code, chuka);
    await service.leaveGroup(groupId, chuka);

    const rows = await t.db
      .select()
      .from(groupMembers)
      .where(eq(groupMembers.userId, chuka));

    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("LEFT");
    expect(rows[0].exitedAt).not.toBeNull();
  });
});

describe("listGroupsForUser", () => {
  it("returns only groups the user is actively in", async () => {
    const geoffrey = await makeUser("geoffrey");
    const chuka = await makeUser("chuka");

    const empire = await service.createGroup(geoffrey, EMPIRE);
    await service.createGroup(chuka, { ...EMPIRE, name: "Someone Else's" });

    const invite = await service.createInvite(empire.groupId, geoffrey);
    if (!invite.ok) throw new Error("setup failed");
    await service.acceptInvite(invite.code, chuka);

    const geoffreyGroups = await service.listGroupsForUser(geoffrey);
    expect(geoffreyGroups.map((g) => g.name)).toEqual(["JFK Empire"]);
    expect(geoffreyGroups[0]).toMatchObject({ role: "OWNER", memberCount: 2 });

    const chukaGroups = await service.listGroupsForUser(chuka);
    expect(chukaGroups.map((g) => g.name).sort()).toEqual([
      "JFK Empire",
      "Someone Else's",
    ]);
  });

  it("drops groups the user has left", async () => {
    const owner = await makeUser("geoffrey");
    const { groupId } = await service.createGroup(owner, EMPIRE);
    const invite = await service.createInvite(groupId, owner);
    if (!invite.ok) throw new Error("setup failed");
    const chuka = await makeUser("chuka");
    await service.acceptInvite(invite.code, chuka);
    await service.leaveGroup(groupId, chuka);

    expect(await service.listGroupsForUser(chuka)).toHaveLength(0);
  });
});

describe("cross-group isolation", () => {
  it("hides a group entirely from someone who is not in it", async () => {
    const geoffrey = await makeUser("geoffrey");
    const stranger = await makeUser("stranger");
    const { groupId } = await service.createGroup(geoffrey, EMPIRE);

    expect(await service.getGroupDetail(groupId, stranger)).toBeNull();
    expect(await service.listMembers(groupId, stranger)).toBeNull();
    await expect(
      service.createInvite(groupId, stranger),
    ).resolves.toMatchObject({ ok: false, reason: "forbidden" });
  });
});

describe("choosing thresholds at creation", () => {
  it("stores the creator's choices instead of the defaults", async () => {
    const owner = await makeUser("geoffrey");
    const { groupId } = await service.createGroup(owner, {
      ...EMPIRE,
      governance: {
        FUND_RELEASE_SMALL: 750,
        DISSOLVE_GROUP: 1000,
      },
      quorumPct: 75,
    });

    const detail = await service.getGroupDetail(groupId, owner);
    const byAction = Object.fromEntries(
      detail!.governance.map((r) => [r.action, r.thresholdPermille]),
    );

    expect(byAction.FUND_RELEASE_SMALL).toBe(750);
    expect(byAction.DISSOLVE_GROUP).toBe(1000);
    // Anything not chosen keeps its default.
    expect(byAction.CHANGE_GOVERNANCE).toBe(750);
    expect(byAction.FUND_RELEASE_LARGE).toBe(667);
    expect(detail!.quorumPct).toBe(75);
  });

  it("still writes a row for every action, so no rule is invisible", async () => {
    const owner = await makeUser("geoffrey");
    const { groupId } = await service.createGroup(owner, {
      ...EMPIRE,
      governance: { FUND_RELEASE_SMALL: 600 },
    });

    const rules = await t.db
      .select()
      .from(governanceRules)
      .where(eq(governanceRules.groupId, groupId));
    expect(rules).toHaveLength(9);
  });

  it("refuses a threshold that would hand the treasury to a minority", async () => {
    const owner = await makeUser("geoffrey");
    const { groupId } = await service.createGroup(owner, {
      ...EMPIRE,
      // A hand-rolled POST trying to set a 1% bar for releasing funds.
      governance: { FUND_RELEASE_SMALL: 10, FUND_RELEASE_LARGE: 0 },
    });

    const detail = await service.getGroupDetail(groupId, owner);
    const byAction = Object.fromEntries(
      detail!.governance.map((r) => [r.action, r.thresholdPermille]),
    );

    // Clamped up to a real majority rather than accepted.
    expect(byAction.FUND_RELEASE_SMALL).toBe(500);
    expect(byAction.FUND_RELEASE_LARGE).toBe(500);
  });

  it("refuses an unreachable threshold above 100%", async () => {
    const owner = await makeUser("geoffrey");
    const { groupId } = await service.createGroup(owner, {
      ...EMPIRE,
      governance: { DISSOLVE_GROUP: 5000 },
    });

    const detail = await service.getGroupDetail(groupId, owner);
    const dissolve = detail!.governance.find((r) => r.action === "DISSOLVE_GROUP");
    expect(dissolve!.thresholdPermille).toBe(1000);
  });

  it("keeps quorum inside a range where a vote can still conclude", async () => {
    const owner = await makeUser("geoffrey");
    const zero = await service.createGroup(owner, { ...EMPIRE, quorumPct: 0 });
    const huge = await service.createGroup(owner, {
      ...EMPIRE,
      name: "Second",
      quorumPct: 900,
    });

    expect((await service.getGroupDetail(zero.groupId, owner))!.quorumPct).toBe(1);
    expect((await service.getGroupDetail(huge.groupId, owner))!.quorumPct).toBe(100);
  });

  it("leaves changing them a governed action once the group is live", async () => {
    const owner = await makeUser("geoffrey");
    const { groupId } = await service.createGroup(owner, EMPIRE);
    const membership = await service.getMembership(groupId, owner);

    // The owner picked the numbers at creation, but cannot revise them alone.
    const decision = can("group.governance.change", membership!);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("needs_proposal");
    }
  });
});
