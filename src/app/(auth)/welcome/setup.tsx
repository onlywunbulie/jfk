"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { AiLogo } from "@/components/ai-logos";
import { setNameAction } from "@/app/(app)/actions";
import { SetupProgress } from "../auth-frame";

/**
 * Steps 2 and 3 of first-time setup. Step 2: what the group should call
 * them. Step 3: connect their AI, the point of Rallied, offered up front but
 * skippable with "Skip for now" (the app reminds them until they connect).
 *
 * Step 3 shows Rallied's real connector address; "I've added it" opens the
 * app (the connection itself finishes in Claude).
 */

export function Setup({ initialName, mcpUrl, next = "/" }: { initialName: string; mcpUrl: string; next?: string }) {
  const router = useRouter();
  const [state, action] = useActionState(setNameAction, {});
  // Saving the name moves setup on to step 3.
  const step = state.saved ? 3 : 2;
  const [showSteps, setShowSteps] = useState(false);
  const [copied, setCopied] = useState(false);

  const enterApp = () => {
    router.replace(next as Route);
    router.refresh();
  };

  if (step === 2) {
    return (
      <>
        <SetupProgress step={2} />
        <h1 className="text-[1.75rem] leading-tight font-semibold tracking-tight text-ink">What should your group call you?</h1>
        <p className="mt-3 mb-8 text-ink-muted">Your wallet is set up, and only you can use it.</p>
        <form action={action} className="space-y-4">
          <Field
            label="Your name"
            name="name"
            defaultValue={initialName}
            placeholder="Amaka"
            maxLength={40}
            autoFocus
            autoComplete="given-name"
            error={state.error}
          />
          <Continue />
        </form>
      </>
    );
  }

  return (
    <div className="animate-arrive">
      <SetupProgress step={3} />
      <h1 className="text-[1.75rem] leading-tight font-semibold tracking-tight text-ink">Connect your AI</h1>
      <p className="mt-3 mb-8 text-ink-muted">
        Ask Claude for a group, a spend or a rule change in plain words. It drafts it, and you send it to a vote here. Once you allow it, it can pay your dues too. It can never vote or spend the group&rsquo;s money.
      </p>

      {!showSteps ? (
        <button
          type="button"
          onClick={() => setShowSteps(true)}
          className="press flex w-full items-center gap-4 rounded-[var(--radius-card)] border border-border bg-surface p-4 text-left transition-colors hover:border-border-strong"
        >
          <span className="grid size-11 shrink-0 place-items-center rounded-full bg-overlay text-ink">
            <AiLogo name="Claude" className="size-6" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-semibold text-ink">Connect Claude</span>
            <span className="block text-sm text-ink-muted">About a minute</span>
          </span>
          <svg viewBox="0 0 16 16" aria-hidden="true" className="size-4 text-ink-faint" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
            <path d="m6 3.5 4.5 4.5L6 12.5" />
          </svg>
        </button>
      ) : (
        <div className="animate-arrive rounded-[var(--radius-card)] border border-border bg-surface p-5">
          <ol className="space-y-4 text-sm">
            <Step n={1}>
              <p className="text-ink">Copy Rallied&rsquo;s address</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <code className="rounded-[6px] bg-raised px-2.5 py-1.5 font-mono text-xs text-ink">{mcpUrl}</code>
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
              <p className="text-ink">In Claude, open Settings → Connectors → Add custom connector, and paste it.</p>
            </Step>
            <Step n={3}>
              <p className="text-ink">Claude brings you back here to choose its limits.</p>
            </Step>
          </ol>
          <Button type="button" size="sm" className="mt-5" onClick={enterApp}>
            I&rsquo;ve added it
          </Button>
        </div>
      )}

      <p className="mt-4 text-sm text-ink-faint">ChatGPT and Grok are coming.</p>

      <Button type="button" variant="secondary" fullWidth className="mt-8" onClick={enterApp}>
        Skip for now
      </Button>
      <p className="mt-3 text-center text-sm text-ink-faint">You can connect it any time from your profile.</p>
    </div>
  );
}

function Continue() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" fullWidth loading={pending}>
      Continue
    </Button>
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
