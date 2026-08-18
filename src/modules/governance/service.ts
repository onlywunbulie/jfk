import "server-only";
import { and, asc, count, desc, eq, lte, sql } from "drizzle-orm";
import { db, type Transaction } from "@/lib/db";
import {
  governanceRules,
  groupMembers,
  groupSettings,
  proposals,
  users,
  votes,
  DEFAULT_VOTE_DAYS,
  LARGE_RELEASE_SHARE_PERMILLE,
  type GovernedAction,
  type ProposalStatus,
  type VoteChoice,
} from "@/lib/db/schema";
import { Money } from "@/lib/money";
import { assertCan } from "@/lib/auth/policy";
import { getMembership } from "@/modules/groups/service";
import { getGroupBalances } from "@/modules/ledger/service";
import { reserveForProposal } from "@/modules/ledger/operations";
import { recordAudit } from "@/modules/audit/service";
import { evaluate, whatIsNeeded, type ProposalOutcome } from "./threshold";
import {
  KIND_ACTION,
  isRuleChange,
  parsePayload,
  type ProposalKind,
  type ProposalPayload,
} from "./kinds";
import { applyProposalPayload } from "./apply";

/**
 * Proposals and voting. See BLUEPRINT.md §9.
 *
 * The one rule everything here protects: **money leaves a group only when the
 * group votes for it.** A proposal that passes immediately reserves the funds
 * it intends to spend, so two approved proposals can never draw on the same
 * naira — the second fails at approval, when it is cheap, rather than at
 * payout, when it is not.
 */

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

export interface CreateProposalInput {
  groupId: string;
  title: string;
  reason: string;
  /** Defaults to a spend, which is what most proposals are. */
  kind?: ProposalKind;
  /** Required for spending proposals. */
  amount?: Money;
  destination?: string;
  /** What to change when this passes. Ignored for spends. */
  payload?: ProposalPayload;
  voteDays?: number;
}

export type CreateProposalResult =
  | { ok: true; proposalId: string; action: GovernedAction }
  | {
      ok: false;
      reason: "not_a_member" | "amount_required" | "insufficient_funds" | "no_members";
      message: string;
    };

/**
 * Open a proposal for the group to vote on.
 *
 * The threshold, quorum and eligible-voter count are **snapshotted here**.
 * Without that, adding a member or editing the rules mid-vote would silently
 * change the answer to a question people had already answered.
 */
export async function createProposal(
  actorId: string,
  input: CreateProposalInput,
): Promise<CreateProposalResult> {
  const membership = await getMembership(input.groupId, actorId);
  if (!membership || membership.role === null) {
    return {
      ok: false,
      reason: "not_a_member",
      message: "You're not a member of this group.",
    };
  }

  assertCan("proposal.create", membership);

  const balances = await getGroupBalances(input.groupId);
  const kind = input.kind ?? "SPEND";

  /**
   * The threshold is decided by what the proposal *does*, never by the
   * proposer. For a rule change that is fixed by the kind; for a spend it
   * depends on how much of the treasury it would take — otherwise anyone could
   * route a large withdrawal through the low bar by claiming it was routine.
   */
  const action =
    kind === "SPEND"
      ? deriveAction(input.amount, balances.total)
      : KIND_ACTION[kind];

  if (isSpendingAction(action)) {
    if (!input.amount?.isPositive()) {
      return {
        ok: false,
        reason: "amount_required",
        message: "A spending proposal needs an amount.",
      };
    }
    if (input.amount.greaterThan(balances.available)) {
      return {
        ok: false,
        reason: "insufficient_funds",
        message: `Only ${balances.available.format()} is available to spend.`,
      };
    }
  }

  const [rule] = await db
    .select({ thresholdPermille: governanceRules.thresholdPermille })
    .from(governanceRules)
    .where(
      and(
        eq(governanceRules.groupId, input.groupId),
        eq(governanceRules.action, action),
      ),
    )
    .limit(1);

  const [settings] = await db
    .select({
      quorumPct: groupSettings.quorumPct,
      defaultVoteDays: groupSettings.defaultVoteDays,
    })
    .from(groupSettings)
    .where(eq(groupSettings.groupId, input.groupId))
    .limit(1);

  const [{ value: eligibleVoterCount }] = await db
    .select({ value: count() })
    .from(groupMembers)
    .where(
      and(
        eq(groupMembers.groupId, input.groupId),
        eq(groupMembers.status, "ACTIVE"),
      ),
    );

  if (eligibleVoterCount === 0) {
    return { ok: false, reason: "no_members", message: "This group has no members." };
  }

  const voteDays = input.voteDays ?? settings?.defaultVoteDays ?? DEFAULT_VOTE_DAYS;
  const closesAt = new Date(Date.now() + voteDays * 24 * 60 * 60 * 1000);

  /**
   * Resolve who a removal is about from the membership, not from the browser.
   *
   * The name is written into the proposal so the record still reads sensibly
   * years later, after the person has left and their row has changed — but a
   * name supplied by the client is not worth trusting on a governance record.
   */
  const payload = await resolvePayload(input.groupId, input.payload);

  const proposalId = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(proposals)
      .values({
        groupId: input.groupId,
        createdBy: actorId,
        action,
        title: input.title.trim(),
        reason: input.reason.trim(),
        amount: input.amount?.minor ?? null,
        destination: input.destination?.trim() || null,
        payload: payload ?? { kind },
        thresholdPermilleSnapshot: rule?.thresholdPermille ?? 667,
        quorumPctSnapshot: settings?.quorumPct ?? 60,
        eligibleVoterCount,
        closesAt,
      })
      .returning({ id: proposals.id });

    await recordAudit(tx, {
      action: "proposal.created",
      actorId,
      groupId: input.groupId,
      subjectType: "proposal",
      subjectId: created.id,
      after: {
        action,
        amount: input.amount?.minor ?? null,
        threshold: rule?.thresholdPermille ?? 667,
        eligibleVoterCount,
      },
    });

    return created.id;
  });

  return { ok: true, proposalId, action };
}

