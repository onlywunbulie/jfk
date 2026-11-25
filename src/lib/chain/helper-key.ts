import "server-only";
import { createWalletClient, http, parseEther, type Account, type Address, type Chain, type Transport, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { env } from "@/lib/env";
import { chain } from "./addresses";
import { relayer } from "./relayer";

type Signer = WalletClient<Transport, Chain, Account>;

let client: Signer | null | undefined;

/**
 * Rallied's helper key: the one a member names as their helper on Base, so
 * Rallied can collect their dues (into their own group's vault, nowhere
 * else) and cast the votes they ask their AI for. Kept apart from the fee
 * wallet (`relayer`), which starts groups and carries out passed votes, so a
 * leak of either key exposes only its own job.
 *
 * Until HELPER_PRIVATE_KEY is set, the fee wallet keeps doing both jobs, as
 * before, so nothing stops working in the meantime.
 */
export function helperKey(): Signer | null {
  if (client !== undefined) return client;
  const key = env().HELPER_PRIVATE_KEY;
  client = key
    ? createWalletClient({ account: privateKeyToAccount(key as `0x${string}`), chain, transport: http(env().BASE_RPC_URL) })
    : relayer();
  return client;
}

/** Whether the helper key is its own key, separate from the fee wallet. */
export function helperIsSeparate(): boolean {
  return Boolean(env().HELPER_PRIVATE_KEY);
}

/**
 * Every key Rallied accepts as a member's helper: the helper key, and the fee
 * wallet that did the job before it, for members who haven't renewed yet.
 */
export function ralliedHelperAddresses(): Address[] {
  const keys = [helperKey(), relayer()].filter((signer): signer is Signer => signer !== null).map((signer) => signer.account.address);
  return [...new Set(keys)];
}

/** Is this one of Rallied's helper keys? */
export function isRalliedHelper(key: string): boolean {
  return ralliedHelperAddresses().some((address) => address.toLowerCase() === key.toLowerCase());
}

/** Named on Base before the helper key existed: works, but the member should renew onto the new key. */
export function isOldHelper(key: string): boolean {
  const current = helperKey()?.account.address;
  return isRalliedHelper(key) && current !== undefined && current.toLowerCase() !== key.toLowerCase();
}

/** The signer for the key a member actually named, so old and new setups both keep working. */
export function signerForHelper(key: string): Signer | null {
  for (const signer of [helperKey(), relayer()]) {
    if (signer && signer.account.address.toLowerCase() === key.toLowerCase()) return signer;
  }
  return null;
}

/** Collections and votes cost the helper key a little ETH on Base; below this, top it up. */
export const HELPER_LOW_WEI = parseEther("0.001");
