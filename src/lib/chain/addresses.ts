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
   * Version 4 (2026-11-26): no human-only voting, automatic dues required to
   * collect a turn, every shortfall readable. Every group started on Base
   * from now on uses it, shared pots included.
   */
  jfkModule: "0xd3E740d6ec186be9e4073367dd9f54caae175Db0",
  jfkSetup: "0x6D418561efABD8270500aD7EA1a2f0079fCA61bE",
  /**
   * Version 3 (2026-11-20): rotating savings. Groups started on Base from
   * 2026-11-20 to 2026-11-26 keep running on it.
   */
  jfkModuleV3: "0x48bB48799153c1a420B8476EaC663C396E291655",
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
 * Rallied's contracts that a group's vault may run on, newest first, with the
 * version each one is. Groups stay on the version they started on.
 */
export const RALLIED_MODULE_VERSIONS = [
  { address: CONTRACTS.jfkModule, version: 4 },
  { address: CONTRACTS.jfkModuleV3, version: 3 },
  { address: CONTRACTS.jfkModuleV2, version: 2 },
] as const;

export const RALLIED_MODULES: readonly Address[] = RALLIED_MODULE_VERSIONS.map((module) => module.address);

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
