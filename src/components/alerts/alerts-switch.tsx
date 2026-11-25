"use client";

import { cn } from "@/lib/cn";
import { useAlerts } from "./use-alerts";

/**
 * The profile's Alerts section: alerts on this device, on or off. Each phone
 * or browser is its own; turning them on here doesn't touch the others.
 */
export function AlertsSwitch() {
  const { state, busy, error, turnOn, turnOff } = useAlerts();
  const on = state === "on";
  const canSwitch = state === "on" || state === "off";

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-4 text-sm">
        <span className="text-ink">This device</span>
        {canSwitch ? (
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label="Alerts on this device"
            disabled={busy}
            onClick={on ? turnOff : turnOn}
            className={cn(
              "press relative h-7 w-12 shrink-0 rounded-full border transition-colors disabled:opacity-60",
              on ? "border-accent bg-accent" : "border-border-strong bg-overlay",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "absolute top-1/2 left-0.5 size-5 -translate-y-1/2 rounded-full shadow transition-transform duration-200 [transition-timing-function:cubic-bezier(.34,1.4,.64,1)]",
                on ? "translate-x-[22px] bg-accent-ink" : "bg-ink-muted",
              )}
            />
          </button>
        ) : (
          <span className="text-ink-muted">{state === "loading" ? "Checking…" : STATUS[state]}</span>
        )}
      </div>
      <p className="text-sm text-ink-muted">{HELP[state]}</p>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

const STATUS = {
  unavailable: "Not available",
  install: "Add to Home Screen first",
  blocked: "Blocked",
} as const;

const HELP: Record<ReturnType<typeof useAlerts>["state"], string> = {
  loading: "New votes, the last day to vote, your turn paid, and dues due.",
  on: "New votes, the last day to vote, your turn paid, and dues due.",
  off: "New votes, the last day to vote, your turn paid, and dues due.",
  unavailable: "This browser can't show alerts from Rallied. The bell still lists what needs you.",
  install: "On iPhone, tap Share, then Add to Home Screen, and open Rallied from there to turn alerts on.",
  blocked: "Alerts are blocked for Rallied in this browser's settings. Allow them there, then come back.",
};
