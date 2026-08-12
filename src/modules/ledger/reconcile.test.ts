import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/lib/db/testing";
import { Money } from "@/lib/money";

const t: TestDb = await createTestDb();
vi.mock("@/lib/db", async () => ({ db: t.db }));

const ledger = await import("./service");
const ops = await import("./operations");
const { reconcileLedger, describeReport } = await import("./reconcile");
const { users, groups, groupSettings, ledgerEntries } = await import(
  "@/lib/db/schema"
);

const GROUPS = [
  "019ff000-0000-7000-8000-0000000a0001",
  "019ff000-0000-7000-8000-0000000a0002",
  "019ff000-0000-7000-8000-0000000a0003",
];
const OWNER = "019ff000-0000-7000-8000-0000000b0001";

async function seed() {
  await t.db
    .insert(users)
    .values({ id: OWNER, email: "owner@jfk.test", displayName: "Owner" })
    .onConflictDoNothing();

  for (const [i, id] of GROUPS.entries()) {
    await t.db
      .insert(groups)
      .values({ id, name: `Group ${i + 1}`, ownerId: OWNER })
      .onConflictDoNothing();
    await t.db.insert(groupSettings).values({ groupId: id }).onConflictDoNothing();
  }
}

beforeEach(async () => {
  await t.reset();
  await seed();
});

afterAll(async () => {
  await t.close();
});

describe("reconciliation on a healthy ledger", () => {
  it("is clean when nothing has happened", async () => {
    const report = await reconcileLedger(t.db);
    expect(report.clean).toBe(true);
    expect(report.findings).toEqual([]);
    expect(describeReport(report)).toMatch(/Ledger clean/);
  });

  it("is clean after a realistic sequence of operations", async () => {
    for (let i = 0; i < 10; i++) {
      await ops.postContribution({
        contributionId: `c-${i}`,
        groupId: GROUPS[0],
        memberUserId: OWNER,
        charged: Money.fromMajor(50_000),
        fee: Money.fromMajor(850),
      });
    }
    await ops.lockFunds({
      groupId: GROUPS[0],
      amount: Money.fromMajor(100_000),
      lockId: "l-1",
    });
    await ops.reserveForProposal({
      groupId: GROUPS[0],
      amount: Money.fromMajor(200_000),
      proposalId: "p-1",
    });
    await ops.postPayout({
      groupId: GROUPS[0],
      amount: Money.fromMajor(200_000),
      releaseId: "r-1",
      destination: "Vendor",
    });

    const report = await reconcileLedger(t.db);
    expect(report.clean).toBe(true);
    expect(report.transactionsChecked).toBe(13);
  });
});

describe("reconciliation catches real corruption", () => {
  /**
   * These tests deliberately corrupt the ledger to prove the job would notice.
   * They go around the service and the triggers on purpose — reconciliation is
   * the backstop for exactly the cases those layers did not catch.
   */

  it("detects cache drift", async () => {
    await ops.postContribution({
      contributionId: "c-1",
      groupId: GROUPS[0],
      memberUserId: OWNER,
      charged: Money.fromMajor(50_000),
      fee: Money.zero(),
    });

    // Pretend a posting updated entries but botched the cache.
    await t.sql(`update account_balances set credits = credits + 100000`);

    const report = await reconcileLedger(t.db);
    expect(report.clean).toBe(false);
    expect(report.findings.some((f) => f.invariant === "cache_matches_entries")).toBe(
      true,
    );
    expect(describeReport(report)).toMatch(/cache says/);
  });

  it("detects a system-wide imbalance", async () => {
    await ops.postContribution({
      contributionId: "c-1",
      groupId: GROUPS[0],
      memberUserId: OWNER,
      charged: Money.fromMajor(50_000),
      fee: Money.zero(),
    });

    // Insert a lone entry, disabling the deferred balance trigger to simulate
    // corruption that arrived some other way (a bad migration, direct SQL).
    const rows = (
      await t.sql(
        `select id from ledger_accounts where purpose = 'GROUP_AVAILABLE'`,
      )
    ).rows as { id: string }[];

    await t.exec(`
      begin;
      alter table ledger_entries disable trigger ledger_entries_must_balance;
      insert into ledger_transactions (id, type, idempotency_key, description)
        values ('tx-bad', 'ADJUSTMENT', 'bad:1', 'Corrupt');
      insert into ledger_entries (id, transaction_id, account_id, direction, amount)
        values ('e-bad', 'tx-bad', '${rows[0].id}', 'CREDIT', 999);
      alter table ledger_entries enable trigger ledger_entries_must_balance;
      commit;
    `);

    const report = await reconcileLedger(t.db);
    expect(report.clean).toBe(false);
    expect(
      report.findings.some((f) => f.invariant === "system_sums_to_zero"),
    ).toBe(true);
    expect(report.findings.some((f) => f.invariant === "double_entry")).toBe(true);
  });

  it("flags money stranded in suspense as a warning, not corruption", async () => {
    await ledger.post({
      type: "ADJUSTMENT",
      idempotencyKey: "susp:1",
      description: "Unattributed deposit",
      legs: [
        {
          account: ledger.systemAccount("PSP_SETTLEMENT"),
          direction: "DEBIT",
          amount: Money.fromMajor(5_000),
        },
        {
          account: ledger.systemAccount("SUSPENSE"),
          direction: "CREDIT",
          amount: Money.fromMajor(5_000),
        },
      ],
    });

    const report = await reconcileLedger(t.db);
    // The books balance, so this is not corruption — but it needs a human.
    expect(report.clean).toBe(true);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      invariant: "suspense_empty",
      severity: "warning",
    });
  });
});

