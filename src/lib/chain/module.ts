import "server-only";
import type { Address } from "viem";
import { RALLIED_MODULES } from "./addresses";
import { safeAbi } from "./abis";
import { publicClient } from "./client";

export { RALLIED_MODULES };

export type ModuleVersion = 2 | 3;

export interface GroupModule {
  address: Address;
  version: ModuleVersion;
}

// A vault never moves from v2 to v3 (there is no path for it), so once known
// it stays known for the life of the server.
const known = new Map<string, GroupModule>();

/**
 * Which of Rallied's contracts runs this vault, read from the vault itself.
 * Null when neither does (a v1 group, or a vault that moved away).
 */
export async function moduleFor(safe: Address): Promise<GroupModule | null> {
  const key = safe.toLowerCase();
  const cached = known.get(key);
  if (cached) return cached;

  const client = publicClient();
  const enabled = await Promise.all(
    RALLIED_MODULES.map((address) =>
      client.readContract({ address: safe, abi: safeAbi, functionName: "isModuleEnabled", args: [address] }),
    ),
  );
  const index = enabled.findIndex(Boolean);
  if (index === -1) return null;
  const found: GroupModule = { address: RALLIED_MODULES[index], version: index === 0 ? 3 : 2 };
  // Not remembered in tests, where one fake vault address plays many groups.
  if (process.env.NODE_ENV !== "test") known.set(key, found);
  return found;
}
