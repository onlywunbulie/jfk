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

describe("every 2 or 3 weeks", () => {
  const fortnightly = { ...weekly, intervalWeeks: 2 };

  it("runs two weeks from the due weekday, and the next one follows on", () => {
    const period = cyclePeriodFor(new Date("2026-03-11T12:00:00Z"), fortnightly);
    expect(period.periodStart.getUTCDay()).toBe(5);
    expect(period.periodEnd.getTime() - period.periodStart.getTime()).toBe(14 * 86_400_000);
    const next = nextPeriod(period, fortnightly);
    expect(iso(next.periodStart)).toBe(iso(period.periodEnd));
  });

  it("every day of a cycle belongs to that same cycle (the weeks don't drift)", () => {
    const period = cyclePeriodFor(new Date("2026-03-11T12:00:00Z"), fortnightly);
    for (let day = 0; day < 14; day++) {
      const inside = new Date(period.periodStart.getTime() + day * 86_400_000 + 3_600_000);
      expect(iso(cyclePeriodFor(inside, fortnightly).periodStart)).toBe(iso(period.periodStart));
    }
  });

  it("every 3 weeks is 21 days, and two groups due on the same weekday agree on dates", () => {
    const three = { ...weekly, intervalWeeks: 3 };
    const a = cyclePeriodFor(new Date("2026-11-17T09:00:00Z"), three);
    const b = cyclePeriodFor(new Date("2026-11-17T21:00:00Z"), three);
    expect(iso(a.periodStart)).toBe(iso(b.periodStart));
    expect(a.periodEnd.getTime() - a.periodStart.getTime()).toBe(21 * 86_400_000);
  });

  it("an interval of 1 is exactly the old weekly cycle", () => {
    const at = new Date("2026-03-11T12:00:00Z");
    expect(cyclePeriodFor(at, { ...weekly, intervalWeeks: 1 })).toEqual(cyclePeriodFor(at, weekly));
  });
});
