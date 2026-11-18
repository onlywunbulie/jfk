"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { AiLogo, type AiName } from "@/components/ai-logos";
import { cn } from "@/lib/cn";
import { disconnectAiAction } from "@/app/(app)/ai-actions";

/**
 * The one place a user connects their AI to Rallied and disconnects it. The
 * connection is for the whole account: one AI acts across all the user's
 * groups (each group's #verify & connect can keep it out of that group).
 *
 * Real: whether an AI is connected, since when, last used, what it can and
 * can't do, and Disconnect, which cuts every token at once. Limits (money
 * caps, what it may do alone) aren't built yet: their screen ("limits" stage)
 * is kept but nothing opens it until they are.
 */

export const LIMIT_PRESETS = [
  { value: "ask", label: "Ask me for everything", detail: "Claude prepares, you tap every time." },
  { value: "dues", label: "Pay my dues, ask for the rest", detail: "Contributions go automatically. Everything else needs a tap." },
  { value: "custom", label: "Custom", detail: "Choose what Claude can do alone, money caps, and how long it lasts." },
] as const;

type Preset = (typeof LIMIT_PRESETS)[number]["value"];
type Stage = "status" | "choose" | "steps" | "limits";

/** Shown to the user; dates are formatted on the server so they match on screen. */
export interface ConnectionView {
  appName: string;
  connectedOn: string;
  lastUsed: string | null;
}

const TILES: { name: AiName; ready: boolean }[] = [
  { name: "Claude", ready: true },
  { name: "ChatGPT", ready: false },
  { name: "Grok", ready: false },
];

export function AiConnection({ connection, mcpUrl }: { connection: ConnectionView | null; mcpUrl: string }) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>(connection ? "status" : "choose");
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  const [, setPreset] = useState<Preset>("dues");
  const [pendingPreset, setPendingPreset] = useState<Preset>("dues");
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // A connection that appears or disappears (after Connect in Claude, or a
  // Disconnect) moves the screen to match, without a reload.
  const [lastSeen, setLastSeen] = useState(connection !== null);
  if ((connection !== null) !== lastSeen) {
    setLastSeen(connection !== null);
    setStage(connection ? "status" : "choose");
  }

  const disconnect = () =>
    startTransition(async () => {
      await disconnectAiAction();
      setConfirming(false);
      setNotice(`Disconnected. ${connection?.appName ?? "Your AI"} can't reach Rallied any more.`);
      router.refresh();
    });

  const name = connection?.appName ?? "Claude";
  const logo: AiName = /chatgpt|openai/i.test(name) ? "ChatGPT" : /grok/i.test(name) ? "Grok" : "Claude";

  return (
    <div className="space-y-4">
      {stage === "status" && connection && (
        <div className="rounded-[var(--radius-card)] border border-border p-5">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-full bg-overlay text-ink">
              <AiLogo name={logo} className="size-5" />
            </span>
            <div>
              <p className="font-semibold text-ink">{connection.appName}</p>
              <p className="text-sm text-inflow">Connected since {connection.connectedOn}</p>
            </div>
          </div>
          <dl className="mt-4 space-y-2 text-sm">
            <Row label="Last used" value={connection.lastUsed ?? "Not yet"} />
            <Row label="Can" value="Read your groups, create groups, draft changes for you to send, and pay your dues once you allow it" />
            <Row label="Can't" value="Vote, send a draft, or spend" />
          </dl>

          {confirming ? (
            <div className="animate-arrive mt-5 rounded-[var(--radius-control)] bg-overlay p-3 text-sm">
              <p className="font-semibold text-ink">Disconnect {connection.appName}?</p>
              <p className="mt-1 text-ink-muted">It stops working in all your groups straight away. You can connect again any time.</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button type="button" variant="danger" size="sm" loading={pending} onClick={disconnect}>
                  Disconnect
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-5 flex flex-wrap gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(true)}>
                Disconnect
              </Button>
            </div>
          )}
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
                <p className="mt-3 text-sm text-ink-faint">Coming</p>
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
              <p className="text-ink">Copy Rallied&rsquo;s connector address</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <code className="rounded-[6px] bg-raised px-2.5 py-1.5 font-mono text-xs break-all text-ink">{mcpUrl}</code>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard?.writeText(mcpUrl).then(
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
              <p className="text-ink">In Claude, open Settings → Connectors → Add custom connector, paste it, then Connect.</p>
            </Step>
            <Step n={3}>
              <p className="text-ink">Sign in to Rallied when asked, and choose Allow.</p>
            </Step>
          </ol>
          <div className="mt-5 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setNotice("Checking…");
                router.refresh();
                setTimeout(() => setNotice("If it still isn't connected, finish connecting in Claude, then check again."), 1500);
              }}
            >
              I&rsquo;ve connected it
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
                  pendingPreset === option.value ? "border-accent bg-accent-soft" : "border-border hover:border-border-strong",
                )}
              >
                <input
                  type="radio"
                  name="limits"
                  value={option.value}
                  checked={pendingPreset === option.value}
                  onChange={() => setPendingPreset(option.value)}
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
                setPreset(pendingPreset);
                setStage("status");
                setNotice("Saved on this screen only. Limits take effect once Claude can act, in a later step. For now it can only read.");
              }}
            >
              Confirm with Face ID
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setStage("status")}>
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
