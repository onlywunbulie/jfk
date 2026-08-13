import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/lib/db/testing";
import { Money } from "@/lib/money";
import { classifyDecline, nextRetryAt } from "./retry";

const t: TestDb = await createTestDb();
vi.mock("@/lib/db", async () => ({ db: t.db }));

const service = await import("./service");
const { simulateContribution } = await import("@/modules/payments/simulate");
const ledger = await import("@/modules/ledger/service");
const { reconcileLedger } = await import("@/modules/ledger/reconcile");
const {
  users,
  groups,
  groupSettings,
  groupMembers,
  contributions,
  contributionCycles,
} = await import("@/lib/db/schema");

const GROUP = "019ff300-0000-7000-8000-00000000aaaa";
const MEMBERS = ["geoffrey", "chuka", "tunde", "amaka"];

/** A four-member monthly treasury group contributing ₦50,000 each. */
async function seedGroup(type: "TREASURY" | "ROTATING" = "TREASURY") {
  const ids: string[] = [];

  for (const [index, name] of MEMBERS.entries()) {
    const [user] = await t.db
      .insert(users)
      .values({ email: `${name}@jfk.test`, displayName: name })
      .returning({ id: users.id });
    ids.push(user.id);

    if (index === 0) {
      await t.db
        .insert(groups)
        .values({ id: GROUP, name: "JFK Empire", ownerId: user.id, type });
      await t.db.insert(groupSettings).values({
        groupId: GROUP,
        contributionAmount: Money.fromMajor(50_000).minor,
        cadence: "MONTHLY",
        dueDay: 1,
        graceDays: 3,
      });
    }

    await t.db.insert(groupMembers).values({
      groupId: GROUP,
      userId: user.id,
      role: index === 0 ? "OWNER" : "MEMBER",
      status: "ACTIVE",
      rotationPosition: type === "ROTATING" ? index + 1 : null,
    });
  }

  return ids;
}

const MARCH = new Date("2026-03-05T00:00:00Z");

beforeEach(async () => {
  await t.reset();
});

afterAll(async () => {
  await t.close();
});

// ---------------------------------------------------------------------------

describe("opening a cycle", () => {
  it("creates one obligation per active member", async () => {
    await seedGroup();
    const result = await service.openCycleFor(GROUP, MARCH);

    expect(result).toMatchObject({ created: true, sequenceNo: 1, obligations: 4 });
    expect(result!.expectedTotal.format()).toBe("₦200,000.00");

    const rows = await t.db.select().from(contributions);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.status === "PENDING")).toBe(true);
    expect(rows.every((r) => r.amount === Money.fromMajor(50_000).minor)).toBe(true);
  });

  it("is idempotent — running the scheduler twice creates one cycle", async () => {
    await seedGroup();

    const first = await service.openCycleFor(GROUP, MARCH);
    const second = await service.openCycleFor(GROUP, MARCH);
    const third = await service.openCycleFor(GROUP, new Date("2026-03-20T00:00:00Z"));

    expect(first!.created).toBe(true);
    expect(second).toBeNull();
    expect(third).toBeNull();

    expect(await t.db.select().from(contributionCycles)).toHaveLength(1);
    expect(await t.db.select().from(contributions)).toHaveLength(4);
  });

  it("opens the next cycle once the period has rolled over", async () => {
    await seedGroup();
    await service.openCycleFor(GROUP, MARCH);

    const april = await service.openCycleFor(GROUP, new Date("2026-04-05T00:00:00Z"));
    expect(april).toMatchObject({ created: true, sequenceNo: 2 });

    const cycles = await t.db.select().from(contributionCycles);
    expect(cycles).toHaveLength(2);
  });

  it("snapshots the amount, so a later rule change is not retroactive", async () => {
    await seedGroup();
    await service.openCycleFor(GROUP, MARCH);

    await t.db
      .update(groupSettings)
      .set({ contributionAmount: Money.fromMajor(80_000).minor });

    const rows = await t.db.select().from(contributions);
    expect(rows.every((r) => r.amount === Money.fromMajor(50_000).minor)).toBe(true);

    // The next cycle picks up the new figure.
    await service.openCycleFor(GROUP, new Date("2026-04-05T00:00:00Z"));
    const [april] = await t.db
      .select()
      .from(contributionCycles)
      .where(eq(contributionCycles.sequenceNo, 2));
    expect(april.contributionAmount).toBe(Money.fromMajor(80_000).minor);
  });

  it("does not back-fill months the app was asleep for", async () => {
    await seedGroup();
    await service.openCycleFor(GROUP, MARCH);

    // Six months later. Billing everyone for the gap would be indefensible.
    const result = await service.openCycleFor(GROUP, new Date("2026-09-05T00:00:00Z"));

    expect(result).toMatchObject({ created: true, sequenceNo: 2 });
    const [cycle] = await t.db
      .select()
      .from(contributionCycles)
      .where(eq(contributionCycles.sequenceNo, 2));
    expect(cycle.periodStart.toISOString().slice(0, 10)).toBe("2026-09-01");
  });

  it("skips a group with no contribution amount set", async () => {
    await seedGroup();
    await t.db.update(groupSettings).set({ contributionAmount: 0n });
    expect(await service.openCycleFor(GROUP, MARCH)).toBeNull();
  });

  it("excludes members who have left", async () => {
    const ids = await seedGroup();
    await t.db
      .update(groupMembers)
      .set({ status: "LEFT" })
      .where(eq(groupMembers.userId, ids[3]));

    const result = await service.openCycleFor(GROUP, MARCH);
    expect(result!.obligations).toBe(3);
    expect(result!.expectedTotal.format()).toBe("₦150,000.00");
  });

  it("names a beneficiary for a rotating group, in order", async () => {
    await seedGroup("ROTATING");
    await service.openCycleFor(GROUP, MARCH);

    const view = await service.getCurrentCycle(GROUP, "nobody");
    expect(view!.beneficiaryName).toBe("geoffrey");
  });

  it("leaves treasury groups with no beneficiary", async () => {
    await seedGroup();
    await service.openCycleFor(GROUP, MARCH);
    const view = await service.getCurrentCycle(GROUP, "nobody");
    expect(view!.beneficiaryName).toBeNull();
  });
});

