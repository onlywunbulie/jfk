import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/lib/db/testing";
import { Money } from "@/lib/money";

const t: TestDb = await createTestDb();
vi.mock("@/lib/db", async () => ({ db: t.db }));

const ledger = await import("./service");
const ops = await import("./operations");
const { reconcileLedger } = await import("./reconcile");
const { users, groups, groupSettings } = await import("@/lib/db/schema");

const GROUP = "019ff000-0000-7000-8000-00000000aaaa";
const OWNER = "019ff000-0000-7000-8000-00000000bbbb";

/** Groups are foreign-keyed from ledger_transactions, so they must exist. */
async function seedGroup(id = GROUP) {
  await t.db
    .insert(users)
    .values({ id: OWNER, email: `${id}@jfk.test`, displayName: "Owner" })
    .onConflictDoNothing();
  await t.db
    .insert(groups)
    .values({ id, name: "JFK Empire", ownerId: OWNER })
    .onConflictDoNothing();
  await t.db
    .insert(groupSettings)
    .values({ groupId: id })
    .onConflictDoNothing();
}

/** Fund a group's available balance the way a real contribution would. */
async function fund(amount: Money, contributionId = crypto.randomUUID()) {
  return ops.postContribution({
    contributionId,
    groupId: GROUP,
    memberUserId: OWNER,
    charged: amount,
    fee: Money.zero(),
  });
}

beforeEach(async () => {
  await t.reset();
  await seedGroup();
});

afterAll(async () => {
  await t.close();
});

// ---------------------------------------------------------------------------

describe("posting", () => {
  it("records a balanced transaction and moves the balance", async () => {
    const result = await fund(Money.fromMajor(50_000));
    expect(result.posted).toBe(true);

    const balances = await ledger.getGroupBalances(GROUP);
    expect(balances.available.format()).toBe("₦50,000.00");
    expect(balances.locked.isZero()).toBe(true);
    expect(balances.total.format()).toBe("₦50,000.00");
  });

  it("refuses an unbalanced transaction before it reaches the database", async () => {
    await expect(
      ledger.post({
        type: "ADJUSTMENT",
        idempotencyKey: "bad:1",
        description: "Money from nowhere",
        groupId: GROUP,
        legs: [
          {
            account: ledger.groupAvailable(GROUP),
            direction: "CREDIT",
            amount: Money.fromMajor(1_000),
          },
          {
            account: ledger.systemAccount("PSP_SETTLEMENT"),
            direction: "DEBIT",
            amount: Money.fromMajor(999),
          },
        ],
      }),
    ).rejects.toThrow(/does not balance/);
  });

  it("refuses a single-sided transaction", async () => {
    await expect(
      ledger.post({
        type: "ADJUSTMENT",
        idempotencyKey: "bad:2",
        description: "One-legged",
        groupId: GROUP,
        legs: [
          {
            account: ledger.groupAvailable(GROUP),
            direction: "CREDIT",
            amount: Money.fromMajor(1_000),
          },
        ],
      }),
    ).rejects.toThrow();
  });

  it("refuses a negative or zero entry", async () => {
    await expect(
      ledger.post({
        type: "ADJUSTMENT",
        idempotencyKey: "bad:3",
        description: "Negative leg",
        groupId: GROUP,
        legs: [
          {
            account: ledger.groupAvailable(GROUP),
            direction: "CREDIT",
            amount: Money.fromMajor(-100),
          },
          {
            account: ledger.systemAccount("PSP_SETTLEMENT"),
            direction: "DEBIT",
            amount: Money.fromMajor(-100),
          },
        ],
      }),
    ).rejects.toThrow(/must be positive/);
  });
});

describe("idempotency — the duplicate-charge guard", () => {
  it("posts the same contribution once no matter how often it is replayed", async () => {
    const id = "contribution-abc";

    const first = await fund(Money.fromMajor(50_000), id);
    const second = await fund(Money.fromMajor(50_000), id);
    const third = await fund(Money.fromMajor(50_000), id);

    expect(first.posted).toBe(true);
    expect(second.posted).toBe(false);
    expect(third.posted).toBe(false);
    expect(second.transactionId).toBe(first.transactionId);

    // The money landed exactly once.
    const balances = await ledger.getGroupBalances(GROUP);
    expect(balances.available.format()).toBe("₦50,000.00");
  });

  it("survives concurrent posts of the same key", async () => {
    const id = "contribution-race";

    // Sequential rather than Promise.all: PGlite is single-connection, so this
    // exercises the unique-index guard rather than driver-level queuing.
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await fund(Money.fromMajor(50_000), id));

    expect(results.filter((r) => r.posted)).toHaveLength(1);
    const balances = await ledger.getGroupBalances(GROUP);
    expect(balances.available.format()).toBe("₦50,000.00");
  });
});

