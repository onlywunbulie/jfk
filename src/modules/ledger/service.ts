import "server-only";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, type Transaction } from "@/lib/db";
import {
  accountBalances,
  ledgerAccounts,
  ledgerEntries,
  ledgerTransactions,
  PURPOSE_KIND,
  type AccountOwnerType,
  type AccountPurpose,
  type LedgerTransactionType,
} from "@/lib/db/schema";
import { Money, type Currency } from "@/lib/money";

/**
 * The ledger.
 *
 * **This module is the only place in the codebase that may write to the
 * `ledger_*` tables.** Everything else asks it to post a transaction. See
 * BLUEPRINT.md §8 and §12.
 *
 * Sign convention: entries are always positive and carry a direction. An
 * account's *raw* balance is `debits - credits`, which sums to zero across the
 * whole system. Its *normal* balance flips sign for liabilities and income, so
 * a group's treasury reads as a positive number.
 */

// ---------------------------------------------------------------------------
// Account addressing
// ---------------------------------------------------------------------------

export interface AccountRef {
  ownerType: AccountOwnerType;
  /** Null for SYSTEM accounts, which are singletons. */
  ownerId: string | null;
  purpose: AccountPurpose;
  currency?: Currency;
}

export const groupAvailable = (groupId: string): AccountRef => ({
  ownerType: "GROUP",
  ownerId: groupId,
  purpose: "GROUP_AVAILABLE",
});

export const groupReserved = (groupId: string): AccountRef => ({
  ownerType: "GROUP",
  ownerId: groupId,
  purpose: "GROUP_RESERVED",
});

export const systemAccount = (purpose: AccountPurpose): AccountRef => ({
  ownerType: "SYSTEM",
  ownerId: null,
  purpose,
});

/**
 * Find or create an account.
 *
 * Created on demand rather than provisioned up front: a group that has never
 * received money has no need of a row, and `ON CONFLICT` makes the lazy path
 * safe under concurrency.
 */
export async function ensureAccount(
  executor: Transaction | typeof db,
  ref: AccountRef,
): Promise<string> {
  const currency = ref.currency ?? "NGN";

  const [existing] = await executor
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.ownerType, ref.ownerType),
        ref.ownerId === null
          ? isNull(ledgerAccounts.ownerId)
          : eq(ledgerAccounts.ownerId, ref.ownerId),
        eq(ledgerAccounts.purpose, ref.purpose),
        eq(ledgerAccounts.currency, currency),
      ),
    )
    .limit(1);

  if (existing) return existing.id;

  const [created] = await executor
    .insert(ledgerAccounts)
    .values({
      ownerType: ref.ownerType,
      ownerId: ref.ownerId,
      purpose: ref.purpose,
      kind: PURPOSE_KIND[ref.purpose],
      currency,
    })
    .onConflictDoNothing()
    .returning({ id: ledgerAccounts.id });

  if (created) {
    await executor
      .insert(accountBalances)
      .values({ accountId: created.id })
      .onConflictDoNothing();
    return created.id;
  }

  // Lost the race; the other writer's row is now visible.
  const [raced] = await executor
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.ownerType, ref.ownerType),
        ref.ownerId === null
          ? isNull(ledgerAccounts.ownerId)
          : eq(ledgerAccounts.ownerId, ref.ownerId),
        eq(ledgerAccounts.purpose, ref.purpose),
        eq(ledgerAccounts.currency, currency),
      ),
    )
    .limit(1);

  if (!raced) {
    throw new Error(
      `Could not create or find ledger account ${ref.ownerType}/${ref.purpose}`,
    );
  }
  return raced.id;
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

export interface PostingLeg {
  account: AccountRef;
  direction: "DEBIT" | "CREDIT";
  amount: Money;
}

export interface PostingInput {
  type: LedgerTransactionType;
  /**
   * Names the real-world thing this posting represents, e.g.
   * `contribution:{id}`. Posting the same key twice is a no-op, which is what
   * makes webhook replays and job retries harmless.
   */
  idempotencyKey: string;
  description: string;
  groupId?: string | null;
  legs: PostingLeg[];
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
}

export interface PostingResult {
  transactionId: string;
  /** False when this key had already been posted and nothing new happened. */
  posted: boolean;
}

