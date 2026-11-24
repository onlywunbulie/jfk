import {
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  getContractAddress,
  keccak256,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { CONTRACTS } from "@/lib/chain/addresses";
import { jfkRotatingSetupAbi, jfkSetupAbi, safeAbi } from "@/lib/chain/abis";
import { DEFAULT_GOVERNANCE, type GovernedAction } from "@/lib/db/schema";
import type { Money } from "@/lib/money";

/**
 * Turning a JFK group into the exact bytes that create its Safe.
 *
 * Pure: no network, no database. That keeps the part where a mistake would
 * be written into a contract forever fully testable.
 */

/**
 * The contract's approval bars, in its `Rule` order (contracts/src/JfkModule.sol).
 * Each comes from the group's own rule where the app has one; the two rules
 * that exist only on-chain take the plan's defaults (BLUEPRINT-WEB3.md §6).
 */
export function contractThresholds(
  governance: Partial<Record<GovernedAction, number>>,
): readonly [number, number, number, number, number, number, number, number, number] {
  const rule = (action: GovernedAction) => governance[action] ?? DEFAULT_GOVERNANCE[action];
  return [
    rule("FUND_RELEASE_SMALL"), // SPEND_SMALL
    rule("FUND_RELEASE_LARGE"), // SPEND_LARGE
    500, // ADD_MEMBER: half the group
    rule("REMOVE_MEMBER"), // REMOVE_MEMBER
    750, // REPLACE_MEMBER: a lost wallet, 3 out of every 4
    rule("CHANGE_CONTRIBUTION"), // CHANGE_CONTRIBUTION
    rule("CHANGE_GOVERNANCE"), // CHANGE_RULES
    rule("DISSOLVE_GROUP"), // CLOSE_GROUP
    rule("CHANGE_GOVERNANCE"), // MIGRATE_MODULE: as hard as changing the rules
  ];
}

export interface GroupSetupInput {
  groupId: string;
  memberWallets: Address[];
  contribution: Money;
  governance: Partial<Record<GovernedAction, number>>;
  quorumPct: number;
  votingPeriodSeconds: number;
  /** How often everyone pays; sets the least time between two collected payments. */
  cadence: "WEEKLY" | "MONTHLY";
  /** Weekly groups: every 1, 2 or 3 weeks. */
  intervalWeeks?: number;
  /**
   * Rotating groups (Ajo): when the first turn is paid out, in seconds since
   * 1970. `memberWallets` is then the turn order.
   */
  rotation?: { firstPayoutAt: number };
}

const DAY_SECONDS = 24 * 60 * 60;

/**
 * A rotating group's timing on Base (contract v3):
 *
 * - roundGap, the least time between two payouts: a day short of the cycle
 *   (27 days for monthly, 6, 13 or 20 for weekly), so a daily job running a
 *   few seconds later or earlier than last time is never refused on a due date.
 * - grace, how much longer a payout waits once due when someone hasn't
 *   paid. Counted from the previous payout, so it must cover the longest
 *   month: 27 + 7 = 34 days for monthly, leaving late payers at least three
 *   days after even a 31-day month's due date. Weekly: 3 days.
 *
 * Rallied's daily job only tries a short payout three days after the due
 * date; these are the contract's floor, which nobody can go under.
 */
export function rotationTiming(cadence: "WEEKLY" | "MONTHLY", intervalWeeks = 1): { roundGap: number; grace: number } {
  if (cadence === "MONTHLY") return { roundGap: 27 * DAY_SECONDS, grace: 7 * DAY_SECONDS };
  const weeks = Math.min(Math.max(Math.trunc(intervalWeeks), 1), 3);
  return { roundGap: (7 * weeks - 1) * DAY_SECONDS, grace: 3 * DAY_SECONDS };
}

/**
 * The least time between two collected payments from one member. A little
 * short of the real cycle, so a due date that drifts (a 28-day February, a
 * collection that ran late) never blocks the next one; still long enough
 * that nobody can be charged twice for one period: 25 days for monthly, and
 * a day short of the cycle for every 1, 2 or 3 weeks (6, 13, 20 days). All
 * within contract v2's 31-day limit.
 */
export function payGapSeconds(cadence: "WEEKLY" | "MONTHLY", intervalWeeks = 1): number {
  const weeks = Math.min(Math.max(Math.trunc(intervalWeeks), 1), 3);
  return (cadence === "MONTHLY" ? 25 : 7 * weeks - 1) * 24 * 60 * 60;
}

export interface GroupSetup {
  initializer: Hex;
  saltNonce: bigint;
}

/**
 * The `Safe.setup` call that makes every member an owner, requires all of
 * them to sign anything directly (the emergency exit), and switches on JFK's
 * module with this group's rules, all in the transaction that creates it.
 */
export function buildGroupSetup(input: GroupSetupInput): GroupSetup {
  if (input.contribution.currency !== "USDC") {
    throw new Error(`An on-chain group saves in USDC, not ${input.contribution.currency}`);
  }
  if (input.memberWallets.length === 0) throw new Error("A group needs at least one member");

  const common = [
    CONTRACTS.jfkModule,
    CONTRACTS.usdc,
    input.contribution.minor,
    contractThresholds(input.governance),
    input.quorumPct,
    input.votingPeriodSeconds,
    payGapSeconds(input.cadence, input.intervalWeeks),
  ] as const;
  let setupData: Hex;
  if (input.rotation) {
    const { roundGap, grace } = rotationTiming(input.cadence, input.intervalWeeks);
    setupData = encodeFunctionData({
      abi: jfkRotatingSetupAbi,
      functionName: "setupForRotatingGroup",
      args: [...common, roundGap, grace, BigInt(input.rotation.firstPayoutAt)],
    });
  } else {
    setupData = encodeFunctionData({ abi: jfkSetupAbi, functionName: "setupForGroup", args: common });
  }

  const initializer = encodeFunctionData({
    abi: safeAbi,
    functionName: "setup",
    args: [
      input.memberWallets,
      BigInt(input.memberWallets.length),
      CONTRACTS.jfkSetup,
      setupData,
      zeroAddress,
      zeroAddress,
      0n,
      zeroAddress,
    ],
  });

  return { initializer, saltNonce: saltNonceFor(input.groupId) };
}

/**
 * Derived from the group's id, so creating the same group twice lands on the
 * same address and the second attempt simply finds the first.
 */
export function saltNonceFor(groupId: string): bigint {
  return BigInt(keccak256(toHex(`jfk-group:${groupId}`)));
}

/**
 * Where the Safe will be, before it exists: the same CREATE2 sum the proxy
 * factory does. `proxyCreationCode` comes from the factory itself.
 */
export function predictSafeAddress(setup: GroupSetup, proxyCreationCode: Hex): Address {
  const salt = keccak256(
    concatHex([keccak256(setup.initializer), encodeAbiParameters([{ type: "uint256" }], [setup.saltNonce])]),
  );
  const initCode = concatHex([
    proxyCreationCode,
    encodeAbiParameters([{ type: "address" }], [CONTRACTS.safeL2Singleton]),
  ]);
  return getContractAddress({
    from: CONTRACTS.safeProxyFactory,
    opcode: "CREATE2",
    salt,
    bytecode: initCode,
  });
}
