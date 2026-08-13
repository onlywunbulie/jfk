import "server-only";
import { and, asc, count, desc, eq, inArray, lte, ne, sql } from "drizzle-orm";
import { db, type Transaction } from "@/lib/db";
import {
  contributionCycles,
  contributions,
  groupMembers,
  groupSettings,
  groups,
  users,
  type Cadence,
  type ContributionStatus,
  type GroupType,
} from "@/lib/db/schema";
import { Money } from "@/lib/money";
import { recordAudit } from "@/modules/audit/service";
import { cyclePeriodFor, nextPeriod, type CyclePeriod } from "./schedule";

/**
 * Cycles and obligations. See BLUEPRINT.md §6.
 *
 * A cycle is one period of a group's schedule. Opening it snapshots the
 * contribution amount and creates one obligation per active member, so a later
 * rule change never rewrites what people already owed.
 */

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

export interface OpenCycleResult {
  cycleId: string;
  sequenceNo: number;
  created: boolean;
  obligations: number;
  expectedTotal: Money;
}

/**
 * Open the cycle covering `asOf`, if it does not already exist.
 *
 * Idempotent through the unique index on (group, sequence_no): running the
 * scheduler twice in a day cannot produce two March cycles or two obligations
 * for the same member.
 */
export async function openCycleFor(
  groupId: string,
  asOf: Date = new Date(),
  executor?: Transaction,
): Promise<OpenCycleResult | null> {
  const run = async (tx: Transaction): Promise<OpenCycleResult | null> => {
    const [group] = await tx
      .select({
        id: groups.id,
        type: groups.type,
        status: groups.status,
        cadence: groupSettings.cadence,
        dueDay: groupSettings.dueDay,
        graceDays: groupSettings.graceDays,
        amount: groupSettings.contributionAmount,
      })
      .from(groups)
      .innerJoin(groupSettings, eq(groupSettings.groupId, groups.id))
      .where(eq(groups.id, groupId))
      .limit(1);

    if (!group || group.status !== "ACTIVE") return null;
    // A group with no contribution amount set has nothing to collect.
    if (group.amount <= 0n) return null;

    const config = {
      cadence: group.cadence,
      dueDay: group.dueDay,
      graceDays: group.graceDays,
    };

    const period = await periodToOpen(tx, groupId, asOf, config);
    if (!period) return null;

    const [last] = await tx
      .select({ sequenceNo: contributionCycles.sequenceNo })
      .from(contributionCycles)
      .where(eq(contributionCycles.groupId, groupId))
      .orderBy(desc(contributionCycles.sequenceNo))
      .limit(1);

    const sequenceNo = (last?.sequenceNo ?? 0) + 1;

    const members = await tx
      .select({ id: groupMembers.id, userId: groupMembers.userId })
      .from(groupMembers)
      .where(
        and(eq(groupMembers.groupId, groupId), eq(groupMembers.status, "ACTIVE")),
      );

    if (members.length === 0) return null;

    const amount = Money.fromMinor(group.amount);
    const expectedTotal = amount.times(members.length);

    const [cycle] = await tx
      .insert(contributionCycles)
      .values({
        groupId,
        sequenceNo,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        dueAt: period.dueAt,
        gracePeriodEndsAt: period.gracePeriodEndsAt,
        status: "OPEN",
        contributionAmount: amount.minor,
        expectedTotal: expectedTotal.minor,
        beneficiaryMemberId:
          group.type === "ROTATING"
            ? await nextBeneficiary(tx, groupId)
            : null,
      })
      .onConflictDoNothing()
      .returning({ id: contributionCycles.id });

    // Another run got there first.
    if (!cycle) {
      const [existing] = await tx
        .select({ id: contributionCycles.id })
        .from(contributionCycles)
        .where(
          and(
            eq(contributionCycles.groupId, groupId),
            eq(contributionCycles.sequenceNo, sequenceNo),
          ),
        )
        .limit(1);

      return {
        cycleId: existing.id,
        sequenceNo,
        created: false,
        obligations: 0,
        expectedTotal,
      };
    }

    await tx.insert(contributions).values(
      members.map((member) => ({
        cycleId: cycle.id,
        groupId,
        memberId: member.id,
        userId: member.userId,
        amount: amount.minor,
        status: "PENDING" as const,
      })),
    );

    await recordAudit(tx, {
      action: "cycle.opened",
      groupId,
      subjectType: "cycle",
      subjectId: cycle.id,
      after: {
        sequenceNo,
        members: members.length,
        expectedTotal: expectedTotal.minor,
      },
    });

    return {
      cycleId: cycle.id,
      sequenceNo,
      created: true,
      obligations: members.length,
      expectedTotal,
    };
  };

  return executor ? run(executor) : db.transaction(run);
}

