import "server-only";
import { and, asc, count, eq, isNull, or, sql } from "drizzle-orm";
import { db, type Transaction } from "@/lib/db";
import {
  DEFAULT_GOVERNANCE,
  governanceRules,
  groupInvites,
  groupMembers,
  groupSettings,
  groups,
  users,
  INVITE_TTL_DAYS,
  type Cadence,
  type GovernedAction,
  type GroupType,
  type MemberRole,
} from "@/lib/db/schema";
import { randomToken } from "@/lib/ids";
import { Money } from "@/lib/money";
import { assertCan, type PolicyContext } from "@/lib/auth/policy";
import { recordAudit } from "@/modules/audit/service";
import {
  getBalancesForGroups,
  getGroupBalances,
  type GroupBalances,
} from "@/modules/ledger/service";

// ---------------------------------------------------------------------------
// Membership context — every authorization decision starts here
// ---------------------------------------------------------------------------

export interface Membership extends PolicyContext {
  groupId: string;
  userId: string;
  memberId: string | null;
}

/**
 * Load everything the policy module needs to judge an action.
 *
 * Every group-scoped operation begins with this call, so there is exactly one
 * place that decides what a user is within a group. Returns a context with
 * `role: null` for non-members rather than throwing, so callers can render a
 * "you're not in this group" state instead of a 500.
 */
export async function getMembership(
  groupId: string,
  userId: string,
  executor: Transaction | typeof db = db,
): Promise<Membership | null> {
  const [group] = await executor
    .select({
      id: groups.id,
      status: groups.status,
      membersCanPropose: groupSettings.membersCanPropose,
    })
    .from(groups)
    .leftJoin(groupSettings, eq(groupSettings.groupId, groups.id))
    .where(eq(groups.id, groupId))
    .limit(1);

  if (!group) return null;

  const [member] = await executor
    .select({
      id: groupMembers.id,
      role: groupMembers.role,
      status: groupMembers.status,
    })
    .from(groupMembers)
    .where(
      and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)),
    )
    .limit(1);

  const [{ value: activeMemberCount }] = await executor
    .select({ value: count() })
    .from(groupMembers)
    .where(
      and(eq(groupMembers.groupId, groupId), eq(groupMembers.status, "ACTIVE")),
    );

  return {
    groupId,
    userId,
    memberId: member?.id ?? null,
    role: member?.role ?? null,
    isActive: member?.status === "ACTIVE",
    groupStatus: group.status,
    activeMemberCount,
    membersCanPropose: group.membersCanPropose ?? true,
  };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateGroupInput {
  name: string;
  description?: string | null;
  type: GroupType;
  contributionAmount: Money;
  cadence: Cadence;
  dueDay: number;
  membersCanPropose?: boolean;

  /**
   * Approval thresholds in permille (667 = 66.7%), overriding the defaults.
   *
   * Settable **only here**, at creation, while there is no money and no other
   * members to protect. Once the group is live, changing a threshold is itself
   * a governed action needing 75% — otherwise an admin could lower the release
   * bar to 1% and then empty the treasury alone, which would undo the one
   * guarantee the whole product makes.
   */
  governance?: Partial<Record<GovernedAction, number>>;

  /** Share of eligible voters who must respond, in percent. */
  quorumPct?: number;
}

/** Thresholds must be a real majority-ish share, never 0% or above 100%. */
export const MIN_THRESHOLD_PERMILLE = 500;
export const MAX_THRESHOLD_PERMILLE = 1000;

/**
 * Create a group, its settings, its default governance rules and its owner
 * membership — all in one transaction.
 *
 * Governance defaults are copied per group rather than referenced globally, so
 * a group's rules are a snapshot it controls, and changing the product's
 * defaults later never silently rewrites an existing group's constitution.
 */
