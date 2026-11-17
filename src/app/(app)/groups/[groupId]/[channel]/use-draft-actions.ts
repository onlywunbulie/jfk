"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useAccount, useConnect, useConnectors, useSendCallsSync } from "wagmi";
import { chain } from "@/lib/chain/addresses";
import { confirmSentAction, discardDraftAction, prepareSendAction } from "@/app/(app)/ai-actions";

/**
 * What every Waiting section does with a draft:
 *  - Discard: gone for real, and the list refreshes.
 *  - Send to vote: Rallied prepares the exact proposal and checks the member
 *    can send it; the member's wallet opens to confirm (Face ID); Rallied pays
 *    the network fee through its paymaster; once it's on Base, Rallied checks
 *    the chain for the proposal and marks the draft sent.
 * Each step says where it's up to, and a failure says why in plain words.
 */

type Stage = "preparing" | "confirm" | "sending";

const STAGE_TEXT: Record<Stage, string> = {
  preparing: "Getting it ready…",
  confirm: "Confirm in the Coinbase window…",
  sending: "Sending to the group on Base…",
};

export function useDraftActions() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [stage, setStage] = useState<{ id: string; stage: Stage } | null>(null);
  const [notice, setNotice] = useState<{ id: string; text: string } | null>(null);

  const { address, isConnected } = useAccount();
  const { connectAsync } = useConnect();
  const connectors = useConnectors();
  const { mutateAsync: sendCalls } = useSendCallsSync();

  const discard = (id: string) => {
    setBusyId(id);
    startTransition(async () => {
      const result = await discardDraftAction(id);
      setBusyId(null);
      if (!result.ok) {
        setNotice({ id, text: result.error });
        return;
      }
      setNotice(null);
      router.refresh();
    });
  };

  const send = async (id: string) => {
    setNotice(null);
    setStage({ id, stage: "preparing" });
    try {
      const prepared = await prepareSendAction(id);
      if (!prepared.ok) {
        setNotice({ id, text: prepared.error });
        return;
      }

      // The wallet must be the one this account signed in with.
      let account = isConnected ? address : undefined;
      if (!account) {
        const connected = await connectAsync({ connector: connectors[0], chainId: chain.id });
        account = connected.accounts[0];
      }
      if (!account || account.toLowerCase() !== prepared.wallet.toLowerCase()) {
        setNotice({
          id,
          text: `Your wallet window is using a different wallet than the one you signed in with (${short(prepared.wallet)}). Switch to that one and try again.`,
        });
        return;
      }

      setStage({ id, stage: "confirm" });
      const result = await sendCalls({
        calls: [prepared.call],
        chainId: chain.id,
        // Rallied pays the network fee. The wallet calls this address itself.
        capabilities: { paymasterService: { url: `${window.location.origin}/api/paymaster` } },
      });
      setStage({ id, stage: "sending" });

      const hash = result.receipts?.[0]?.transactionHash;
      if (!hash || result.status !== "success") {
        setNotice({ id, text: "It didn't go through on Base. Nothing was sent; try again." });
        return;
      }
      const confirmed = await confirmSentAction(id, hash);
      if (!confirmed.ok) {
        setNotice({ id, text: confirmed.error });
        return;
      }
      router.refresh();
    } catch (cause) {
      console.error("Send to vote failed", cause);
      setNotice({ id, text: describe(cause) });
    } finally {
      setStage(null);
    }
  };

  return {
    discard,
    send,
    discarding: (id: string) => pending && busyId === id,
    /** "Confirm in the Coinbase window…" while this draft is being sent, else null. */
    sending: (id: string) => (stage?.id === id ? STAGE_TEXT[stage.stage] : null),
    /** While sending, where it's up to; otherwise the last message for this draft. */
    noticeFor: (id: string) => (stage?.id === id ? STAGE_TEXT[stage.stage] : notice?.id === id ? notice.text : null),
  };
}

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Wallet errors are written for developers; members get one plain line. */
function describe(cause: unknown): string {
  const text = cause instanceof Error ? `${cause.name} ${cause.message}` : String(cause);
  if (/reject|denied|cancel/i.test(text)) return "You closed the Coinbase window before confirming. Nothing was sent.";
  if (/popup|blocked/i.test(text)) return "Your browser blocked the Coinbase window. Allow pop-ups for this site, then try again.";
  if (/paymaster|sponsor/i.test(text)) return "Rallied couldn't pay the network fee for this one. Nothing was sent.";
  return "Couldn't send it. Nothing was sent; try again.";
}
