import Link from "next/link";
import type { Route } from "next";
import { cn } from "@/lib/cn";
import { EXPLORER_URL } from "@/lib/chain/addresses";
import type { History, HistoryEntry } from "@/modules/groups/onchain-history";
import { ChannelIntro, DateDivider } from "./parts";
import { ScrollToBottom } from "./scroll-to-bottom";

/**
 * #transactions: the user's own money at the top, filters, then every
 * movement as short rows under Rall's name, one header per day, newest at
 * the bottom. Everything is read from the group's vault on Base, and each
 * row links to its transaction on BaseScan.
 */

export type Filter = "all" | "mine" | "in" | "out";

type Entry = HistoryEntry;

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "mine", label: "Mine" },
  { value: "in", label: "In" },
  { value: "out", label: "Out" },
];

/** The user's own money, from Base: everything they've paid in, and whether this period is paid. */
export interface YourMoneyData {
  paidIn: string;
  thisPeriod: string | null;
}

export function Transactions({
  base,
  filter,
  history,
  you,
}: {
  base: string;
  filter: Filter;
  history: History;
  you: YourMoneyData | null;
}) {
  const href = (next: Filter) =>
    (next === "all" ? `${base}/transactions` : `${base}/transactions?filter=${next}`) as Route;

  if (!history.ok) {
    const text = {
      not_on_base: "Money moves on Base, where everyone can check it. Start this group on Base first; every payment in and out will show here.",
      unreachable: "Couldn't reach Base's records just now. Refresh in a moment.",
      not_found: "This group isn't available.",
    }[history.reason];
    return (
      <div className="pt-6">
        <ChannelIntro title="Every transaction">{text}</ChannelIntro>
        {history.reason === "not_on_base" && (
          <Link
            href={`${base}/about` as Route}
            className="mt-6 inline-block text-sm text-ink underline decoration-ink-faint underline-offset-4 hover:decoration-ink"
          >
            Go to #about to start it on Base
          </Link>
        )}
      </div>
    );
  }

  const entries = history.entries;
  const shown = entries.filter(
    (entry) =>
      filter === "all" ||
      (filter === "mine" && entry.mine) ||
      (filter === "in" && entry.inflow) ||
      (filter === "out" && !entry.inflow),
  );
  const days = [...new Set(shown.map((entry) => entry.day))];

  return (
    <div className="flex min-h-full flex-col">
      {/*
        Pinned: the user's money and the filters stay at the top of the main
        card while the feed scrolls under them. The negative margins cancel the
        main card's padding so the band runs edge to edge, and it pins at
        -1.5rem (the padding's height) so it sits flush with the card's top
        edge, leaving no gap above it for the feed to show through.
      */}
      <div className="sticky -top-6 z-10 -mx-4 -mt-6 flex flex-wrap items-end justify-between gap-4 border-b border-border bg-canvas px-4 py-4 lg:-mx-8 lg:px-8">
        {you ? <YourMoney you={you} /> : <span />}

        <nav aria-label="Filter transactions" className="flex flex-wrap gap-5">
          {FILTERS.map((option) => (
            <Link
              key={option.value}
              href={href(option.value)}
              aria-current={filter === option.value ? "page" : undefined}
              className={cn(
                "press py-1 text-sm underline-offset-[6px] transition-colors",
                filter === option.value
                  ? "text-ink underline decoration-ink decoration-2"
                  : "text-ink-muted hover:text-ink",
              )}
            >
              {option.label}
            </Link>
          ))}
        </nav>
      </div>

      {/* The feed: opens on the newest entries at the bottom, like a chat. */}
      <div className="flex flex-1 flex-col justify-end pt-6">
        <ScrollToBottom />
        <ChannelIntro title="Every transaction">Every dollar in and out of the group.</ChannelIntro>

        {shown.length === 0 ? (
          <p className="mt-10 text-center text-sm text-ink-muted">
            {filter === "all" ? "Nothing yet. Dues paid in #about show up here." : "Nothing here yet."}
          </p>
        ) : (
          days.map((day) => {
            const entries = shown.filter((entry) => entry.day === day);
            return (
              <section key={day} aria-label={day}>
                <DateDivider label={day} />
                <DayAsRows entries={entries} />
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}

/**
 * The user's own money in this group, from Base. On a phone it shrinks to one
 * line so the pinned band stays short.
 */
function YourMoney({ you }: { you: YourMoneyData }) {
  const period = you.thisPeriod ?? "Not paid yet";
  const tone = you.thisPeriod ? "inflow" : "pending";
  return (
    <section aria-label="Your money">
      <p className="text-sm text-ink-muted sm:hidden">
        Paid in <span className="text-ink tabular-nums">{you.paidIn}</span> · This period:{" "}
        <span className={tone === "inflow" ? "text-inflow" : "text-pending"}>{period}</span>
      </p>
      <div className="hidden w-fit min-w-72 sm:block">
        <h3 className="text-sm text-ink-muted">Your money</h3>
        <dl className="mt-3 space-y-2 text-sm">
          <Pair label="You've paid in" value={you.paidIn} />
          <Pair label="This period" value={period} tone={tone} />
        </dl>
      </div>
    </section>
  );
}

function Pair({ label, value, tone }: { label: string; value: string; tone?: "inflow" | "pending" }) {
  return (
    <div className="flex items-baseline justify-between gap-6">
      <dt className="text-ink-muted">{label}</dt>
      <dd className={cn("tabular-nums", tone === "inflow" ? "text-inflow" : tone === "pending" ? "text-pending" : "text-ink")}>{value}</dd>
    </div>
  );
}

function Amount({ entry }: { entry: Entry }) {
  return (
    <span className={cn("shrink-0 tabular-nums", entry.inflow ? "text-inflow" : "text-ink-muted")}>
      {entry.inflow ? "+" : "−"}
      {entry.amount}
    </span>
  );
}

function BaseScanLink({ txHash }: { txHash: string }) {
  return (
    <a
      href={`${EXPLORER_URL}/tx/${txHash}`}
      target="_blank"
      rel="noreferrer"
      className="text-xs text-ink-faint underline decoration-ink-faint/50 underline-offset-4 transition-colors hover:text-ink hover:decoration-ink"
    >
      BaseScan
    </a>
  );
}

// ---------------------------------------------------------------------------
// Rows under one Rall header per day
// ---------------------------------------------------------------------------

function DayAsRows({ entries }: { entries: Entry[] }) {
  return (
    <article className="mt-4 flex gap-4 py-1">
      <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-full bg-accent text-base font-bold text-accent-ink">
        R
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2">
          <span className="text-base font-semibold text-ink">Rall</span>
          <span className="rounded-[4px] bg-raised px-1.5 py-px text-[0.6875rem] leading-4 font-semibold text-ink-muted">AGENT</span>
        </p>
        <ul className="mt-1 max-w-xl">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className={cn(
                "-mx-3 flex items-center gap-3 rounded-[var(--radius-control)] px-3 py-2 text-sm",
                entry.mine && "bg-raised",
              )}
            >
              <span className="w-10 shrink-0 text-xs text-ink-faint tabular-nums">{entry.time}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ink">{entry.what}</span>
                {entry.approved && <span className="block text-xs text-ink-faint">Approved: {entry.approved}</span>}
              </span>
              <Amount entry={entry} />
              <BaseScanLink txHash={entry.txHash} />
            </li>
          ))}
        </ul>
      </div>
    </article>
  );
}