/** Fill in anything the payload should not take the client's word for. */
async function resolvePayload(
  groupId: string,
  payload: ProposalPayload | undefined,
): Promise<ProposalPayload | undefined> {
  if (!payload) return undefined;
  if (payload.kind !== "REMOVE_MEMBER" && payload.kind !== "REMOVE_ADMIN") {
    return payload;
  }

  const [target] = await db
    .select({ displayName: users.displayName })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(
      and(
        eq(groupMembers.groupId, groupId),
        eq(groupMembers.userId, payload.userId),
        eq(groupMembers.status, "ACTIVE"),
      ),
    )
    .limit(1);

  return { ...payload, displayName: target?.displayName ?? "a former member" };
}

/** Large withdrawals need a higher bar than routine ones. */
function deriveAction(amount: Money | undefined, treasury: Money): GovernedAction {
  if (!amount?.isPositive()) return "FUND_RELEASE_SMALL";
  if (treasury.isZero()) return "FUND_RELEASE_LARGE";

  // Above 20% of the treasury counts as large (BLUEPRINT.md §9).
  const sharePermille = Number((amount.minor * 1000n) / treasury.minor);
  return sharePermille > LARGE_RELEASE_SHARE_PERMILLE
    ? "FUND_RELEASE_LARGE"
    : "FUND_RELEASE_SMALL";
}

function isSpendingAction(action: GovernedAction): boolean {
  return action === "FUND_RELEASE_SMALL" || action === "FUND_RELEASE_LARGE";
}

// ---------------------------------------------------------------------------
// Voting
// ---------------------------------------------------------------------------

export type CastVoteResult =
  | { ok: true; outcome: ProposalOutcome; changed: boolean }
  | {
      ok: false;
      reason: "not_a_member" | "not_found" | "closed" | "not_eligible";
      message: string;
    };

/**
 * Cast or change a vote.
 *
 * The `closesAt` check happens inside the transaction that writes the vote, so
 * a vote submitted as the deadline passes is either in or out — never counted
 * against a proposal that has already been decided.
 */
