"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { SEND_STAGE_TEXT, useSendToBase } from "@/lib/chain/use-send-to-base";
import { confirmAiVotesAction, prepareAiVotesAction } from "@/app/(app)/ai-vote-actions";

/** One button, one wallet confirm, then back to the AI. Nothing happens on page load. */
export function AiVotesConfirm({
  groupId,
  mode,
  title,
  lines,
}: {
  groupId: string;
  mode: "allow" | "remove";
  title: string;
  lines: string[];
}) {
  const sendToBase = useSendToBase();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function go() {
    setError(null);
    setBusy("Getting it ready…");
    try {
      const prepared = await prepareAiVotesAction(groupId, mode);
      if (!prepared.ok) return setError(prepared.error);
      const sent = await sendToBase({
        calls: prepared.calls,
        wallet: prepared.wallet,
        onStage: (stage, wallet) => setBusy(SEND_STAGE_TEXT[wallet][stage]),
      });
      if (!sent.ok) return setError(sent.error);
      setBusy("Checking Base…");
      const confirmed = await confirmAiVotesAction(groupId, mode);
      if (!confirmed.ok) return setError(confirmed.error);
      setDone(true);
    } finally {
      setBusy(null);
    }
  }

  if (done) {
    return (
      <>
        {mode === "allow" && (
          // eslint-disable-next-line @next/next/no-img-element -- a small static SVG
          <img src="/illustrations/all-set.svg" alt="" aria-hidden="true" className="mb-8 h-32 w-auto self-start" />
        )}
        <h1 className="text-[1.75rem] leading-tight font-semibold tracking-tight text-ink">{mode === "allow" ? "Done" : "Stopped"}</h1>
        <p className="mt-3 text-ink-muted">
          {mode === "allow"
            ? "Tell your AI how you’d like to vote, and it votes for you. You can close this tab and go back to it."
            : "Your AI can no longer vote for you in this group. You can still vote in #votes."}
        </p>
      </>
    );
  }

  return (
    <>
      <h1 className="text-[1.75rem] leading-tight font-semibold tracking-tight text-balance text-ink">{title}</h1>
      <div className="mt-4 space-y-2 text-ink-muted">
        {lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
      <div className="mt-8">
        <Button type="button" size="lg" fullWidth loading={busy !== null} onClick={go}>
          {mode === "allow" ? "Confirm in my wallet" : "Stop it in my wallet"}
        </Button>
        {busy && (
          <p role="status" className="mt-3 text-sm text-ink-muted">
            {busy}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-3 rounded-[var(--radius-control)] bg-danger-soft px-4 py-3 text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </>
  );
}