// ---------------------------------------------------------------------------
// The property test BLUEPRINT.md §17 asks for.
// ---------------------------------------------------------------------------

describe("property: any sequence of valid operations keeps the books sound", () => {
  /** Deterministic PRNG so a failure is reproducible from the seed. */
  function makeRandom(seed: number) {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  it("holds across 250 random operations over three groups", async () => {
    const random = makeRandom(20260812);
    const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];

    // Mirror of the ledger, maintained independently, so the assertions are
    // not just the ledger agreeing with itself.
    const expected = new Map(
      GROUPS.map((id) => [id, { available: 0n, locked: 0n }]),
    );
    const openReservations: { groupId: string; amount: bigint; id: string }[] = [];
    let operations = 0;

    for (let step = 0; step < 250; step++) {
      const groupId = pick(GROUPS);
      const state = expected.get(groupId)!;
      const action = random();

      // 45%: a contribution arrives.
      if (action < 0.45) {
        // Round naira amounts between ₦1,000 and ₦100,000.
        const naira = BigInt(1 + Math.floor(random() * 100)) * 1000n;
        const charged = Money.fromMinor(naira * 100n);
        const fee = Money.fromMinor(BigInt(Math.floor(random() * 200_000)));
        const net = charged.minus(fee);
        if (!net.isPositive()) continue;

        await ops.postContribution({
          contributionId: `prop-c-${step}`,
          groupId,
          memberUserId: OWNER,
          charged,
          fee,
        });
        state.available += net.minor;
        operations++;
        continue;
      }

      // 20%: lock some of what is available.
      if (action < 0.65 && state.available > 0n) {
        const amount = state.available / 2n;
        if (amount <= 0n) continue;

        await ops.lockFunds({
          groupId,
          amount: Money.fromMinor(amount),
          lockId: `prop-l-${step}`,
        });
        state.available -= amount;
        state.locked += amount;
        operations++;
        continue;
      }

      // 20%: reserve for a proposal.
      if (action < 0.85 && state.available > 0n) {
        const amount = state.available / 3n;
        if (amount <= 0n) continue;

        const id = `prop-p-${step}`;
        await ops.reserveForProposal({
          groupId,
          amount: Money.fromMinor(amount),
          proposalId: id,
        });
        state.available -= amount;
        state.locked += amount;
        openReservations.push({ groupId, amount, id });
        operations++;
        continue;
      }

      // 15%: settle an open reservation — half pay out, half fail and reverse.
      if (openReservations.length > 0) {
        const index = Math.floor(random() * openReservations.length);
        const [reservation] = openReservations.splice(index, 1);
        const reservationState = expected.get(reservation.groupId)!;

        if (random() < 0.5) {
          await ops.postPayout({
            groupId: reservation.groupId,
            amount: Money.fromMinor(reservation.amount),
            releaseId: `prop-r-${step}`,
            destination: "Vendor",
          });
          reservationState.locked -= reservation.amount;
        } else {
          await ops.releaseReservation({
            groupId: reservation.groupId,
            amount: Money.fromMinor(reservation.amount),
            proposalId: reservation.id,
            reason: "transfer failed",
          });
          reservationState.locked -= reservation.amount;
          reservationState.available += reservation.amount;
        }
        operations++;
      }
    }

    // The run must have actually exercised the ledger.
    expect(operations).toBeGreaterThan(100);

    // 1. Every group matches the independently tracked expectation.
    for (const groupId of GROUPS) {
      const state = expected.get(groupId)!;
      const actual = await ledger.getGroupBalances(groupId);

      expect(actual.available.minor, `available for ${groupId}`).toBe(
        state.available,
      );
      expect(actual.locked.minor, `locked for ${groupId}`).toBe(state.locked);
      expect(actual.available.isNegative()).toBe(false);
      expect(actual.locked.isNegative()).toBe(false);
    }

    // 2. The cached balance equals the balance derived from entries.
    for (const groupId of GROUPS) {
      const cached = await ledger.getGroupBalances(groupId);
      const derivedAvailable = await ledger.getBalance(
        ledger.groupAvailable(groupId),
      );
      const derivedLocked = await ledger.getBalance(ledger.groupLocked(groupId));

      expect(cached.available.equals(derivedAvailable)).toBe(true);
      expect(cached.locked.equals(derivedLocked)).toBe(true);
    }

    // 3. Every invariant the reconciliation job knows about.
    const report = await reconcileLedger(t.db);
    expect(describeReport(report)).toMatch(/Ledger clean/);
    expect(report.clean).toBe(true);
    expect(report.findings).toEqual([]);

    // 4. The whole system sums to zero — nothing invented, nothing destroyed.
    const allEntries = await t.db
      .select({
        direction: ledgerEntries.direction,
        amount: ledgerEntries.amount,
      })
      .from(ledgerEntries);

    const net = allEntries.reduce(
      (sum, e) => (e.direction === "DEBIT" ? sum + e.amount : sum - e.amount),
      0n,
    );
    expect(net).toBe(0n);
  });
});