export async function createGroup(
  ownerId: string,
  input: CreateGroupInput,
  meta: { ip?: string | null } = {},
): Promise<{ groupId: string }> {
  return db.transaction(async (tx) => {
    const [group] = await tx
      .insert(groups)
      .values({
        name: input.name.trim(),
        description: input.description?.trim() || null,
        type: input.type,
        ownerId,
      })
      .returning({ id: groups.id });

    await tx.insert(groupSettings).values({
      groupId: group.id,
      contributionAmount: input.contributionAmount.minor,
      cadence: input.cadence,
      dueDay: input.dueDay,
      membersCanPropose: input.membersCanPropose ?? true,
      quorumPct: clampQuorum(input.quorumPct),
    });

    // Every action gets a row, whether or not the creator chose a value for it.
    // A missing rule would silently fall back to a hard-coded default at vote
    // time, which is exactly the kind of invisible rule this table exists to
    // prevent — the group's constitution should be readable in one query.
    await tx.insert(governanceRules).values(
      (Object.keys(DEFAULT_GOVERNANCE) as GovernedAction[]).map((action) => ({
        groupId: group.id,
        action,
        thresholdPermille: clampThreshold(
          input.governance?.[action] ?? DEFAULT_GOVERNANCE[action],
        ),
      })),
    );

    await tx.insert(groupMembers).values({
      groupId: group.id,
      userId: ownerId,
      role: "OWNER",
      status: "ACTIVE",
      // The creator takes the first payout slot in a rotating group.
      rotationPosition: input.type === "ROTATING" ? 1 : null,
    });

    await recordAudit(tx, {
      action: "group.created",
      actorId: ownerId,
      actorIp: meta.ip,
      groupId: group.id,
      subjectType: "group",
      subjectId: group.id,
      after: {
        name: input.name,
        type: input.type,
        contributionAmount: input.contributionAmount.minor,
        cadence: input.cadence,
      },
    });

    return { groupId: group.id };
  });
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

export type CreateInviteResult =
  | { ok: true; code: string; expiresAt: Date }
  | { ok: false; reason: "forbidden" };

export async function createInvite(
  groupId: string,
  actorId: string,
  options: { email?: string | null; maxUses?: number } = {},
  meta: { ip?: string | null } = {},
): Promise<CreateInviteResult> {
  // Outsiders get an opaque failure — a group you aren't in should not be
  // distinguishable from one that doesn't exist. Members who simply lack the
  // role get a real error, because they're entitled to know why.
  const membership = await getMembership(groupId, actorId);
  if (!membership || membership.role === null) {
    return { ok: false, reason: "forbidden" };
  }
  assertCan("member.invite", membership);

  const code = randomToken(12);
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

  await db.transaction(async (tx) => {
    await tx.insert(groupInvites).values({
      groupId,
      code,
      createdBy: actorId,
      email: options.email?.trim().toLowerCase() || null,
      maxUses: options.maxUses ?? 1,
      expiresAt,
    });

    await recordAudit(tx, {
      action: "invite.created",
      actorId,
      actorIp: meta.ip,
      groupId,
      subjectType: "invite",
      subjectId: code,
      after: { email: options.email ?? null, maxUses: options.maxUses ?? 1 },
    });
  });

  return { ok: true, code, expiresAt };
}

export type InvitePreview = {
  groupId: string;
  groupName: string;
  groupType: GroupType;
  memberCount: number;
  contributionAmount: Money;
  cadence: Cadence;
};

/** What a prospective member sees before deciding to join. */
export async function previewInvite(code: string): Promise<InvitePreview | null> {
  const [row] = await db
    .select({
      groupId: groups.id,
      groupName: groups.name,
      groupType: groups.type,
      contributionAmount: groupSettings.contributionAmount,
      cadence: groupSettings.cadence,
      expiresAt: groupInvites.expiresAt,
      revokedAt: groupInvites.revokedAt,
      uses: groupInvites.uses,
      maxUses: groupInvites.maxUses,
      status: groups.status,
    })
    .from(groupInvites)
    .innerJoin(groups, eq(groups.id, groupInvites.groupId))
    .innerJoin(groupSettings, eq(groupSettings.groupId, groups.id))
    .where(eq(groupInvites.code, code))
    .limit(1);

  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  if (row.uses >= row.maxUses) return null;
  if (row.status !== "ACTIVE") return null;

  const [{ value: memberCount }] = await db
    .select({ value: count() })
    .from(groupMembers)
    .where(
      and(
        eq(groupMembers.groupId, row.groupId),
        eq(groupMembers.status, "ACTIVE"),
      ),
    );

  return {
    groupId: row.groupId,
    groupName: row.groupName,
    groupType: row.groupType,
    memberCount,
    contributionAmount: Money.fromMinor(row.contributionAmount),
    cadence: row.cadence,
  };
}

export type AcceptInviteResult =
  | { ok: true; groupId: string; alreadyMember: boolean }
  | {
      ok: false;
      reason: "not_found" | "expired" | "exhausted" | "revoked" | "wrong_email" | "removed";
    };

/**
 * Redeem an invite.
 *
 * The whole redemption is one transaction with the use-count incremented via a
 * conditional UPDATE, so two people clicking the last seat on a link at the
 * same moment cannot both get in.
 */
export async function acceptInvite(
  code: string,
  userId: string,
  meta: { ip?: string | null } = {},
): Promise<AcceptInviteResult> {
  return db.transaction(async (tx) => {
    const [invite] = await tx
      .select()
      .from(groupInvites)
      .where(eq(groupInvites.code, code))
      .limit(1);

    if (!invite) return { ok: false as const, reason: "not_found" as const };
    if (invite.revokedAt) return { ok: false as const, reason: "revoked" as const };
    if (invite.expiresAt.getTime() <= Date.now()) {
      return { ok: false as const, reason: "expired" as const };
    }

    // An invite addressed to a specific person is not transferable.
    if (invite.email) {
      const [user] = await tx
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!user || user.email !== invite.email) {
        return { ok: false as const, reason: "wrong_email" as const };
      }
    }

    const [existing] = await tx
      .select({ id: groupMembers.id, status: groupMembers.status })
      .from(groupMembers)
      .where(
        and(
          eq(groupMembers.groupId, invite.groupId),
          eq(groupMembers.userId, userId),
        ),
      )
      .limit(1);

    if (existing?.status === "ACTIVE") {
      return {
        ok: true as const,
        groupId: invite.groupId,
        alreadyMember: true,
      };
    }

    // Someone the group voted out cannot walk back in through a link.
    if (existing?.status === "REMOVED") {
      return { ok: false as const, reason: "removed" as const };
    }

    // Claim a seat. The WHERE clause is the concurrency guard: if another
    // request took the last use first, this updates zero rows.
    const claimed = await tx
      .update(groupInvites)
      .set({ uses: sql`${groupInvites.uses} + 1` })
      .where(
        and(
          eq(groupInvites.id, invite.id),
          sql`${groupInvites.uses} < ${groupInvites.maxUses}`,
        ),
      )
      .returning({ id: groupInvites.id });

    if (claimed.length === 0) {
      return { ok: false as const, reason: "exhausted" as const };
    }

    if (existing) {
      // Rejoining reactivates the original row so history stays attached.
      await tx
        .update(groupMembers)
        .set({ status: "ACTIVE", joinedAt: new Date(), exitedAt: null })
        .where(eq(groupMembers.id, existing.id));
    } else {
      await tx.insert(groupMembers).values({
        groupId: invite.groupId,
        userId,
        role: "MEMBER",
        status: "ACTIVE",
        rotationPosition: await nextRotationPosition(tx, invite.groupId),
      });
    }

    await recordAudit(tx, {
      action: "member.joined",
      actorId: userId,
      actorIp: meta.ip,
      groupId: invite.groupId,
      subjectType: "user",
      subjectId: userId,
      after: { via: "invite", code },
    });

    return {
      ok: true as const,
      groupId: invite.groupId,
      alreadyMember: false,
    };
  });
}