export async function castVote(
  proposalId: string,
  actorId: string,
  choice: VoteChoice,
  reason?: string,
): Promise<CastVoteResult> {
  const [proposal] = await db
    .select()
    .from(proposals)
    .where(eq(proposals.id, proposalId))
    .limit(1);

  if (!proposal) {
    return { ok: false, reason: "not_found", message: "Proposal not found." };
  }

  const membership = await getMembership(proposal.groupId, actorId);
  if (!membership || membership.role === null || !membership.memberId) {
    return {
      ok: false,
      reason: "not_a_member",
      message: "You're not a member of this group.",
    };
  }

  assertCan("group.vote", membership);

  const result = await db.transaction(async (tx) => {
    // Re-read inside the transaction: the status may have changed since.
    const [current] = await tx
      .select()
      .from(proposals)
      .where(eq(proposals.id, proposalId))
      .limit(1);

    if (current.status !== "OPEN") {
      return { closed: true as const };
    }
    if (current.closesAt.getTime() <= Date.now()) {
      return { closed: true as const };
    }

    const [existing] = await tx
      .select({ id: votes.id, choice: votes.choice })
      .from(votes)
      .where(
        and(eq(votes.proposalId, proposalId), eq(votes.memberId, membership.memberId!)),
      )
      .limit(1);

    if (existing) {
      // Changing your mind updates the row; it never adds a second vote.
      if (existing.choice === choice) return { closed: false as const, changed: false };
      await tx
        .update(votes)
        .set({ choice, reason: reason ?? null, castAt: new Date() })
        .where(eq(votes.id, existing.id));
    } else {
      await tx.insert(votes).values({
        proposalId,
        memberId: membership.memberId!,
        userId: actorId,
        choice,
        reason: reason ?? null,
      });
    }

    return { closed: false as const, changed: true };
  });

  if (result.closed) {
    return {
      ok: false,
      reason: "closed",
      message: "Voting on this proposal has closed.",
    };
  }

  // Re-count and settle the proposal if this vote decided it.
  const outcome = await evaluateProposal(proposalId);

  await recordAudit(db, {
    action: "vote.cast",
    actorId,
    groupId: proposal.groupId,
    subjectType: "proposal",
    subjectId: proposalId,
    after: { choice },
  });

  return { ok: true, outcome, changed: result.changed };
}

// ---------------------------------------------------------------------------
// Counting and settling
// ---------------------------------------------------------------------------

export async function tallyVotes(
  proposalId: string,
  executor: Transaction | typeof db = db,
) {
  const [row] = await executor
    .select({
      yes: count(sql`case when ${votes.choice} = 'YES' then 1 end`),
      no: count(sql`case when ${votes.choice} = 'NO' then 1 end`),
      abstain: count(sql`case when ${votes.choice} = 'ABSTAIN' then 1 end`),
    })
    .from(votes)
    .where(eq(votes.proposalId, proposalId));

  return {
    yes: Number(row?.yes ?? 0),
    no: Number(row?.no ?? 0),
    abstain: Number(row?.abstain ?? 0),
  };
}

/**
 * Count the votes and, if the proposal is decided, settle it.
 *
 * On approval this **reserves the money immediately** — moving it from
 * available to locked in the ledger. That is what stops two proposals from
 * each passing against the same funds.
 *
 * If the reservation fails because the money is no longer there, the proposal
 * is rejected with an honest reason rather than left approved-but-unfundable.
 */
