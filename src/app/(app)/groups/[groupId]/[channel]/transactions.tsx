import Link from "next/link";
import type { Route } from "next";
import { cn } from "@/lib/cn";
import { EXPLORER_URL } from "@/lib/chain/addresses";
import { ChannelIntro, DateDivider } from "./parts";
import { ScrollToBottom } from "./scroll-to-bottom";

/**
 * #transactions: the user's own money at the top, filters, then every
 * movement as short rows under Rall's name, one header per day, newest at
 * the bottom. UI only: the entries are samples until Rallied reads them from
 * Base.
 */

export type Filter = "all" | "mine" | "in" | "out";

interface Entry {
  id: string;
  day: string;
  time: string;
  what: string;
  amount: string;
  inflow: boolean;
  mine: boolean;
  /** Money out only: the vote that approved it. */
  approved?: string;
}

const ENTRIES: Entry[] = [
  { id: "1", day: "9 November 2026", time: "09:12", what: "Bisi paid in", amount: "USDC 100", inflow: true, mine: false },
  { id: "2", day: "10 November 2026", time: "18:40", what: "Chidi paid in", amount: "USDC 100", inflow: true, mine: false },
  { id: "3", day: "10 November 2026", time: "20:05", what: "You paid in", amount: "USDC 100", inflow: true, mine: true },
  { id: "4", day: "12 November 2026", time: "08:02", what: "Generator repair, paid to Kemi", amount: "USDC 400", inflow: false, mine: false, approved: "6 of 8 voted yes" },
  { id: "5", day: "Today", time: "09:14", what: "Amaka paid in", amount: "USDC 100", inflow: true, mine: false },
  { id: "6", day: "Today", time: "10:40", what: "Tunde paid in", amount: "USDC 100", inflow: true, mine: false },
];

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "mine", label: "Mine" },
  { value: "in", label: "In" },
  { value: "out", label: "Out" },
];

export function Transactions({ base, filter, rotating }: { base: string; filter: Filter; rotating: boolean }) {
  const href = (next: Filter) =>
    (next === "all" ? `${base}/transactions` : `${base}/transactions?filter=${next}`) as Route;

  const shown = ENTRIES.filter(
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
        <YourMoney rotating={rotating} />

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
          <p className="mt-10 text-center text-sm text-ink-muted">Nothing here yet.</p>
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
 * The user's own money in this group. "Your share" only means something in a
 * rotating group. On a phone it shrinks to one line so the pinned band stays
 * short.
 */
function YourMoney({ rotating }: { rotating: boolean }) {
  return (
    <section aria-label="Your money">
      <p className="text-sm text-ink-muted sm:hidden">
        Paid in <span className="text-ink tabular-nums">USDC 600</span> · This round:{" "}
        <span className="text-inflow">Paid</span>
        {rotating && (
          <>
            {" "}
            · Share <span className="text-ink tabular-nums">USDC 800, 1 Mar</span>
          </>
        )}
      </p>
      <div className="hidden w-fit min-w-72 sm:block">
        <h3 className="text-sm text-ink-muted">Your money</h3>
        <dl className="mt-3 space-y-2 text-sm">
        <Pair label="You've paid in" value="USDC 600" />
        <Pair label="This round" value="Paid" tone="inflow" />
          {rotating && <Pair label="Your share" value="USDC 800 on 1 March" />}
        </dl>
      </div>
    </section>
  );
}

function Pair({ label, value, tone }: { label: string; value: string; tone?: "inflow" }) {
  return (
    <div className="flex items-baseline justify-between gap-6">
      <dt className="text-ink-muted">{label}</dt>
      <dd className={cn("tabular-nums", tone === "inflow" ? "text-inflow" : "text-ink")}>{value}</dd>
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

function BaseScanLink() {
  return (
    <a
      href={EXPLORER_URL}
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
              <BaseScanLink />
            </li>
          ))}
        </ul>
      </div>
    </article>
  );
}

