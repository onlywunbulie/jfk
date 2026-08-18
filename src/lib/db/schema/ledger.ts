import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createdAt, primaryId } from "./identity";
import { groups } from "./groups";

/**
 * The ledger. Read BLUEPRINT.md §8 before changing anything here.
 *
 * Double-entry: every movement of money is one transaction made of two or more
 * entries whose debits and credits sum to the same amount. Balances are never
 * stored as a mutable field — they are derived by summing entries. The cache in
 * `account_balances` is an optimisation that a nightly job re-derives and
 * alarms on if it has drifted.
 *
 * Entries and transactions are append-only, enforced by database triggers. A
 * mistake is corrected with a reversing transaction, never an edit.
 */

// ---------------------------------------------------------------------------
// Account model
// ---------------------------------------------------------------------------

export const accountOwnerTypeEnum = pgEnum("account_owner_type", [
  "USER",
  "GROUP",
  "SYSTEM",
]);

/**
 * What an account is for.
 *
 *  PSP_SETTLEMENT — cash sitting in the Paystack balance. An asset.
 *  GROUP_AVAILABLE — money a group can propose to spend. We owe it: a liability.
 *  GROUP_RESERVED — money an approved proposal is about to spend. Fenced off
 *    so a second proposal cannot claim the same naira.
 *  USER_WALLET — reserved. The MVP personal wallet is a view, not a balance.
 *  FEE_EXPENSE — gateway fees incurred.
 *  FEE_RECOVERY — fees funded by whoever paid the charge. Offsets FEE_EXPENSE.
 *  EXTERNAL — the world outside JFK: destination bank accounts on payout.
 *  SUSPENSE — money we have received but cannot yet attribute. Must end at zero.
 */
export const accountPurposeEnum = pgEnum("account_purpose", [
  "PSP_SETTLEMENT",
  "GROUP_AVAILABLE",
  "GROUP_RESERVED",
  "USER_WALLET",
  "FEE_EXPENSE",
  "FEE_RECOVERY",
  "EXTERNAL",
  "SUSPENSE",
]);

/**
 * Accounting classification, which decides the sign of a "healthy" balance.
 *
 * Assets and expenses increase with debits; liabilities and income increase
 * with credits. Storing this on the account lets one generic balance function
 * present every account the right way up.
 */
export const accountKindEnum = pgEnum("account_kind", [
  "ASSET",
  "LIABILITY",
  "INCOME",
  "EXPENSE",
]);

export const entryDirectionEnum = pgEnum("entry_direction", ["DEBIT", "CREDIT"]);

/** Why a transaction happened. Enumerated so history stays queryable. */
export const ledgerTransactionTypeEnum = pgEnum("ledger_transaction_type", [
  "CONTRIBUTION",
  "FUND_LOCK",
  "FUND_UNLOCK",
  "RESERVATION",
  "RESERVATION_RELEASE",
  "PAYOUT",
  "REFUND",
  "REVERSAL",
  "ADJUSTMENT",
]);

export const ledgerAccounts = pgTable(
  "ledger_accounts",
  {
    id: primaryId(),
    ownerType: accountOwnerTypeEnum("owner_type").notNull(),
    /** Null for SYSTEM accounts, which are singletons per purpose. */
    ownerId: text("owner_id"),
    purpose: accountPurposeEnum("purpose").notNull(),
    kind: accountKindEnum("kind").notNull(),
    currency: text("currency").notNull().default("NGN"),
    createdAt: createdAt(),
  },
  (table) => [
    // One account per owner per purpose. `coalesce` so SYSTEM accounts, whose
    // owner_id is null, still collide correctly — NULLs are distinct in a
    // plain unique index, which would let duplicates through.
    uniqueIndex("ledger_accounts_identity_unique").on(
      table.ownerType,
      sql`coalesce(${table.ownerId}, '')`,
      table.purpose,
      table.currency,
    ),
    index("ledger_accounts_owner_idx").on(table.ownerType, table.ownerId),
  ],
);

// ---------------------------------------------------------------------------
// Transactions and entries
// ---------------------------------------------------------------------------

