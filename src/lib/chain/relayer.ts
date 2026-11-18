import "server-only";
import { createWalletClient, http, type Account, type Chain, type Transport, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { parseEther } from "viem";
import { env } from "@/lib/env";
import { chain } from "./addresses";

let client: WalletClient<Transport, Chain, Account> | null | undefined;

/**
 * The app's own small wallet, used only to pay network fees for actions
 * anyone is allowed to take, such as creating a group's Safe. It is never an
 * owner of a Safe and has no power over one: paying the fee for a Safe does
 * not make you its owner.
 *
 * Null when no key is configured; callers say so plainly rather than failing
 * somewhere deep in a transaction.
 */
export function relayer(): WalletClient<Transport, Chain, Account> | null {
  if (client !== undefined) return client;
  const key = env().RELAYER_PRIVATE_KEY;
  client = key
    ? createWalletClient({
        account: privateKeyToAccount(key as `0x${string}`),
        chain,
        transport: http(env().BASE_RPC_URL),
      })
    : null;
  return client;
}

/**
 * Below this, the fee wallet stops starting new groups, keeping what's left
 * for what members already rely on: carrying out passed votes and collecting
 * automatic dues. About a hundred such transactions on Base.
 */
export const RELAYER_RESERVE_WEI = parseEther("0.0005");

/** Below this, it's time to top the fee wallet up: the health check says so. */
export const RELAYER_LOW_WEI = parseEther("0.002");
