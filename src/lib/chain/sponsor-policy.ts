import { decodeFunctionData, getAddress, isAddress, type Address, type Hex } from "viem";
import { CONTRACTS, RALLIED_MODULES, chain, isRalliedModule } from "./addresses";
import { erc20Abi, jfkDuesAbi, jfkHelperAbi, jfkModuleAbi, jfkRotationAbi } from "./abis";

/**
 * What Rallied will pay the network fee for. A wallet asks the paymaster to
 * sponsor a user operation; this decides whether it qualifies. The rule:
 * on Base Sepolia, every call is one of the exact things Rallied asks a
 * member's wallet to do, and no call carries money (ETH):
 *  - Rallied's contract: propose, vote, contribute, name or remove a helper, leave.
 *  - USDC: approve, and only Rallied's contract as the spender.
 * Nothing else, not even another USDC function or Safe's factory (Rallied's
 * own key starts groups). Who's asking (a member's wallet) is checked by the
 * caller, against the database.
 *
 * Coinbase Developer Platform's allowlist checks the contracts again; this
 * is the first line, so a leaked endpoint can't spend Rallied's gas on
 * anything else.
 */

/** Base Account (Coinbase Smart Wallet) wraps calls in one of these. */
const smartWalletAbi = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "executeBatch",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

/** The only contracts Rallied pays for: its modules (v3 and v2), and USDC (only to approve one of them). */
export const SPONSORED_CONTRACTS: readonly Address[] = [...RALLIED_MODULES, CONTRACTS.usdc];

/** The member-side functions of Rallied's contract, the only ones a member's wallet sends. */
const MODULE_FUNCTIONS = new Set([
  "propose",
  "vote",
  "contribute",
  "setHelper",
  "revokeHelper",
  "leave",
  // Rotating groups (v3): anyone may trigger a due payout, or cover a member's debt.
  "payTurn",
  "coverDebt",
]);
const moduleAbi = [
  ...jfkModuleAbi,
  ...jfkRotationAbi,
  ...jfkDuesAbi,
  ...jfkHelperAbi,
  { type: "function", name: "leave", stateMutability: "nonpayable", inputs: [{ name: "safe", type: "address" }], outputs: [] },
] as const;

/** Is this one call something Rallied pays for? A reason when it isn't. */
function callProblem(target: Address, value: bigint, data: Hex): string | null {
  if (value !== 0n) return "sends money";
  const to = target.toLowerCase();
  if (isRalliedModule(to)) {
    try {
      const call = decodeFunctionData({ abi: moduleAbi, data });
      return MODULE_FUNCTIONS.has(call.functionName) ? null : `calls ${call.functionName}, which members don't send`;
    } catch {
      return "calls something unknown on Rallied's contract";
    }
  }
  if (to === CONTRACTS.usdc.toLowerCase()) {
    try {
      const call = decodeFunctionData({ abi: erc20Abi, data });
      if (call.functionName !== "approve") return "a USDC call other than approving Rallied's contract";
      const [spender] = call.args as readonly [Address, bigint];
      return isRalliedModule(spender) ? null : "approves someone other than Rallied's contract";
    } catch {
      return "a USDC call other than approving Rallied's contract";
    }
  }
  return "calls a contract Rallied doesn't sponsor";
}

export type SponsorCheck = { ok: true; sender: Address } | { ok: false; reason: string };

export function checkSponsorable(userOp: unknown, chainIdHex: unknown): SponsorCheck {
  if (typeof chainIdHex !== "string" || Number.parseInt(chainIdHex, 16) !== chain.id) {
    return { ok: false, reason: "wrong network" };
  }
  if (!userOp || typeof userOp !== "object") return { ok: false, reason: "no user operation" };
  const { sender, callData } = userOp as { sender?: unknown; callData?: unknown };
  if (typeof sender !== "string" || !isAddress(sender)) return { ok: false, reason: "no sender" };
  if (typeof callData !== "string" || !callData.startsWith("0x")) return { ok: false, reason: "no call data" };

  let calls: { target: Address; value: bigint; data: Hex }[];
  try {
    const decoded = decodeFunctionData({ abi: smartWalletAbi, data: callData as Hex });
    calls =
      decoded.functionName === "execute"
        ? [{ target: decoded.args[0], value: decoded.args[1], data: decoded.args[2] }]
        : decoded.args[0].map((call) => ({ target: call.target, value: call.value, data: call.data }));
  } catch {
    return { ok: false, reason: "unrecognised wallet call" };
  }

  if (calls.length === 0) return { ok: false, reason: "nothing to do" };
  for (const call of calls) {
    const problem = callProblem(call.target, call.value, call.data);
    if (problem) return { ok: false, reason: problem };
  }
  return { ok: true, sender: getAddress(sender) };
}
