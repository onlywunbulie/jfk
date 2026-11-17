"use client";

import type { Address, Hex } from "viem";
import { useAccount, useConfig, useConnect, useConnectors, useSendCallsSync, useSendTransaction, useSwitchChain } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { chain } from "./addresses";
import { BASE_ACCOUNT_ID, TEST_WALLET_ID } from "./wagmi";

/**
 * Sending one contract call from the member's own wallet, the one they signed
 * in with, and waiting until Base has it. Used by Send to vote and by voting.
 *
 *  - Coinbase's wallet: sent as a wallet call with Rallied's paymaster, so
 *    Rallied pays the fee and the member just confirms.
 *  - A browser wallet (test network only, see wagmi.ts): an ordinary
 *    transaction that pays its own small test fee.
 *
 * Each step is reported through onStage so the screen can say where it's up
 * to; failures come back as one plain line.
 */

export type Wallet = "base" | "test";
export type SendStage = "confirm" | "sending";

export const SEND_STAGE_TEXT: Record<Wallet, Record<SendStage, string>> = {
  base: { confirm: "Confirm in the Coinbase window…", sending: "Sending it to Base…" },
  test: { confirm: "Confirm in your wallet…", sending: "Waiting for Base to include it…" },
};

export type SendResult = { ok: true; hash: Hex; wallet: Wallet } | { ok: false; error: string };

export function useSendToBase() {
  const config = useConfig();
  const { address, isConnected, connector: activeConnector, chainId: walletChainId } = useAccount();
  const { connectAsync } = useConnect();
  const connectors = useConnectors();
  const { switchChainAsync } = useSwitchChain();
  const { mutateAsync: sendCalls } = useSendCallsSync();
  const { mutateAsync: sendTransaction } = useSendTransaction();

  /**
   * Already connected is the usual case. Otherwise a browser wallet that
   * already knows this site and holds the member's address is used quietly;
   * failing that, Coinbase's window.
   */
  async function connectWallet(expected: Address): Promise<{ account: Address | undefined; wallet: Wallet; onChain: number | undefined }> {
    if (isConnected && address) {
      return { account: address, wallet: activeConnector?.id === TEST_WALLET_ID ? "test" : "base", onChain: walletChainId };
    }
    const browserWallet = connectors.find((c) => c.id === TEST_WALLET_ID);
    if (browserWallet) {
      const known = await browserWallet.getAccounts().catch(() => [] as readonly Address[]);
      if (known.some((a) => a.toLowerCase() === expected.toLowerCase())) {
        const connected = await connectAsync({ connector: browserWallet, chainId: chain.id });
        return { account: connected.accounts[0], wallet: "test", onChain: connected.chainId };
      }
    }
    const baseAccount = connectors.find((c) => c.id === BASE_ACCOUNT_ID) ?? connectors[0];
    const connected = await connectAsync({ connector: baseAccount, chainId: chain.id });
    return { account: connected.accounts[0], wallet: "base", onChain: connected.chainId };
  }

  return async function sendToBase(input: {
    call: { to: Address; data: Hex };
    /** The wallet this account signed in with; any other is refused. */
    wallet: string;
    onStage?: (stage: SendStage, wallet: Wallet) => void;
  }): Promise<SendResult> {
    let wallet: Wallet = "base";
    try {
      const connected = await connectWallet(input.wallet as Address);
      wallet = connected.wallet;
      if (!connected.account || connected.account.toLowerCase() !== input.wallet.toLowerCase()) {
        return {
          ok: false,
          error: `Your wallet is using a different address than the one you signed in with (${short(input.wallet)}). Switch to that one and try again.`,
        };
      }

      input.onStage?.("confirm", wallet);
      let hash: Hex | undefined;
      if (wallet === "base") {
        const result = await sendCalls({
          calls: [input.call],
          chainId: chain.id,
          // Rallied pays the network fee. The wallet calls this address itself.
          capabilities: { paymasterService: { url: `${window.location.origin}/api/paymaster` } },
        });
        input.onStage?.("sending", wallet);
        hash = result.status === "success" ? result.receipts?.[0]?.transactionHash : undefined;
      } else {
        if (connected.onChain !== chain.id) await switchChainAsync({ chainId: chain.id });
        const sent = await sendTransaction({ to: input.call.to, data: input.call.data, chainId: chain.id });
        input.onStage?.("sending", wallet);
        const receipt = await waitForTransactionReceipt(config, { hash: sent, chainId: chain.id });
        hash = receipt.status === "success" ? sent : undefined;
      }

      if (!hash) return { ok: false, error: "It didn't go through on Base. Nothing changed; try again." };
      return { ok: true, hash, wallet };
    } catch (cause) {
      console.error("Sending to Base failed", cause);
      return { ok: false, error: describe(cause, wallet) };
    }
  };
}

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Wallet errors are written for developers; members get one plain line. */
function describe(cause: unknown, wallet: Wallet): string {
  const text = cause instanceof Error ? `${cause.name} ${cause.message}` : String(cause);
  if (wallet === "test") {
    if (/reject|denied|cancel/i.test(text)) return "You said no in your wallet. Nothing changed.";
    if (/insufficient funds|exceeds the balance|gas required exceeds/i.test(text))
      return "Your test wallet needs a little Base Sepolia ETH for the fee. Get some free from a faucet, then try again.";
    if (/chain|network/i.test(text)) return "Your wallet couldn't switch to Base Sepolia. Switch it there yourself, then try again.";
    return "Couldn't send it. Nothing changed; try again.";
  }
  if (/reject|denied|cancel/i.test(text)) return "You closed the Coinbase window before confirming. Nothing changed.";
  if (/popup|blocked/i.test(text)) return "Your browser blocked the Coinbase window. Allow pop-ups for this site, then try again.";
  if (/paymaster|sponsor/i.test(text)) return "Rallied couldn't pay the network fee for this one. Nothing changed.";
  return "Couldn't send it. Nothing changed; try again.";
}