describe("the one-charge-per-member-per-cycle guarantee", () => {
  it("is enforced by the database, not just the scheduler", async () => {
    const ids = await seedGroup();
    const result = await service.openCycleFor(GROUP, MARCH);

    const [member] = await t.db
      .select({ id: groupMembers.id })
      .from(groupMembers)
      .where(eq(groupMembers.userId, ids[0]))
      .limit(1);

    // A second obligation for the same member in the same cycle must be
    // impossible even by direct insert.
    await expect(
      t.db.insert(contributions).values({
        cycleId: result!.cycleId,
        groupId: GROUP,
        memberId: member.id,
        userId: ids[0],
        amount: Money.fromMajor(50_000).minor,
      }),
    ).rejects.toThrow();
  });
});

describe("closing a cycle", () => {
  it("refuses to close before the grace period has passed", async () => {
    await seedGroup();
    const cycle = await service.openCycleFor(GROUP, MARCH);

    // Grace runs to 4 March; this is the 2nd.
    expect(await service.closeCycle(cycle!.cycleId, new Date("2026-03-02T00:00:00Z"))).toBeNull();
  });

  it("marks everything unpaid as MISSED", async () => {
    await seedGroup();
    const cycle = await service.openCycleFor(GROUP, MARCH);

    const result = await service.closeCycle(
      cycle!.cycleId,
      new Date("2026-03-10T00:00:00Z"),
    );

    expect(result).toMatchObject({ missed: 4, fullyFunded: false });
    expect(result!.collected.isZero()).toBe(true);

    const rows = await t.db.select().from(contributions);
    expect(rows.every((r) => r.status === "MISSED")).toBe(true);
  });

  it("keeps the obligation rather than deleting it — arrears are history", async () => {
    await seedGroup();
    const cycle = await service.openCycleFor(GROUP, MARCH);
    await service.closeCycle(cycle!.cycleId, new Date("2026-03-10T00:00:00Z"));

    const arrears = await service.getArrears(GROUP);
    expect(arrears).toHaveLength(4);
    expect(arrears[0].totalOwed.format()).toBe("₦50,000.00");
    expect(arrears[0].missedCount).toBe(1);
  });

  it("is idempotent", async () => {
    await seedGroup();
    const cycle = await service.openCycleFor(GROUP, MARCH);
    const at = new Date("2026-03-10T00:00:00Z");

    expect(await service.closeCycle(cycle!.cycleId, at)).not.toBeNull();
    expect(await service.closeCycle(cycle!.cycleId, at)).toBeNull();
  });

  it("reports a rotating cycle as ready to pay out when fully funded", async () => {
    const ids = await seedGroup("ROTATING");
    const cycle = await service.openCycleFor(GROUP, MARCH);

    // Everyone pays, through the real payment pipeline.
    for (const userId of ids) {
      await simulateContribution({ groupId: GROUP, userId });
    }
    await t.db
      .update(contributions)
      .set({ status: "PAID", paidAt: new Date() })
      .where(eq(contributions.cycleId, cycle!.cycleId));

    const result = await service.closeCycle(
      cycle!.cycleId,
      new Date("2026-03-10T00:00:00Z"),
    );

    expect(result!.fullyFunded).toBe(true);
    expect(result!.payoutDue).not.toBeNull();
    expect(result!.collected.format()).toBe("₦200,000.00");
  });

  it("delays the payout when a rotating cycle is short", async () => {
    const ids = await seedGroup("ROTATING");
    const cycle = await service.openCycleFor(GROUP, MARCH);

    // Only three of four pay.
    const rows = await t.db.select().from(contributions);
    for (const row of rows.slice(0, 3)) {
      await t.db
        .update(contributions)
        .set({ status: "PAID", paidAt: new Date() })
        .where(eq(contributions.id, row.id));
    }
    void ids;

    const result = await service.closeCycle(
      cycle!.cycleId,
      new Date("2026-03-10T00:00:00Z"),
    );

    // Nobody gets a short pot — BLUEPRINT.md §22 decision 4.
    expect(result!.fullyFunded).toBe(false);
    expect(result!.payoutDue).toBeNull();
    expect(result!.missed).toBe(1);
  });
});

