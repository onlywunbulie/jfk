import { baseSepolia } from "viem/chains";
import type { Address } from "viem";

/**
 * Where JFK lives on-chain. Safe to import from client and server alike: it is
 * public information, and the browser needs it to build transactions.
 *
 * Base Sepolia (test network) until the mainnet gate in BLUEPRINT-WEB3.md §13
 * is passed. The JFK addresses come from contracts/deployments/base-sepolia.json;
 * a test keeps the two in step.
 */
export const chain = baseSepolia;

export const CONTRACTS = {
  /** Version 2 (2026-11-16): helpers and collected dues. v1 is kept in the deployment record. */
  jfkModule: "0x2E036f9aFdC44D1399FD720A0626544b1e57F401",
  jfkSetup: "0xDaf87e6Af54E85762476AC21baD7d53BdfAC88D0",
  /** Safe v1.4.1, the L2 flavour that emits events for indexing. */
  safeL2Singleton: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
  safeProxyFactory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
  /** Circle's USDC on Base Sepolia. Six decimals. */
  usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
} as const satisfies Record<string, Address>;

/** Shown on every link to the chain, so people can check for themselves. */
export const EXPLORER_URL = "https://sepolia.basescan.org";

/** "0x4596A149…182b" — enough to recognise, short enough to fit a pill. */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