/**
 * Which period, if any, should be opened now.
 *
 * Returns null when the current period already has a cycle. When a group has
 * been idle and several periods have passed, this deliberately opens only the
 * *next* one rather than back-filling — retroactively billing people for
 * months the app was asleep would be indefensible.
 */
async function periodToOpen(
  tx: Transaction,
  groupId: string,
  asOf: Date,
  config: { cadence: Cadence; dueDay: number; graceDays: number },
): Promise<CyclePeriod | null> {
  const [latest] = await tx
    .select({
      periodStart: contributionCycles.periodStart,
      periodEnd: contributionCycles.periodEnd,
      dueAt: contributionCycles.dueAt,
      gracePeriodEndsAt: contributionCycles.gracePeriodEndsAt,
    })
    .from(contributionCycles)
    .where(eq(contributionCycles.groupId, groupId))
    .orderBy(desc(contributionCycles.sequenceNo))
    .limit(1);

  const current = cyclePeriodFor(asOf, config);

  if (!latest) return current;

  // Already covered.
  if (latest.periodEnd.getTime() > asOf.getTime()) return null;

  const following = nextPeriod(latest, config);

  // If the app was idle for months, jump to the period we are actually in
  // rather than opening every one we missed.
  return following.periodEnd.getTime() <= asOf.getTime() ? current : following;
}

/** Whose turn it is in a rotating group: lowest position not yet paid out. */
async function nextBeneficiary(
  tx: Transaction,
  groupId: string,
): Promise<string | null> {
  const paidOut = await tx
    .select({ memberId: contributionCycles.beneficiaryMemberId })
    .from(contributionCycles)
    .where(
      and(
        eq(contributionCycles.groupId, groupId),
        eq(contributionCycles.status, "SETTLED"),
      ),
    );

  const collected = paidOut
    .map((row) => row.memberId)
    .filter((id): id is string => id !== null);

  const candidates = await tx
    .select({ id: groupMembers.id })
    .from(groupMembers)
    .where(
      and(
        eq(groupMembers.groupId, groupId),
        eq(groupMembers.status, "ACTIVE"),
        collected.length > 0
          ? sql`${groupMembers.id} not in ${collected}`
          : sql`true`,
      ),
    )
    .orderBy(asc(groupMembers.rotationPosition), asc(groupMembers.joinedAt))
    .limit(1);

  // Everyone has collected — the rotation starts again from the top.
  if (candidates.length === 0) {
    const [first] = await tx
      .select({ id: groupMembers.id })
      .from(groupMembers)
      .where(
        and(eq(groupMembers.groupId, groupId), eq(groupMembers.status, "ACTIVE")),
      )
      .orderBy(asc(groupMembers.rotationPosition), asc(groupMembers.joinedAt))
      .limit(1);
    return first?.id ?? null;
  }

  return candidates[0].id;
}

// ---------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------

export interface CloseCycleResult {
  cycleId: string;
  missed: number;
  collected: Money;
  fullyFunded: boolean;
  /** Set for a rotating cycle that closed fully funded and is ready to pay out. */
  payoutDue: { beneficiaryMemberId: string; amount: Money } | null;
}

