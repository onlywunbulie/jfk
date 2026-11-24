import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/lib/db/testing";

const t: TestDb = await createTestDb();
vi.mock("@/lib/db", async () => ({ db: t.db }));
vi.mock("server-only", () => ({}));

const SAFE = "0x1111111111111111111111111111111111111111";
const V3 = "0x48bB48799153c1a420B8476EaC663C396E291655";
const TX = "0xabc";

/** What the fake chain says: which contract runs the vault, when the next payout is due, and whether the contract would pay now. */
const chain = {
  version: 3 as 2 | 3,
  nextPayoutAt: 0n,
  wouldPay: true,
  sent: [] as unknown[],
};

vi.mock("@/lib/chain/module", () => ({
  moduleFor: async () => ({ address: V3, version: chain.version }),
}));
vi.mock("@/lib/chain/client", () => ({
  publicClient: () => ({
    readContract: async () => [true, 1, 0, 0, chain.nextPayoutAt, 27 * 86400, 7 * 86400, 0n, 0n],
    simulateContract: async () => {
      if (!chain.wouldPay) throw new Error("NotDueYet");
      return {};
    },
    waitForTransactionReceipt: async () => ({ status: "success", logs: [] }),
  }),
}));
vi.mock("@/lib/chain/relayer", () => ({
  relayer: () => ({
    account: { address: "0x2222222222222222222222222222222222222222" },
    writeContract: async (call: unknown) => {
      chain.sent.push(call);
      return TX;
    },
  }),
}));

const { runTurnPayouts } = await import("@/modules/groups/onchain-rotation");
const { createGroup } = await import("@/modules/groups/service");
const { users, groups, auditLogs } = await import("@/lib/db/schema");
const { Money } = await import("@/lib/money");
const { eq } = await import("drizzle-orm");

const NOW = new Date("2026-12-01T07:00:00Z");
const seconds = (date: Date) => BigInt(Math.floor(date.getTime() / 1000));

beforeEach(async () => {
  await t.reset();
  Object.assign(chain, { version: 3, nextPayoutAt: seconds(NOW) - 60n, wouldPay: true, sent: [] });
});

afterAll(async () => {
  await t.close();
});

async function rotatingGroupOnBase() {
  const [owner] = await t.db.insert(users).values({ displayName: "Ade", walletAddress: SAFE.replace("1111", "3333") }).returning();
  const { groupId } = await createGroup(owner.id, {
    name: "Ajo",
    type: "ROTATING",
    contributionAmount: Money.fromMajor(100, "USDC"),
    cadence: "MONTHLY",
    dueDay: 1,
  });
  await t.db.update(groups).set({ safeAddress: SAFE, currency: "USDC" }).where(eq(groups.id, groupId));
  return groupId;
}

describe("paying out rotating groups' turns", () => {
  it("pays a due turn through Rallied's key, and records it", async () => {
    const groupId = await rotatingGroupOnBase();
    const run = await runTurnPayouts(NOW);

    expect(run).toMatchObject({ tried: 1, paid: 1, results: [{ groupId, result: "paid" }] });
    expect(chain.sent).toEqual([expect.objectContaining({ address: V3, functionName: "payTurn", args: [SAFE] })]);
    const logged = await t.db.select().from(auditLogs).where(eq(auditLogs.action, "rotation.turn_paid"));
    expect(logged).toHaveLength(1);
  });

  it("sends nothing before the payout date", async () => {
    await rotatingGroupOnBase();
    chain.nextPayoutAt = seconds(NOW) + 86400n;
    const run = await runTurnPayouts(NOW);
    expect(run.results[0].result).toBe("not_due");
    expect(chain.sent).toEqual([]);
  });

  it("sends nothing while the contract is still waiting for late payers", async () => {
    await rotatingGroupOnBase();
    chain.wouldPay = false;
    const run = await runTurnPayouts(NOW);
    expect(run.results[0].result).toBe("waiting_for_late_payers");
    expect(chain.sent).toEqual([]);
  });

  it("leaves a group on contract v2 alone: it has no turns on Base", async () => {
    await rotatingGroupOnBase();
    chain.version = 2;
    const run = await runTurnPayouts(NOW);
    expect(run.results[0].result).toBe("not_rotating");
    expect(chain.sent).toEqual([]);
  });

  it("only looks at rotating groups that are on Base", async () => {
    const groupId = await rotatingGroupOnBase();
    await t.db.update(groups).set({ safeAddress: null }).where(eq(groups.id, groupId));
    expect(await runTurnPayouts(NOW)).toMatchObject({ tried: 0, paid: 0 });
  });
});