export const ledgerTransactions = pgTable(
  "ledger_transactions",
  {
    id: primaryId(),
    type: ledgerTransactionTypeEnum("type").notNull(),
    groupId: text("group_id").references(() => groups.id, {
      onDelete: "restrict",
    }),

    /**
     * The duplicate guard. Every posting names the thing it represents —
     * `contribution:{id}`, `payout:{releaseId}` — so replaying a webhook or
     * retrying a job can never post the same money twice.
     */
    idempotencyKey: text("idempotency_key").notNull(),

    description: text("description").notNull(),
    metadata: jsonb("metadata"),

    /** When the money moved, which may predate when we learned about it. */
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("ledger_transactions_idempotency_unique").on(table.idempotencyKey),
    index("ledger_transactions_group_idx").on(table.groupId, table.occurredAt),
  ],
);

export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: primaryId(),
    transactionId: text("transaction_id")
      .notNull()
      .references(() => ledgerTransactions.id, { onDelete: "restrict" }),
    accountId: text("account_id")
      .notNull()
      .references(() => ledgerAccounts.id, { onDelete: "restrict" }),
    direction: entryDirectionEnum("direction").notNull(),

    /** Always positive. Direction carries the sign, so there are no negatives. */
    amount: bigint("amount", { mode: "bigint" }).notNull(),

    createdAt: createdAt(),
  },
  (table) => [
    check("ledger_entries_amount_positive", sql`${table.amount} > 0`),
    index("ledger_entries_account_idx").on(table.accountId, table.createdAt),
    index("ledger_entries_transaction_idx").on(table.transactionId),
  ],
);

// ---------------------------------------------------------------------------
// Balance cache
// ---------------------------------------------------------------------------

/**
 * Running totals, updated inside the same transaction that writes the entries.
 *
 * This is an optimisation, not the truth. `reconcileLedger()` recomputes every
 * balance from the entries and raises the alarm on any drift.
 */
export const accountBalances = pgTable("account_balances", {
  accountId: text("account_id")
    .primaryKey()
    .references(() => ledgerAccounts.id, { onDelete: "restrict" }),
  debits: bigint("debits", { mode: "bigint" }).notNull().default(sql`0`),
  credits: bigint("credits", { mode: "bigint" }).notNull().default(sql`0`),
  entryCount: bigint("entry_count", { mode: "bigint" }).notNull().default(sql`0`),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type LedgerAccount = typeof ledgerAccounts.$inferSelect;
export type LedgerTransaction = typeof ledgerTransactions.$inferSelect;
export type LedgerEntry = typeof ledgerEntries.$inferSelect;
export type AccountBalance = typeof accountBalances.$inferSelect;

export type AccountPurpose = (typeof accountPurposeEnum.enumValues)[number];
export type AccountKind = (typeof accountKindEnum.enumValues)[number];
export type AccountOwnerType = (typeof accountOwnerTypeEnum.enumValues)[number];
export type EntryDirection = (typeof entryDirectionEnum.enumValues)[number];
export type LedgerTransactionType =
  (typeof ledgerTransactionTypeEnum.enumValues)[number];

/** The accounting kind for each purpose. Single source of truth for signs. */
export const PURPOSE_KIND: Record<AccountPurpose, AccountKind> = {
  PSP_SETTLEMENT: "ASSET",
  GROUP_AVAILABLE: "LIABILITY",
  GROUP_RESERVED: "LIABILITY",
  USER_WALLET: "LIABILITY",
  FEE_EXPENSE: "EXPENSE",
  FEE_RECOVERY: "INCOME",
  EXTERNAL: "LIABILITY",
  SUSPENSE: "LIABILITY",
};

/** Purposes that belong to a group rather than a user or the system. */
export const GROUP_PURPOSES = ["GROUP_AVAILABLE", "GROUP_RESERVED"] as const;

/** Purposes with exactly one system-wide account. */
export const SYSTEM_PURPOSES = [
  "PSP_SETTLEMENT",
  "FEE_EXPENSE",
  "FEE_RECOVERY",
  "EXTERNAL",
  "SUSPENSE",
] as const;
