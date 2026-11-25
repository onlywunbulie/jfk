"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { BellIcon } from "@/components/ui/iconoir";
import { useAlerts } from "./use-alerts";

/** How long "Not now" lasts before the bar comes back. */
const SNOOZE_DAYS = 7;
const SNOOZE_KEY = "rallied.alerts-nudge-snoozed-until";

/**
 * A message bar offering alerts on this device, until they're on. Browsers
 * only let a site ask after a tap, so this is that tap. On an iPhone in
 * Safari it explains Add to Home Screen instead, since that's what alerts
 * need there. "Not now" hides it on this device for a week; the profile's
 * Alerts section stays the way back.
 */
export function AlertsNudge() {
  const { state, busy, error, turnOn } = useAlerts();
  const [hidden, setHidden] = useState(snoozed);
  if (hidden || (state !== "off" && state !== "install")) return null;

  const snooze = () => {
    try {
      localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_DAYS * 24 * 60 * 60 * 1000));
    } catch {
      // Private browsing: it just comes back next time.
    }
    setHidden(true);
  };

  return (
    <div
      role="status"
      className="animate-arrive mb-6 flex flex-col gap-4 rounded-[var(--radius-card)] border border-border bg-surface p-4 sm:flex-row sm:items-center"
    >
      <div className="flex min-w-0 flex-1 items-center gap-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-overlay text-ink">
          <BellIcon className="size-5" />
        </span>
        <div className="min-w-0">
          <p className="font-semibold text-ink">Get alerts on this device</p>
          <p className="text-sm text-ink-muted">
            {state === "install"
              ? "On iPhone, tap Share, then Add to Home Screen. Open Rallied from there to turn alerts on."
              : "New votes, the last day to vote, your turn paid, and dues due."}
          </p>
          {error && (
            <p role="alert" className="mt-1 text-sm text-danger">
              {error}
            </p>
          )}
        </div>
      </div>
      <div className="flex shrink-0 justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={snooze}>
          Not now
        </Button>
        {state === "off" && (
          <Button type="button" size="sm" onClick={turnOn} disabled={busy}>
            {busy ? "Turning on…" : "Turn on"}
          </Button>
        )}
      </div>
    </div>
  );
}

function snoozed(): boolean {
  try {
    if (typeof window === "undefined") return true;
    return Number(localStorage.getItem(SNOOZE_KEY) ?? 0) > Date.now();
  } catch {
    return false;
  }
}
