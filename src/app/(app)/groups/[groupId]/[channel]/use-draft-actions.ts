"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { SEND_STAGE_TEXT, useSendToBase, type SendStage, type Wallet } from "@/lib/chain/use-send-to-base";
import { confirmSentAction, discardDraftAction, prepareSendAction } from "@/app/(app)/ai-actions";

/**
 * What every Waiting section does with a draft:
 *  - Discard: gone for real, and the list refreshes.
 *  - Send to vote: Rallied prepares the exact proposal and checks the member
 *    can send it; the member's wallet confirms it (see useSendToBase); once
 *    it's on Base, Rallied checks the chain for the proposal and marks the
 *    draft sent.
 * Each step says where it's up to, and a failure says why in plain words.
 */

type Stage = "preparing" | SendStage;

export function useDraftActions() {
  const router = useRouter();
  const sendToBase = useSendToBase();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [stage, setStage] = useState<{ id: string; stage: Stage; wallet: Wallet } | null>(null);
  const [notice, setNotice] = useState<{ id: string; text: string } | null>(null);

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
    setStage({ id, stage: "preparing", wallet: "base" });
    try {
      const prepared = await prepareSendAction(id);
      if (!prepared.ok) {
        setNotice({ id, text: prepared.error });
        return;
      }
      const sent = await sendToBase({
        calls: [prepared.call],
        wallet: prepared.wallet,
        onStage: (next, wallet) => setStage({ id, stage: next, wallet }),
      });
      if (!sent.ok) {
        setNotice({ id, text: sent.error });
        return;
      }
      const confirmed = await confirmSentAction(id, sent.hash);
      if (!confirmed.ok) {
        setNotice({ id, text: confirmed.error });
        return;
      }
      router.refresh();
    } catch (cause) {
      console.error("Send to vote failed", cause);
      setNotice({ id, text: "Couldn't send it. Nothing was sent; try again." });
    } finally {
      setStage(null);
    }
  };

  const stageText = (id: string) =>
    stage?.id === id ? (stage.stage === "preparing" ? "Getting it ready…" : SEND_STAGE_TEXT[stage.wallet][stage.stage]) : null;

  return {
    discard,
    send,
    discarding: (id: string) => pending && busyId === id,
    /** "Confirm in the Coinbase window…" while this draft is being sent, else null. */
    sending: stageText,
    /** While sending, where it's up to; otherwise the last message for this draft. */
    noticeFor: (id: string) => stageText(id) ?? (notice?.id === id ? notice.text : null),
  };
}
