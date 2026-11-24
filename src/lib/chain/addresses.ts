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
  /**
   * Version 3 (2026-11-20): rotating savings. Every group started on Base
   * from now on uses it, shared pots included (they behave as in v2).
   */
  jfkModule: "0x48bB48799153c1a420B8476EaC663C396E291655",
  jfkSetup: "0xF44DF78ba5BaA9a3F836E446af99930389196f10",
  /**
   * Version 2 (2026-11-16): helpers and collected dues. Groups started on
   * Base before v3 keep running on it; `moduleFor` tells them apart.
   */
  jfkModuleV2: "0x2E036f9aFdC44D1399FD720A0626544b1e57F401",
  /** Safe v1.4.1, the L2 flavour that emits events for indexing. */
  safeL2Singleton: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
  safeProxyFactory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
  /** Circle's USDC on Base Sepolia. Six decimals. */
  usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
} as const satisfies Record<string, Address>;

/**
 * Rallied's contracts that a group's vault may run on, newest first. Groups
 * started on Base from 2026-11-20 use v3; earlier ones stay on v2.
 */
export const RALLIED_MODULES: readonly Address[] = [CONTRACTS.jfkModule, CONTRACTS.jfkModuleV2];

/** Whether an address is one of Rallied's contracts. */
export function isRalliedModule(address: string): boolean {
  return RALLIED_MODULES.some((module) => module.toLowerCase() === address.toLowerCase());
}

/** Shown on every link to the chain, so people can check for themselves. */
export const EXPLORER_URL = "https://sepolia.basescan.org";

/**
 * Blockscout's free API for a vault's whole history. Base's public node only
 * searches about 200 blocks of logs per request, which can't cover a group's life.
 */
export const HISTORY_API_URL = "https://base-sepolia.blockscout.com/api";

/** "0x4596A149…182b" — enough to recognise, short enough to fit a pill. */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