describe("append-only enforcement", () => {
  it("blocks UPDATE and DELETE on entries", async () => {
    await fund(Money.fromMajor(1_000));

    await expect(
      t.sql(`update ledger_entries set amount = 999999`),
    ).rejects.toThrow(/append-only/);
    await expect(t.sql(`delete from ledger_entries`)).rejects.toThrow(
      /append-only/,
    );
  });

  it("blocks UPDATE and DELETE on transactions", async () => {
    await fund(Money.fromMajor(1_000));

    await expect(
      t.sql(`update ledger_transactions set description = 'tampered'`),
    ).rejects.toThrow(/append-only/);
    await expect(t.sql(`delete from ledger_transactions`)).rejects.toThrow(
      /append-only/,
    );
  });
});

describe("the database enforces balance, not just the application", () => {
  it("rejects a hand-written unbalanced transaction at COMMIT", async () => {
    // Bypasses the service entirely — this is the guarantee that survives a
    // bug in TypeScript, a migration, or someone in psql.
    await fund(Money.fromMajor(1_000));

    const accounts = await t.sql(
      `select id, purpose from ledger_accounts order by purpose`,
    );
    const rows = accounts.rows as { id: string; purpose: string }[];
    const available = rows.find((r) => r.purpose === "GROUP_AVAILABLE")!;
    const psp = rows.find((r) => r.purpose === "PSP_SETTLEMENT")!;

    await expect(
      t.exec(`
        begin;
        insert into ledger_transactions (id, type, idempotency_key, description)
          values ('tx-manual', 'ADJUSTMENT', 'manual:1', 'Sneaky');
        insert into ledger_entries (id, transaction_id, account_id, direction, amount)
          values ('e1', 'tx-manual', '${available.id}', 'CREDIT', 100000);
        insert into ledger_entries (id, transaction_id, account_id, direction, amount)
          values ('e2', 'tx-manual', '${psp.id}', 'DEBIT', 1);
        commit;
      `),
    ).rejects.toThrow(/does not balance/);

    // And nothing was left behind by the rejected commit.
    const after = await t.sql(
      `select count(*)::int as n from ledger_transactions where id = 'tx-manual'`,
    );
    expect((after.rows as { n: number }[])[0].n).toBe(0);
  });

  it("rejects a zero or negative entry amount at the column level", async () => {
    await fund(Money.fromMajor(1_000));
    const accounts = await t.sql(`select id from ledger_accounts limit 1`);
    const accountId = (accounts.rows as { id: string }[])[0].id;

    await expect(
      t.sql(`
        insert into ledger_transactions (id, type, idempotency_key, description)
          values ('tx-zero', 'ADJUSTMENT', 'zero:1', 'Zero');
        insert into ledger_entries (id, transaction_id, account_id, direction, amount)
          values ('ez', 'tx-zero', '${accountId}', 'DEBIT', 0);
      `),
    ).rejects.toThrow();
  });
});

