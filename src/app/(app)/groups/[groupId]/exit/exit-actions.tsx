"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { SEND_STAGE_TEXT, useSendToBase } from "@/lib/chain/use-send-to-base";
import { carryOutExitAction, exitApprovedAction, prepareExitApprovalAction } from "@/app/(app)/exit-actions";

/**
 * The two things a member does here: approve the exit from their own wallet
 * (they pay the small network fee, so this works even if Rallied can't),
 * and, once everyone has approved, pay everyone out.
 */
export function ExitActions({ groupId, youApproved, ready }: { groupId: string; youApproved: boolean; ready: boolean }) {
  const router = useRouter();
  const sendToBase = useSendToBase();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function approve() {
    setError(null);
    setBusy("Getting it ready…");
    try {
      const prepared = await prepareExitApprovalAction(groupId);
      if (!prepared.ok) return setError(prepared.error);
      const sent = await sendToBase({
        calls: [prepared.call],
        wallet: prepared.wallet,
        sponsored: false,
        onStage: (stage, wallet) => setBusy(SEND_STAGE_TEXT[wallet][stage]),
      });
      if (!sent.ok) return setError(sent.error);
      await exitApprovedAction(groupId);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function payOut() {
    setError(null);
    setBusy("Paying everyone out…");
    try {
      const result = await carryOutExitAction(groupId);
      if (!result.ok) return setError(result.error);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      {ready ? (
        <Button type="button" onClick={payOut} loading={busy !== null}>
          Pay everyone out
        </Button>
      ) : youApproved ? (
        <p className="text-sm text-inflow">You&rsquo;ve approved. Waiting for everyone else.</p>
      ) : (
        <Button type="button" onClick={approve} loading={busy !== null}>
          Approve in my wallet
        </Button>
      )}
      {busy && <p className="text-sm text-ink-muted">{busy}</p>}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
