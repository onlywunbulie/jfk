import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/lib/db/testing";
import { Money } from "@/lib/money";

const t: TestDb = await createTestDb();
vi.mock("@/lib/db", async () => ({ db: t.db }));

// The network, stood in. Each test sets what the chain "has".
const chain = vi.hoisted(() => ({
  deployed: new Set<string>(),
  deploys: 0,
  deployResult: { ok: true as const, txHash: "0xabc" as `0x${string}` } as
    | { ok: true; txHash: `0x${string}` }
    | { ok: false; reason: "no_relayer" | "relayer_out_of_funds" | "reverted" },
  confirms: true,
}));
vi.mock("./onchain-chain", () => ({
  proxyCreationCode: async () => "0x6080",
  hasCode: async (address: string) => chain.deployed.has(address.toLowerCase()),
  deploySafe: async () => {
    chain.deploys++;
    return chain.deployResult;
  },
  confirmGroupSafe: async () => chain.confirms,
}));

const groupsService = await import("./service");
const { startGroupOnChain, getOnChainStatus } = await import("./onchain");
const { users, groups } = await import("@/lib/db/schema");

const WALLET_A = "0x4596a149ac1d950ba229b208445dcb51fc84182b";
const WALLET_B = "0x27c73a4bdc1ca98cafb44cf33ab8c681db2bd129";

async function user(name: string, wallet: string | null) {
  const [row] = await t.db
    .insert(users)
    .values({ displayName: name, walletAddress: wallet, email: wallet ? null : `${name}@jfk.test` })
    .returning({ id: users.id });
  return row.id;
}

async function usdcGroup(ownerId: string) {
  const { groupId } = await groupsService.createGroup(ownerId, {
    name: "Brothers",
    type: "TREASURY",
    contributionAmount: Money.fromMajor(50, "USDC"),
    cadence: "MONTHLY",
    dueDay: 1,
  });
  return groupId;
}

async function join(groupId: string, ownerId: string, memberId: string) {
  const invite = await groupsService.createInvite(groupId, ownerId, { maxUses: 5 });
  if (!invite.ok) throw new Error("invite failed");
  const accepted = await groupsService.acceptInvite(invite.code, memberId);
  if (!accepted.ok) throw new Error(`join failed: ${accepted.reason}`);
}

beforeEach(async () => {
  await t.reset();
  chain.deployed.clear();
  chain.deploys = 0;
  chain.deployResult = { ok: true, txHash: "0xabc" };
  chain.confirms = true;
});

afterAll(async () => {
  await t.close();
});

describe("starting a group on-chain", () => {
  it("creates the Safe with everyone in it and records where it lives", async () => {
    const owner = await user("Amaka", WALLET_A);
    const friend = await user("Tunde", WALLET_B);
    const groupId = await usdcGroup(owner);
    await join(groupId, owner, friend);

    const result = await startGroupOnChain(groupId, owner);

    expect(result.ok).toBe(true);
    expect(chain.deploys).toBe(1);
    const [row] = await t.db.select().from(groups).where(eq(groups.id, groupId));
    expect(row.safeAddress).toMatch(/^0x[0-9a-f]{40}$/);
    expect(row.startedOnChainAt).not.toBeNull();
  });

  it("is only for the person who created the group", async () => {
    const owner = await user("Amaka", WALLET_A);
    const friend = await user("Tunde", WALLET_B);
    const groupId = await usdcGroup(owner);
    await join(groupId, owner, friend);

    expect(await startGroupOnChain(groupId, friend)).toEqual({ ok: false, reason: "not_owner" });
    expect(chain.deploys).toBe(0);
  });

  it("waits until every member has a wallet", async () => {
    const owner = await user("Amaka", WALLET_A);
    const emailOnly = await user("Kemi", null);
    const groupId = await usdcGroup(owner);
    await join(groupId, owner, emailOnly);

    expect(await startGroupOnChain(groupId, owner)).toEqual({ ok: false, reason: "members_without_wallets" });
    const status = await getOnChainStatus(groupId, owner);
    expect(status?.members.map((m) => m.hasWallet)).toEqual([true, false]);
  });

  it("refuses a naira group from the Paystack era", async () => {
    const owner = await user("Amaka", WALLET_A);
    const { groupId } = await groupsService.createGroup(owner, {
      name: "Old",
      type: "TREASURY",
      contributionAmount: Money.fromMajor(50_000),
      cadence: "MONTHLY",
      dueDay: 1,
    });
    expect(await startGroupOnChain(groupId, owner)).toEqual({ ok: false, reason: "not_usdc" });
  });

  it("happens once", async () => {
    const owner = await user("Amaka", WALLET_A);
    const groupId = await usdcGroup(owner);
    expect((await startGroupOnChain(groupId, owner)).ok).toBe(true);
    expect(await startGroupOnChain(groupId, owner)).toEqual({ ok: false, reason: "already_started" });
  });

  it("finds a Safe an earlier attempt already created, instead of paying twice", async () => {
    const owner = await user("Amaka", WALLET_A);
    const groupId = await usdcGroup(owner);

    // The first attempt created the Safe but failed before recording it.
    chain.confirms = false;
    expect(await startGroupOnChain(groupId, owner)).toEqual({ ok: false, reason: "not_confirmed" });
    const [first] = await t.db.select().from(groups).where(eq(groups.id, groupId));
    expect(first.safeAddress).toBeNull();

    // The retry predicts the same address, sees code there, and doesn't deploy again.
    chain.confirms = true;
    const deploysBefore = chain.deploys;
    const { getAddress } = await import("viem");
    const { buildGroupSetup, predictSafeAddress } = await import("./onchain-setup");
    const predicted = predictSafeAddress(
      buildGroupSetup({
        groupId,
        memberWallets: [getAddress(WALLET_A)],
        contribution: Money.fromMajor(50, "USDC"),
        governance: {},
        quorumPct: 60,
        votingPeriodSeconds: 3 * 86400,
      }),
      "0x6080",
    );
    chain.deployed.add(predicted.toLowerCase());

    const retry = await startGroupOnChain(groupId, owner);
    expect(retry).toMatchObject({ ok: true, txHash: null });
    expect(chain.deploys).toBe(deploysBefore);
  });

  it("records nothing when the network refuses", async () => {
    const owner = await user("Amaka", WALLET_A);
    const groupId = await usdcGroup(owner);
    chain.deployResult = { ok: false, reason: "relayer_out_of_funds" };

    expect(await startGroupOnChain(groupId, owner)).toEqual({ ok: false, reason: "relayer_out_of_funds" });
    const [row] = await t.db.select().from(groups).where(eq(groups.id, groupId));
    expect(row.safeAddress).toBeNull();
  });
});

describe("joining after the group has started", () => {
  it("needs a vote, so an invite link no longer works", async () => {
    const owner = await user("Amaka", WALLET_A);
    const late = await user("Tunde", WALLET_B);
    const groupId = await usdcGroup(owner);
    const invite = await groupsService.createInvite(groupId, owner, { maxUses: 5 });
    if (!invite.ok) throw new Error("invite failed");

    await startGroupOnChain(groupId, owner);

    expect(await groupsService.acceptInvite(invite.code, late)).toEqual({
      ok: false,
      reason: "started_on_chain",
    });
  });
});
