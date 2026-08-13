import type { Cadence } from "@/lib/db/schema";

/**
 * Cycle date maths.
 *
 * Pure functions with no database access, so the awkward calendar cases are
 * cheap to test exhaustively — and they are the cases that quietly overcharge
 * or skip a month if they are wrong.
 *
 * Everything is computed in UTC. West Africa Time is UTC+1 with no daylight
 * saving, so a due date "on the 1st" is set at 00:00 UTC, which is 01:00 in
 * Lagos — early enough on the correct day for everybody.
 */

export interface CyclePeriod {
  periodStart: Date;
  periodEnd: Date;
  dueAt: Date;
  gracePeriodEndsAt: Date;
}

export interface ScheduleConfig {
  cadence: Cadence;
  /** 1–28 for monthly, 1–7 (Mon–Sun) for weekly. */
  dueDay: number;
  graceDays: number;
}

/**
 * The period containing or following `from`.
 *
 * Monthly cycles run from the due day of one month to the due day of the next,
 * so a group whose contribution falls on the 15th has cycles that run 15th to
 * 15th rather than being forced onto calendar months.
 */
export function cyclePeriodFor(from: Date, config: ScheduleConfig): CyclePeriod {
  return config.cadence === "MONTHLY"
    ? monthlyPeriod(from, config)
    : weeklyPeriod(from, config);
}

/** The period immediately after the given one. */
export function nextPeriod(
  previous: CyclePeriod,
  config: ScheduleConfig,
): CyclePeriod {
  // Step one millisecond past the end so we land in the next period, never
  // back on the boundary of the one we just finished.
  return cyclePeriodFor(new Date(previous.periodEnd.getTime() + 1), config);
}

function monthlyPeriod(from: Date, config: ScheduleConfig): CyclePeriod {
  // Capped at 28 so every month has the day — a group due on the 31st would
  // otherwise silently skip February.
  const day = clamp(config.dueDay, 1, 28);

  const year = from.getUTCFullYear();
  const month = from.getUTCMonth();

  let start = new Date(Date.UTC(year, month, day));
  // If the due day has already passed this month, this cycle began last month.
  if (from.getTime() < start.getTime()) {
    start = new Date(Date.UTC(year, month - 1, day));
  }

  const end = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, day),
  );

  return withGrace(start, end, config.graceDays);
}

function weeklyPeriod(from: Date, config: ScheduleConfig): CyclePeriod {
  // JS getUTCDay is 0=Sunday; the app uses 1=Monday…7=Sunday.
  const targetDow = clamp(config.dueDay, 1, 7) % 7;

  const start = startOfUtcDay(from);
  const delta = (start.getUTCDay() - targetDow + 7) % 7;
  start.setUTCDate(start.getUTCDate() - delta);

  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);

  return withGrace(start, end, config.graceDays);
}

function withGrace(start: Date, end: Date, graceDays: number): CyclePeriod {
  const grace = new Date(start);
  grace.setUTCDate(grace.getUTCDate() + Math.max(0, graceDays));

  return {
    periodStart: start,
    periodEnd: end,
    // The contribution is due at the start of the period, not the end: the
    // group collects up front and the money then sits for the period.
    dueAt: start,
    gracePeriodEndsAt: grace,
  };
}

function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/** Human label for a cycle, e.g. "March 2026" or "week of 3 Mar". */
export function describePeriod(period: CyclePeriod, cadence: Cadence): string {
  if (cadence === "MONTHLY") {
    return period.periodStart.toLocaleDateString("en-NG", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
  }
  return `week of ${period.periodStart.toLocaleDateString("en-NG", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  })}`;
}
