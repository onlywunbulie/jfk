/**
 * How often a group pays, in words. One place, so every screen and Claude
 * say it the same way. Safe on client and server.
 */

type Cadence = "WEEKLY" | "MONTHLY";

/** "month", "week", "2 weeks", "3 weeks": reads after "every". */
export function everyText(cadence: Cadence, intervalWeeks = 1): string {
  if (cadence === "MONTHLY") return "month";
  return intervalWeeks > 1 ? `${intervalWeeks} weeks` : "week";
}

/** "Once a month", "Once a week", "Every 2 weeks". */
export function howOftenTitle(cadence: Cadence, intervalWeeks = 1): string {
  if (cadence === "MONTHLY") return "Once a month";
  return intervalWeeks > 1 ? `Every ${intervalWeeks} weeks` : "Once a week";
}

/** The choices offered when making a group. Every 2 or 3 months waits for contract v3. */
export const HOW_OFTEN = [
  { key: "weekly", label: "Every week", cadence: "WEEKLY", intervalWeeks: 1 },
  { key: "every_2_weeks", label: "Every 2 weeks", cadence: "WEEKLY", intervalWeeks: 2 },
  { key: "every_3_weeks", label: "Every 3 weeks", cadence: "WEEKLY", intervalWeeks: 3 },
  { key: "monthly", label: "Every month", cadence: "MONTHLY", intervalWeeks: 1 },
] as const;

export type HowOftenKey = (typeof HOW_OFTEN)[number]["key"];
