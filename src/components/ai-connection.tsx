"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { AiLogo, type AiName } from "@/components/ai-logos";
import { cn } from "@/lib/cn";

/**
 * The one place a user connects their AI to Rallied, changes its limits and
 * disconnects it. The connection is for the whole account: one AI acts across
 * all the user's groups, so it's managed in Settings, not inside a group.
 *
 * UI only: nothing connects yet (Rallied's MCP address is a later step), and
 * the starting state is a sample: Claude connected.
 */

export const LIMIT_PRESETS = [
  { value: "ask", label: "Ask me for everything", detail: "Claude prepares, you tap every time." },
  { value: "dues", label: "Pay my dues, ask for the rest", detail: "Contributions go automatically. Everything else needs a tap." },
  { value: "custom", label: "Custom", detail: "Choose what Claude can do alone, money caps, and how long it lasts." },
] as const;

type Preset = (typeof LIMIT_PRESETS)[number]["value"];
type Stage = "connected" | "choose" | "steps" | "limits";

const MCP_ADDRESS = "https://rallied.app/mcp";

const TILES: { name: AiName; ready: boolean }[] = [
  { name: "Claude", ready: true },
  { name: "ChatGPT", ready: false },
  { name: "Grok", ready: false },
];

export function AiConnection() {
  const [stage, setStage] = useState<Stage>("connected");
  const [preset, setPreset] = useState<Preset>("dues");
  const [pending, setPending] = useState<Preset>("dues");
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const presetLabel = LIMIT_PRESETS.find((p) => p.value === preset)?.label;

  return (
    <div className="space-y-4">
      {stage === "connected" && (
        <div className="rounded-[var(--radius-card)] border border-border p-5">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-full bg-overlay text-ink">
              <AiLogo name="Claude" className="size-5" />
            </span>
            <div>
              <p className="font-semibold text-ink">Claude</p>
              <p className="text-sm text-inflow">Connected since 26 August</p>
            </div>
          </div>
          <dl className="mt-4 space-y-2 text-sm">
            <Row label="Limits" value={presetLabel ?? ""} />
            <Row label="Renews" value="In 63 days" />
            <Row label="Groups" value="Acts in all your groups" />
          </dl>
          <div className="mt-5 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                setPending(preset);
                setNotice(null);
                setStage("limits");
              }}
            >
              Change limits
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setStage("choose");
                setNotice("Disconnected on this screen only. Disconnecting for real comes in a later step.");
              }}
            >
              Disconnect
            </Button>
          </div>
        </div>
      )}

      {stage === "choose" && (
        <div className="grid gap-3 sm:grid-cols-3">
          {TILES.map((tile) => (
            <div key={tile.name} className="flex flex-col items-start rounded-[var(--radius-card)] border border-border p-4">
              <span className="grid size-10 place-items-center rounded-full bg-overlay text-ink">
                <AiLogo name={tile.name} className="size-5" />
              </span>
              <p className="mt-3 font-semibold text-ink">{tile.name}</p>
              {tile.ready ? (
                <Button
                  type="button"
                  size="sm"
                  className="mt-3"
                  onClick={() => {
                    setNotice(null);
                    setStage("steps");
                  }}
                >
                  Connect
                </Button>
              ) : (
                <p className="mt-3 text-sm text-ink-faint">Coming soon</p>
              )}
            </div>
          ))}
        </div>
      )}

      {stage === "steps" && (
        <div className="rounded-[var(--radius-card)] border border-border p-5">
          <p className="font-semibold text-ink">Connect Claude</p>
          <ol className="mt-4 space-y-4 text-sm">
            <Step n={1}>
              <p className="text-ink">Copy Rallied&rsquo;s address</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <code className="rounded-[6px] bg-raised px-2.5 py-1.5 font-mono text-xs text-ink">{MCP_ADDRESS}</code>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard?.writeText(MCP_ADDRESS).then(
                      () => setCopied(true),
                      () => setCopied(false),
                    );
                  }}
                >
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
            </Step>
            <Step n={2}>
              <p className="text-ink">In Claude, open Settings → Connectors → Add custom connector, and paste it.</p>
            </Step>
            <Step n={3}>
              <p className="text-ink">Claude brings you back here to choose its limits.</p>
            </Step>
          </ol>
          <div className="mt-5 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setPending(preset);
                setStage("limits");
              }}
            >
              I&rsquo;ve added it
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setStage("choose")}>
              Back
            </Button>
          </div>
        </div>
      )}

      {stage === "limits" && (
        <fieldset className="rounded-[var(--radius-card)] border border-border p-5">
          <legend className="sr-only">Claude&rsquo;s limits</legend>
          <p className="font-semibold text-ink">What can Claude do without asking you?</p>
          <p className="mt-1 text-sm text-ink-muted">Money only ever goes into your groups&rsquo; vaults, never anywhere else.</p>
          <div className="mt-4 space-y-2">
            {LIMIT_PRESETS.map((option) => (
              <label
                key={option.value}
                className={cn(
                  "press flex cursor-pointer items-start gap-3 rounded-[var(--radius-control)] border p-3 transition-colors",
                  pending === option.value ? "border-accent bg-accent-soft" : "border-border hover:border-border-strong",
                )}
              >
                <input
                  type="radio"
                  name="limits"
                  value={option.value}
                  checked={pending === option.value}
                  onChange={() => setPending(option.value)}
                  className="mt-1 accent-[var(--color-accent)]"
                />
                <span>
                  <span className="block text-sm text-ink">{option.label}</span>
                  <span className="block text-xs text-ink-muted">{option.detail}</span>
                </span>
              </label>
            ))}
          </div>
          <div className="mt-5 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setPreset(pending);
                setStage("connected");
                setNotice("Saved on this screen only. Confirming with Face ID comes in a later step.");
              }}
            >
              Confirm with Face ID
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setStage("connected")}>
              Cancel
            </Button>
          </div>
        </fieldset>
      )}

      {notice && (
        <p role="status" className="text-xs text-ink-muted">
          {notice}
        </p>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="text-right text-ink">{value}</dd>
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-overlay text-xs font-semibold text-ink tabular-nums">
        {n}
      </span>
      <div className="min-w-0 pt-0.5">{children}</div>
    </li>
  );
}
