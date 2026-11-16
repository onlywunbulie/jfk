"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { AiLogo, type AiName } from "@/components/ai-logos";
import { setAiInGroupAction } from "@/app/(app)/ai-actions";

/**
 * "Your AI" in a group's #verify & connect. Three states:
 * - no AI connected at all: a link to connect it in the profile;
 * - connected and allowed here: "Claude · connected", which you can tap to
 *   take it out of this group only (after a confirmation right there);
 * - connected but kept out of this group: "not connected here", with Connect.
 *
 * Real: the switch is saved, and Claude's tools stop seeing this group at
 * once. Disconnecting everywhere lives in the profile.
 */
export function VerifyAi({
  ai,
  groupId,
  groupName,
  connected,
  allowedHere,
}: {
  ai: AiName | null;
  groupId: string;
  groupName: string;
  /** Whether the user has an AI connected to Rallied at all. */
  connected: boolean;
  /** Whether that AI may see this group. */
  allowedHere: boolean;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const setAllowed = (allowed: boolean) =>
    startTransition(async () => {
      const result = await setAiInGroupAction({ groupId, allowed });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setConfirming(false);
      router.refresh();
    });

  if (!connected || !ai) {
    return (
      <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-ink-muted">No AI connected</span>
        <Link
          href={`/groups/${groupId}/verify?profile=1` as Route}
          className="text-ink underline decoration-ink-faint underline-offset-4 hover:decoration-ink"
        >
          Connect one
        </Link>
      </span>
    );
  }

  if (!allowedHere) {
    return (
      <span className="block">
        <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="inline-flex items-center gap-1.5 text-ink-muted">
            <AiLogo name={ai} className="size-3.5" />
            {ai} · not connected here
          </span>
          <button
            type="button"
            disabled={pending}
            onClick={() => setAllowed(true)}
            className="press text-ink underline decoration-ink-faint underline-offset-4 hover:decoration-ink disabled:opacity-60"
          >
            {pending ? "Connecting…" : "Connect"}
          </button>
        </span>
        {error && <span role="alert" className="mt-2 block text-danger">{error}</span>}
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
            {ai} stops seeing {groupName}. Your other groups aren&rsquo;t affected.
          </span>
          <span className="mt-3 flex flex-wrap gap-2">
            <Button type="button" variant="danger" size="sm" loading={pending} onClick={() => setAllowed(false)}>
              Disconnect
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </span>
          {error && <span role="alert" className="mt-2 block text-danger">{error}</span>}
        </span>
      )}
    </span>
  );
}
