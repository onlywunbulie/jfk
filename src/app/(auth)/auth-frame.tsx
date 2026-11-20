import type { ReactNode } from "react";
import { AiLogo } from "@/components/ai-logos";

/**
 * The frame for signing in and first-time setup. On the left (desktop only),
 * what Rallied feels like: a sample of Rall's message and the user's AI at
 * work, in the app's real style. On the right, the one thing to do now.
 */
export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh bg-canvas lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <aside
        aria-label="A look at Rallied"
        className="hidden flex-col justify-center border-r border-border bg-surface px-12 py-16 lg:flex xl:px-20"
      >
        <Preview />
      </aside>

      <main className="flex flex-col px-6 py-12 sm:px-10">
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center">{children}</div>
        <p className="mx-auto mt-10 w-full max-w-sm text-xs text-ink-faint">Test network · no real money yet</p>
      </main>
    </div>
  );
}

/** A still from a rotating group: Rall's update, then the user's Claude paying in. */
function Preview() {
  return (
    <div aria-hidden="true" className="mx-auto w-full max-w-md">
      <p className="mb-6 text-sm text-ink-faint">What your group sees</p>

      <div className="flex gap-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent text-base font-bold text-accent-ink">R</span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2">
            <span className="font-semibold text-ink">Rall</span>
            <span className="rounded-[4px] bg-raised px-1.5 py-px text-[0.6875rem] leading-4 font-semibold text-ink-muted">AGENT</span>
            <span className="text-xs text-ink-faint">Today, 08:00</span>
          </p>
          <dl className="mt-2 space-y-2 rounded-[var(--radius-big)] bg-raised px-5 py-4 text-sm">
            <Row label="Round">4 of 8</Row>
            <Row label="Getting paid">Tunde on 1 December, $800.00</Row>
            <Row label="This round">
              7 of 8 paid <span className="text-ink-muted">· Late: Femi</span>
            </Row>
          </dl>
        </div>
      </div>

      <div className="mt-6 flex gap-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-overlay text-ink">
          <AiLogo name="Claude" className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2">
            <span className="font-semibold text-ink">Your Claude</span>
            <span className="text-xs text-ink-faint">08:02</span>
          </p>
          <p className="mt-2 inline-block rounded-[var(--radius-big)] bg-raised px-5 py-4 text-sm text-ink">
            Paid your $100.00 to Detty December. <span className="text-inflow">Done</span>
          </p>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-24 shrink-0 text-ink-muted">{label}</dt>
      <dd className="min-w-0 text-ink">{children}</dd>
    </div>
  );
}

/** Where a first-time user is in setup: three short bars, the done ones lit. */
export function SetupProgress({ step }: { step: 1 | 2 | 3 }) {
  return (
    <div className="mb-8" role="progressbar" aria-valuemin={1} aria-valuemax={3} aria-valuenow={step} aria-label={`Setup, step ${step} of 3`}>
      <div className="flex gap-1.5">
        {[1, 2, 3].map((n) => (
          <span key={n} className={`h-1 flex-1 rounded-full transition-colors duration-300 ${n <= step ? "bg-accent" : "bg-overlay"}`} />
        ))}
      </div>
      <p className="mt-2 text-xs text-ink-faint">Step {step} of 3</p>
    </div>
  );
}
