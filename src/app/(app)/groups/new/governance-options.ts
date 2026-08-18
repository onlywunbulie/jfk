import type { GovernedAction } from "@/lib/db/schema";

/**
 * The threshold choices offered when creating a group.
 *
 * A select rather than a free number field: percentages invite nonsense (0%,
 * 3%, 101%), and the difference between 66% and 67% is meaningless to a group
 * of friends. These are the shares people actually reason about — a simple
 * majority, two thirds, three quarters, and everyone.
 */
export const THRESHOLD_CHOICES = [
  { permille: 500, label: "Half", hint: "50%" },
  { permille: 600, label: "Three fifths", hint: "60%" },
  { permille: 667, label: "Two thirds", hint: "66.7%" },
  { permille: 750, label: "Three quarters", hint: "75%" },
  { permille: 800, label: "Four fifths", hint: "80%" },
  { permille: 1000, label: "Everyone", hint: "100%" },
] as const;

/**
 * The governed actions, grouped so the step reads as four decisions rather
 * than nine sliders. Order matters: money first, because that is what people
 * came to decide.
 */
export const GOVERNANCE_GROUPS: {
  title: string;
  blurb: string;
  actions: { action: GovernedAction; label: string; hint: string }[];
}[] = [
  {
    title: "Spending",
    blurb: "How much of the group has to agree before money leaves.",
    actions: [
      {
        action: "FUND_RELEASE_SMALL",
        label: "Routine spend",
        hint: "Up to a fifth of the treasury",
      },
      {
        action: "FUND_RELEASE_LARGE",
        label: "Large withdrawal",
        hint: "More than a fifth of the treasury",
      },
    ],
  },
  {
    title: "Changing the rules",
    blurb: "Nobody can change these alone, including whoever creates the group.",
    actions: [
      {
        action: "CHANGE_CONTRIBUTION",
        label: "Change the contribution",
        hint: "Amount or how often",
      },
      {
        action: "CHANGE_GOVERNANCE",
        label: "Change these thresholds",
        hint: "The bar for changing the bar",
      },
      { action: "CHANGE_LOCK_RULE", label: "Change a lock", hint: "Free up held money" },
    ],
  },
  {
    title: "People",
    blurb: "Removing someone is a group decision once there are three of you.",
    actions: [
      { action: "REMOVE_MEMBER", label: "Remove a member", hint: "" },
      { action: "REMOVE_ADMIN", label: "Remove an admin", hint: "" },
    ],
  },
  {
    title: "The big ones",
    blurb: "Rare, and hard to undo.",
    actions: [
      {
        action: "ROTATION_ORDER_CHANGE",
        label: "Change payout order",
        hint: "Rotating groups only",
      },
      {
        action: "DISSOLVE_GROUP",
        label: "Dissolve the group",
        hint: "Ends it and returns the money",
      },
    ],
  },
];

export const QUORUM_CHOICES = [
  { pct: 40, label: "40%" },
  { pct: 50, label: "50%" },
  { pct: 60, label: "60%" },
  { pct: 75, label: "75%" },
  { pct: 100, label: "Everyone" },
] as const;

/** Every action in one flat list, for validating what the form submits. */
export const ALL_GOVERNED_ACTIONS: GovernedAction[] = GOVERNANCE_GROUPS.flatMap(
  (group) => group.actions.map((a) => a.action),
);
