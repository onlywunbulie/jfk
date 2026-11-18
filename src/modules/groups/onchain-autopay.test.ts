import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, getAddress, type Hex } from "viem";
import { createTestDb, type TestDb } from "@/lib/db/testing";

// Automatic dues, against a real database, with Base and Rallied's key
// replaced by stand-ins. The point is the guard rails: Rallied only ever
// collects the group's amount, for a member who allowed it on Base, once a
// period, and never after they stopped it.
const t: TestDb = await createTestDb();
vi.mock("@/lib/db", async () => ({ db: t.db }));
vi.mock("server-only", () => ({}));

const AMAKA = "0x27c73a4bdc1ca98cafb44cf33ab8c681db2bd129";
const RALLIED_KEY = getAddress("0xe2058d49dbe0031d2bc89a4050548a8fdb1659ea");
const SAFE = getAddress("0x2a7a348bccee61c5ef6c213efc0baa05841a5a70");
const TX = `0x${"ef".repeat(32)}` as Hex;
const NOW = () => BigInt(Math.floor(Date.now() / 1000));
const DAY = 86_400n;

const chain = {
  helper: { key: "0x0000000000000000000000000000000000000000" as string, powers: 0, expiresAt: 0n },
  contribution: 1_000_000n,
  payGap: 25 * 86_400,
  lastPaidAt: 0n,
  balance: 10_000_000n,
  allowance: 12_000_000n,
  receipt: "success" as "success" | "reverted",
  collected: [] as unknown[],
};

function read({ functionName }: { functionName: string }) {
  switch (functionName) {
    case "isOwner":
      return true;
    case "getGroup":
      return ["0x0", chain.contribution, 3 * 86400, 60, false, [500, 667, 500, 667, 750, 667, 750, 800, 750], 0n];
    case "getGroupSettings":
      return [false, chain.payGap];
    case "getHelper":
      return chain.helper;
    case "lastPaidAt":
      return chain.lastPaidAt;
    case "balanceOf":
      return chain.balance;
    case "allowance":
      return chain.allowance;
    default:
      throw new Error(`unexpected read ${functionName}`);
  }
}

vi.mock("@/lib/chain/client", () => ({
  publicClient: () => ({
    readContract: async (call: { functionName: string }) => read(call),
    waitForTransactionReceipt: async () => ({ status: chain.receipt, logs: [] }),
  }),
}));
vi.mock("@/lib/chain/relayer", () => ({
  relayer: () => ({
    account: { address: RALLIED_KEY },
    writeContract: async (call: unknown) => {
      chain.collected.push(call);
      return TX;
    },
  }),
}));

const { prepareAutopay, confirmAutopay, stopAutopay, collectDues, autopayStatus, runScheduledCollections, prepareRemoval } =
  await import("./onchain-autopay");
const { createGroup } = await import("./service");
const { users, groups } = await import("@/lib/db/schema");
const { Money } = await import("@/lib/money");
const { CONTRACTS } = await import("@/lib/chain/addresses");
const { erc20Abi, jfkHelperAbi } = await import("@/lib/chain/abis");
const { eq } = await import("drizzle-orm");

/** Rallied's key as the member's live helper with the collect power. */
const ralliedIsHelper = () => {
  chain.helper = { key: RALLIED_KEY, powers: 4, expiresAt: NOW() + 365n * DAY };
};

beforeEach(async () => {
  await t.reset();
  Object.assign(chain, {
    helper: { key: "0x0000000000000000000000000000000000000000", powers: 0, expiresAt: 0n },
    contribution: 1_000_000n,
    lastPaidAt: 0n,
    balance: 10_000_000n,
    allowance: 12_000_000n,
    receipt: "success",
    collected: [],
  });
});

afterAll(async () => {
  await t.close();
});

async function setup() {
  const [amaka] = await t.db.insert(users).values({ displayName: "Amaka", walletAddress: AMAKA }).returning();
  const { groupId } = await createGroup(amaka.id, {
    name: "OTF",
    type: "TREASURY",
    contributionAmount: Money.fromMajor(1, "USDC"),
    cadence: "MONTHLY",
    dueDay: 1,
  });
  await t.db.update(groups).set({ safeAddress: SAFE.toLowerCase(), currency: "USDC" }).where(eq(groups.id, groupId));
  return { amaka: amaka.id, groupId };
}

/** Set up and confirmed, the way the confirm page does it. */
async function turnOn(amaka: string, groupId: string) {
  ralliedIsHelper();
  const confirmed = await confirmAutopay(amaka, groupId, TX);
  if (!confirmed.ok) throw new Error(confirmed.reason);
}

