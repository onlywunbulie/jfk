import { describe, expect, it } from "vitest";
import { decodeFunctionData, getAddress, zeroAddress } from "viem";
import { Money } from "@/lib/money";
import { CONTRACTS } from "@/lib/chain/addresses";
import { jfkSetupAbi, safeAbi } from "@/lib/chain/abis";
import { buildGroupSetup, contractThresholds, saltNonceFor } from "./onchain-setup";

const AMAKA = getAddress("0x4596a149ac1d950ba229b208445dcb51fc84182b");
const TUNDE = getAddress("0x27c73a4bdc1ca98cafb44cf33ab8c681db2bd129");

function setupFor(overrides: Partial<Parameters<typeof buildGroupSetup>[0]> = {}) {
  return buildGroupSetup({
    groupId: "group-1",
    memberWallets: [AMAKA, TUNDE],
    contribution: Money.fromMajor(50, "USDC"),
    governance: {},
    quorumPct: 60,
    votingPeriodSeconds: 3 * 86400,
    cadence: "MONTHLY",
    ...overrides,
  });
}

/** Unwrap Safe.setup, then the JfkSetup call inside it. */
function decode(initializer: `0x${string}`) {
  const setup = decodeFunctionData({ abi: safeAbi, data: initializer });
  const [owners, threshold, to, data, fallback] = setup.args as unknown as readonly [
    readonly string[], bigint, string, `0x${string}`, string,
  ];
  const inner = decodeFunctionData({ abi: jfkSetupAbi, data });
  return { owners, threshold, to, fallback, inner: inner.args };
}

describe("creating a group's Safe", () => {
  it("makes every member an owner and needs all of them to sign directly", () => {
    const { owners, threshold } = decode(setupFor().initializer);
    expect(owners).toEqual([AMAKA, TUNDE]);
    expect(threshold).toBe(2n);
  });

  it("switches on JFK's module with the group's money rules, in the same call", () => {
    const { to, fallback, inner } = decode(setupFor().initializer);
    expect(to).toBe(CONTRACTS.jfkSetup);
    expect(fallback).toBe(zeroAddress);

    const [module, token, contribution, , quorum, period, payGap] = inner;
    expect(module).toBe(CONTRACTS.jfkModule);
    expect(token).toBe(CONTRACTS.usdc);
    expect(contribution).toBe(50_000_000n); // $50 in USDC's six decimal places
    expect(quorum).toBe(60);
    expect(period).toBe(3 * 86400);
    expect(payGap).toBe(25 * 86400); // monthly: at least 25 days between collected dues
  });

  it("spaces collected dues by the group's schedule: 25 days monthly, 6 weekly", () => {
    const weekly = decode(setupFor({ cadence: "WEEKLY" }).initializer).inner;
    expect(weekly[6]).toBe(6 * 86400);
  });

  it("every 2 or 3 weeks spaces collections a day short of the cycle, inside v2's 31-day limit", () => {
    expect(decode(setupFor({ cadence: "WEEKLY", intervalWeeks: 2 }).initializer).inner[6]).toBe(13 * 86400);
    expect(decode(setupFor({ cadence: "WEEKLY", intervalWeeks: 3 }).initializer).inner[6]).toBe(20 * 86400);
    expect(decode(setupFor({ cadence: "MONTHLY", intervalWeeks: 3 }).initializer).inner[6]).toBe(25 * 86400);
  });

  it("refuses to put a naira group on-chain", () => {
    expect(() => setupFor({ contribution: Money.fromMajor(50_000, "NGN") })).toThrow(/USDC/);
  });

  it("refuses a group with nobody in it", () => {
    expect(() => setupFor({ memberWallets: [] })).toThrow(/at least one member/);
  });

  it("uses the same salt for the same group, so a retry finds the first attempt", () => {
    expect(setupFor().saltNonce).toBe(saltNonceFor("group-1"));
    expect(saltNonceFor("group-1")).not.toBe(saltNonceFor("group-2"));
  });
});

describe("the group's rules, in the contract's order", () => {
  it("carries each rule the group chose into its on-chain slot", () => {
    const t = contractThresholds({
      FUND_RELEASE_SMALL: 600,
      FUND_RELEASE_LARGE: 800,
      REMOVE_MEMBER: 750,
      CHANGE_CONTRIBUTION: 1000,
      CHANGE_GOVERNANCE: 800,
      DISSOLVE_GROUP: 1000,
    });
    expect(t).toEqual([600, 800, 500, 750, 750, 1000, 800, 1000, 800]);
  });

  it("falls back to the defaults for anything the group didn't set", () => {
    expect(contractThresholds({})).toEqual([500, 667, 500, 667, 750, 667, 750, 800, 750]);
  });

  it("only ever produces bars the contract accepts", () => {
    for (const bar of contractThresholds({})) {
      expect(bar).toBeGreaterThanOrEqual(500);
      expect(bar).toBeLessThanOrEqual(1000);
    }
  });
});

describe("a rotating group's setup (contract v3)", () => {
  it("registers as rotating, in the turn order, with its timing and first payout", async () => {
    const { decodeFunctionData: decodeCall } = await import("viem");
    const { jfkRotatingSetupAbi } = await import("@/lib/chain/abis");
    const { rotationTiming } = await import("./onchain-setup");
    const firstPayoutAt = 1_800_000_000;
    const { initializer } = setupFor({ memberWallets: [TUNDE, AMAKA], rotation: { firstPayoutAt } });

    const setup = decodeCall({ abi: safeAbi, data: initializer });
    const [owners, , , data] = setup.args as unknown as readonly [readonly string[], bigint, string, `0x${string}`];
    expect(owners).toEqual([TUNDE, AMAKA]); // the Safe's owner order is the first cycle's turn order
    const inner = decodeCall({ abi: jfkRotatingSetupAbi, data });
    expect(inner.functionName).toBe("setupForRotatingGroup");
    const args = inner.args as readonly unknown[];
    const { roundGap, grace } = rotationTiming("MONTHLY");
    expect(args[0]).toBe(CONTRACTS.jfkModule);
    expect(args.slice(7)).toEqual([roundGap, grace, BigInt(firstPayoutAt)]);
  });
});

describe("rotation timing", () => {
  it("never refuses a payout on a due date, and leaves late payers at least three days in any month", async () => {
    const { rotationTiming } = await import("./onchain-setup");
    const day = 86400;
    const { roundGap, grace } = rotationTiming("MONTHLY");
    for (const monthDays of [28, 29, 30, 31]) {
      expect(roundGap).toBeLessThan(monthDays * day); // due date is always past the earliest payout
      expect(roundGap + grace - monthDays * day).toBeGreaterThanOrEqual(3 * day); // a short payout waits 3+ days past due
    }
    expect(grace).toBeLessThanOrEqual(7 * day); // the contract's limit
  });

  it("weekly: a day short of the cycle, three days' grace", async () => {
    const { rotationTiming } = await import("./onchain-setup");
    expect(rotationTiming("WEEKLY", 2)).toEqual({ roundGap: 13 * 86400, grace: 3 * 86400 });
  });
});