export class UnbalancedTransactionError extends Error {
  constructor(debits: Money, credits: Money) {
    super(
      `Ledger transaction does not balance: debits ${debits.format()} vs credits ${credits.format()}`,
    );
    this.name = "UnbalancedTransactionError";
  }
}

export class InsufficientFundsError extends Error {
  constructor(
    readonly accountPurpose: AccountPurpose,
    readonly available: Money,
    readonly requested: Money,
  ) {
    super(
      `Insufficient funds in ${accountPurpose}: ${available.format()} available, ${requested.format()} requested`,
    );
    this.name = "InsufficientFundsError";
  }
}

/**
 * Post a balanced transaction.
 *
 * Everything happens in one database transaction: the transaction row, its
 * entries, and the balance-cache updates commit together or not at all. The
 * database re-checks that the entries balance and that no group account went
 * negative at COMMIT, so a bug here cannot corrupt the books — it can only
 * fail loudly.
 *
 * Pass `executor` to join an outer transaction, so a contribution's ledger
 * posting and its `contributions` row update commit atomically.
 */
export async function post(
  input: PostingInput,
  executor?: Transaction,
): Promise<PostingResult> {
  assertBalanced(input.legs);

  const run = async (tx: Transaction): Promise<PostingResult> => {
    // The unique index on idempotency_key is the real guard; this makes the
    // common replay case cheap and gives us the existing id to return.
    const [existing] = await tx
      .select({ id: ledgerTransactions.id })
      .from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, input.idempotencyKey))
      .limit(1);

    if (existing) return { transactionId: existing.id, posted: false };

    const [transaction] = await tx
      .insert(ledgerTransactions)
      .values({
        type: input.type,
        groupId: input.groupId ?? null,
        idempotencyKey: input.idempotencyKey,
        description: input.description,
        metadata: input.metadata ?? null,
        occurredAt: input.occurredAt ?? new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: ledgerTransactions.id });

    // Another writer inserted the same key between our check and our insert.
    if (!transaction) {
      const [raced] = await tx
        .select({ id: ledgerTransactions.id })
        .from(ledgerTransactions)
        .where(eq(ledgerTransactions.idempotencyKey, input.idempotencyKey))
        .limit(1);
      return { transactionId: raced.id, posted: false };
    }

    for (const leg of input.legs) {
      const accountId = await ensureAccount(tx, leg.account);

      await tx.insert(ledgerEntries).values({
        transactionId: transaction.id,
        accountId,
        direction: leg.direction,
        amount: leg.amount.minor,
      });

      // Keep the cache in step within the same transaction. The nightly
      // reconciliation re-derives these from entries and alarms on drift.
      await tx
        .update(accountBalances)
        .set({
          debits:
            leg.direction === "DEBIT"
              ? sql`${accountBalances.debits} + ${leg.amount.minor}`
              : accountBalances.debits,
          credits:
            leg.direction === "CREDIT"
              ? sql`${accountBalances.credits} + ${leg.amount.minor}`
              : accountBalances.credits,
          entryCount: sql`${accountBalances.entryCount} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(accountBalances.accountId, accountId));
    }

    return { transactionId: transaction.id, posted: true };
  };

  return executor ? run(executor) : db.transaction(run);
}

/** Debits must equal credits, and there must be at least two legs. */
function assertBalanced(legs: PostingLeg[]): void {
  if (legs.length < 2) {
    throw new UnbalancedTransactionError(Money.zero(), Money.zero());
  }

  let debits = Money.zero();
  let credits = Money.zero();

  for (const leg of legs) {
    if (!leg.amount.isPositive()) {
      throw new Error(
        `Ledger entries must be positive; direction carries the sign. Got ${leg.amount.format()}`,
      );
    }
    if (leg.direction === "DEBIT") debits = debits.plus(leg.amount);
    else credits = credits.plus(leg.amount);
  }

  if (!debits.equals(credits)) throw new UnbalancedTransactionError(debits, credits);
}

/**
 * Post the exact opposite of an existing transaction.
 *
 * The only sanctioned way to undo something: the original stays in the record
 * and the correction is visible beside it.
 */
export async function reverse(
  transactionId: string,
  reason: string,
  executor?: Transaction,
): Promise<PostingResult> {
  const run = async (tx: Transaction): Promise<PostingResult> => {
    const [original] = await tx
      .select()
      .from(ledgerTransactions)
      .where(eq(ledgerTransactions.id, transactionId))
      .limit(1);

    if (!original) throw new Error(`No ledger transaction ${transactionId}`);

    const entries = await tx
      .select({
        accountId: ledgerEntries.accountId,
        direction: ledgerEntries.direction,
        amount: ledgerEntries.amount,
        ownerType: ledgerAccounts.ownerType,
        ownerId: ledgerAccounts.ownerId,
        purpose: ledgerAccounts.purpose,
        currency: ledgerAccounts.currency,
      })
      .from(ledgerEntries)
      .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
      .where(eq(ledgerEntries.transactionId, transactionId));

    return post(
      {
        type: "REVERSAL",
        idempotencyKey: `reversal:${transactionId}`,
        description: `Reversal of ${original.description}: ${reason}`,
        groupId: original.groupId,
        metadata: { reversedTransactionId: transactionId, reason },
        legs: entries.map((entry) => ({
          account: {
            ownerType: entry.ownerType,
            ownerId: entry.ownerId,
            purpose: entry.purpose,
            currency: entry.currency as Currency,
          },
          direction: entry.direction === "DEBIT" ? ("CREDIT" as const) : ("DEBIT" as const),
          amount: Money.fromMinor(entry.amount),
        })),
      },
      tx,
    );
  };

  return executor ? run(executor) : db.transaction(run);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Balance of one account, in its natural direction.
 *
 * Derived from entries rather than read from the cache: correctness first.
 * `getGroupBalances` uses the cache for the hot path.
 */
export async function getBalance(
  ref: AccountRef,
  executor: Transaction | typeof db = db,
): Promise<Money> {
  const currency = ref.currency ?? "NGN";

  const [row] = await executor
    .select({
      debits: sql<string>`coalesce(sum(case when ${ledgerEntries.direction} = 'DEBIT' then ${ledgerEntries.amount} else 0 end), 0)`,
      credits: sql<string>`coalesce(sum(case when ${ledgerEntries.direction} = 'CREDIT' then ${ledgerEntries.amount} else 0 end), 0)`,
    })
    .from(ledgerEntries)
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
    .where(
      and(
        eq(ledgerAccounts.ownerType, ref.ownerType),
        ref.ownerId === null
          ? isNull(ledgerAccounts.ownerId)
          : eq(ledgerAccounts.ownerId, ref.ownerId),
        eq(ledgerAccounts.purpose, ref.purpose),
        eq(ledgerAccounts.currency, currency),
      ),
    );

  return normalBalance(
    ref.purpose,
    BigInt(row?.debits ?? 0),
    BigInt(row?.credits ?? 0),
    currency,
  );
}

export interface GroupBalances {
  available: Money;
  reserved: Money;
  total: Money;
}

/** The two numbers a group wallet shows, plus their sum. From the cache. */
export async function getGroupBalances(
  groupId: string,
  currency: Currency = "NGN",
  executor: Transaction | typeof db = db,
): Promise<GroupBalances> {
  const rows = await executor
    .select({
      purpose: ledgerAccounts.purpose,
      debits: accountBalances.debits,
      credits: accountBalances.credits,
    })
    .from(accountBalances)
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, accountBalances.accountId))
    .where(
      and(
        eq(ledgerAccounts.ownerType, "GROUP"),
        eq(ledgerAccounts.ownerId, groupId),
        eq(ledgerAccounts.currency, currency),
        inArray(ledgerAccounts.purpose, ["GROUP_AVAILABLE", "GROUP_RESERVED"]),
      ),
    );

  let available = Money.zero(currency);
  let reserved = Money.zero(currency);

  for (const row of rows) {
    const balance = normalBalance(row.purpose, row.debits, row.credits, currency);
    if (row.purpose === "GROUP_AVAILABLE") available = balance;
    else reserved = balance;
  }

  return { available, reserved, total: available.plus(reserved) };
}

/**
 * Balances for many groups at once.
 *
 * The home screen lists every group a user belongs to; one query rather than
 * one per group. Groups with no money yet simply have no account rows, so the
 * caller fills in zero.
 */
export async function getBalancesForGroups(
  groupIds: string[],
  currency: Currency = "NGN",
): Promise<Map<string, GroupBalances>> {
  const result = new Map<string, GroupBalances>();
  if (groupIds.length === 0) return result;

  const rows = await db
    .select({
      groupId: ledgerAccounts.ownerId,
      purpose: ledgerAccounts.purpose,
      debits: accountBalances.debits,
      credits: accountBalances.credits,
    })
    .from(accountBalances)
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, accountBalances.accountId))
    .where(
      and(
        eq(ledgerAccounts.ownerType, "GROUP"),
        inArray(ledgerAccounts.ownerId, groupIds),
        eq(ledgerAccounts.currency, currency),
        inArray(ledgerAccounts.purpose, ["GROUP_AVAILABLE", "GROUP_RESERVED"]),
      ),
    );

  for (const groupId of groupIds) {
    result.set(groupId, {
      available: Money.zero(currency),
      reserved: Money.zero(currency),
      total: Money.zero(currency),
    });
  }

  for (const row of rows) {
    if (!row.groupId) continue;
    const current = result.get(row.groupId);
    if (!current) continue;

    const balance = normalBalance(row.purpose, row.debits, row.credits, currency);
    const next =
      row.purpose === "GROUP_AVAILABLE"
        ? { ...current, available: balance }
        : { ...current, reserved: balance };

    result.set(row.groupId, { ...next, total: next.available.plus(next.reserved) });
  }

  return result;
}

/** Flip the sign for liabilities and income so a healthy balance is positive. */
function normalBalance(
  purpose: AccountPurpose,
  debits: bigint,
  credits: bigint,
  currency: Currency = "NGN",
): Money {
  const kind = PURPOSE_KIND[purpose];
  const raw =
    kind === "ASSET" || kind === "EXPENSE" ? debits - credits : credits - debits;
  return Money.fromMinor(raw, currency);
}

export interface LedgerEntryView {
  transactionId: string;
  type: LedgerTransactionType;
  description: string;
  /** Signed from the account's own point of view: positive is money in. */
  amount: Money;
  occurredAt: Date;
  metadata: unknown;
}

/** Statement for one account, newest first. */
export async function listEntries(
  ref: AccountRef,
  options: { limit?: number; offset?: number } = {},
): Promise<LedgerEntryView[]> {
  const currency = ref.currency ?? "NGN";
  const kind = PURPOSE_KIND[ref.purpose];
  const increasesWithDebit = kind === "ASSET" || kind === "EXPENSE";

  const rows = await db
    .select({
      transactionId: ledgerTransactions.id,
      type: ledgerTransactions.type,
      description: ledgerTransactions.description,
      direction: ledgerEntries.direction,
      amount: ledgerEntries.amount,
      occurredAt: ledgerTransactions.occurredAt,
      metadata: ledgerTransactions.metadata,
    })
    .from(ledgerEntries)
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
    .innerJoin(
      ledgerTransactions,
      eq(ledgerTransactions.id, ledgerEntries.transactionId),
    )
    .where(
      and(
        eq(ledgerAccounts.ownerType, ref.ownerType),
        ref.ownerId === null
          ? isNull(ledgerAccounts.ownerId)
          : eq(ledgerAccounts.ownerId, ref.ownerId),
        eq(ledgerAccounts.purpose, ref.purpose),
        eq(ledgerAccounts.currency, currency),
      ),
    )
    .orderBy(desc(ledgerTransactions.occurredAt), desc(ledgerEntries.id))
    .limit(options.limit ?? 50)
    .offset(options.offset ?? 0);

  return rows.map((row) => {
    const isIncrease =
      (row.direction === "DEBIT") === increasesWithDebit;
    const magnitude = Money.fromMinor(row.amount, currency);
    return {
      transactionId: row.transactionId,
      type: row.type,
      description: row.description,
      amount: isIncrease ? magnitude : magnitude.negated(),
      occurredAt: row.occurredAt,
      metadata: row.metadata,
    };
  });
}
