"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { discardDraftAction } from "@/app/(app)/ai-actions";

/**
 * What every Waiting section does with a draft: discard it for real (then
 * refresh, so it's gone from the list), or say that sending isn't here yet.
 * Sending a draft to a vote is recorded on Base with the user's wallet, which
 * comes with the contract step.
 */
export function useDraftActions() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
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

  const send = (id: string) =>
    setNotice({ id, text: "Sending to a vote comes with the next step, when votes go on Base. Your draft is kept here." });

  return { discard, send, discarding: (id: string) => pending && busyId === id, noticeFor: (id: string) => (notice?.id === id ? notice.text : null) };
}
