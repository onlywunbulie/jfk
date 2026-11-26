import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, erc20Abi, getAddress, type Hex } from "viem";

vi.mock("server-only", () => ({}));

// The emergency exit's plan, with Base replaced by a stand-in: the split
// follows the group's own closing rule, falls back to equal shares if the
// contract can't be read, and the vault always ends empty.
const SAFE = getAddress("0x2a7a348bccee61c5ef6c213efc0baa05841a5a70");
const ADA = getAddress("0x00000000000000000000000000000000000000a1");
const BAYO = getAddress("0x00000000000000000000000000000000000000b2");
const CHI = getAddress("0x00000000000000000000000000000000000000c3");
const MODULE = getAddress("0xd3E740d6ec186be9e4073367dd9f54caae175Db0");

const chain = {
  balance: 0n,
  module: true as boolean,
  rotating: false,
  contribution: 10_000_000n,
  paidIn: {} as Record<string, bigint>,
  paidThisRound: {} as Record<string, boolean>,
  approved: {} as Record<string, boolean>,
};

vi.mock("@/lib/chain/module", () => ({ moduleFor: async () => (chain.module ? { address: MODULE, version: 4 } : null) }));
vi.mock("@/lib/chain/client", () => ({
  publicClient: () => ({
    readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      switch (functionName) {
        case "getOwners":
          return [ADA, BAYO, CHI];
        case "balanceOf":
          return chain.balance;
        case "nonce":
          return 7n;
        case "getTransactionHash":
          return `0x${"ab".repeat(32)}` as Hex;
        case "approvedHashes":
          return chain.approved[String(args?.[0])] ? 1n : 0n;
        case "getRotation":
          return [chain.rotating, 1, 0, 0, 0n, 0, 0, 0n, 0n];
        case "getGroup":
          return ["0x0", chain.contribution, 0, 0, false, [], 0n];
        case "rotationStatus":
          return [true, chain.paidThisRound[String(args?.[1])] ?? false, false, false];
        case "paidIn":
          return chain.paidIn[String(args?.[1])] ?? 0n;
        default:
          throw new Error(`unexpected read ${functionName}`);
      }
    },
  }),
}));
vi.mock("@/lib/chain/relayer", () => ({ relayer: () => null }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/modules/audit/service", () => ({ recordAudit: async () => undefined }));
vi.mock("./service", () => ({ getGroupDetail: async () => null, listMembers: async () => null }));

const { planExit } = await import("@/modules/groups/onchain-exit");
const { multiSendAbi } = await import("@/lib/chain/abis");

/** The transfers inside the plan's MultiSend batch: [recipient, amount]. */
function transfersIn(data: Hex): [string, bigint][] {
  const batch = decodeFunctionData({ abi: multiSendAbi, data }).args[0].slice(2);
  const out: [string, bigint][] = [];
  let at = 0;
  while (at < batch.length) {
    const length = Number(BigInt(`0x${batch.slice(at + 2 + 40 + 64, at + 2 + 40 + 128)}`));
    const call = `0x${batch.slice(at + 2 + 40 + 128, at + 2 + 40 + 128 + length * 2)}` as Hex;
    const transfer = decodeFunctionData({ abi: erc20Abi, data: call });
    out.push([transfer.args[0] as string, transfer.args[1] as bigint]);
    at += 2 + 40 + 128 + length * 2;
  }
  return out;
}

beforeEach(() => {
  Object.assign(chain, { balance: 0n, module: true, rotating: false, paidIn: {}, paidThisRound: {}, approved: {} });
});

describe("the emergency exit's split", () => {
  it("has nothing to do when the vault is empty", async () => {
    expect(await planExit(SAFE)).toBeNull();
  });

  it("splits a shared pot by what each paid in, the last taking the rounding (as closing does)", async () => {
    chain.balance = 100_000_000n;
    chain.paidIn = { [ADA]: 10_000_000n, [BAYO]: 20_000_000n, [CHI]: 0n };
    const plan = await planExit(SAFE);
    expect(plan?.amounts).toEqual([33_333_333n, 66_666_666n, 1n]);
    expect(transfersIn(plan!.data)).toEqual([
      [ADA, 33_333_333n],
      [BAYO, 66_666_666n],
      [CHI, 1n],
    ]);
  });

  it("sends nobody a zero transfer", async () => {
    chain.balance = 30_000_000n;
    chain.paidIn = { [ADA]: 0n, [BAYO]: 0n, [CHI]: 30_000_000n };
    const plan = await planExit(SAFE);
    expect(transfersIn(plan!.data)).toEqual([[CHI, 30_000_000n]]);
  });

  it("in a rotating group, gives this round back to who paid it, then the rest equally", async () => {
    chain.rotating = true;
    chain.balance = 50_000_000n; // two paid this round (20), plus 30 left over
    chain.paidThisRound = { [ADA]: true, [CHI]: true };
    const plan = await planExit(SAFE);
    expect(plan?.amounts).toEqual([20_000_000n, 10_000_000n, 20_000_000n]);
    expect(plan?.rule).toMatch(/this round back/i);
  });

  it("splits equally when Rallied's contract can't be read", async () => {
    chain.module = false;
    chain.balance = 10_000_000n;
    const plan = await planExit(SAFE);
    expect(plan?.amounts).toEqual([3_333_333n, 3_333_333n, 3_333_334n]);
    expect(plan?.rule).toMatch(/equally/i);
  });

  it("always pays out exactly what's in the vault", async () => {
    for (const balance of [1n, 7n, 999_999n, 123_456_789n]) {
      chain.balance = balance;
      chain.paidIn = { [ADA]: 3n, [BAYO]: 5n, [CHI]: 11n };
      const plan = await planExit(SAFE);
      expect(plan?.amounts.reduce((a, b) => a + b, 0n)).toBe(balance);
    }
  });
});