describe("the cycle view", () => {
  it("shows who has paid and who has not", async () => {
    const ids = await seedGroup();
    await service.openCycleFor(GROUP, MARCH);
    await simulateContribution({ groupId: GROUP, userId: ids[0] });

    // The simulator credits the treasury; mark the obligation as the webhook
    // would when the collection job started it.
    const [first] = await t.db
      .select()
      .from(contributions)
      .where(eq(contributions.userId, ids[0]));
    await t.db
      .update(contributions)
      .set({ status: "PAID", paidAt: new Date() })
      .where(eq(contributions.id, first.id));

    const view = await service.getCurrentCycle(GROUP, ids[0]);

    expect(view!.contributions).toHaveLength(4);
    expect(view!.collected.format()).toBe("₦50,000.00");
    expect(view!.expectedTotal.format()).toBe("₦200,000.00");
    expect(view!.yours!.status).toBe("PAID");
    expect(view!.contributions.filter((c) => c.status === "PENDING")).toHaveLength(3);
  });

  it("returns null for a group with no cycle yet", async () => {
    await seedGroup();
    expect(await service.getCurrentCycle(GROUP, "nobody")).toBeNull();
  });
});

describe("a full month, end to end", () => {
  it("opens, collects, closes and reconciles clean", async () => {
    const ids = await seedGroup();

    const cycle = await service.openCycleFor(GROUP, MARCH);
    expect(cycle!.obligations).toBe(4);

    for (const userId of ids) {
      await simulateContribution({ groupId: GROUP, userId });
    }
    await t.db
      .update(contributions)
      .set({ status: "PAID", paidAt: new Date() })
      .where(eq(contributions.cycleId, cycle!.cycleId));

    const closed = await service.closeCycle(
      cycle!.cycleId,
      new Date("2026-03-10T00:00:00Z"),
    );

    expect(closed).toMatchObject({ missed: 0, fullyFunded: true });
    expect((await ledger.getGroupBalances(GROUP)).available.format()).toBe(
      "₦200,000.00",
    );
    expect(await service.getArrears(GROUP)).toHaveLength(0);

    const report = await reconcileLedger(t.db);
    expect(report.clean).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("decline classification", () => {
  it("treats fixable problems as soft", () => {
    for (const reason of [
      "Insufficient funds",
      "Transaction timed out",
      "Issuer unavailable",
      "Declined",
      "",
      null,
    ]) {
      expect(classifyDecline(reason)).toBe("soft");
    }
  });

  it("treats a dead card as hard", () => {
    for (const reason of [
      "Card expired",
      "Invalid card number",
      "Stolen card",
      "Do not honour",
      "Card revoked by issuer",
      "Restricted card",
    ]) {
      expect(classifyDecline(reason)).toBe("hard");
    }
  });

  it("defaults an unrecognised reason to soft", () => {
    // Being wrong costs three attempts; wrongly killing a working card blocks
    // someone's contributions until they notice.
    expect(classifyDecline("Something nobody has seen before")).toBe("soft");
  });
});

describe("the retry ladder", () => {
  const start = new Date("2026-03-01T09:00:00Z");

  it("walks 6, 24 then 72 hours", () => {
    expect(nextRetryAt(1, start)!.toISOString()).toBe("2026-03-01T15:00:00.000Z");
    expect(nextRetryAt(2, start)!.toISOString()).toBe("2026-03-02T09:00:00.000Z");
    expect(nextRetryAt(3, start)!.toISOString()).toBe("2026-03-04T09:00:00.000Z");
  });

  it("gives up after the third attempt", () => {
    expect(nextRetryAt(4, start)).toBeNull();
    expect(nextRetryAt(10, start)).toBeNull();
  });
});
