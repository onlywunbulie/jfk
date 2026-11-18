"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { SEND_STAGE_TEXT, useSendToBase } from "@/lib/chain/use-send-to-base";
import { confirmAutopayAction, prepareAutopayAction, prepareRemovalAction } from "@/app/(app)/autopay-actions";

/**
 * One button, one wallet confirm, then "go back to your AI". The wallet
 * window only opens from a tap, so this can't happen by itself on load.
 */
export function AutoPayConfirm({
  mode,
  groupId,
  title,
  lines,
  alreadyOn = null,
}: {
  mode: "set-up" | "remove";
  groupId: string;
  title: string;
  lines: string[];
  alreadyOn?: string | null;
}) {
  const sendToBase = useSendToBase();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function go() {
    setError(null);
    setBusy("Getting it ready…");
    try {
      const prepared = mode === "set-up" ? await prepareAutopayAction(groupId) : await prepareRemovalAction(groupId);
      if (!prepared.ok) {
        setError(prepared.error);
        return;
      }
      const sent = await sendToBase({
        calls: prepared.calls,
        wallet: prepared.wallet,
        onStage: (stage, wallet) => setBusy(SEND_STAGE_TEXT[wallet][stage]),
      });
      if (!sent.ok) {
        setError(sent.error);
        return;
      }
      if (mode === "set-up") {
        setBusy("Checking Base…");
        const confirmed = await confirmAutopayAction(groupId, sent.hash);
        if (!confirmed.ok) {
          setError(confirmed.error);
          return;
        }
      }
      setDone(true);
    } finally {
      setBusy(null);
    }
  }

  if (done) {
    return (
      <>
        {mode === "set-up" && (
          // eslint-disable-next-line @next/next/no-img-element -- a small static SVG
          <img src="/illustrations/all-set.svg" alt="" aria-hidden="true" className="mb-8 h-32 w-auto self-start" />
        )}
        <h1 className="text-[1.75rem] leading-tight font-semibold tracking-tight text-ink">{mode === "set-up" ? "Done" : "Removed"}</h1>
        <p className="mt-3 text-ink-muted">
          {mode === "set-up"
            ? "Rallied will pay your dues on each due date. You can close this tab and go back to your AI."
            : "Rallied is no longer your helper in this group on Base. You can close this tab."}
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
      {alreadyOn && mode === "set-up" && (
        <p className="mt-4 text-sm text-inflow">Already on until {alreadyOn}. Confirming again renews it for a year.</p>
      )}
      <div className="mt-8">
        <Button type="button" size="lg" fullWidth loading={busy !== null} onClick={go}>
          {mode === "set-up" ? "Confirm in my wallet" : "Remove in my wallet"}
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
