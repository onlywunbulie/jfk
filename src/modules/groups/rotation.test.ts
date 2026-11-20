import { describe, expect, it } from "vitest";
import { rotation, type RotationMember } from "@/modules/groups/rotation";

const joined = (day: number) => new Date(Date.UTC(2026, 10, day));
const members: RotationMember[] = [
  { userId: "c", displayName: "Chidi", rotationPosition: 3, joinedAt: joined(3) },
  { userId: "a", displayName: "Ada", rotationPosition: 1, joinedAt: joined(1) },
  { userId: "b", displayName: "Bisi", rotationPosition: 2, joinedAt: joined(2) },
];
const monthly = { cadence: "MONTHLY" as const, dueDay: 1 };

describe("rotation", () => {
  it("puts members in their payout order", () => {
    expect(rotation(members, monthly, null).map((t) => [t.round, t.name])).toEqual([
      [1, "Ada"],
      [2, "Bisi"],
      [3, "Chidi"],
    ]);
  });

  it("has no dates and no next turn before the group is on Base", () => {
    const turns = rotation(members, monthly, null);
    expect(turns.every((t) => t.date === null && !t.next)).toBe(true);
  });

  it("gives each turn the next due date, one period apart, from the start", () => {
    const turns = rotation(members, monthly, new Date(Date.UTC(2026, 10, 17)), new Date(Date.UTC(2026, 10, 20)));
    expect(turns.map((t) => t.date?.toISOString().slice(0, 10))).toEqual(["2026-12-01", "2027-01-01", "2027-02-01"]);
    expect(turns.map((t) => t.next)).toEqual([true, false, false]);
  });

  it("moves 'next' along once a turn's date has passed", () => {
    const turns = rotation(members, monthly, new Date(Date.UTC(2026, 10, 17)), new Date(Date.UTC(2026, 11, 15)));
    expect(turns.map((t) => t.next)).toEqual([false, true, false]);
  });

  it("works week by week too", () => {
    const turns = rotation(members, { cadence: "WEEKLY", dueDay: 5, intervalWeeks: 2 }, new Date(Date.UTC(2026, 10, 17)));
    const gaps = [1, 2].map((i) => (turns[i].date!.getTime() - turns[i - 1].date!.getTime()) / 86_400_000);
    expect(gaps).toEqual([14, 14]);
    expect(turns[0].date!.getUTCDay()).toBe(5); // a Friday
  });

  it("puts anyone without a position after those with one, by when they joined", () => {
    const late = { userId: "d", displayName: "Dayo", rotationPosition: null, joinedAt: joined(0) };
    expect(rotation([late, ...members], monthly, null).at(-1)!.name).toBe("Dayo");
  });
});