/**
 * Close a cycle whose grace period has passed.
 *
 * Anything still unpaid becomes MISSED — the member is in arrears. The
 * obligation is not deleted: arrears are a fact about the group's history, not
 * something to tidy away.
 */
export async function closeCycle(
  cycleId: string,
  asOf: Date = new Date(),
  executor?: Transaction,
): Promise<CloseCycleResult | null> {
  const run = async (tx: Transaction): Promise<CloseCycleResult | null> => {
    const [cycle] = await tx
      .select()
      .from(contributionCycles)
      .where(eq(contributionCycles.id, cycleId))
      .limit(1);

    if (!cycle || cycle.status === "CLOSED" || cycle.status === "SETTLED") {
      return null;
    }
    if (cycle.gracePeriodEndsAt.getTime() > asOf.getTime()) return null;

    const stillOwing = await tx
      .update(contributions)
      .set({ status: "MISSED" })
      .where(
        and(
          eq(contributions.cycleId, cycleId),
          inArray(contributions.status, ["PENDING", "FAILED", "PROCESSING"]),
        ),
      )
      .returning({ id: contributions.id });

    const [totals] = await tx
      .select({
        paid: sql<string>`coalesce(sum(case when ${contributions.status} = 'PAID' then ${contributions.amount} else 0 end), 0)`,
        outstanding: count(
          sql`case when ${contributions.status} = 'MISSED' then 1 end`,
        ),
      })
      .from(contributions)
      .where(eq(contributions.cycleId, cycleId));

    const collected = Money.fromMinor(BigInt(totals.paid));
    const fullyFunded = stillOwing.length === 0;

    await tx
      .update(contributionCycles)
      .set({ status: "CLOSED", closedAt: asOf })
      .where(eq(contributionCycles.id, cycleId));

    await recordAudit(tx, {
      action: "cycle.closed",
      groupId: cycle.groupId,
      subjectType: "cycle",
      subjectId: cycleId,
      after: {
        missed: stillOwing.length,
        collected: collected.minor,
        fullyFunded,
      },
    });

    const [group] = await tx
      .select({ type: groups.type })
      .from(groups)
      .where(eq(groups.id, cycle.groupId))
      .limit(1);

    // Rotating payout only when the pot is complete. An underfunded cycle
    // delays rather than short-changing whoever's turn it is — see
    // BLUEPRINT.md §22 decision 4.
    const payoutDue =
      group?.type === "ROTATING" && fullyFunded && cycle.beneficiaryMemberId
        ? { beneficiaryMemberId: cycle.beneficiaryMemberId, amount: collected }
        : null;

    return {
      cycleId,
      missed: stillOwing.length,
      collected,
      fullyFunded,
      payoutDue,
    };
  };

  return executor ? run(executor) : db.transaction(run);
}

