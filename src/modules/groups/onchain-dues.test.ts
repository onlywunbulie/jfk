import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, getAddress } from "viem";
import { createTestDb, type TestDb } from "@/lib/db/testing";

// Dues on Base, against a real database, with Base replaced by a stand-in
// whose balances, approvals and payment dates each test sets.
const t: TestDb = await createTestDb();
vi.mock("@/lib/db", async () => ({ db: t.db }));
vi.mock("server-only", () => ({}));

const AMAKA_WALLET = "0x27c73a4bdc1ca98cafb44cf33ab8c681db2bd129";
const KEMI_WALLET = "0x4596a149ac1d950ba229b208445dcb51fc84182b";
const SAFE = getAddress("0x2a7a348bccee61c5ef6c213efc0baa05841a5a70");
const NOW = () => BigInt(Math.floor(Date.now() / 1000));
const DAY = 86_400n;

const chain = {
  isOwner: true,
  contribution: 2_000_000n,
  payGap: 25 * 86_400,
  closed: false,
  vault: 2_000_000n,
  balances: {} as Record<string, bigint>,
  allowance: 0n,
  paidIn: {} as Record<string, bigint>,
  lastPaidAt: {} as Record<string, bigint>,
};

function read({ functionName, args }: { functionName: string; args?: readonly unknown[] }) {
  const who = String(args?.at(-1)).toLowerCase();
  switch (functionName) {
    case "isModuleEnabled":
      return true;
    case "isOwner":
      return chain.isOwner;
    case "getGroup":
      return ["0x0", chain.contribution, 3 * 86400, 60, chain.closed, [500, 667, 500, 667, 750, 667, 750, 800, 750], 0n];
    case "getGroupSettings":
      return [false, chain.payGap];
    case "balanceOf":
      return who === SAFE.toLowerCase() ? chain.vault : (chain.balances[who] ?? 0n);
    case "allowance":
      return chain.allowance;
    case "paidIn":
      return chain.paidIn[who] ?? 0n;
    case "lastPaidAt":
      return chain.lastPaidAt[who] ?? 0n;
    default:
      throw new Error(`unexpected read ${functionName}`);
  }
}

vi.mock("@/lib/chain/client", () => ({
  publicClient: () => ({
    readContract: async (call: { functionName: string; args?: readonly unknown[] }) => read(call),
    multicall: async ({ contracts }: { contracts: { functionName: string; args?: readonly unknown[] }[] }) => contracts.map(read),
  }),
}));

const { readDues, prepareDues } = await import("./onchain-dues");
const { createGroup } = await import("./service");
const { users, groups, groupMembers } = await import("@/lib/db/schema");
const { Money } = await import("@/lib/money");
const { CONTRACTS } = await import("@/lib/chain/addresses");
const { erc20Abi, jfkDuesAbi } = await import("@/lib/chain/abis");
const { eq } = await import("drizzle-orm");

beforeEach(async () => {
  await t.reset();
  Object.assign(chain, {
    isOwner: true,
    contribution: 2_000_000n,
    closed: false,
    vault: 2_000_000n,
    balances: { [AMAKA_WALLET]: 10_000_000n },
    allowance: 0n,
    paidIn: {},
    lastPaidAt: {},
  });
});

afterAll(async () => {
  await t.close();
});

async function setup(onBase = true) {
  const [amaka] = await t.db.insert(users).values({ displayName: "Amaka", walletAddress: AMAKA_WALLET }).returning();
  const [kemi] = await t.db.insert(users).values({ displayName: "Kemi", walletAddress: KEMI_WALLET }).returning();
  const { groupId } = await createGroup(amaka.id, {
    name: "Test Run",
    type: "TREASURY",
    contributionAmount: Money.fromMajor(2, "USDC"),
    cadence: "MONTHLY",
    dueDay: 1,
  });
  await t.db.insert(groupMembers).values({ groupId, userId: kemi.id, role: "MEMBER", status: "ACTIVE" });
  if (onBase) await t.db.update(groups).set({ safeAddress: SAFE.toLowerCase(), currency: "USDC" }).where(eq(groups.id, groupId));
  return { amaka: amaka.id, groupId };
}

