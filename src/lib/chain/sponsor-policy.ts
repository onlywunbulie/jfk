import { decodeFunctionData, getAddress, isAddress, type Address, type Hex } from "viem";
import { CONTRACTS, chain } from "./addresses";

/**
 * What Rallied will pay the network fee for. A wallet asks the paymaster to
 * sponsor a user operation; this decides whether it qualifies. The rule:
 * on Base Sepolia, every call goes to one of Rallied's own contracts, and no
 * call carries money (ETH). Who's asking (a member's wallet) is checked by
 * the caller, against the database.
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

/** The only contracts Rallied pays for: its module, test USDC (for dues approvals) and Safe's factory. */
export const SPONSORED_CONTRACTS: readonly Address[] = [CONTRACTS.jfkModule, CONTRACTS.usdc, CONTRACTS.safeProxyFactory];

export type SponsorCheck = { ok: true; sender: Address } | { ok: false; reason: string };

export function checkSponsorable(userOp: unknown, chainIdHex: unknown): SponsorCheck {
  if (typeof chainIdHex !== "string" || Number.parseInt(chainIdHex, 16) !== chain.id) {
    return { ok: false, reason: "wrong network" };
  }
  if (!userOp || typeof userOp !== "object") return { ok: false, reason: "no user operation" };
  const { sender, callData } = userOp as { sender?: unknown; callData?: unknown };
  if (typeof sender !== "string" || !isAddress(sender)) return { ok: false, reason: "no sender" };
  if (typeof callData !== "string" || !callData.startsWith("0x")) return { ok: false, reason: "no call data" };

  let calls: { target: Address; value: bigint }[];
  try {
    const decoded = decodeFunctionData({ abi: smartWalletAbi, data: callData as Hex });
    calls =
      decoded.functionName === "execute"
        ? [{ target: decoded.args[0], value: decoded.args[1] }]
        : decoded.args[0].map((call) => ({ target: call.target, value: call.value }));
  } catch {
    return { ok: false, reason: "unrecognised wallet call" };
  }

  if (calls.length === 0) return { ok: false, reason: "nothing to do" };
  const allowed = new Set(SPONSORED_CONTRACTS.map((address) => address.toLowerCase()));
  for (const call of calls) {
    if (!allowed.has(call.target.toLowerCase())) return { ok: false, reason: "calls a contract Rallied doesn't sponsor" };
    if (call.value !== 0n) return { ok: false, reason: "sends money" };
  }
  return { ok: true, sender: getAddress(sender) };
}
