import "server-only";
import type { Address, Hex } from "viem";
import { CONTRACTS } from "@/lib/chain/addresses";
import { jfkModuleAbi, safeAbi, safeProxyFactoryAbi } from "@/lib/chain/abis";
import { publicClient } from "@/lib/chain/client";
import { relayer } from "@/lib/chain/relayer";
import type { GroupSetup } from "./onchain-setup";

/**
 * Everything the "start a group on-chain" flow says to the network, in one
 * place so tests can stand it in.
 */

let creationCode: Hex | undefined;

export async function proxyCreationCode(): Promise<Hex> {
  creationCode ??= await publicClient().readContract({
    address: CONTRACTS.safeProxyFactory,
    abi: safeProxyFactoryAbi,
    functionName: "proxyCreationCode",
  });
  return creationCode;
}

export async function hasCode(address: Address): Promise<boolean> {
  const code = await publicClient().getCode({ address });
  return code !== undefined && code !== "0x";
}

export type DeployResult =
  | { ok: true; txHash: Hex }
  | { ok: false; reason: "no_relayer" | "relayer_out_of_funds" | "reverted" };

/** Create the Safe, paid for by the app's relayer, and wait for it to land. */
export async function deploySafe(setup: GroupSetup): Promise<DeployResult> {
  const wallet = relayer();
  if (!wallet) return { ok: false, reason: "no_relayer" };

  const balance = await publicClient().getBalance({ address: wallet.account.address });
  if (balance === 0n) return { ok: false, reason: "relayer_out_of_funds" };

  const txHash = await wallet.writeContract({
    address: CONTRACTS.safeProxyFactory,
    abi: safeProxyFactoryAbi,
    functionName: "createProxyWithNonce",
    args: [CONTRACTS.safeL2Singleton, setup.initializer, setup.saltNonce],
  });
  const receipt = await publicClient().waitForTransactionReceipt({ hash: txHash });
  return receipt.status === "success" ? { ok: true, txHash } : { ok: false, reason: "reverted" };
}

/**
 * Check a Safe really is a JFK group with exactly these members, before the
 * app records it as one.
 */
export async function confirmGroupSafe(safe: Address, members: Address[]): Promise<boolean> {
  const client = publicClient();
  const [owners, moduleOn, group] = await Promise.all([
    client.readContract({ address: safe, abi: safeAbi, functionName: "getOwners" }),
    client.readContract({ address: safe, abi: safeAbi, functionName: "isModuleEnabled", args: [CONTRACTS.jfkModule] }),
    client.readContract({ address: CONTRACTS.jfkModule, abi: jfkModuleAbi, functionName: "getGroup", args: [safe] }),
  ]);
  const same = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((x) => b.some((y) => y.toLowerCase() === x.toLowerCase()));
  return moduleOn && group[0].toLowerCase() === CONTRACTS.usdc.toLowerCase() && same(owners, members);
}