export async function evaluateProposal(
  proposalId: string,
  now: Date = new Date(),
): Promise<ProposalOutcome> {
  const [proposal] = await db
    .select()
    .from(proposals)
    .where(eq(proposals.id, proposalId))
    .limit(1);

  if (!proposal) throw new Error(`No proposal ${proposalId}`);

  const tally = await tallyVotes(proposalId);
  const atDeadline = proposal.closesAt.getTime() <= now.getTime();

  const outcome = evaluate(
    {
      ...tally,
      eligibleVoters: proposal.eligibleVoterCount,
      thresholdPermille: proposal.thresholdPermilleSnapshot,
      quorumPct: proposal.quorumPctSnapshot,
    },
    atDeadline,
  );

  if (proposal.status !== "OPEN" || outcome.decision === "undecided") {
    return outcome;
  }

  if (outcome.decision === "rejected") {
    await db.transaction(async (tx) => {
      await tx
        .update(proposals)
        .set({
          status: atDeadline && outcome.reason === "quorum_missed" ? "EXPIRED" : "REJECTED",
          decidedAt: now,
          outcomeReason: describeRejection(outcome.reason),
        })
        .where(and(eq(proposals.id, proposalId), eq(proposals.status, "OPEN")));

      await recordAudit(tx, {
        action: "proposal.rejected",
        groupId: proposal.groupId,
        subjectType: "proposal",
        subjectId: proposalId,
        after: { ...tally, reason: outcome.reason },
      });
    });
    return outcome;
  }

  // Approved. Reserve the funds, or enact the rule change, in the same breath.
  await db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(proposals)
      .set({ status: "APPROVED", decidedAt: now, outcomeReason: "Approved by the group" })
      .where(and(eq(proposals.id, proposalId), eq(proposals.status, "OPEN")))
      .returning({ id: proposals.id });

    // Another evaluation got there first.
    if (!claimed) return;

    /**
     * A rule change takes effect now, and the proposal is finished — there is
     * no second step, because nothing has to leave the building. Marking it
     * EXECUTED rather than APPROVED keeps "approved but not yet done" meaning
     * only one thing: money waiting to be sent.
     */
    const payload = parsePayload(proposal.payload);
    if (payload && isRuleChange(payload.kind)) {
      await applyProposalPayload(tx, proposal.groupId, proposalId, payload);

      await tx
        .update(proposals)
        .set({
          status: "EXECUTED",
          executedAt: now,
          outcomeReason: "Approved by the group and applied",
        })
        .where(eq(proposals.id, proposalId));

      await recordAudit(tx, {
        action: "proposal.approved",
        groupId: proposal.groupId,
        subjectType: "proposal",
        subjectId: proposalId,
        after: { ...tally, kind: payload.kind },
      });
      return;
    }

    if (proposal.amount && proposal.amount > 0n) {
      try {
        await reserveForProposal(
          {
            groupId: proposal.groupId,
            amount: Money.fromMinor(proposal.amount),
            proposalId,
          },
          tx,
        );
      } catch (error) {
        // The vote passed but the money is gone — most likely another proposal
        // reserved it first. Say so plainly rather than leaving a promise the
        // group cannot keep.
        await tx
          .update(proposals)
          .set({
            status: "REJECTED",
            outcomeReason:
              "Approved by the group, but the funds were no longer available.",
          })
          .where(eq(proposals.id, proposalId));

        await recordAudit(tx, {
          action: "proposal.rejected",
          groupId: proposal.groupId,
          subjectType: "proposal",
          subjectId: proposalId,
          after: {
            reason: "funds_unavailable",
            detail: error instanceof Error ? error.message : String(error),
          },
        });
        return;
      }
    }

    await recordAudit(tx, {
      action: "proposal.approved",
      groupId: proposal.groupId,
      subjectType: "proposal",
      subjectId: proposalId,
      after: { ...tally, amount: proposal.amount },
    });
  });

  // Re-read: the reservation may have flipped it back to rejected.
  const [settled] = await db
    .select({ status: proposals.status })
    .from(proposals)
    .where(eq(proposals.id, proposalId))
    .limit(1);

  return settled.status === "APPROVED"
    ? outcome
    : {
        decision: "rejected",
        reason: "threshold_missed",
        approvalPermille: outcome.approvalPermille,
        turnoutPct: outcome.turnoutPct,
      };
}

function describeRejection(reason: string): string {
  switch (reason) {
    case "quorum_missed":
      return "Not enough members voted.";
    case "threshold_unreachable":
      return "Too many members voted against it for it to pass.";
    default:
      return "It didn't reach the approval the group requires.";
  }
}