describe("reading dues from Base", () => {
  it("shows the vault, everyone's total, and who has paid this period", async () => {
    const { amaka, groupId } = await setup();
    chain.paidIn = { [KEMI_WALLET]: 4_000_000n };
    chain.lastPaidAt = { [KEMI_WALLET]: NOW() - 2n * DAY };

    const dues = await readDues(groupId, amaka);
    if (!dues.ok) throw new Error(dues.reason);
    expect(dues.vault).toContain("2");
    const kemi = dues.members.find((m) => m.name === "Kemi");
    const you = dues.members.find((m) => m.isYou);
    expect(kemi?.paidThisPeriod).toMatch(/^Paid /);
    expect(kemi?.paidIn).toContain("4");
    expect(you).toMatchObject({ name: "You", paidThisPeriod: null });
    expect(dues.you).toMatchObject({ paidThisPeriod: null, canPay: true, short: null });
  });

  it("a payment older than the group's gap counts as last period, not this one", async () => {
    const { amaka, groupId } = await setup();
    chain.lastPaidAt = { [AMAKA_WALLET]: NOW() - 26n * DAY };
    const dues = await readDues(groupId, amaka);
    if (!dues.ok) throw new Error(dues.reason);
    expect(dues.you.paidThisPeriod).toBeNull();
  });

  it("says how short the user's wallet is", async () => {
    const { amaka, groupId } = await setup();
    chain.balances = { [AMAKA_WALLET]: 500_000n };
    const dues = await readDues(groupId, amaka);
    if (!dues.ok) throw new Error(dues.reason);
    expect(dues.you.canPay).toBe(false);
    expect(dues.you.short).toContain("1.5");
  });

  it("a group that isn't on Base has no dues to show", async () => {
    const { amaka, groupId } = await setup(false);
    expect(await readDues(groupId, amaka)).toEqual({ ok: false, reason: "not_on_base" });
  });
});

describe("paying dues", () => {
  it("approves exactly this period's amount for Rallied's contract, then contributes", async () => {
    const { amaka, groupId } = await setup();
    const prepared = await prepareDues(amaka, groupId);
    if (!prepared.ok) throw new Error(prepared.reason);
    expect(prepared.calls.map((c) => c.to)).toEqual([CONTRACTS.usdc, CONTRACTS.jfkModule]);

    const approve = decodeFunctionData({ abi: erc20Abi, data: prepared.calls[0].data });
    expect(approve).toMatchObject({ functionName: "approve", args: [CONTRACTS.jfkModule, 2_000_000n] });
    const contribute = decodeFunctionData({ abi: jfkDuesAbi, data: prepared.calls[1].data });
    expect(contribute).toMatchObject({ functionName: "contribute", args: [SAFE] });
  });

  it("skips the approval when an earlier one still covers it", async () => {
    const { amaka, groupId } = await setup();
    chain.allowance = 2_000_000n;
    const prepared = await prepareDues(amaka, groupId);
    if (!prepared.ok) throw new Error(prepared.reason);
    expect(prepared.calls.map((c) => c.to)).toEqual([CONTRACTS.jfkModule]);
  });

  it("refuses plainly: not enough USDC, not an owner, a closed group", async () => {
    const { amaka, groupId } = await setup();
    chain.balances = { [AMAKA_WALLET]: 1_000_000n };
    expect(await prepareDues(amaka, groupId)).toMatchObject({ ok: false, reason: expect.stringContaining("faucet.circle.com") });
    chain.balances = { [AMAKA_WALLET]: 10_000_000n };

    chain.isOwner = false;
    expect(await prepareDues(amaka, groupId)).toMatchObject({ ok: false, reason: expect.stringContaining("owners") });
    chain.isOwner = true;

    chain.closed = true;
    expect(await prepareDues(amaka, groupId)).toMatchObject({ ok: false, reason: expect.stringContaining("closed") });
  });

  it("a group that isn't on Base says to start it first", async () => {
    const { amaka, groupId } = await setup(false);
    expect(await prepareDues(amaka, groupId)).toMatchObject({ ok: false, reason: expect.stringContaining("Start it on Base") });
  });

  it("someone outside the group can't pay into it through Rallied", async () => {
    const { groupId } = await setup();
    const [stranger] = await t.db.insert(users).values({ displayName: "Tunde" }).returning();
    expect(await prepareDues(stranger.id, groupId)).toMatchObject({ ok: false, reason: expect.stringContaining("no longer in this group") });
  });
});
