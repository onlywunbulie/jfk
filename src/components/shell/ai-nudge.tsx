"use client";

import { useState } from "react";
import { AiLogo } from "@/components/ai-logos";
import { Button } from "@/components/ui/button";
import { AI_NUDGE_COOKIE } from "./ai-nudge-cookie";

/** How long "Not now" lasts before the nudge comes back. */
const SNOOZE_DAYS = 3;

/**
 * A message bar for someone with no AI connected: Rallied is built around
 * one, so skipping it at sign-up isn't the end of it. "Not now" hides it for
 * three days; connecting hides it for good (the layout stops sending it).
 *
 * "Connect Claude" opens the profile, where the steps are.
 */
export function AiNudge({ onConnect }: { onConnect: () => void }) {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;

  const snooze = () => {
    document.cookie = `${AI_NUDGE_COOKIE}=1; path=/; max-age=${SNOOZE_DAYS * 24 * 60 * 60}; samesite=lax`;
    setHidden(true);
  };

  return (
    <div
      role="status"
      className="animate-arrive mb-6 flex flex-col gap-4 rounded-[var(--radius-card)] border border-border bg-surface p-4 sm:flex-row sm:items-center"
    >
      <div className="flex min-w-0 flex-1 items-center gap-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-overlay text-ink">
          <AiLogo name="Claude" className="size-5" />
        </span>
        <div className="min-w-0">
          <p className="font-semibold text-ink">Connect Claude</p>
          <p className="text-sm text-ink-muted">
            Ask for a group, a spend or a rule change in plain words, and Claude drafts it for you to send.
          </p>
        </div>
      </div>
      <div className="flex shrink-0 justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={snooze}>
          Not now
        </Button>
        <Button type="button" size="sm" onClick={onConnect}>
          Connect
        </Button>
      </div>
    </div>
  );
}