describe("locking", () => {
  it("moves money from available to locked without changing the total", async () => {
    await fund(Money.fromMajor(500_000));
    await ops.lockFunds({
      groupId: GROUP,
      amount: Money.fromMajor(300_000),
      lockId: "lock-1",
    });

    const balances = await ledger.getGroupBalances(GROUP);
    expect(balances.available.format()).toBe("₦200,000.00");
    expect(balances.locked.format()).toBe("₦300,000.00");
    expect(balances.total.format()).toBe("₦500,000.00");
  });

  it("returns the money on unlock", async () => {
    await fund(Money.fromMajor(500_000));
    await ops.lockFunds({
      groupId: GROUP,
      amount: Money.fromMajor(300_000),
      lockId: "lock-1",
    });
    await ops.unlockFunds({
      groupId: GROUP,
      amount: Money.fromMajor(300_000),
      lockId: "lock-1",
    });

    const balances = await ledger.getGroupBalances(GROUP);
    expect(balances.available.format()).toBe("₦500,000.00");
    expect(balances.locked.isZero()).toBe(true);
  });

  it("refuses to lock more than is available", async () => {
    await fund(Money.fromMajor(100_000));

    await expect(
      ops.lockFunds({
        groupId: GROUP,
        amount: Money.fromMajor(200_000),
        lockId: "lock-too-big",
      }),
    ).rejects.toThrow(/Insufficient funds/);

    const balances = await ledger.getGroupBalances(GROUP);
    expect(balances.available.format()).toBe("₦100,000.00");
  });
});

describe("reservations — two proposals cannot spend the same naira", () => {
  it("lets the first approved proposal reserve and blocks the second", async () => {
    await fund(Money.fromMajor(500_000));

    await ops.reserveForProposal({
      groupId: GROUP,
      amount: Money.fromMajor(300_000),
      proposalId: "proposal-1",
    });

    // ₦200,000 left, so a second ₦300,000 proposal cannot also be funded.
    await expect(
      ops.reserveForProposal({
        groupId: GROUP,
        amount: Money.fromMajor(300_000),
        proposalId: "proposal-2",
      }),
    ).rejects.toThrow(/Insufficient funds/);

    const balances = await ledger.getGroupBalances(GROUP);
    expect(balances.available.format()).toBe("₦200,000.00");
    expect(balances.locked.format()).toBe("₦300,000.00");
    expect(balances.total.format()).toBe("₦500,000.00");
  });

  it("restores the exact prior balance when a payout fails", async () => {
    await fund(Money.fromMajor(500_000));
    const before = await ledger.getGroupBalances(GROUP);

    await ops.reserveForProposal({
      groupId: GROUP,
      amount: Money.fromMajor(300_000),
      proposalId: "proposal-1",
    });
    await ops.releaseReservation({
      groupId: GROUP,
      amount: Money.fromMajor(300_000),
      proposalId: "proposal-1",
      reason: "transfer failed",
    });

    const after = await ledger.getGroupBalances(GROUP);
    expect(after.available.equals(before.available)).toBe(true);
    expect(after.locked.equals(before.locked)).toBe(true);
    expect(after.total.equals(before.total)).toBe(true);
  });
});

describe("payout", () => {
  it("takes money out of locked and off the platform", async () => {
    await fund(Money.fromMajor(500_000));
    await ops.reserveForProposal({
      groupId: GROUP,
      amount: Money.fromMajor(300_000),
      proposalId: "proposal-1",
    });
    await ops.postPayout({
      groupId: GROUP,
      amount: Money.fromMajor(300_000),
      releaseId: "release-1",
      destination: "GTB ****4321",
    });

    const balances = await ledger.getGroupBalances(GROUP);
    expect(balances.available.format()).toBe("₦200,000.00");
    expect(balances.locked.isZero()).toBe(true);
    expect(balances.total.format()).toBe("₦200,000.00");

    // Cash left the platform too.
    const psp = await ledger.getBalance(ledger.systemAccount("PSP_SETTLEMENT"));
    expect(psp.format()).toBe("₦200,000.00");
  });
});

describe("the JFK Empire worked example", () => {
  it("runs the whole §3 scenario and lands on the right numbers", async () => {
    // Ten friends contribute ₦50,000 each.
    for (let i = 0; i < 10; i++) {
      await fund(Money.fromMajor(50_000), `cycle1-member-${i}`);
    }

    let balances = await ledger.getGroupBalances(GROUP);
    expect(balances.total.format()).toBe("₦500,000.00");

    // An admin's ₦300,000 proposal passes and reserves the funds.
    await ops.reserveForProposal({
      groupId: GROUP,
      amount: Money.fromMajor(300_000),
      proposalId: "purchase-x",
    });

    balances = await ledger.getGroupBalances(GROUP);
    expect(balances.available.format()).toBe("₦200,000.00");
    expect(balances.locked.format()).toBe("₦300,000.00");

    // It executes.
    await ops.postPayout({
      groupId: GROUP,
      amount: Money.fromMajor(300_000),
      releaseId: "purchase-x-release",
      destination: "Vendor",
    });

    balances = await ledger.getGroupBalances(GROUP);
    expect(balances.total.format()).toBe("₦200,000.00");

    const report = await reconcileLedger(t.db);
    expect(report.clean).toBe(true);
    expect(report.findings).toEqual([]);
  });
});

