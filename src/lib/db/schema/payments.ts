import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createdAt, primaryId, updatedAt, users } from "./identity";
import { groups } from "./groups";

/**
 * Payments. See BLUEPRINT.md §10.
 *
 * Two rules shape everything here:
 *
 *   1. We never touch a card number. Paystack's popup collects it and hands
 *      back an `authorization_code`; that token is all we store.
 *   2. The webhook is the only source of truth for money in. An API response
 *      saying "success" starts a payment; only a verified webhook settles it.
 */

export const paymentProviderEnum = pgEnum("payment_provider", ["PAYSTACK"]);

export const paymentMethodStatusEnum = pgEnum("payment_method_status", [
  "ACTIVE",
  "EXPIRED",
  "REVOKED",
]);

export const paymentDirectionEnum = pgEnum("payment_direction", ["IN", "OUT"]);

export const paymentStatusEnum = pgEnum("payment_status", [
  "INITIATED",
  "PENDING",
  "SUCCESS",
  "FAILED",
  "REVERSED",
]);

export const paymentPurposeEnum = pgEnum("payment_purpose", [
  "CARD_TOKENIZATION",
  "CONTRIBUTION",
  "PAYOUT",
]);

// ---------------------------------------------------------------------------
// payment_methods
// ---------------------------------------------------------------------------

export const paymentMethods = pgTable(
  "payment_methods",
  {
    id: primaryId(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: paymentProviderEnum("provider").notNull().default("PAYSTACK"),

    /** The reusable token. This is the whole point — never a PAN. */
    providerAuthCode: text("provider_auth_code").notNull(),

    /**
     * Paystack's fingerprint for the underlying card. Two authorizations for
     * the same physical card share a signature, so this is what stops a member
     * accumulating five entries for one card.
     */
    signature: text("signature"),

    last4: text("last4"),
    brand: text("brand"),
    bank: text("bank"),
    expMonth: smallint("exp_month"),
    expYear: smallint("exp_year"),

    isDefault: boolean("is_default").notNull().default(false),
    status: paymentMethodStatusEnum("status").notNull().default("ACTIVE"),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("payment_methods_user_idx").on(table.userId, table.status),
    // One entry per physical card per person. Partial, because `signature` is
    // null for methods a provider does not fingerprint.
    uniqueIndex("payment_methods_user_signature_unique")
      .on(table.userId, table.signature)
      .where(sql`${table.signature} is not null`),
  ],
);

// ---------------------------------------------------------------------------
// bank_accounts — payout destinations (used from Phase 6)
// ---------------------------------------------------------------------------

export const bankAccounts = pgTable(
  "bank_accounts",
  {
    id: primaryId(),
    ownerType: text("owner_type").notNull(),
    ownerId: text("owner_id").notNull(),
    bankCode: text("bank_code").notNull(),
    accountNumber: text("account_number").notNull(),

    /**
     * The name the bank returned for this account number. Shown to the group
     * before they vote, so nobody approves a transfer to "an account" without
     * seeing whose it is.
     */
    resolvedName: text("resolved_name").notNull(),

    providerRecipientCode: text("provider_recipient_code"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("bank_accounts_owner_number_unique").on(
      table.ownerType,
      table.ownerId,
      table.bankCode,
      table.accountNumber,
    ),
  ],
);

// ---------------------------------------------------------------------------
// payments
// ---------------------------------------------------------------------------

export const payments = pgTable(
  "payments",
  {
    id: primaryId(),
    provider: paymentProviderEnum("provider").notNull().default("PAYSTACK"),

    /**
     * Our reference, sent to the provider and echoed back. Deterministic for
     * contributions (`jfk_c_{contributionId}`) so a retried request cannot
     * produce a second charge.
     */
    reference: text("reference").notNull(),

    /** The provider's own id, once we know it. */
    providerRef: text("provider_ref"),

    direction: paymentDirectionEnum("direction").notNull(),
    purpose: paymentPurposeEnum("purpose").notNull(),
    status: paymentStatusEnum("status").notNull().default("INITIATED"),

    amount: bigint("amount", { mode: "bigint" }).notNull(),
    fee: bigint("fee", { mode: "bigint" }).notNull().default(sql`0`),

    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    groupId: text("group_id").references(() => groups.id, { onDelete: "restrict" }),
    paymentMethodId: text("payment_method_id").references(() => paymentMethods.id, {
      onDelete: "set null",
    }),
    bankAccountId: text("bank_account_id").references(() => bankAccounts.id, {
      onDelete: "set null",
    }),

    /** Set once the money has been posted, linking the payment to the books. */
    ledgerTransactionId: text("ledger_transaction_id"),

    failureReason: text("failure_reason"),

    /** The provider's raw payload, kept verbatim for disputes. */
    raw: jsonb("raw"),

    settledAt: timestamp("settled_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("payments_reference_unique").on(table.reference),
    index("payments_status_idx").on(table.status, table.createdAt),
    index("payments_group_idx").on(table.groupId, table.createdAt),
    index("payments_user_idx").on(table.userId, table.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// webhook_events
// ---------------------------------------------------------------------------

/**
 * Every webhook we receive, stored before it is acted on.
 *
 * The unique index on (provider, provider_event_id) is what makes duplicate
 * delivery harmless — the second insert violates it and we stop. Paystack
 * retries aggressively, so this is not a theoretical concern.
 */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: primaryId(),
    provider: paymentProviderEnum("provider").notNull().default("PAYSTACK"),

    /**
     * A stable identifier for this delivery. Paystack does not send an event
     * id, so we derive one from the event type and the transaction reference —
     * see the adapter.
     */
    providerEventId: text("provider_event_id").notNull(),

    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    signatureValid: boolean("signature_valid").notNull(),

    processedAt: timestamp("processed_at", { withTimezone: true }),
    error: text("error"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("webhook_events_provider_event_unique").on(
      table.provider,
      table.providerEventId,
    ),
    index("webhook_events_unprocessed_idx")
      .on(table.createdAt)
      .where(sql`${table.processedAt} is null`),
  ],
);

export type PaymentMethod = typeof paymentMethods.$inferSelect;
export type BankAccount = typeof bankAccounts.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type PaymentStatus = (typeof paymentStatusEnum.enumValues)[number];
export type PaymentPurpose = (typeof paymentPurposeEnum.enumValues)[number];

/** Charged and refunded purely to obtain a reusable authorization code. */
export const TOKENIZATION_AMOUNT_KOBO = 5_000n;