describe("setting up automatic dues", () => {
  it("asks the wallet to name Rallied's key with only the collect power, for a year, and approve a year of dues", async () => {
    const { amaka, groupId } = await setup();
    const prepared = await prepareAutopay(amaka, groupId);
    if (!prepared.ok) throw new Error(prepared.reason);

    const [helper, approve] = prepared.calls;
    expect(helper.to).toBe(CONTRACTS.jfkModule);
    const set = decodeFunctionData({ abi: jfkHelperAbi, data: helper.data });
    expect(set.functionName).toBe("setHelper");
    const [safe, key, powers, expiresAt] = set.args as [string, string, number, bigint];
    expect([safe, key, powers]).toEqual([SAFE, RALLIED_KEY, 4]);
    // About a year, and inside the contract's 366-day limit.
    expect(Number(expiresAt - NOW())).toBeGreaterThan(364 * 86_400);
    expect(Number(expiresAt - NOW())).toBeLessThan(366 * 86_400);

    expect(approve.to).toBe(CONTRACTS.usdc);
    expect(decodeFunctionData({ abi: erc20Abi, data: approve.data }).args).toEqual([CONTRACTS.jfkModule, 12_000_000n]);
    expect(prepared.summary).toMatchObject({ every: "month", groupName: "OTF" });
  });

  it("is only remembered once Base shows Rallied as the helper", async () => {
    const { amaka, groupId } = await setup();
    expect(await confirmAutopay(amaka, groupId, TX)).toMatchObject({ ok: false });
    expect(await autopayStatus(amaka, groupId)).toEqual({ on: false, why: "never_set_up" });

    await turnOn(amaka, groupId);
    expect(await autopayStatus(amaka, groupId)).toMatchObject({ on: true });
  });
});

describe("collecting", () => {
  it("collects exactly the member's dues through Rallied's key, once", async () => {
    const { amaka, groupId } = await setup();
    await turnOn(amaka, groupId);

    const paid = await collectDues(amaka, groupId, "asked");
    expect(paid).toMatchObject({ ok: true, txHash: TX });
    expect(chain.collected).toEqual([expect.objectContaining({ functionName: "collect", args: [SAFE, getAddress(AMAKA)] })]);

    // Base now shows it paid just now: a second ask is refused, not charged.
    chain.lastPaidAt = NOW();
    expect(await collectDues(amaka, groupId, "asked")).toMatchObject({ ok: false, reason: "already_paid" });
    expect(chain.collected).toHaveLength(1);
  });

  it("never collects without set-up, after a stop, or once the permission is gone from Base", async () => {
    const { amaka, groupId } = await setup();
    expect(await collectDues(amaka, groupId, "asked")).toMatchObject({ ok: false, reason: "not_set_up" });

    await turnOn(amaka, groupId);
    expect(await stopAutopay(amaka, groupId)).toEqual({ ok: true, wasOn: true });
    expect(await collectDues(amaka, groupId, "asked")).toMatchObject({ ok: false, reason: "stopped" });

    await turnOn(amaka, groupId); // set up again
    chain.helper = { key: "0x0000000000000000000000000000000000000000", powers: 0, expiresAt: 0n }; // removed on Base
    expect(await collectDues(amaka, groupId, "asked")).toMatchObject({ ok: false, reason: "removed_from_base" });

    // A helper that is someone else's key, or lacks the collect power, doesn't count either.
    chain.helper = { key: RALLIED_KEY, powers: 2, expiresAt: NOW() + DAY };
    expect(await collectDues(amaka, groupId, "asked")).toMatchObject({ ok: false, reason: "removed_from_base" });
    expect(chain.collected).toEqual([]);
  });

  it("says plainly when the wallet is short or the approval is used up, and remembers it", async () => {
    const { amaka, groupId } = await setup();
    await turnOn(amaka, groupId);

    chain.balance = 500_000n;
    expect(await collectDues(amaka, groupId, "asked")).toMatchObject({ ok: false, reason: "short" });
    expect(await autopayStatus(amaka, groupId)).toMatchObject({ on: true, problem: expect.stringContaining("Add USDC") });

    chain.balance = 10_000_000n;
    chain.allowance = 0n;
    expect(await collectDues(amaka, groupId, "asked")).toMatchObject({ ok: false, reason: "allowance_used_up" });
    expect(chain.collected).toEqual([]);
  });

  it("the daily run only collects people whose period is due and unpaid", async () => {
    const { amaka, groupId } = await setup();
    await turnOn(amaka, groupId);

    // Paid two days ago: inside the group's gap, so nothing to collect.
    chain.lastPaidAt = NOW() - 2n * DAY;
    let run = await runScheduledCollections();
    expect(run).toMatchObject({ tried: 1, collected: 0 });

    // Never paid: due.
    chain.lastPaidAt = 0n;
    run = await runScheduledCollections();
    expect(run).toMatchObject({ tried: 1, collected: 1 });

    // Stopped members aren't tried at all.
    await stopAutopay(amaka, groupId);
    expect(await runScheduledCollections()).toMatchObject({ tried: 0 });
  });
});

describe("removing it from Base", () => {
  it("takes the helper away and sets the approval to zero", async () => {
    const { amaka, groupId } = await setup();
    ralliedIsHelper();
    const prepared = await prepareRemoval(amaka, groupId);
    if (!prepared.ok) throw new Error(prepared.reason);
    expect(decodeFunctionData({ abi: jfkHelperAbi, data: prepared.calls[0].data })).toMatchObject({ functionName: "revokeHelper", args: [SAFE] });
    expect(decodeFunctionData({ abi: erc20Abi, data: prepared.calls[1].data }).args).toEqual([CONTRACTS.jfkModule, 0n]);
  });
});
