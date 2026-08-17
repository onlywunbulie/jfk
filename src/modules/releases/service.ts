import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { db, type Transaction } from "@/lib/db";
import {
  fundReleases,
  proposals,
  users,
  type ReleaseStatus,
} from "@/lib/db/schema";
import { Money } from "@/lib/money";
import { assertCan } from "@/lib/auth/policy";
import { getMembership } from "@/modules/groups/service";
import { postPayout, releaseReservation } from "@/modules/ledger/operations";
import { recordAudit } from "@/modules/audit/service";

/**
 * Releasing money. See BLUEPRINT.md §8 step 8.
 *
 * This is the last step of the money story and the one the whole product
 * exists to constrain. Two things guard it:
 *
 *   1. `fund_releases.proposal_id` is NOT NULL and UNIQUE. A release without
 *      an approved proposal cannot be written to the database, and one
 *      proposal can authorise exactly one release.
 *   2. Execution is a **separate deliberate step** from approval. A passed
 *      vote reserves the money; a human still has to press the button.
 *
 * Two routes out, both behind the same gate:
 *
 *   - **Transfer** — the provider moves the money. Simulated in this build.
 *   - **Manual** — a human moved it at their bank and recorded it here. The
 *     books stay honest when automatic transfers are unavailable, which for a
 *     small group is the common case.
 */

export type ExecuteResult =
  | { ok: true; releaseId: string; status: ReleaseStatus; amount: Money }
  | {
      ok: false;
      reason:
        | "not_a_member"
        | "not_found"
        | "not_approved"
        | "already_released"
        | "nothing_to_release"
        | "transfer_failed";
      message: string;
    };

export interface ExecuteOptions {
  /** True when a human moved the money themselves and is recording it. */
  manual?: boolean;
  /** Force the simulated transfer to fail, to exercise the reversal path. */
  simulateFailure?: boolean;
}

/**
 * Execute an approved proposal.
 *
 * The money was already moved from available to locked when the vote passed.
 * This spends that reservation: locked goes down, and the money leaves the
 * platform. If the transfer fails, the reservation is handed straight back so
 * the group's available balance returns to exactly what it was.
 */
export async function executeRelease(
  proposalId: string,
  actorId: string,
  options: ExecuteOptions = {},
): Promise<ExecuteResult> {
  const [proposal] = await db
    .select()
    .from(proposals)
    .where(eq(proposals.id, proposalId))
    .limit(1);

  if (!proposal) {
    return { ok: false, reason: "not_found", message: "Proposal not found." };
  }

  const membership = await getMembership(proposal.groupId, actorId);
  if (!membership || membership.role === null) {
    return {
      ok: false,
      reason: "not_a_member",
      message: "You're not a member of this group.",
    };
  }

  // Admins execute; the group decides. Both are required, neither is enough.
  assertCan("proposal.execute", membership);

  if (proposal.status !== "APPROVED") {
    return {
      ok: false,
      reason: proposal.status === "EXECUTED" ? "already_released" : "not_approved",
      message:
        proposal.status === "EXECUTED"
          ? "This has already been paid out."
          : "Only a proposal the group approved can be paid out.",
    };
  }

  if (!proposal.amount || proposal.amount <= 0n) {
    return {
      ok: false,
      reason: "nothing_to_release",
      message: "This proposal doesn't move any money.",
    };
  }

  const amount = Money.fromMinor(proposal.amount);
  const destination = proposal.destination ?? "Unspecified destination";

  /**
   * One release per proposal, enforced by a unique index. A previous attempt
   * that failed has already used that slot, so retrying means putting the
   * spend back to the group rather than pressing the button again.
   *
   * That is deliberate. A failed payout returns the money to available, where
   * another proposal could legitimately claim it — so the group should
   * re-confirm rather than have an admin silently re-spend it later.
   */
  const previous = await getReleaseForProposal(proposalId);
  if (previous) {
    return {
      ok: false,
      reason: "already_released",
      message:
        previous.status === "FAILED"
          ? "That payout already failed once. Raise a new proposal to try again."
          : "This has already been paid out.",
    };
  }

  // Claim the proposal so two admins pressing at once cannot both execute.
  const claimed = await db
    .update(proposals)
    .set({ status: "EXECUTING" })
    .where(and(eq(proposals.id, proposalId), eq(proposals.status, "APPROVED")))
    .returning({ id: proposals.id });

  if (claimed.length === 0) {
    return {
      ok: false,
      reason: "already_released",
      message: "Someone else is already paying this out.",
    };
  }

  const [release] = await db
    .insert(fundReleases)
    .values({
      groupId: proposal.groupId,
      proposalId,
      amount: proposal.amount,
      destination,
      status: "EXECUTING",
      recordedManually: options.manual ?? false,
      executedBy: actorId,
    })
    .returning({ id: fundReleases.id });

  // A manual release is a statement of fact: the human already moved it.
  // A transfer is simulated here; a live provider call would go in its place
  // and settle on the webhook instead.
  const succeeded = options.manual ? true : !options.simulateFailure;

  if (!succeeded) {
    return failRelease(
      release.id,
      proposalId,
      proposal.groupId,
      amount,
      actorId,
      "The transfer was declined by the provider.",
    );
  }

  await db.transaction(async (tx) => {
    await postPayout(
      {
        groupId: proposal.groupId,
        amount,
        releaseId: release.id,
        destination,
      },
      tx,
    );

    await tx
      .update(fundReleases)
      .set({ status: "EXECUTED", executedAt: new Date() })
      .where(eq(fundReleases.id, release.id));

    await tx
      .update(proposals)
      .set({ status: "EXECUTED", executedAt: new Date() })
      .where(eq(proposals.id, proposalId));

    await recordAudit(tx, {
      action: "funds.released",
      actorId,
      groupId: proposal.groupId,
      subjectType: "release",
      subjectId: release.id,
      after: {
        amount: amount.minor,
        destination,
        manual: options.manual ?? false,
        proposalId,
      },
    });
  });

  return { ok: true, releaseId: release.id, status: "EXECUTED", amount };
}

