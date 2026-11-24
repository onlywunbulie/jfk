import Link from "next/link";
import type { Route } from "next";
import { cn } from "@/lib/cn";
import { Money } from "@/lib/money";
import { shortAddress } from "@/lib/chain/addresses";
import { isWalletName } from "@/lib/names";
import { cyclePeriodFor, nextPeriod } from "@/modules/contributions/schedule";
import { rotation, type RotationMember } from "@/modules/groups/rotation";
import { readRotation, type ChainRotation, type RotationSeat } from "@/modules/groups/onchain-rotation";
import type { GroupDetail } from "@/modules/groups/service";
import { ChannelIntro, Detail, RallMessage } from "./parts";

/**
 * #payout order, for rotating savings groups: whose turn it is, and when.
 *
 * On contract v3 everything comes from Base: the order (which moves when
 * someone misses), who has collected, who has paid into this round, who owes
 * what, who leaves or joins when the cycle ends. Payouts are automatic:
 * Rallied's daily job triggers them on the due date.
 *
 * Before the group is on Base, or on the earlier contract (v2), it shows the
 * planned order from Rallied's records and says plainly that turns aren't
 * paid out automatically there.
 */

const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const LINK = "text-ink underline decoration-ink-faint underline-offset-4 hover:decoration-ink";

type Member = RotationMember & { walletAddress: string | null };

export async function PayoutOrder({ group, members, viewerId }: { group: GroupDetail; members: Member[]; viewerId: string }) {
  const chain = await readRotation(group.safeAddress, members);
  if (chain.ok) return <ChainOrder group={group} chain={chain} viewerId={viewerId} />;
  return <PlannedOrder group={group} members={members} viewerId={viewerId} reason={chain.reason} />;
}

// ---------------------------------------------------------------------------
// On Base (contract v3)
// ---------------------------------------------------------------------------

