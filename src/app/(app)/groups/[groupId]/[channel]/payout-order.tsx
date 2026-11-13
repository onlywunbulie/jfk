import Link from "next/link";
import type { Route } from "next";
import { cn } from "@/lib/cn";
import { ChannelIntro, Detail, RallMessage } from "./parts";

/**
 * #payout order, for rotating savings groups: the rotation round by round
 * (paid out ✓, now, upcoming), whose turn is next, anyone who owes after
 * their turn, and a pointer to swap requests, which are voted on in #votes.
 *
 * The order is Random (drawn by Rallied) or Custom (arranged by whoever
 * started the group); changing it or swapping turns needs a group vote. A
 * member who owes after their turn can't join the next cycle until settled.
 *
 * UI only: the rotation is a sample.
 */

interface Turn {
  round: number;
  name: string;
  date: string;
  status: "paid" | "now" | "upcoming";
  you?: boolean;
  /** Rounds still owed after their own payout. */
  owes?: number;
}

const ORDER = { method: "Random, drawn by Rallied" as const, amount: "USDC 800" };

const TURNS: Turn[] = [
  { round: 1, name: "Ade", date: "1 September", status: "paid" },
  { round: 2, name: "Femi", date: "1 October", status: "paid", owes: 1 },
  { round: 3, name: "Amaka", date: "1 November", status: "paid" },
  { round: 4, name: "Tunde", date: "1 December", status: "now" },
  { round: 5, name: "Kemi", date: "1 January", status: "upcoming" },
  { round: 6, name: "You", date: "1 February", status: "upcoming", you: true },
  { round: 7, name: "Chidi", date: "1 March", status: "upcoming" },
  { round: 8, name: "Bisi", date: "1 April", status: "upcoming" },
];

export function PayoutOrder({ base }: { base: string }) {
  const now = TURNS.find((turn) => turn.status === "now");
  const mine = TURNS.find((turn) => turn.you);
  const owing = TURNS.filter((turn) => turn.owes);

  return (
    <>
      <ChannelIntro title="Payout order">Who gets paid each round. Changing the order or swapping turns needs a vote.</ChannelIntro>

      <RallMessage time="Today" footnote={null}>
        {now && (
          <Detail label="This round">
            Round {now.round} of {TURNS.length} · <span className="font-semibold">{ORDER.amount}</span> to {now.name} on {now.date}
          </Detail>
        )}
        {mine && (
          <Detail label="Your turn">
            Round {mine.round}, {mine.date}
          </Detail>
        )}
        <Detail label="Order">{ORDER.method}</Detail>
        {owing.length > 0 && (
          <Detail label="Owing">
            <span className="text-danger">
              {owing.map((turn) => `${turn.name}, ${turn.owes} round${turn.owes === 1 ? "" : "s"}`).join(" · ")}
            </span>
          </Detail>
        )}
      </RallMessage>

      <ol className="mt-8 max-w-xl" aria-label="The rotation">
        {TURNS.map((turn) => (
          <li
            key={turn.round}
            className={cn(
              "-mx-3 flex items-center gap-4 rounded-[var(--radius-control)] px-3 py-3 text-sm",
              turn.status === "now" && "bg-raised",
            )}
            aria-current={turn.status === "now" ? "step" : undefined}
          >
            <span
              className={cn(
                "grid size-8 shrink-0 place-items-center rounded-full text-xs font-semibold tabular-nums",
                turn.status === "paid" && "bg-inflow-soft text-inflow",
                turn.status === "now" && "bg-accent text-accent-ink",
                turn.status === "upcoming" && "border border-border text-ink-muted",
              )}
            >
              {turn.status === "paid" ? (
                <svg viewBox="0 0 16 16" aria-hidden="true" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="m3.5 8.5 3 3 6-7" />
                </svg>
              ) : (
                turn.round
              )}
              {turn.status === "paid" && <span className="sr-only">Round {turn.round}, paid out</span>}
            </span>

            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className={cn("truncate", turn.status === "upcoming" ? "text-ink-muted" : "text-ink")}>{turn.name}</span>
                {turn.status === "now" && <span className="text-xs text-accent">this round</span>}
              </span>
              <span className="block text-xs text-ink-faint">
                Round {turn.round} · {turn.date}
              </span>
            </span>

            {turn.owes ? (
              <span className="shrink-0 rounded-full bg-danger-soft px-2 py-0.5 text-xs text-danger">
                Owes {turn.owes} round{turn.owes === 1 ? "" : "s"}
              </span>
            ) : (
              <span className={cn("shrink-0 text-xs tabular-nums", turn.status === "paid" ? "text-inflow" : "text-ink-faint")}>
                {turn.status === "paid" ? `Paid ${ORDER.amount}` : ORDER.amount}
              </span>
            )}
          </li>
        ))}
      </ol>

      <p className="mt-6 max-w-xl text-sm text-ink-muted">
        Anyone who still owes after their turn can&rsquo;t join the next cycle until it&rsquo;s settled. A friend can cover for them.
        1 swap request is being voted on in{" "}
        <Link href={`${base}/votes` as Route} className="text-ink underline decoration-ink-faint underline-offset-4 hover:decoration-ink">
          #votes
        </Link>
        .
      </p>
    </>
  );
}