/**
 * Hand the reservation back and mark everything failed.
 *
 * The group's available balance must return to exactly what it was before the
 * proposal passed — a failed payout should leave no trace on the balance, only
 * in the history.
 */
async function failRelease(
  releaseId: string,
  proposalId: string,
  groupId: string,
  amount: Money,
  actorId: string,
  reason: string,
): Promise<ExecuteResult> {
  await db.transaction(async (tx) => {
    await releaseReservation(
      { groupId, amount, proposalId, reason: "payout failed" },
      tx,
    );

    await tx
      .update(fundReleases)
      .set({ status: "FAILED", failureReason: reason })
      .where(eq(fundReleases.id, releaseId));

    // Back to APPROVED, not REJECTED: the group said yes, and they should be
    // able to try again without voting a second time.
    await tx
      .update(proposals)
      .set({ status: "APPROVED", outcomeReason: `Payout failed: ${reason}` })
      .where(eq(proposals.id, proposalId));

    await recordAudit(tx, {
      action: "proposal.executed",
      actorId,
      groupId,
      subjectType: "release",
      subjectId: releaseId,
      after: { failed: true, reason, amount: amount.minor },
    });
  });

  return { ok: false, reason: "transfer_failed", message: reason };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ReleaseView {
  id: string;
  amount: Money;
  destination: string;
  status: ReleaseStatus;
  recordedManually: boolean;
  executedByName: string | null;
  executedAt: Date | null;
  failureReason: string | null;
  proposalId: string;
  proposalTitle: string;
}

export async function listReleases(
  groupId: string,
  viewerId: string,
): Promise<ReleaseView[] | null> {
  const membership = await getMembership(groupId, viewerId);
  if (!membership || membership.role === null) return null;

  const rows = await db
    .select({
      id: fundReleases.id,
      amount: fundReleases.amount,
      destination: fundReleases.destination,
      status: fundReleases.status,
      recordedManually: fundReleases.recordedManually,
      executedAt: fundReleases.executedAt,
      failureReason: fundReleases.failureReason,
      proposalId: fundReleases.proposalId,
      proposalTitle: proposals.title,
      executedByName: users.displayName,
    })
    .from(fundReleases)
    .innerJoin(proposals, eq(proposals.id, fundReleases.proposalId))
    .leftJoin(users, eq(users.id, fundReleases.executedBy))
    .where(eq(fundReleases.groupId, groupId))
    .orderBy(desc(fundReleases.createdAt));

  return rows.map((row) => ({
    ...row,
    amount: Money.fromMinor(row.amount),
  }));
}

/** The release attached to one proposal, if it has one. */
export async function getReleaseForProposal(
  proposalId: string,
  executor: Transaction | typeof db = db,
): Promise<ReleaseView | null> {
  const [row] = await executor
    .select({
      id: fundReleases.id,
      amount: fundReleases.amount,
      destination: fundReleases.destination,
      status: fundReleases.status,
      recordedManually: fundReleases.recordedManually,
      executedAt: fundReleases.executedAt,
      failureReason: fundReleases.failureReason,
      proposalId: fundReleases.proposalId,
      proposalTitle: proposals.title,
      executedByName: users.displayName,
    })
    .from(fundReleases)
    .innerJoin(proposals, eq(proposals.id, fundReleases.proposalId))
    .leftJoin(users, eq(users.id, fundReleases.executedBy))
    .where(eq(fundReleases.proposalId, proposalId))
    .limit(1);

  return row ? { ...row, amount: Money.fromMinor(row.amount) } : null;
}