/**
 * Keep a chosen threshold inside a range that still means something.
 *
 * Below half is not a majority, and above 100% is unreachable — a group that
 * set either would have locked its own money away or handed it to a minority,
 * and would not find out until the first vote.
 */
function clampThreshold(permille: number): number {
  if (!Number.isFinite(permille)) return DEFAULT_GOVERNANCE.FUND_RELEASE_SMALL;
  return Math.min(
    MAX_THRESHOLD_PERMILLE,
    Math.max(MIN_THRESHOLD_PERMILLE, Math.round(permille)),
  );
}

/** Quorum of zero would let one voter decide; 100 would stall on one absence. */
function clampQuorum(pct: number | undefined): number {
  if (pct === undefined || !Number.isFinite(pct)) return 60;
  return Math.min(100, Math.max(1, Math.round(pct)));
}

/** Next free payout slot, or null for treasury groups where order is moot. */
async function nextRotationPosition(
  tx: Transaction,
  groupId: string,
): Promise<number | null> {
  const [group] = await tx
    .select({ type: groups.type })
    .from(groups)
    .where(eq(groups.id, groupId))
    .limit(1);

  if (group?.type !== "ROTATING") return null;

  const [row] = await tx
    .select({ highest: sql<number | null>`max(${groupMembers.rotationPosition})` })
    .from(groupMembers)
    .where(eq(groupMembers.groupId, groupId));

  return (row?.highest ?? 0) + 1;
}

