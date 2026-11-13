"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { AiLogo, type AiName } from "@/components/ai-logos";

/**
 * "Your AI" in a group's #verify & connect. "Claude · connected" is a button:
 * tapping it asks, right there, whether to disconnect Claude from this group
 * only. The user's other groups aren't affected; disconnecting everywhere,
 * connecting and limits live in the profile.
 *
 * UI only: the connection is a sample and nothing is revoked.
 */
export function VerifyAi({ ai, groupName }: { ai: AiName; groupName: string }) {
  const [connected, setConnected] = useState(true);
  const [confirming, setConfirming] = useState(false);

  if (!connected) {
    return (
      <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="inline-flex items-center gap-1.5 text-ink-muted">
          <AiLogo name={ai} className="size-3.5" />
          {ai} · not connected here
        </span>
        <button
          type="button"
          onClick={() => setConnected(true)}
          className="press text-ink underline decoration-ink-faint underline-offset-4 hover:decoration-ink"
        >
          Connect
        </button>
      </span>
    );
  }

  return (
    <span className="block">
      <button
        type="button"
        onClick={() => setConfirming((open) => !open)}
        aria-expanded={confirming}
        className="press inline-flex items-center gap-1.5 rounded-[6px] text-ink underline decoration-ink-faint underline-offset-4 transition-colors hover:decoration-ink"
      >
        <AiLogo name={ai} className="size-3.5" />
        {ai} · connected
      </button>

      {confirming && (
        <span role="group" aria-label={`Disconnect ${ai}`} className="animate-arrive mt-3 block rounded-[var(--radius-control)] bg-overlay p-3">
          <span className="block font-semibold text-ink">Disconnect {ai} from this group?</span>
          <span className="mt-1 block text-ink-muted">
            {ai} stops acting for you in {groupName}. Your other groups aren&rsquo;t affected.
          </span>
          <span className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="danger"
              size="sm"
              onClick={() => {
                setConnected(false);
                setConfirming(false);
              }}
            >
              Disconnect
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </span>
        </span>
      )}
    </span>
  );
}