describe("gateway fees", () => {
  it("credits the group the cash that arrived, and records the fee", async () => {
    // Absorb mode: charged ₦50,000, Paystack takes ₦850, group gets ₦49,150.
    await ops.postContribution({
      contributionId: "fee-1",
      groupId: GROUP,
      memberUserId: OWNER,
      charged: Money.fromMajor(50_000),
      fee: Money.fromMajor(850),
    });

    const balances = await ledger.getGroupBalances(GROUP);
    expect(balances.available.format()).toBe("₦49,150.00");

    const feeExpense = await ledger.getBalance(ledger.systemAccount("FEE_EXPENSE"));
    expect(feeExpense.format()).toBe("₦850.00");

    // The fee legs are a wash on JFK's own books.
    const feeRecovery = await ledger.getBalance(
      ledger.systemAccount("FEE_RECOVERY"),
    );
    expect(feeRecovery.equals(feeExpense)).toBe(true);

    const report = await reconcileLedger(t.db);
    expect(report.clean).toBe(true);
  });

  it("refuses a contribution whose fee swallows the whole charge", async () => {
    await expect(
      ops.postContribution({
        contributionId: "fee-2",
        groupId: GROUP,
        memberUserId: OWNER,
        charged: Money.fromMajor(100),
        fee: Money.fromMajor(100),
      }),
    ).rejects.toThrow(/must be positive/);
  });
});

describe("reversal", () => {
  it("undoes a transaction by posting its mirror image", async () => {
    const contribution = await fund(Money.fromMajor(50_000), "to-reverse");
    await ledger.reverse(contribution.transactionId, "charged in error");

    const balances = await ledger.getGroupBalances(GROUP);
    expect(balances.total.isZero()).toBe(true);

    // Both the original and the correction remain in the history.
    const entries = await ledger.listEntries(ledger.groupAvailable(GROUP));
    expect(entries).toHaveLength(2);
    expect(entries.some((e) => e.type === "REVERSAL")).toBe(true);

    const report = await reconcileLedger(t.db);
    expect(report.clean).toBe(true);
  });

  it("is itself idempotent", async () => {
    const contribution = await fund(Money.fromMajor(50_000), "to-reverse");
    const first = await ledger.reverse(contribution.transactionId, "error");
    const second = await ledger.reverse(contribution.transactionId, "error");

    expect(first.posted).toBe(true);
    expect(second.posted).toBe(false);
    expect((await ledger.getGroupBalances(GROUP)).total.isZero()).toBe(true);
  });
});

describe("statement", () => {
  it("signs amounts from the account's point of view", async () => {
    await fund(Money.fromMajor(50_000), "in-1");
    await ops.lockFunds({
      groupId: GROUP,
      amount: Money.fromMajor(20_000),
      lockId: "lock-1",
    });

    const entries = await ledger.listEntries(ledger.groupAvailable(GROUP));
    const contribution = entries.find((e) => e.type === "CONTRIBUTION")!;
    const lock = entries.find((e) => e.type === "FUND_LOCK")!;

    expect(contribution.amount.format()).toBe("₦50,000.00");
    expect(lock.amount.format()).toBe("-₦20,000.00");
  });
});

describe("group isolation", () => {
  it("keeps one group's money entirely separate from another's", async () => {
    const other = "019ff000-0000-7000-8000-00000000cccc";
    await seedGroup(other);

    await fund(Money.fromMajor(500_000));
    await ops.postContribution({
      contributionId: "other-1",
      groupId: other,
      memberUserId: OWNER,
      charged: Money.fromMajor(10_000),
      fee: Money.zero(),
    });

    expect((await ledger.getGroupBalances(GROUP)).total.format()).toBe(
      "₦500,000.00",
    );
    expect((await ledger.getGroupBalances(other)).total.format()).toBe(
      "₦10,000.00",
    );
  });
});