export async function revokeInvite(
  groupId: string,
  code: string,
  actorId: string,
  meta: { ip?: string | null } = {},
): Promise<{ ok: boolean }> {
  const membership = await getMembership(groupId, actorId);
  if (!membership || membership.role === null) return { ok: false };
  assertCan("member.invite", membership);

  await db.transaction(async (tx) => {
    await tx
      .update(groupInvites)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(groupInvites.code, code),
          eq(groupInvites.groupId, groupId),
          isNull(groupInvites.revokedAt),
        ),
      );

    await recordAudit(tx, {
      action: "invite.revoked",
      actorId,
      actorIp: meta.ip,
      groupId,
      subjectType: "invite",
      subjectId: code,
    });
  });

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Membership changes
// ---------------------------------------------------------------------------

export type RoleChangeResult =
  | { ok: true }
  | { ok: false; reason: "not_a_member" | "target_not_found" | "forbidden" };

/**
 * Grant admin. Owner-only, and deliberately one-directional: revoking admin is
 * governed (see the policy module), so an owner cannot strip dissenting admins
 * ahead of a vote.
 */
export async function grantAdmin(
  groupId: string,
  actorId: string,
  targetUserId: string,
  meta: { ip?: string | null } = {},
): Promise<RoleChangeResult> {
  const membership = await getMembership(groupId, actorId);
  if (!membership) return { ok: false, reason: "not_a_member" };
  assertCan("role.grant_admin", membership);

  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({ id: groupMembers.id, role: groupMembers.role })
      .from(groupMembers)
      .where(
        and(
          eq(groupMembers.groupId, groupId),
          eq(groupMembers.userId, targetUserId),
          eq(groupMembers.status, "ACTIVE"),
        ),
      )
      .limit(1);

    if (!target) return { ok: false as const, reason: "target_not_found" as const };
    if (target.role !== "MEMBER") return { ok: true as const };

    await tx
      .update(groupMembers)
      .set({ role: "ADMIN" })
      .where(eq(groupMembers.id, target.id));

    await recordAudit(tx, {
      action: "member.role_changed",
      actorId,
      actorIp: meta.ip,
      groupId,
      subjectType: "user",
      subjectId: targetUserId,
      before: { role: target.role },
      after: { role: "ADMIN" },
    });

    return { ok: true as const };
  });
}

export type RemoveMemberResult =
  | { ok: true }
  | { ok: false; reason: "not_a_member" | "target_not_found" };

/**
 * Remove a member directly. Only reachable in groups below the governed-removal
 * threshold — the policy module refuses otherwise, and larger groups must go
 * through a proposal.
 */
export async function removeMember(
  groupId: string,
  actorId: string,
  targetUserId: string,
  meta: { ip?: string | null } = {},
): Promise<RemoveMemberResult> {
  const membership = await getMembership(groupId, actorId);
  if (!membership) return { ok: false, reason: "not_a_member" };

  const [target] = await db
    .select({ id: groupMembers.id, role: groupMembers.role })
    .from(groupMembers)
    .where(
      and(
        eq(groupMembers.groupId, groupId),
        eq(groupMembers.userId, targetUserId),
        eq(groupMembers.status, "ACTIVE"),
      ),
    )
    .limit(1);

  if (!target) return { ok: false, reason: "target_not_found" };

  assertCan("member.remove", {
    ...membership,
    targetIsSelf: targetUserId === actorId,
    targetRole: target.role,
  });

  await db.transaction(async (tx) => {
    await tx
      .update(groupMembers)
      .set({ status: "REMOVED", exitedAt: new Date(), rotationPosition: null })
      .where(eq(groupMembers.id, target.id));

    await recordAudit(tx, {
      action: "member.removed",
      actorId,
      actorIp: meta.ip,
      groupId,
      subjectType: "user",
      subjectId: targetUserId,
      before: { role: target.role, status: "ACTIVE" },
      after: { status: "REMOVED" },
    });
  });

  return { ok: true };
}

export type LeaveGroupResult =
  | { ok: true }
  | { ok: false; reason: "not_a_member" | "owner_must_transfer" };

/**
 * Leave voluntarily.
 *
 * The owner cannot simply walk out — someone must hold the group, and an
 * ownerless group has nobody who can grant admin. Transferring ownership first
 * is a deliberate, separate step.
 */
