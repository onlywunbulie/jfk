import Link from "next/link";
import type { Route } from "next";
import { cn } from "@/lib/cn";
import { rotation, type RotationMember } from "@/modules/groups/rotation";
import type { GroupDetail } from "@/modules/groups/service";
import { ChannelIntro, Detail, RallMessage } from "./parts";

/**
 * #payout order, for rotating savings groups: whose turn comes when, from
 * real data. The order is the order people joined; each turn falls on a due
 * date, counted from when the group started on Base.
 *
 * Rallied's contract doesn't pay out by turn yet, so nothing here is marked
 * paid. Until it does, a turn's pot leaves the vault the way any money does:
 * a spend proposal to that member, voted on. This screen says so plainly.
 */

const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

export function PayoutOrder({
  group,
  members,
  viewerId,
}: {
  group: GroupDetail;
  members: RotationMember[];
  viewerId: string;
}) {
  const base = `/groups/${group.id}`;
  const turns = rotation(
    members,
    { cadence: group.cadence, dueDay: group.dueDay, intervalWeeks: group.intervalWeeks },
    group.startedOnChainAt,
  );
  // Everyone's dues, once each, make one turn's pot.
  const pot = group.contributionAmount.times(turns.length);
  const next = turns.find((turn) => turn.next);
  const mine = turns.find((turn) => turn.userId === viewerId);
  const link = "text-ink underline decoration-ink-faint underline-offset-4 hover:decoration-ink";

  return (
    <>
      <ChannelIntro title="Payout order">Whose turn it is to collect the pot, and when.</ChannelIntro>

      <RallMessage time="Today" footnote={null}>
        <Detail label="Each turn">
          <span className="font-semibold tabular-nums">{pot.format()}</span>
          <span className="text-ink-muted">
            {" "}
            · everyone&rsquo;s {group.contributionAmount.format()} from {turns.length} member{turns.length === 1 ? "" : "s"}
          </span>
        </Detail>
        {next && (
          <Detail label="Next turn">
            {next.userId === viewerId ? "You" : next.name}, on {DAY.format(next.date!)}
          </Detail>
        )}
        {mine && mine !== next && (
          <Detail label="Your turn">
            Turn {mine.round}
            {mine.date ? `, on ${DAY.format(mine.date)}` : ""}
          </Detail>
        )}
        <Detail label="Order">The order people joined</Detail>
        <Detail label="Paying out">
          {group.startedOnChainAt ? (
            <>
              Not automatic yet: it comes with Rallied&rsquo;s next contract. Until then, a turn&rsquo;s pot is paid by a spend the
              group votes on, from{" "}
              <Link href={`${base}/propose` as Route} className={link}>
                #propose
              </Link>
              .
            </>
          ) : (
            <>
              Turns get their dates once the group is on Base. Start it in{" "}
              <Link href={`${base}/about` as Route} className={link}>
                #about
              </Link>
              .
            </>
          )}
        </Detail>
      </RallMessage>

      <ol className="mt-8 max-w-xl" aria-label="The rotation">
        {turns.map((turn) => {
          const you = turn.userId === viewerId;
          return (
            <li
              key={turn.userId}
              aria-current={turn.next ? "step" : undefined}
              className={cn(
                "-mx-3 flex items-center gap-4 rounded-[var(--radius-control)] px-3 py-3 text-sm",
                turn.next && "bg-raised",
              )}
            >
              <span
                className={cn(
                  "grid size-8 shrink-0 place-items-center rounded-full text-xs font-semibold tabular-nums",
                  turn.next ? "bg-accent text-accent-ink" : "border border-border text-ink-muted",
                )}
              >
                {turn.round}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-ink">{you ? "You" : turn.name}</span>
                  {turn.next && <span className="text-xs text-accent">next</span>}
                </span>
                <span className="block text-xs text-ink-faint">
                  Turn {turn.round}
                  {turn.date ? ` · ${DAY.format(turn.date)}` : ""}
                </span>
              </span>
              <span className="shrink-0 text-xs text-ink-faint tabular-nums">{pot.format()}</span>
            </li>
          );
        })}
      </ol>
    </>
  );
}
