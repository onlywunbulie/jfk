import { cyclePeriodFor, nextPeriod, type ScheduleConfig } from "@/modules/contributions/schedule";

/**
 * A rotating group's turns, from real data only: the members in their payout
 * order (the order they joined, unless a vote changes it), and the due date
 * each turn falls on, counted from the first due date after the group
 * started on Base. Before it's on Base there are no dates yet.
 *
 * Nothing here says a turn was paid: Rallied's contract doesn't pay out by
 * turn yet, so the honest thing is the order, the dates and whose is next.
 */

export interface RotationMember {
  userId: string;
  displayName: string;
  rotationPosition: number | null;
  joinedAt: Date;
}

export interface Turn {
  round: number;
  userId: string;
  name: string;
  /** Null until the group is on Base and its schedule has started. */
  date: Date | null;
  /** The first turn whose date hasn't passed. */
  next: boolean;
}

export function rotation(
  members: RotationMember[],
  schedule: Omit<ScheduleConfig, "graceDays">,
  startedAt: Date | null,
  now: Date = new Date(),
): Turn[] {
  const ordered = [...members].sort(
    (a, b) =>
      (a.rotationPosition ?? Number.MAX_SAFE_INTEGER) - (b.rotationPosition ?? Number.MAX_SAFE_INTEGER) ||
      a.joinedAt.getTime() - b.joinedAt.getTime(),
  );

  const config: ScheduleConfig = { ...schedule, graceDays: 0 };
  let period = startedAt ? cyclePeriodFor(startedAt, config) : null;
  let nextFound = false;

  return ordered.map((member, index) => {
    const date = period ? period.periodEnd : null;
    if (period) period = nextPeriod(period, config);
    const next = date !== null && !nextFound && date.getTime() >= now.getTime();
    if (next) nextFound = true;
    return { round: index + 1, userId: member.userId, name: member.displayName, date, next };
  });
}
