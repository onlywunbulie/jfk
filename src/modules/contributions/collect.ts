import "server-only";
import { and, eq, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  contributionCycles,
  contributions,
  groupSettings,
  paymentMethods,
} from "@/lib/db/schema";
import { Money } from "@/lib/money";
import { planCharge } from "@/modules/payments/fees";
import { paystack } from "@/modules/payments/paystack";
import { getUserEmail, startPayment } from "@/modules/payments/service";
import { classifyDecline, nextRetryAt, type DeclineKind } from "./retry";

/**
 * Automatic collection and the retry ladder. See BLUEPRINT.md §6 and §10.
 *
 * Two rules govern everything here:
 *
 *   1. **The payment reference is derived from the contribution id and the
 *      attempt number.** A retry of attempt 2 reuses the same reference, so a
 *      job that runs twice cannot charge someone twice for the same attempt.
 *   2. **Only soft declines are retried.** Retrying a revoked card is pure
 *      noise for the member and the issuer; that gets a "re-add your card"
 *      nudge instead.
 */

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

export type CollectOutcome =
  | { contributionId: string; outcome: "charged"; reference: string }
  | { contributionId: string; outcome: "skipped"; reason: string }
  | {
      contributionId: string;
      outcome: "failed";
      kind: DeclineKind;
      reason: string;
      retryAt: Date | null;
    };

/**
 * Attempt one contribution.
 *
 * Records the attempt and asks the provider to charge. It never posts to the
 * ledger — the webhook does that, and only after the bank has confirmed.
 */
export async function collectContribution(
  contributionId: string,
  now: Date = new Date(),
): Promise<CollectOutcome> {
  const [row] = await db
    .select({
      id: contributions.id,
      groupId: contributions.groupId,
      userId: contributions.userId,
      amount: contributions.amount,
      status: contributions.status,
      attemptCount: contributions.attemptCount,
      grossUpFees: groupSettings.grossUpFees,
      autoChargeEnabled: groupSettings.autoChargeEnabled,
    })
    .from(contributions)
    .innerJoin(groupSettings, eq(groupSettings.groupId, contributions.groupId))
    .where(eq(contributions.id, contributionId))
    .limit(1);

  if (!row) {
    return { contributionId, outcome: "skipped", reason: "not found" };
  }
  if (row.status === "PAID" || row.status === "WAIVED") {
    return { contributionId, outcome: "skipped", reason: `already ${row.status}` };
  }
  if (row.status === "PROCESSING") {
    // A charge is already in flight; the webhook will resolve it.
    return { contributionId, outcome: "skipped", reason: "already processing" };
  }

  const [card] = await db
    .select({
      id: paymentMethods.id,
      authCode: paymentMethods.providerAuthCode,
    })
    .from(paymentMethods)
    .where(
      and(
        eq(paymentMethods.userId, row.userId),
        eq(paymentMethods.status, "ACTIVE"),
      ),
    )
    .orderBy(sql`${paymentMethods.isDefault} desc`)
    .limit(1);

  if (!card) {
    await db
      .update(contributions)
      .set({ lastFailureReason: "No saved card" })
      .where(eq(contributions.id, contributionId));
    return { contributionId, outcome: "skipped", reason: "no saved card" };
  }

  const email = await getUserEmail(row.userId);
  if (!email) {
    return { contributionId, outcome: "skipped", reason: "no email" };
  }

  const attempt = row.attemptCount + 1;
  const target = Money.fromMinor(row.amount);
  const plan = planCharge(target, row.grossUpFees);

  /**
   * Deterministic per (contribution, attempt). Two runs of the collection job
   * on the same attempt produce the same reference, and Paystack rejects the
   * duplicate — the guard holds even before our own webhook dedupe.
   */
  const reference = `jfk_c_${contributionId}_a${attempt}`;

  // Claim the attempt before calling out. If the process dies mid-charge, the
  // contribution is left PROCESSING and the reconciliation job chases it,
  // rather than being retried into a double charge.
  await db
    .update(contributions)
    .set({ status: "PROCESSING", attemptCount: attempt, nextRetryAt: null })
    .where(eq(contributions.id, contributionId));

  await startPayment({
    reference,
    purpose: "CONTRIBUTION",
    amount: plan.charged,
    userId: row.userId,
    groupId: row.groupId,
    paymentMethodId: card.id,
    metadata: { contributionId, attempt, target: target.minor.toString() },
  });

  const result = await paystack.chargeAuthorization({
    authorizationCode: card.authCode,
    email,
    amount: plan.charged,
    reference,
    metadata: { contributionId, groupId: row.groupId },
  });

  if (result.accepted && result.provisionalStatus !== "failed") {
    // Still PROCESSING: the webhook marks it PAID.
    return { contributionId, outcome: "charged", reference };
  }

  const reason = result.failureReason ?? "charge declined";
  const kind = classifyDecline(reason);
  const retryAt = kind === "soft" ? nextRetryAt(attempt, now) : null;

  await db
    .update(contributions)
    .set({
      status: "FAILED",
      lastFailureReason: reason,
      nextRetryAt: retryAt,
    })
    .where(eq(contributions.id, contributionId));

  // A dead card should stop being charged everywhere, not just here.
  if (kind === "hard") {
    await db
      .update(paymentMethods)
      .set({ status: "EXPIRED" })
      .where(eq(paymentMethods.id, card.id));
  }

  return { contributionId, outcome: "failed", kind, reason, retryAt };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** Contributions due for a first attempt: cycle open, past due, auto-charge on. */
export async function findDueContributions(now: Date = new Date()) {
  return db
    .select({ id: contributions.id })
    .from(contributions)
    .innerJoin(
      contributionCycles,
      eq(contributionCycles.id, contributions.cycleId),
    )
    .innerJoin(groupSettings, eq(groupSettings.groupId, contributions.groupId))
    .where(
      and(
        eq(contributions.status, "PENDING"),
        eq(contributionCycles.status, "OPEN"),
        lte(contributionCycles.dueAt, now),
        eq(groupSettings.autoChargeEnabled, true),
      ),
    );
}

/** Failed contributions whose next rung on the ladder has come due. */
export async function findRetryableContributions(now: Date = new Date()) {
  return db
    .select({ id: contributions.id })
    .from(contributions)
    .innerJoin(
      contributionCycles,
      eq(contributionCycles.id, contributions.cycleId),
    )
    .where(
      and(
        eq(contributions.status, "FAILED"),
        isNotNull(contributions.nextRetryAt),
        lte(contributions.nextRetryAt, now),
        eq(contributionCycles.status, "OPEN"),
      ),
    );
}

/** Members to nudge: unpaid, with the due date near or passed. */
export async function findContributionsNeedingReminder(
  now: Date = new Date(),
  daysBefore: number,
) {
  const horizon = new Date(now.getTime() + daysBefore * 24 * 60 * 60 * 1000);

  return db
    .select({
      id: contributions.id,
      userId: contributions.userId,
      groupId: contributions.groupId,
      amount: contributions.amount,
      dueAt: contributionCycles.dueAt,
    })
    .from(contributions)
    .innerJoin(
      contributionCycles,
      eq(contributionCycles.id, contributions.cycleId),
    )
    .where(
      and(
        inArray(contributions.status, ["PENDING", "FAILED"]),
        eq(contributionCycles.status, "OPEN"),
        or(
          lte(contributionCycles.dueAt, horizon),
          lte(contributionCycles.dueAt, now),
        ),
      ),
    );
}