/** Cycles past their grace period that are still open. */
export async function findCyclesToClose(asOf: Date = new Date()) {
  return db
    .select({ id: contributionCycles.id, groupId: contributionCycles.groupId })
    .from(contributionCycles)
    .where(
      and(
        eq(contributionCycles.status, "OPEN"),
        lte(contributionCycles.gracePeriodEndsAt, asOf),
      ),
    );
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ContributionView {
  id: string;
  userId: string;
  displayName: string;
  amount: Money;
  status: ContributionStatus;
  attemptCount: number;
  lastFailureReason: string | null;
  paidAt: Date | null;
  isYou: boolean;
}

export interface CycleView {
  id: string;
  sequenceNo: number;
  periodStart: Date;
  periodEnd: Date;
  dueAt: Date;
  gracePeriodEndsAt: Date;
  status: string;
  cadence: Cadence;
  groupType: GroupType;
  contributionAmount: Money;
  expectedTotal: Money;
  collected: Money;
  beneficiaryName: string | null;
  contributions: ContributionView[];
  /** The viewer's own obligation, if they have one this cycle. */
  yours: ContributionView | null;
}

/** The current cycle for a group, with everyone's status. */
export async function getCurrentCycle(
  groupId: string,
  viewerId: string,
): Promise<CycleView | null> {
  const [cycle] = await db
    .select({
      id: contributionCycles.id,
      sequenceNo: contributionCycles.sequenceNo,
      periodStart: contributionCycles.periodStart,
      periodEnd: contributionCycles.periodEnd,
      dueAt: contributionCycles.dueAt,
      gracePeriodEndsAt: contributionCycles.gracePeriodEndsAt,
      status: contributionCycles.status,
      contributionAmount: contributionCycles.contributionAmount,
      expectedTotal: contributionCycles.expectedTotal,
      beneficiaryMemberId: contributionCycles.beneficiaryMemberId,
      cadence: groupSettings.cadence,
      groupType: groups.type,
    })
    .from(contributionCycles)
    .innerJoin(groups, eq(groups.id, contributionCycles.groupId))
    .innerJoin(groupSettings, eq(groupSettings.groupId, groups.id))
    .where(eq(contributionCycles.groupId, groupId))
    .orderBy(desc(contributionCycles.sequenceNo))
    .limit(1);

  if (!cycle) return null;

  const rows = await db
    .select({
      id: contributions.id,
      userId: contributions.userId,
      displayName: users.displayName,
      amount: contributions.amount,
      status: contributions.status,
      attemptCount: contributions.attemptCount,
      lastFailureReason: contributions.lastFailureReason,
      paidAt: contributions.paidAt,
    })
    .from(contributions)
    .innerJoin(users, eq(users.id, contributions.userId))
    .where(eq(contributions.cycleId, cycle.id))
    .orderBy(asc(users.displayName));

  const views: ContributionView[] = rows.map((row) => ({
    ...row,
    amount: Money.fromMinor(row.amount),
    isYou: row.userId === viewerId,
  }));

  const collected = views
    .filter((v) => v.status === "PAID")
    .reduce((sum, v) => sum.plus(v.amount), Money.zero());

  let beneficiaryName: string | null = null;
  if (cycle.beneficiaryMemberId) {
    const [beneficiary] = await db
      .select({ name: users.displayName })
      .from(groupMembers)
      .innerJoin(users, eq(users.id, groupMembers.userId))
      .where(eq(groupMembers.id, cycle.beneficiaryMemberId))
      .limit(1);
    beneficiaryName = beneficiary?.name ?? null;
  }

  return {
    ...cycle,
    contributionAmount: Money.fromMinor(cycle.contributionAmount),
    expectedTotal: Money.fromMinor(cycle.expectedTotal),
    collected,
    beneficiaryName,
    contributions: views,
    yours: views.find((v) => v.isYou) ?? null,
  };
}

export interface ArrearsRow {
  userId: string;
  displayName: string;
  missedCount: number;
  totalOwed: Money;
}

/** Who is behind, and by how much. Visible but not humiliating. */
export async function getArrears(groupId: string): Promise<ArrearsRow[]> {
  const rows = await db
    .select({
      userId: contributions.userId,
      displayName: users.displayName,
      missedCount: count(),
      totalOwed: sql<string>`coalesce(sum(${contributions.amount}), 0)`,
    })
    .from(contributions)
    .innerJoin(users, eq(users.id, contributions.userId))
    .where(
      and(eq(contributions.groupId, groupId), eq(contributions.status, "MISSED")),
    )
    .groupBy(contributions.userId, users.displayName)
    .orderBy(desc(count()));

  return rows.map((row) => ({
    userId: row.userId,
    displayName: row.displayName,
    missedCount: Number(row.missedCount),
    totalOwed: Money.fromMinor(BigInt(row.totalOwed)),
  }));
}

/** Groups that may need a cycle opened. */
export async function findGroupsNeedingCycles() {
  return db
    .select({ id: groups.id, name: groups.name })
    .from(groups)
    .innerJoin(groupSettings, eq(groupSettings.groupId, groups.id))
    .where(and(eq(groups.status, "ACTIVE"), ne(groupSettings.contributionAmount, 0n)));
}