export async function leaveGroup(
  groupId: string,
  userId: string,
  meta: { ip?: string | null } = {},
): Promise<LeaveGroupResult> {
  const membership = await getMembership(groupId, userId);
  if (!membership || !membership.isActive || !membership.memberId) {
    return { ok: false, reason: "not_a_member" };
  }
  if (membership.role === "OWNER") {
    return { ok: false, reason: "owner_must_transfer" };
  }

  await db.transaction(async (tx) => {
    await tx
      .update(groupMembers)
      .set({ status: "LEFT", exitedAt: new Date(), rotationPosition: null })
      .where(eq(groupMembers.id, membership.memberId!));

    await recordAudit(tx, {
      action: "member.left",
      actorId: userId,
      actorIp: meta.ip,
      groupId,
      subjectType: "user",
      subjectId: userId,
      before: { role: membership.role },
    });
  });

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface GroupSummary {
  id: string;
  name: string;
  type: GroupType;
  role: MemberRole;
  memberCount: number;
  contributionAmount: Money;
  cadence: Cadence;
  status: "ACTIVE" | "DISSOLVING" | "DISSOLVED";
  /** Live from the ledger. Zero for a group that has never received money. */
  balance: GroupBalances;
}

/** Every group the user actively belongs to, for the home screen. */
export async function listGroupsForUser(userId: string): Promise<GroupSummary[]> {
  const rows = await db
    .select({
      id: groups.id,
      name: groups.name,
      type: groups.type,
      status: groups.status,
      role: groupMembers.role,
      contributionAmount: groupSettings.contributionAmount,
      cadence: groupSettings.cadence,
      memberCount: sql<number>`(
        select count(*) from ${groupMembers} m
        where m.group_id = ${groups.id} and m.status = 'ACTIVE'
      )`,
    })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .innerJoin(groupSettings, eq(groupSettings.groupId, groups.id))
    .where(
      and(
        eq(groupMembers.userId, userId),
        eq(groupMembers.status, "ACTIVE"),
        or(eq(groups.status, "ACTIVE"), eq(groups.status, "DISSOLVING")),
      ),
    )
    .orderBy(asc(groups.createdAt));

  // One balance query for all of them rather than one per card.
  const balances = await getBalancesForGroups(rows.map((r) => r.id));

  return rows.map((row) => ({
    ...row,
    memberCount: Number(row.memberCount),
    contributionAmount: Money.fromMinor(row.contributionAmount),
    balance: balances.get(row.id) ?? {
      available: Money.zero(),
      locked: Money.zero(),
      total: Money.zero(),
    },
  }));
}

export interface MemberView {
  userId: string;
  memberId: string;
  displayName: string;
  avatarUrl: string | null;
  role: MemberRole;
  rotationPosition: number | null;
  joinedAt: Date;
}

export async function listMembers(
  groupId: string,
  viewerId: string,
): Promise<MemberView[] | null> {
  // A non-member gets null, not an error: from outside, a group they aren't in
  // is indistinguishable from one that doesn't exist. Mirrors getGroupDetail.
  const membership = await getMembership(groupId, viewerId);
  if (!membership || membership.role === null) return null;
  assertCan("group.view", membership);

  const rows = await db
    .select({
      userId: users.id,
      memberId: groupMembers.id,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      role: groupMembers.role,
      rotationPosition: groupMembers.rotationPosition,
      joinedAt: groupMembers.joinedAt,
    })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(
      and(eq(groupMembers.groupId, groupId), eq(groupMembers.status, "ACTIVE")),
    )
    .orderBy(asc(groupMembers.rotationPosition), asc(groupMembers.joinedAt));

  return rows;
}

export interface GroupDetail extends GroupSummary {
  description: string | null;
  membersCanPropose: boolean;
  quorumPct: number;
  dueDay: number;
  governance: { action: string; thresholdPermille: number }[];
}

export async function getGroupDetail(
  groupId: string,
  viewerId: string,
): Promise<GroupDetail | null> {
  const membership = await getMembership(groupId, viewerId);
  if (!membership || membership.role === null) return null;
  assertCan("group.view", membership);

  const [row] = await db
    .select({
      id: groups.id,
      name: groups.name,
      description: groups.description,
      type: groups.type,
      status: groups.status,
      contributionAmount: groupSettings.contributionAmount,
      cadence: groupSettings.cadence,
      dueDay: groupSettings.dueDay,
      membersCanPropose: groupSettings.membersCanPropose,
      quorumPct: groupSettings.quorumPct,
    })
    .from(groups)
    .innerJoin(groupSettings, eq(groupSettings.groupId, groups.id))
    .where(eq(groups.id, groupId))
    .limit(1);

  if (!row) return null;

  const governance = await db
    .select({
      action: governanceRules.action,
      thresholdPermille: governanceRules.thresholdPermille,
    })
    .from(governanceRules)
    .where(eq(governanceRules.groupId, groupId))
    .orderBy(asc(governanceRules.action));

  return {
    ...row,
    role: membership.role,
    memberCount: membership.activeMemberCount,
    contributionAmount: Money.fromMinor(row.contributionAmount),
    balance: await getGroupBalances(groupId),
    governance,
  };
}