/** Proposals whose deadline has passed but which are still open. */
export async function findProposalsToClose(now: Date = new Date()) {
  return db
    .select({ id: proposals.id })
    .from(proposals)
    .where(and(eq(proposals.status, "OPEN"), lte(proposals.closesAt, now)));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface VoteView {
  userId: string;
  displayName: string;
  choice: VoteChoice;
  reason: string | null;
  castAt: Date;
  isYou: boolean;
}

export interface ProposalView {
  id: string;
  groupId: string;
  title: string;
  reason: string;
  action: GovernedAction;
  amount: Money | null;
  destination: string | null;
  status: ProposalStatus;
  createdByName: string;
  thresholdPermille: number;
  quorumPct: number;
  eligibleVoterCount: number;
  createdAt: Date;
  closesAt: Date;
  decidedAt: Date | null;
  executedAt: Date | null;
  outcomeReason: string | null;
  tally: { yes: number; no: number; abstain: number };
  outcome: ProposalOutcome;
  needed: ReturnType<typeof whatIsNeeded>;
  votes: VoteView[];
  /** The viewer's own vote, if cast. */
  yourVote: VoteChoice | null;
  canVote: boolean;
}

export async function getProposal(
  proposalId: string,
  viewerId: string,
): Promise<ProposalView | null> {
  const [proposal] = await db
    .select({
      id: proposals.id,
      groupId: proposals.groupId,
      title: proposals.title,
      reason: proposals.reason,
      action: proposals.action,
      amount: proposals.amount,
      destination: proposals.destination,
      status: proposals.status,
      thresholdPermille: proposals.thresholdPermilleSnapshot,
      quorumPct: proposals.quorumPctSnapshot,
      eligibleVoterCount: proposals.eligibleVoterCount,
      createdAt: proposals.createdAt,
      closesAt: proposals.closesAt,
      decidedAt: proposals.decidedAt,
      executedAt: proposals.executedAt,
      outcomeReason: proposals.outcomeReason,
      createdByName: users.displayName,
    })
    .from(proposals)
    .innerJoin(users, eq(users.id, proposals.createdBy))
    .where(eq(proposals.id, proposalId))
    .limit(1);

  if (!proposal) return null;

  // A proposal is only visible to the group it belongs to.
  const membership = await getMembership(proposal.groupId, viewerId);
  if (!membership || membership.role === null) return null;

  const voteRows = await db
    .select({
      userId: votes.userId,
      displayName: users.displayName,
      choice: votes.choice,
      reason: votes.reason,
      castAt: votes.castAt,
    })
    .from(votes)
    .innerJoin(users, eq(users.id, votes.userId))
    .where(eq(votes.proposalId, proposalId))
    .orderBy(asc(votes.castAt));

  const tally = {
    yes: voteRows.filter((v) => v.choice === "YES").length,
    no: voteRows.filter((v) => v.choice === "NO").length,
    abstain: voteRows.filter((v) => v.choice === "ABSTAIN").length,
  };

  const thresholdInput = {
    ...tally,
    eligibleVoters: proposal.eligibleVoterCount,
    thresholdPermille: proposal.thresholdPermille,
    quorumPct: proposal.quorumPct,
  };

  return {
    ...proposal,
    amount: proposal.amount === null ? null : Money.fromMinor(proposal.amount),
    tally,
    outcome: evaluate(thresholdInput, proposal.closesAt.getTime() <= Date.now()),
    needed: whatIsNeeded(thresholdInput),
    votes: voteRows.map((v) => ({ ...v, isYou: v.userId === viewerId })),
    yourVote: voteRows.find((v) => v.userId === viewerId)?.choice ?? null,
    canVote: proposal.status === "OPEN" && proposal.closesAt.getTime() > Date.now(),
  };
}

export interface ProposalSummary {
  id: string;
  title: string;
  action: GovernedAction;
  amount: Money | null;
  status: ProposalStatus;
  closesAt: Date;
  tally: { yes: number; no: number; abstain: number };
  thresholdPermille: number;
  eligibleVoterCount: number;
  yourVote: VoteChoice | null;
}

export async function listProposals(
  groupId: string,
  viewerId: string,
): Promise<ProposalSummary[] | null> {
  const membership = await getMembership(groupId, viewerId);
  if (!membership || membership.role === null) return null;

  const rows = await db
    .select({
      id: proposals.id,
      title: proposals.title,
      action: proposals.action,
      amount: proposals.amount,
      status: proposals.status,
      closesAt: proposals.closesAt,
      thresholdPermille: proposals.thresholdPermilleSnapshot,
      eligibleVoterCount: proposals.eligibleVoterCount,
    })
    .from(proposals)
    .where(eq(proposals.groupId, groupId))
    .orderBy(desc(proposals.createdAt));

  return Promise.all(
    rows.map(async (row) => ({
      ...row,
      amount: row.amount === null ? null : Money.fromMinor(row.amount),
      tally: await tallyVotes(row.id),
      yourVote:
        (
          await db
            .select({ choice: votes.choice })
            .from(votes)
            .where(and(eq(votes.proposalId, row.id), eq(votes.userId, viewerId)))
            .limit(1)
        )[0]?.choice ?? null,
    })),
  );
}
