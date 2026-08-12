import "server-only";
import type { Transaction } from "@/lib/db";
import { Money } from "@/lib/money";
import {
  getGroupBalances,
  groupAvailable,
  groupLocked,
  post,
  systemAccount,
  InsufficientFundsError,
  type PostingResult,
} from "./service";

/**
 * The money movements JFK actually performs, each expressed as a balanced
 * posting. Nothing outside this file decides what the legs of a transaction
 * are — callers say "a contribution happened", not "debit this, credit that".
 *
 * Every function takes an idempotency key derived from the domain object, so
 * calling it twice for the same contribution or payout is a no-op.
 */

// ---------------------------------------------------------------------------
// Money in
// ---------------------------------------------------------------------------

export interface ContributionPosting {
  contributionId: string;
  groupId: string;
  memberUserId: string;
  /** What the member's card was actually charged. */
  charged: Money;
  /** The gateway's cut of that charge. */
  fee: Money;
  occurredAt?: Date;
}

/**
 * Record a settled contribution.
 *
 *   DR PSP_SETTLEMENT    net     cash now sits in the Paystack balance
 *   CR GROUP_AVAILABLE   net     we owe the group that money
 *   DR FEE_EXPENSE       fee     the gateway's cut, recorded not hidden
 *   CR FEE_RECOVERY      fee     funded out of the same payment
 *
 * The fee legs are a wash on JFK's own books but make gateway cost visible and
 * reconcilable against Paystack's statements. The group is credited exactly
 * the cash that arrived — never a figure we hope will arrive.
 *
 * Called only after a verified webhook confirms the charge (BLUEPRINT.md §10).
 */
export async function postContribution(
  input: ContributionPosting,
  executor?: Transaction,
): Promise<PostingResult> {
  const net = input.charged.minus(input.fee);

  if (!net.isPositive()) {
    throw new Error(
      `Contribution net of fees must be positive: charged ${input.charged.format()}, fee ${input.fee.format()}`,
    );
  }

  const legs = [
    { account: systemAccount("PSP_SETTLEMENT"), direction: "DEBIT" as const, amount: net },
    { account: groupAvailable(input.groupId), direction: "CREDIT" as const, amount: net },
  ];

  if (input.fee.isPositive()) {
    legs.push(
      { account: systemAccount("FEE_EXPENSE"), direction: "DEBIT" as const, amount: input.fee },
      { account: systemAccount("FEE_RECOVERY"), direction: "CREDIT" as const, amount: input.fee },
    );
  }

  return post(
    {
      type: "CONTRIBUTION",
      idempotencyKey: `contribution:${input.contributionId}`,
      description: "Contribution received",
      groupId: input.groupId,
      occurredAt: input.occurredAt,
      metadata: {
        contributionId: input.contributionId,
        memberUserId: input.memberUserId,
        charged: input.charged.minor.toString(),
        fee: input.fee.minor.toString(),
      },
      legs,
    },
    executor,
  );
}

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

/**
 * Fence money off so it cannot be proposed for spending.
 *
 *   DR GROUP_AVAILABLE  →  CR GROUP_LOCKED
 *
 * The total is unchanged; only what the group may reach moves. Because this is
 * a real posting rather than a flag, every lock and unlock is in the history.
 */
export async function lockFunds(
  input: { groupId: string; amount: Money; lockId: string; reason?: string },
  executor?: Transaction,
): Promise<PostingResult> {
  await assertAvailable(input.groupId, input.amount, executor);

  return post(
    {
      type: "FUND_LOCK",
      idempotencyKey: `lock:${input.lockId}`,
      description: input.reason ?? "Funds locked",
      groupId: input.groupId,
      metadata: { lockId: input.lockId },
      legs: [
        { account: groupAvailable(input.groupId), direction: "DEBIT", amount: input.amount },
        { account: groupLocked(input.groupId), direction: "CREDIT", amount: input.amount },
      ],
    },
    executor,
  );
}

/**
 * Release a lock whose condition has been met.
 *
 * Eligible is not the same as withdrawn: this only returns the money to the
 * group's available balance, where a proposal can then be raised against it.
 */
