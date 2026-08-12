import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, type Transaction } from "@/lib/db";
import {
  paymentMethods,
  payments,
  webhookEvents,
  users,
  type PaymentPurpose,
} from "@/lib/db/schema";
import { Money } from "@/lib/money";
import { postContribution } from "@/modules/ledger/operations";
import { recordAudit } from "@/modules/audit/service";
import type { NormalizedPaymentEvent, PaymentProvider } from "./provider";

/**
 * Turning provider events into money in the books.
 *
 * The one rule: **the webhook is the source of truth.** Starting a charge
 * writes a `payments` row and nothing else. Only a verified, deduplicated
 * event posts to the ledger.
 */

// ---------------------------------------------------------------------------
// Recording intent
// ---------------------------------------------------------------------------

export interface StartPaymentInput {
  reference: string;
  purpose: PaymentPurpose;
  amount: Money;
  userId: string;
  groupId?: string | null;
  paymentMethodId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Record that we are about to ask for money.
 *
 * Written *before* the provider is called, so a request that times out still
 * leaves a trace for the reconciliation job to chase. Idempotent on reference.
 */
export async function startPayment(
  input: StartPaymentInput,
  executor: Transaction | typeof db = db,
): Promise<{ paymentId: string; alreadyExists: boolean }> {
  const [existing] = await executor
    .select({ id: payments.id })
    .from(payments)
    .where(eq(payments.reference, input.reference))
    .limit(1);

  if (existing) return { paymentId: existing.id, alreadyExists: true };

  const [created] = await executor
    .insert(payments)
    .values({
      reference: input.reference,
      direction: "IN",
      purpose: input.purpose,
      status: "INITIATED",
      amount: input.amount.minor,
      userId: input.userId,
      groupId: input.groupId ?? null,
      paymentMethodId: input.paymentMethodId ?? null,
      raw: input.metadata ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: payments.id });

  if (created) return { paymentId: created.id, alreadyExists: false };

  const [raced] = await executor
    .select({ id: payments.id })
    .from(payments)
    .where(eq(payments.reference, input.reference))
    .limit(1);
  return { paymentId: raced.id, alreadyExists: true };
}

// ---------------------------------------------------------------------------
// Webhook intake
// ---------------------------------------------------------------------------

export type WebhookIntake =
  | { outcome: "processed"; eventId: string }
  | { outcome: "duplicate"; eventId: string }
  | { outcome: "invalid_signature" }
  | { outcome: "ignored"; eventId: string; reason: string }
  | { outcome: "error"; eventId: string; message: string };

/**
 * Take one webhook delivery from raw bytes to settled money.
 *
 *   1. Verify the signature over the exact bytes received.
 *   2. Insert into `webhook_events`. A unique violation means we have seen
 *      this event before — stop, and report success to the provider.
 *   3. Apply it.
 *
 * Step 2 is the entire duplicate-payment defence. Paystack retries on any
 * non-2xx and can deliver the same event several times regardless, so this
 * path is exercised in normal operation, not just in theory.
 */
export async function handleWebhook(
  provider: PaymentProvider,
  rawBody: string,
  headers: Headers,
): Promise<WebhookIntake> {
  const verification = provider.verifyWebhook(rawBody, headers);
  if (!verification.valid) return { outcome: "invalid_signature" };

  const event = provider.parseWebhook(verification.payload);

  // Claim the event. If another delivery got here first, this inserts nothing.
  const claimed = await db
    .insert(webhookEvents)
    .values({
      provider: provider.name,
      providerEventId: event.eventId,
      eventType: event.type,
      payload: verification.payload as object,
      signatureValid: true,
    })
    .onConflictDoNothing()
    .returning({ id: webhookEvents.id });

  if (claimed.length === 0) return { outcome: "duplicate", eventId: event.eventId };

  const webhookRowId = claimed[0].id;

  try {
    const result = await applyEvent(provider, event);

    await db
      .update(webhookEvents)
      .set({ processedAt: new Date() })
      .where(eq(webhookEvents.id, webhookRowId));

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // Record the failure and leave `processed_at` null so the retry job can
    // pick it up. The row stays claimed, so a provider redelivery still cannot
    // double-apply it.
    await db
      .update(webhookEvents)
      .set({ error: message })
      .where(eq(webhookEvents.id, webhookRowId));

    return { outcome: "error", eventId: event.eventId, message };
  }
}

async function applyEvent(
  provider: PaymentProvider,
  event: NormalizedPaymentEvent,
): Promise<WebhookIntake> {
  switch (event.type) {
    case "charge.success":
      return applyChargeSuccess(provider, event);
    case "charge.failed":
      return applyChargeFailure(event);
    default:
      // Transfers land in Phase 6. Recording and ignoring is correct for now —
      // the event is stored, so nothing is lost.
      return {
        outcome: "ignored",
        eventId: event.eventId,
        reason: `no handler for ${event.type}`,
      };
  }
}

/**
 * A charge succeeded.
 *
 * Everything happens in one database transaction: the card token is saved, the
 * payment row is settled, and the ledger is posted. Either all of it commits
 * or none of it does — a settled payment with no ledger entry would be exactly
 * the silent discrepancy the whole design exists to prevent.
 */
async function applyChargeSuccess(
  provider: PaymentProvider,
  event: NormalizedPaymentEvent,
): Promise<WebhookIntake> {
  if (!event.reference) {
    return { outcome: "ignored", eventId: event.eventId, reason: "no reference" };
  }

  return db.transaction(async (tx) => {
    const [payment] = await tx
      .select()
      .from(payments)
      .where(eq(payments.reference, event.reference!))
      .limit(1);

    if (!payment) {
      // Money arrived that we did not ask for. Do not guess who it belongs to.
      return {
        outcome: "ignored" as const,
        eventId: event.eventId,
        reason: `unknown reference ${event.reference}`,
      };
    }

    if (payment.status === "SUCCESS") {
      return { outcome: "duplicate" as const, eventId: event.eventId };
    }

    // Save the reusable card token, if this event carried one.
    if (event.authorization?.reusable && payment.userId) {
      await saveAuthorization(tx, payment.userId, event);
    }

    // Paystack's figures win over anything we estimated.
    const charged = event.amount ?? Money.fromMinor(payment.amount);
    const fee = event.fee ?? Money.zero();

    let ledgerTransactionId: string | null = null;

    if (payment.purpose === "CONTRIBUTION" && payment.groupId) {
      const posting = await postContribution(
        {
          contributionId: payment.id,
          groupId: payment.groupId,
          memberUserId: payment.userId!,
          charged,
          fee,
        },
        tx,
      );
      ledgerTransactionId = posting.transactionId;
    }
    // A CARD_TOKENIZATION charge is refunded by Paystack immediately and never
    // belongs to a group, so it is deliberately not posted to the ledger.

    await tx
      .update(payments)
      .set({
        status: "SUCCESS",
        providerRef: event.providerRef,
        fee: fee.minor,
        amount: charged.minor,
        ledgerTransactionId,
        settledAt: new Date(),
        raw: event.raw as object,
      })
      .where(eq(payments.id, payment.id));

    await recordAudit(tx, {
      action: "payment.settled",
      actorId: payment.userId,
      groupId: payment.groupId,
      subjectType: "payment",
      subjectId: payment.id,
      after: {
        charged: charged.minor,
        fee: fee.minor,
        provider: provider.name,
      },
    });

    return { outcome: "processed" as const, eventId: event.eventId };
  });
}

async function applyChargeFailure(
  event: NormalizedPaymentEvent,
): Promise<WebhookIntake> {
  if (!event.reference) {
    return { outcome: "ignored", eventId: event.eventId, reason: "no reference" };
  }

  await db
    .update(payments)
    .set({
      status: "FAILED",
      providerRef: event.providerRef,
      failureReason: event.failureReason ?? "charge failed",
      raw: event.raw as object,
    })
    .where(
      and(eq(payments.reference, event.reference), eq(payments.status, "INITIATED")),
    );

  return { outcome: "processed", eventId: event.eventId };
}

/**
 * Store a reusable card token.
 *
 * Deduplicated on Paystack's `signature`, which fingerprints the physical
 * card — so re-adding the same card updates the existing entry rather than
 * cluttering the wallet with copies.
 */
async function saveAuthorization(
  tx: Transaction,
  userId: string,
  event: NormalizedPaymentEvent,
): Promise<void> {
  const auth = event.authorization!;

  const [existingDefault] = await tx
    .select({ id: paymentMethods.id })
    .from(paymentMethods)
    .where(
      and(
        eq(paymentMethods.userId, userId),
        eq(paymentMethods.isDefault, true),
        eq(paymentMethods.status, "ACTIVE"),
      ),
    )
    .limit(1);

  await tx
    .insert(paymentMethods)
    .values({
      userId,
      provider: "PAYSTACK",
      providerAuthCode: auth.authorizationCode,
      signature: auth.signature,
      last4: auth.last4,
      brand: auth.brand,
      bank: auth.bank,
      expMonth: auth.expMonth,
      expYear: auth.expYear,
      // The first card a member adds becomes their default.
      isDefault: !existingDefault,
      status: "ACTIVE",
    })
    .onConflictDoUpdate({
      target: [paymentMethods.userId, paymentMethods.signature],
      // The unique index is partial (`where signature is not null`), and
      // Postgres will not infer a partial index unless the predicate is
      // repeated here. Without this the insert fails outright.
      targetWhere: sql`${paymentMethods.signature} is not null`,
      set: {
        providerAuthCode: auth.authorizationCode,
        last4: auth.last4,
        brand: auth.brand,
        bank: auth.bank,
        expMonth: auth.expMonth,
        expYear: auth.expYear,
        status: "ACTIVE",
        updatedAt: new Date(),
      },
    });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface PaymentMethodView {
  id: string;
  brand: string | null;
  last4: string | null;
  bank: string | null;
  expMonth: number | null;
  expYear: number | null;
  isDefault: boolean;
  expiringSoon: boolean;
}

export async function listPaymentMethods(
  userId: string,
): Promise<PaymentMethodView[]> {
  const rows = await db
    .select()
    .from(paymentMethods)
    .where(
      and(eq(paymentMethods.userId, userId), eq(paymentMethods.status, "ACTIVE")),
    );

  return rows.map((row) => ({
    id: row.id,
    brand: row.brand,
    last4: row.last4,
    bank: row.bank,
    expMonth: row.expMonth,
    expYear: row.expYear,
    isDefault: row.isDefault,
    expiringSoon: isExpiringSoon(row.expMonth, row.expYear),
  }));
}

/** Within 60 days of expiry — worth nudging before a contribution fails. */
function isExpiringSoon(month: number | null, year: number | null): boolean {
  if (month == null || year == null) return false;
  // Cards expire at the end of their stated month.
  const expiry = new Date(Date.UTC(year < 100 ? 2000 + year : year, month, 1));
  return expiry.getTime() - Date.now() < 60 * 24 * 60 * 60 * 1000;
}

/** Fetch a user's email for a charge request. */
export async function getUserEmail(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.email ?? null;
}

/** Payments stuck pending, for the webhook safety-net job. */
export async function listStalePayments(olderThanMinutes = 30) {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000);
  return db
    .select({
      id: payments.id,
      reference: payments.reference,
      createdAt: payments.createdAt,
    })
    .from(payments)
    .where(
      and(
        eq(payments.status, "INITIATED"),
        isNull(payments.settledAt),
        eq(payments.direction, "IN"),
      ),
    )
    .then((rows) => rows.filter((r) => r.createdAt < cutoff));
}
