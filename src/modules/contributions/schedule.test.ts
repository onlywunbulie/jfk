import { describe, expect, it } from "vitest";
import { cyclePeriodFor, nextPeriod, describePeriod } from "./schedule";

const monthly = { cadence: "MONTHLY" as const, dueDay: 1, graceDays: 3 };
const weekly = { cadence: "WEEKLY" as const, dueDay: 5, graceDays: 2 };

const iso = (date: Date) => date.toISOString().slice(0, 10);

describe("monthly cycles", () => {
  it("runs from the due day to the same day next month", () => {
    const period = cyclePeriodFor(new Date("2026-03-15T10:00:00Z"), monthly);
    expect(iso(period.periodStart)).toBe("2026-03-01");
    expect(iso(period.periodEnd)).toBe("2026-04-01");
    expect(iso(period.dueAt)).toBe("2026-03-01");
  });

  it("belongs to the previous month before the due day arrives", () => {
    const period = cyclePeriodFor(new Date("2026-03-15T10:00:00Z"), {
      ...monthly,
      dueDay: 20,
    });
    expect(iso(period.periodStart)).toBe("2026-02-20");
    expect(iso(period.periodEnd)).toBe("2026-03-20");
  });

  it("caps the due day at 28 so February is never skipped", () => {
    const period = cyclePeriodFor(new Date("2026-02-10T00:00:00Z"), {
      ...monthly,
      dueDay: 31,
    });
    expect(iso(period.periodStart)).toBe("2026-01-28");
    expect(iso(period.periodEnd)).toBe("2026-02-28");
  });

  it("crosses a year boundary cleanly", () => {
    const december = cyclePeriodFor(new Date("2026-12-15T00:00:00Z"), monthly);
    expect(iso(december.periodStart)).toBe("2026-12-01");
    expect(iso(december.periodEnd)).toBe("2027-01-01");
  });

  it("handles a leap February", () => {
    // 2028 is a leap year. On 1 March the current cycle began 28 February,
    // and must end 28 March — the extra day must not shift anything.
    const period = cyclePeriodFor(new Date("2028-03-01T00:00:00Z"), {
      ...monthly,
      dueDay: 28,
    });
    expect(iso(period.periodStart)).toBe("2028-02-28");
    expect(iso(period.periodEnd)).toBe("2028-03-28");
  });

  it("belongs to the previous cycle before the due day, even in February", () => {
    const period = cyclePeriodFor(new Date("2028-02-15T00:00:00Z"), {
      ...monthly,
      dueDay: 28,
    });
    expect(iso(period.periodStart)).toBe("2028-01-28");
    expect(iso(period.periodEnd)).toBe("2028-02-28");
  });

  it("adds the grace period to the due date", () => {
    const period = cyclePeriodFor(new Date("2026-03-01T00:00:00Z"), monthly);
    expect(iso(period.gracePeriodEndsAt)).toBe("2026-03-04");
  });

  it("is exact on the boundary instant", () => {
    const period = cyclePeriodFor(new Date("2026-03-01T00:00:00Z"), monthly);
    expect(iso(period.periodStart)).toBe("2026-03-01");
  });
});

describe("weekly cycles", () => {
  it("starts on the configured weekday", () => {
    // 2026-03-11 is a Wednesday; dueDay 5 is Friday, so the cycle began
    // the previous Friday, 2026-03-06.
    const period = cyclePeriodFor(new Date("2026-03-11T12:00:00Z"), weekly);
    expect(period.periodStart.getUTCDay()).toBe(5);
    expect(iso(period.periodStart)).toBe("2026-03-06");
    expect(iso(period.periodEnd)).toBe("2026-03-13");
  });

  it("treats 7 as Sunday", () => {
    const period = cyclePeriodFor(new Date("2026-03-11T12:00:00Z"), {
      ...weekly,
      dueDay: 7,
    });
    expect(period.periodStart.getUTCDay()).toBe(0);
  });

  it("treats 1 as Monday", () => {
    const period = cyclePeriodFor(new Date("2026-03-11T12:00:00Z"), {
      ...weekly,
      dueDay: 1,
    });
    expect(period.periodStart.getUTCDay()).toBe(1);
    expect(iso(period.periodStart)).toBe("2026-03-09");
  });

  it("spans exactly seven days", () => {
    const period = cyclePeriodFor(new Date("2026-03-11T12:00:00Z"), weekly);
    const days =
      (period.periodEnd.getTime() - period.periodStart.getTime()) /
      (24 * 60 * 60 * 1000);
    expect(days).toBe(7);
  });
});

describe("nextPeriod", () => {
  it("moves to the following month without gaps or overlaps", () => {
    const march = cyclePeriodFor(new Date("2026-03-15T00:00:00Z"), monthly);
    const april = nextPeriod(march, monthly);

    expect(iso(april.periodStart)).toBe("2026-04-01");
    expect(iso(april.periodEnd)).toBe("2026-05-01");
    // No gap: April starts exactly where March ended.
    expect(april.periodStart.getTime()).toBe(march.periodEnd.getTime());
  });

  it("chains twelve months without drifting", () => {
    let period = cyclePeriodFor(new Date("2026-01-15T00:00:00Z"), monthly);
    const starts: string[] = [iso(period.periodStart)];

    for (let i = 0; i < 12; i++) {
      period = nextPeriod(period, monthly);
      starts.push(iso(period.periodStart));
    }

    expect(starts).toEqual([
      "2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01",
      "2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01",
      "2026-09-01", "2026-10-01", "2026-11-01", "2026-12-01",
      "2027-01-01",
    ]);
  });

  it("chains weekly cycles without drifting", () => {
    let period = cyclePeriodFor(new Date("2026-03-06T00:00:00Z"), weekly);
    for (let i = 0; i < 10; i++) {
      const previous = period;
      period = nextPeriod(period, weekly);
      expect(period.periodStart.getTime()).toBe(previous.periodEnd.getTime());
      expect(period.periodStart.getUTCDay()).toBe(5);
    }
  });
});

describe("describePeriod", () => {
  it("names a monthly cycle by its month", () => {
    const period = cyclePeriodFor(new Date("2026-03-15T00:00:00Z"), monthly);
    expect(describePeriod(period, "MONTHLY")).toBe("March 2026");
  });

  it("names a weekly cycle by its start date", () => {
    const period = cyclePeriodFor(new Date("2026-03-11T00:00:00Z"), weekly);
    expect(describePeriod(period, "WEEKLY")).toMatch(/week of 6 Mar/);
  });
});
