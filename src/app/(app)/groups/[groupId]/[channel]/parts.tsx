import type { ReactNode } from "react";
import { EXPLORER_URL } from "@/lib/chain/addresses";
import { cn } from "@/lib/cn";

/**
 * The pieces every designed channel is built from: the intro, the date
 * divider, and a message from Rall with its details and footnote.
 */

// Dates are shown in Lagos time, rendered on the server, so every member
// sees the same thing.
const TIME_ZONE = "Africa/Lagos";

export function longDate(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: TIME_ZONE }).format(date);
}

export function stamp(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: TIME_ZONE,
  }).format(date);
}

/**
 * The top of a designed channel: a round # tile, a large title, then one
 * line underneath.
 */
export function ChannelIntro({ title, children }: { title: string; children: ReactNode }) {
  return (
    <header>
      <span aria-hidden="true" className="grid size-[68px] place-items-center rounded-full bg-raised text-ink">
        <svg viewBox="0 0 20 20" className="size-10" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
          <path d="M8 3.5 6.5 16.5M13.5 3.5 12 16.5M4 7.5h12.5M3.5 12.5H16" />
        </svg>
      </span>
      <h2 className="mt-4 text-[2rem] leading-tight font-extrabold tracking-tight text-balance text-ink">
        {title}
      </h2>
      <p className="mt-2 max-w-2xl text-base leading-relaxed text-pretty text-ink-muted">{children}</p>
    </header>
  );
}

/**
 * A hairline across the card with a label in the middle: a real date (shown
 * as "25 August 2026"), or plain words like "Waiting for you". Pass one or
 * the other. Never pass `new Date()` from a client component: the server and
 * the browser render it at different moments and hydration breaks.
 */
export function DateDivider({ date, label }: { date?: Date; label?: string }) {
  const text = label ?? (date ? longDate(date) : "");
  return (
    <div role="separator" aria-label={text} className="mt-6 flex items-center gap-2">
      <span className="h-px flex-1 bg-border" />
      {date ? (
        <time dateTime={date.toISOString()} className="text-xs font-semibold text-ink-faint">
          {text}
        </time>
      ) : (
        <span className="text-xs font-semibold text-ink-faint">{text}</span>
      )}
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/**
 * The group's details, posted by Rall, Rallied's agent: avatar, name with an
 * AGENT tag and the time, then the details in a rounded bubble.
 */
export function RallMessage({
  sentAt,
  time,
  highlight = false,
  body = "details",
  footnote,
  children,
}: {
  /** "details" for label/value rows (Detail), "text" for plain sentences. */
  body?: "details" | "text";
  /** A real moment, shown as "25/08/2026, 07:40". Omit it when `time` says it all. */
  sentAt?: Date;
  /** Shown instead of the full date and time, e.g. "09:14" or "Pinned". */
  time?: string;
  /** Marks the viewer's own entry with a subtle outline. */
  highlight?: boolean;
  footnote: ReactNode;
  children: ReactNode;
}) {
  return (
    <article aria-label="Message from Rall" className="mt-4 flex gap-4 py-1">
      <span
        aria-hidden="true"
        className="grid size-10 shrink-0 place-items-center rounded-full bg-accent text-base font-bold text-accent-ink"
      >
        R
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-base font-semibold text-ink">Rall</span>
          <span className="rounded-[4px] bg-raised px-1.5 py-px text-[0.6875rem] leading-4 font-semibold text-ink-muted">
            AGENT
          </span>
          {sentAt ? (
            <time dateTime={sentAt.toISOString()} className="text-xs text-ink-faint">
              {time ?? stamp(sentAt)}
            </time>
          ) : (
            time && <span className="text-xs text-ink-faint">{time}</span>
          )}
        </p>

        <div
          className={cn(
            "mt-2 w-fit max-w-xl space-y-3 rounded-3xl bg-raised px-5 py-4 text-sm leading-relaxed",
            highlight && "ring-1 ring-border-strong",
          )}
        >
          {body === "details" ? <dl className="space-y-2">{children}</dl> : <div>{children}</div>}
          {footnote}
        </div>
      </div>
    </article>
  );
}

/**
 * Only once the group's vault exists on Base: a small line at the foot of
 * Rall's message that opens the vault in the chain's explorer (BaseScan), so
 * anyone can check the money for themselves.
 */
export function VaultFootnote({ address }: { address: string }) {
  return (
    <p className="border-t border-border pt-3 text-xs text-ink-faint">
      <a
        href={`${EXPLORER_URL}/address/${address}`}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 underline decoration-ink-faint/50 underline-offset-4 transition-colors hover:text-ink hover:decoration-ink"
      >
        BaseScan
      </a>
    </p>
  );
}

export function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
      <dt className="shrink-0 text-ink-muted sm:w-28">{label}</dt>
      <dd className="min-w-0 text-pretty text-ink">{children}</dd>
    </div>
  );
}
