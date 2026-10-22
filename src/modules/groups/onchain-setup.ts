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
import { jfkSetupAbi, safeAbi } from "@/lib/chain/abis";
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

  const setupData = encodeFunctionData({
    abi: jfkSetupAbi,
    functionName: "setupForGroup",
    args: [
      CONTRACTS.jfkModule,
      CONTRACTS.usdc,
      input.contribution.minor,
      contractThresholds(input.governance),
      input.quorumPct,
      input.votingPeriodSeconds,
    ],
  });

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
