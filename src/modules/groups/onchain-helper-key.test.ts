import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createTestDb, type TestDb } from "@/lib/db/testing";

// Moving automatic dues and AI votes from the fee wallet to Rallied's own
// helper key, with Base replaced by a stand-in. Setups from before keep
// working on the old key until the member renews; everything new names the
// helper key; and whichever key a member named is the one that signs.
const t: TestDb = await createTestDb();
vi.mock("@/lib/db", async () => ({ db: t.db }));
vi.mock("server-only", () => ({}));

const HELPER_PRIVATE_KEY = `0x${"11".repeat(32)}` as const;
const HELPER = privateKeyToAccount(HELPER_PRIVATE_KEY).address;
const FEE_WALLET = getAddress("0xe2058d49dbe0031d2bc89a4050548a8fdb1659ea");
const AMAKA = "0x27c73a4bdc1ca98cafb44cf33ab8c681db2bd129";
const SAFE = getAddress("0x2a7a348bccee61c5ef6c213efc0baa05841a5a70");
const TX = `0x${"ef".repeat(32)}` as Hex;
const NOW = () => BigInt(Math.floor(Date.now() / 1000));
const YEAR = 365n * 86_400n;

const chain = {
  helper: { key: FEE_WALLET as string, powers: 0, expiresAt: 0n },
  /** Which key signed each collection. */
  signedBy: [] as string[],
};

vi.mock("@/lib/env", () => ({ env: () => ({ HELPER_PRIVATE_KEY, NODE_ENV: "test" }) }));
vi.mock("@/lib/chain/client", () => ({
  publicClient: () => ({
    readContract: async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case "isModuleEnabled":
        case "isOwner":
          return true;
        case "getGroup":
          return ["0x0", 1_000_000n, 3 * 86400, 60, false, [500, 667, 500, 667, 750, 667, 750, 800, 750], 0n];
        case "getGroupSettings":
          return [false, 25 * 86_400];
        case "getHelper":
          return chain.helper;
        case "lastPaidAt":
          return 0n;
        case "balanceOf":
          return 10_000_000n;
        case "allowance":
          return 12_000_000n;
        default:
          throw new Error(`unexpected read ${functionName}`);
      }
    },
    waitForTransactionReceipt: async () => ({ status: "success", logs: [] }),
  }),
}));
const signer = (address: string) => ({
  account: { address },
  writeContract: async () => {
    chain.signedBy.push(address);
    return TX;
  },
});
vi.mock("@/lib/chain/relayer", () => ({ relayer: () => signer(FEE_WALLET) }));
// The helper key's wallet, without a network: it records that it signed.
vi.mock("viem", async (original) => ({
  ...(await original<typeof import("viem")>()),
  createWalletClient: ({ account }: { account: { address: string } }) => signer(account.address),
}));

const { prepareAutopay, confirmAutopay, collectDues, autopayStatus } = await import("./onchain-autopay");
const { createGroup } = await import("./service");
const { users, groups } = await import("@/lib/db/schema");
const { Money } = await import("@/lib/money");
const { jfkHelperAbi } = await import("@/lib/chain/abis");
const { eq } = await import("drizzle-orm");

beforeEach(async () => {
  await t.reset();
  chain.helper = { key: FEE_WALLET, powers: 0, expiresAt: 0n };
  chain.signedBy = [];
});

afterAll(async () => {
  await t.close();
});

async function setupWithDues(namedKey: string, powers = 4) {
  const [amaka] = await t.db.insert(users).values({ displayName: "Amaka", walletAddress: AMAKA }).returning();
  const { groupId } = await createGroup(amaka.id, {
    name: "OTF",
    type: "TREASURY",
    contributionAmount: Money.fromMajor(1, "USDC"),
    cadence: "MONTHLY",
    dueDay: 1,
  });
  await t.db.update(groups).set({ safeAddress: SAFE.toLowerCase(), currency: "USDC" }).where(eq(groups.id, groupId));
  chain.helper = { key: namedKey, powers, expiresAt: NOW() + YEAR };
  const confirmed = await confirmAutopay(amaka.id, groupId, TX);
  if (!confirmed.ok) throw new Error(confirmed.reason);
  return { amaka: amaka.id, groupId };
}

describe("the helper key", () => {
  it("an old setup on the fee wallet keeps collecting, signed by the fee wallet, and is asked to renew", async () => {
    const { amaka, groupId } = await setupWithDues(FEE_WALLET);
    expect(await autopayStatus(amaka, groupId)).toMatchObject({ on: true, renew: true });
    expect(await collectDues(amaka, groupId, "asked")).toMatchObject({ ok: true });
    expect(chain.signedBy).toEqual([FEE_WALLET]);
  });

  it("renewing names the helper key and keeps the AI's vote", async () => {
    const { amaka, groupId } = await setupWithDues(FEE_WALLET, 4 | 2);
    const prepared = await prepareAutopay(amaka, groupId);
    if (!prepared.ok) throw new Error(prepared.reason);
    const [, key, powers] = decodeFunctionData({ abi: jfkHelperAbi, data: prepared.calls[0].data }).args as [string, string, number];
    expect(key).toBe(HELPER);
    expect(powers).toBe(4 | 2);
  });

  it("once on the helper key, the helper key signs and nothing asks to renew", async () => {
    const { amaka, groupId } = await setupWithDues(HELPER);
    expect(await autopayStatus(amaka, groupId)).toMatchObject({ on: true, renew: false });
    expect(await collectDues(amaka, groupId, "asked")).toMatchObject({ ok: true });
    expect(chain.signedBy).toEqual([HELPER]);
  });

  it("a key that isn't Rallied's never counts", async () => {
    const { amaka, groupId } = await setupWithDues(HELPER);
    chain.helper = { key: "0x00000000000000000000000000000000000000aa", powers: 4, expiresAt: NOW() + YEAR };
    expect(await autopayStatus(amaka, groupId)).toEqual({ on: false, why: "removed_from_base" });
    expect(await collectDues(amaka, groupId, "asked")).toMatchObject({ ok: false });
    expect(chain.signedBy).toEqual([]);
  });
});
