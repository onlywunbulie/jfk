import "server-only";
import type { Address, Hex } from "viem";
import { publicClient } from "@/lib/chain/client";

/**
 * Did this wallet really sign this message?
 *
 * Goes to the chain because a smart wallet is a contract: its signatures are
 * checked by asking the contract (ERC-1271), or, for a wallet that hasn't
 * been deployed yet, by simulating its deployment (ERC-6492). viem handles
 * both, and ordinary wallets too.
 *
 * Its own module so tests can stand it in without a network.
 */
export async function verifyWalletSignature(input: {
  address: Address;
  message: string;
  signature: Hex;
}): Promise<boolean> {
  return publicClient().verifyMessage(input);
}