export async function unlockFunds(
  input: { groupId: string; amount: Money; lockId: string },
  executor?: Transaction,
): Promise<PostingResult> {
  return post(
    {
      type: "FUND_UNLOCK",
      idempotencyKey: `unlock:${input.lockId}`,
      description: "Lock condition met — funds unlocked",
      groupId: input.groupId,
      metadata: { lockId: input.lockId },
      legs: [
        { account: groupLocked(input.groupId), direction: "DEBIT", amount: input.amount },
        { account: groupAvailable(input.groupId), direction: "CREDIT", amount: input.amount },
      ],
    },
    executor,
  );
}

// ---------------------------------------------------------------------------
// Reservations — the guard against double-spending an approved proposal
// ---------------------------------------------------------------------------

/**
 * Fence off the money an approved proposal intends to spend.
 *
 * Posted the moment a proposal passes, so two proposals that each cleared
 * their threshold cannot both draw on the same naira. The second one to be
 * approved fails here rather than at payout time, when it would be far messier.
 */
export async function reserveForProposal(
  input: { groupId: string; amount: Money; proposalId: string },
  executor?: Transaction,
): Promise<PostingResult> {
  await assertAvailable(input.groupId, input.amount, executor);

  return post(
    {
      type: "RESERVATION",
      idempotencyKey: `reserve:${input.proposalId}`,
      description: "Reserved for an approved proposal",
      groupId: input.groupId,
      metadata: { proposalId: input.proposalId },
      legs: [
        { account: groupAvailable(input.groupId), direction: "DEBIT", amount: input.amount },
        { account: groupLocked(input.groupId), direction: "CREDIT", amount: input.amount },
      ],
    },
    executor,
  );
}

/** Hand a reservation back, e.g. when a payout fails or a proposal is cancelled. */
export async function releaseReservation(
  input: { groupId: string; amount: Money; proposalId: string; reason: string },
  executor?: Transaction,
): Promise<PostingResult> {
  return post(
    {
      type: "RESERVATION_RELEASE",
      idempotencyKey: `unreserve:${input.proposalId}`,
      description: `Reservation released: ${input.reason}`,
      groupId: input.groupId,
      metadata: { proposalId: input.proposalId, reason: input.reason },
      legs: [
        { account: groupLocked(input.groupId), direction: "DEBIT", amount: input.amount },
        { account: groupAvailable(input.groupId), direction: "CREDIT", amount: input.amount },
      ],
    },
    executor,
  );
}

// ---------------------------------------------------------------------------
// Money out
// ---------------------------------------------------------------------------

/**
 * Money genuinely leaving for a destination bank account.
 *
 *   DR GROUP_LOCKED     the reserved money is spent
 *   CR PSP_SETTLEMENT   cash leaves the Paystack balance
 *
 * Posted only when the transfer webhook confirms success. If it fails, the
 * reservation is released instead and the group's balance is untouched.
 */
export async function postPayout(
  input: {
    groupId: string;
    amount: Money;
    releaseId: string;
    destination: string;
  },
  executor?: Transaction,
): Promise<PostingResult> {
  return post(
    {
      type: "PAYOUT",
      idempotencyKey: `payout:${input.releaseId}`,
      description: `Funds released to ${input.destination}`,
      groupId: input.groupId,
      metadata: { releaseId: input.releaseId, destination: input.destination },
      legs: [
        { account: groupLocked(input.groupId), direction: "DEBIT", amount: input.amount },
        { account: systemAccount("PSP_SETTLEMENT"), direction: "CREDIT", amount: input.amount },
      ],
    },
    executor,
  );
}

/**
 * Application-level check with a useful error.
 *
 * The database enforces non-negativity too, at COMMIT. This exists so callers
 * get `InsufficientFundsError` naming the shortfall rather than a raw
 * constraint violation from Postgres.
 */
async function assertAvailable(
  groupId: string,
  amount: Money,
  executor?: Transaction,
): Promise<void> {
  const balances = await getGroupBalances(groupId, "NGN", executor);
  if (balances.available.lessThan(amount)) {
    throw new InsufficientFundsError(
      "GROUP_AVAILABLE",
      balances.available,
      amount,
    );
  }
}