function ChainOrder({
  group,
  chain,
  viewerId,
}: {
  group: GroupDetail;
  chain: Extract<ChainRotation, { ok: true }>;
  viewerId: string;
}) {
  const usd = (minor: bigint) => Money.fromMinor(minor, "USDC").format();
  const seats = chain.order;
  const pot = usd(chain.contribution * BigInt(seats.length));
  const next = seats[chain.turn];
  const paid = seats.filter((seat) => seat.paidThisRound).length;
  const owing = [...seats, ...chain.joining].filter((seat) => seat.debt > 0n);
  const nameOf = (seat: RotationSeat) =>
    seat.userId === viewerId ? "You" : isWalletName(seat.name) || seat.name.startsWith("0x") ? shortAddress(seat.wallet) : seat.name;

  // The coming due dates, one per turn still to collect, from the group's schedule.
  const schedule = { cadence: group.cadence, dueDay: group.dueDay, graceDays: 0, intervalWeeks: group.intervalWeeks };
  const now = new Date();
  const dueNow = now >= chain.nextPayoutAt;
  const dates = new Map<number, Date>();
  let period = cyclePeriodFor(dueNow ? now : chain.nextPayoutAt, schedule);
  for (let i = chain.turn; i < seats.length; i++) {
    dates.set(i, period.periodEnd);
    period = nextPeriod(period, schedule);
  }

  return (
    <>
      <ChannelIntro title="Payout order">
        Whose turn it is to collect the pot, and when. Payouts happen automatically on the due date.
      </ChannelIntro>

      <RallMessage time="Today" footnote={null}>
        <Detail label="Each turn">
          <span className="font-semibold tabular-nums">{pot}</span>
          <span className="text-ink-muted">
            {" "}
            · everyone&rsquo;s {usd(chain.contribution)} from {seats.length} member{seats.length === 1 ? "" : "s"}
          </span>
        </Detail>
        {next && (
          <Detail label="Next turn">
            {nameOf(next)}, {dueNow ? "due now" : `on ${DAY.format(dates.get(chain.turn)!)}`}
          </Detail>
        )}
        <Detail label="This round">
          {paid} of {seats.length} paid in · {usd(chain.roundPot)} so far
          {dueNow && paid < seats.length && (
            <span className="text-ink-muted"> · waiting a few days for late payers, then it pays out what&rsquo;s in</span>
          )}
        </Detail>
        {owing.length > 0 && (
          <Detail label="Owing">
            <span className="text-danger">{owing.map((seat) => `${nameOf(seat)} ${usd(seat.debt)}`).join(" · ")}</span>
          </Detail>
        )}
        {chain.lastPayout && (
          <Detail label="Last payout">
            <span className="tabular-nums">{usd(chain.lastPayout.paid)}</span> to{" "}
            {chain.lastPayout.userId === viewerId
              ? "you"
              : isWalletName(chain.lastPayout.name) || chain.lastPayout.name.startsWith("0x")
                ? shortAddress(chain.lastPayout.wallet)
                : chain.lastPayout.name}
            <span className="text-ink-muted">
              {" "}
              · round {chain.lastPayout.round}, {DAY.format(chain.lastPayout.at)}
            </span>
          </Detail>
        )}
        <Detail label="Cycle">{chain.cycle}</Detail>
      </RallMessage>

      <ol className="mt-8 max-w-xl" aria-label="The rotation">
        {seats.map((seat, i) => {
          const isNext = i === chain.turn;
          const date = dates.get(i);
          return (
            <li
              key={seat.wallet}
              aria-current={isNext ? "step" : undefined}
              className={cn("-mx-3 flex items-center gap-4 rounded-[var(--radius-control)] px-3 py-3 text-sm", isNext && "bg-raised")}
            >
              <span
                className={cn(
                  "grid size-8 shrink-0 place-items-center rounded-full text-xs font-semibold tabular-nums",
                  seat.collected ? "bg-inflow-soft text-inflow" : isNext ? "bg-accent text-accent-ink" : "border border-border text-ink-muted",
                )}
              >
                {seat.collected ? (
                  <svg viewBox="0 0 16 16" aria-hidden="true" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <path d="m3.5 8.5 3 3 6-7" />
                  </svg>
                ) : (
                  i + 1
                )}
                {seat.collected && <span className="sr-only">Turn {i + 1}, collected</span>}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-ink">{nameOf(seat)}</span>
                  {isNext && <span className="text-xs text-accent">next</span>}
                </span>
                <span className="block text-xs text-ink-faint">
                  {seat.collected ? "Collected this cycle" : date ? DAY.format(date) : ""}
                  {seat.leaving ? " · leaves when this cycle ends" : ""}
                </span>
              </span>
              <span className="shrink-0 text-xs tabular-nums">
                {seat.debt > 0n ? (
                  <span className="text-danger">Owes {usd(seat.debt)}</span>
                ) : (
                  <span className={seat.paidThisRound ? "text-inflow" : "text-ink-faint"}>
                    {seat.paidThisRound ? "Paid this round" : "Not paid yet"}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ol>

      {chain.joining.length > 0 && (
        <p className="mt-6 max-w-xl text-sm text-ink-muted">Joining next cycle, at the back: {chain.joining.map(nameOf).join(", ")}.</p>
      )}
      <p className="mt-6 max-w-xl text-xs leading-relaxed text-ink-faint">
        Miss a round and you owe it: your next payment goes straight to whoever was short, and if you haven&rsquo;t collected yet
        you move to the back. After your turn, automatic dues stay on until the cycle ends.
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
// Before Base, or on the earlier contract (v2)
// ---------------------------------------------------------------------------

function PlannedOrder({
  group,
  members,
  viewerId,
  reason,
}: {
  group: GroupDetail;
  members: Member[];
  viewerId: string;
  reason: "not_on_base" | "not_rotating" | "unreachable";
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
          {reason === "not_on_base" ? (
            <>
              Automatic, once the group is on Base: each turn is paid on its due date. Start it in{" "}
              <Link href={`${base}/about` as Route} className={LINK}>
                #about
              </Link>
              .
            </>
          ) : reason === "unreachable" ? (
            <>Couldn&rsquo;t reach Base just now, so this is the planned order. The money is safe on Base.</>
          ) : (
            <>
              This group runs on Rallied&rsquo;s earlier contract, which doesn&rsquo;t pay out by turn: a turn&rsquo;s pot is paid by
              a spend the group votes on, from{" "}
              <Link href={`${base}/propose` as Route} className={LINK}>
                #propose
              </Link>
              . Groups started on Base from now on pay out automatically.
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
              className={cn("-mx-3 flex items-center gap-4 rounded-[var(--radius-control)] px-3 py-3 text-sm", turn.next && "bg-raised")}
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
