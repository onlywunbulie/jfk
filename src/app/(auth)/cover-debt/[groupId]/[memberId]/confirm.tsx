"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { SEND_STAGE_TEXT, useSendToBase } from "@/lib/chain/use-send-to-base";
import { coveredAction, prepareCoverDebtAction } from "@/app/(app)/cover-debt-actions";

/**
 * One button, one wallet confirm. The wallet window only opens from a tap,
 * so nothing is paid by loading the page.
 */
export function CoverDebtConfirm({ groupId, memberId, title, lines }: { groupId: string; memberId: string; title: string; lines: string[] }) {
  const sendToBase = useSendToBase();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function go() {
    setError(null);
    setBusy("Getting it ready…");
    try {
      const prepared = await prepareCoverDebtAction(groupId, memberId);
      if (!prepared.ok) return setError(prepared.error);
      const sent = await sendToBase({
        calls: prepared.calls,
        wallet: prepared.wallet,
        onStage: (stage, wallet) => setBusy(SEND_STAGE_TEXT[wallet][stage]),
      });
      if (!sent.ok) return setError(sent.error);
      await coveredAction(groupId);
      setDone(true);
    } finally {
      setBusy(null);
    }
  }

  if (done) {
    return (
      <>
        {/* eslint-disable-next-line @next/next/no-img-element -- a small static SVG */}
        <img src="/illustrations/all-set.svg" alt="" aria-hidden="true" className="mb-8 h-32 w-auto self-start" />
        <h1 className="text-[1.75rem] leading-tight font-semibold tracking-tight text-ink">Covered</h1>
        <p className="mt-3 text-ink-muted">It went straight to whoever was short. You can close this tab and go back to your AI.</p>
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
          Confirm in my wallet
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
