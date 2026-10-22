import { DEFAULT_GOVERNANCE, type GovernedAction } from "@/lib/db/schema";
import { ALL_GOVERNED_ACTIONS, QUORUM_CHOICES, THRESHOLD_CHOICES } from "./governance-options";

/**
 * The conversation that creates a group.
 *
 * Scripted, not generated: every question, its order and what counts as a
 * valid answer is decided here, so the flow is instant, free, and asks the
 * same thing of everyone. Nothing typed into it leaves the app.
 *
 * The wording is deliberately plain. The people answering are friends pooling
 * money, not accountants: nothing here says "treasury", "threshold" or
 * "quorum", and any idea that needs explaining is explained in the same
 * breath as the question that uses it.
 *
 * Pure data and functions with no React in them, so the branching — weekly
 * versus monthly due days, suggested versus hand-picked rules — can be tested
 * without rendering anything.
 */

/** Answers so far, keyed by question id. A missing key means "not asked yet". */
export type Answers = Readonly<Record<string, string>>;

export interface Choice {
  value: string;
  label: string;
  hint?: string;
}

interface QuestionBase {
  id: string;
  /** What the agent says. */
  ask: string;
  /** A quieter second line: the explanation for anything that needs one. */
  detail?: string;
  /** Short facts shown with the question, e.g. the rules being suggested. */
  facts?: { label: string; value: string }[];
  /** How a given answer reads back in the thread. */
  display: (value: string) => string;
}

export interface TextQuestion extends QuestionBase {
  kind: "text";
  placeholder: string;
  inputMode?: "text" | "decimal" | "numeric";
  maxLength?: number;
  /** Present when the question may be skipped; the label for doing so. */
  skipLabel?: string;
  /** Tidy what was typed before it is validated and stored. */
  normalise: (raw: string) => string;
  /** An error message, or null when the answer is acceptable. */
  validate: (value: string) => string | null;
}

export interface ChoiceQuestion extends QuestionBase {
  kind: "choice";
  choices: Choice[];
}

export type Question = TextQuestion | ChoiceQuestion;

const WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

/** "How many must say yes", the way people actually say it. */
const SHARE_WORDS: Record<number, string> = {
  500: "Half of the group",
  600: "3 out of every 5",
  667: "2 out of every 3",
  750: "3 out of every 4",
  800: "4 out of every 5",
  1000: "Everyone",
};

const SMALL_AMOUNT = "A small amount is up to one fifth (20%) of the group's money.";
const ADMIN =
  "An admin is a member who helps run the group. Admins can't move money without a vote either.";

/** What each rule is called when it is listed. */
const RULE_LABELS: Record<GovernedAction, string> = {
  FUND_RELEASE_SMALL: "To spend a small amount",
  FUND_RELEASE_LARGE: "To spend a big amount",
  CHANGE_CONTRIBUTION: "To change how much people pay",
  CHANGE_GOVERNANCE: "To change these rules",
  REMOVE_MEMBER: "To remove a member",
  REMOVE_ADMIN: "To remove an admin",
  ROTATION_ORDER_CHANGE: "To change whose turn is next",
  DISSOLVE_GROUP: "To close the group",
};

const thresholdChoices: Choice[] = THRESHOLD_CHOICES.map((choice) => ({
  value: String(choice.permille),
  label: SHARE_WORDS[choice.permille] ?? choice.label,
}));

const thresholdId = (action: GovernedAction) => `threshold.${action}`;

/** "667" → "2 out of every 3" */
export function describeThreshold(permille: number | string): string {
  return SHARE_WORDS[Number(permille)] ?? `${Number(permille) / 10}%`;
}

/** "60" → "6 out of every 10 members" */
function describeTurnout(pct: string): string {
  if (pct === "100") return "Everyone";
  if (pct === "50") return "Half of the group";
  if (pct === "75") return "3 out of every 4";
  return `${Number(pct) / 10} out of every 10`;
}

/**
 * "50" → "$50", "1250.5" → "$1,250.50". Works on the digits as text, so a
 * contribution amount is never passed through a float on its way to the
 * screen.
 */
export function formatDollars(amount: string): string {
  const [whole, fraction] = amount.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `$${grouped}${fraction ? `.${fraction.padEnd(2, "0")}` : ""}`;
}

/** The rules a group of this kind has, in the order they are listed and asked. */
export function rulesFor(answers: Answers): { action: GovernedAction; label: string }[] {
  return ALL_GOVERNED_ACTIONS
    // Turns only exist in a group where people take turns.
    .filter(
      (action) => action !== "ROTATION_ORDER_CHANGE" || answers.type === "ROTATING",
    )
    .map((action) => ({ action, label: RULE_LABELS[action] }));
}

/** One question per rule, for someone who chose to set their own. */
function thresholdQuestions(answers: Answers): ChoiceQuestion[] {
  const prompts: Record<GovernedAction, { ask: string; detail?: string }> = {
    FUND_RELEASE_SMALL: {
      ask: "How many members must say yes to spend a small amount?",
      detail: SMALL_AMOUNT,
    },
    FUND_RELEASE_LARGE: {
      ask: "And to spend a big amount?",
      detail: "A big amount is anything more than one fifth (20%) of the group's money.",
    },
    CHANGE_CONTRIBUTION: {
      ask: "How many must say yes to change how much people pay, or how often?",
    },
    CHANGE_GOVERNANCE: {
      ask: "How many must say yes to change these rules later?",
      detail: "This protects the rules themselves, so nobody can make spending easier on their own.",
    },
    REMOVE_MEMBER: { ask: "How many must say yes to remove someone from the group?" },
    REMOVE_ADMIN: { ask: "How many must say yes to remove an admin?", detail: ADMIN },
    ROTATION_ORDER_CHANGE: {
      ask: "How many must say yes to change whose turn it is to collect?",
    },
    DISSOLVE_GROUP: {
      ask: "Last one. How many must say yes to close the group for good?",
      detail: "Closing the group ends it and the money goes back to the members.",
    },
  };

  return rulesFor(answers).map(({ action }) => ({
    id: thresholdId(action),
    kind: "choice" as const,
    ...prompts[action],
    choices: thresholdChoices,
    display: describeThreshold,
  }));
}

/**
 * Every question this conversation will ask, given what has been said so far.
 *
 * The list changes as answers arrive: a weekly group is asked for a weekday
 * rather than a date, and the one-per-rule questions only appear for someone
 * who chose to set their own.
 */
export function buildScript(answers: Answers): Question[] {
  const name = answers.name?.trim() || "the group";
  const monthly = answers.cadence !== "WEEKLY";

  const questions: Question[] = [
    {
      id: "name",
      kind: "text",
      ask: "Let's set up your group. What do you want to call it?",
      placeholder: "JFK Empire",
      maxLength: 60,
      normalise: (raw) => raw.trim(),
      validate: (value) =>
        value.length < 2 ? "Give the group a name of at least two letters." : null,
      display: (value) => value,
    },
    {
      id: "description",
      kind: "text",
      ask: `What is the money in ${name} for?`,
      detail: "A short line is enough. Everyone you invite will see it.",
      placeholder: "A plot of land by December",
      maxLength: 280,
      skipLabel: "Skip",
      normalise: (raw) => raw.trim(),
      validate: () => null,
      display: (value) => value || "Skipped",
    },
    {
      id: "type",
      kind: "choice",
      ask: "How should the money work?",
      choices: [
        {
          value: "TREASURY",
          label: "Save together",
          hint: "Everyone pays in and the money stays in the group. It only comes out when the group votes to spend it.",
        },
        {
          value: "ROTATING",
          label: "Take turns (Ajo)",
          hint: "Each round, one person collects everything that was paid in. It goes round until everyone has had a turn.",
        },
      ],
      display: (value) => (value === "ROTATING" ? "Take turns (Ajo)" : "Save together"),
    },
    {
      id: "amount",
      kind: "text",
      ask: "How much will each person pay in each time, in dollars?",
      detail:
        "The group saves in digital dollars (USDC), so savings keep their value. Everyone pays the same amount.",
      placeholder: "50",
      inputMode: "decimal",
      // People type "$50" or "1,000" as readily as "50".
      normalise: (raw) => raw.replace(/[$,\s]/g, ""),
      validate: (value) => {
        if (!/^\d+(\.\d{1,2})?$/.test(value)) return "Enter an amount like 50 or 12.50.";
        if (!/[1-9]/.test(value)) return "The amount must be more than zero.";
        return null;
      },
      display: formatDollars,
    },
    {
      id: "cadence",
      kind: "choice",
      ask: "How often will everyone pay?",
      choices: [
        { value: "MONTHLY", label: "Once a month" },
        { value: "WEEKLY", label: "Once a week" },
      ],
      display: (value) => (value === "WEEKLY" ? "Once a week" : "Once a month"),
    },
    monthly
      ? {
          id: "dueDay",
          kind: "text",
          ask: "What day of the month should everyone pay by?",
          detail: "Type a number from 1 to 28. It stops at 28 because February is short.",
          placeholder: "1",
          inputMode: "numeric",
          maxLength: 4,
          normalise: (raw) => raw.trim().replace(/(st|nd|rd|th)$/i, ""),
          validate: (value) =>
            /^\d{1,2}$/.test(value) && Number(value) >= 1 && Number(value) <= 28
              ? null
              : "Pick a day from 1 to 28.",
          display: (value) => `Day ${value} of every month`,
        }
      : {
          id: "dueDay",
          kind: "choice",
          ask: "What day of the week should everyone pay by?",
          choices: WEEKDAYS.map((day, index) => ({
            value: String(index + 1),
            label: day,
          })),
          display: (value) => `${WEEKDAYS[Number(value) - 1] ?? "Monday"}s`,
        },
    {
      id: "rules",
      kind: "choice",
      ask: "Now the voting. Nothing happens in the group unless enough members say yes. Here is how many I suggest for each thing:",
      detail: `${SMALL_AMOUNT} Anything more is a big amount. ${ADMIN} Choose carefully: once the group starts, changing a rule needs a vote too.`,
      facts: rulesFor(answers).map(({ action, label }) => ({
        label,
        value: describeThreshold(DEFAULT_GOVERNANCE[action]),
      })),
      choices: [
        { value: "recommended", label: "Use these" },
        { value: "custom", label: "Let me choose" },
      ],
      display: (value) => (value === "custom" ? "Let me choose" : "Use these"),
    },
    ...(answers.rules === "custom" ? thresholdQuestions(answers) : []),
    {
      id: "quorumPct",
      kind: "choice",
      ask: "How many members must take part in a vote for it to count?",
      detail:
        "This stops two or three people deciding while everyone else is away. Voting \"not sure\" still counts as taking part.",
      choices: QUORUM_CHOICES.map((choice) => ({
        value: String(choice.pct),
        label: describeTurnout(String(choice.pct)),
      })),
      display: describeTurnout,
    },
    {
      id: "membersCanPropose",
      kind: "choice",
      ask: "Who is allowed to suggest spending the money?",
      detail:
        "Suggesting is only asking. The group still votes on it, and everyone can always vote.",
      choices: [
        { value: "yes", label: "Any member" },
        { value: "no", label: "Admins only", hint: ADMIN },
      ],
      display: (value) => (value === "no" ? "Admins only" : "Any member"),
    },
  ];

  return questions;
}

/** How the turnout answer reads in the closing summary. */
export function summariseTurnout(answers: Answers): string {
  return describeTurnout(answers.quorumPct ?? "60");
}

/**
 * Record an answer, dropping anything it makes stale.
 *
 * Switching between weekly and monthly changes what a due day even means, so
 * the old one is forgotten and asked again. Going back to the suggested rules
 * discards any that were picked by hand.
 */
export function answer(answers: Answers, id: string, value: string): Answers {
  const next: Record<string, string> = { ...answers, [id]: value };

  if (id === "cadence" && answers.cadence !== undefined && answers.cadence !== value) {
    delete next.dueDay;
  }
  if (id === "rules" && value === "recommended") {
    for (const action of ALL_GOVERNED_ACTIONS) delete next[thresholdId(action)];
  }

  return next;
}

/** The share each rule will be created with: chosen, or the suggestion. */
export function resolveThresholds(answers: Answers): Record<GovernedAction, number> {
  const resolved = { ...DEFAULT_GOVERNANCE };
  if (answers.rules !== "custom") return resolved;

  for (const action of ALL_GOVERNED_ACTIONS) {
    const chosen = answers[thresholdId(action)];
    if (chosen !== undefined) resolved[action] = Number(chosen);
  }
  return resolved;
}

/**
 * The finished conversation as the fields `createGroupAction` expects — the
 * same post the old wizard made, so the server side is untouched.
 */
export function toFormFields(answers: Answers): [name: string, value: string][] {
  const fields: [string, string][] = [
    ["name", answers.name ?? ""],
    ["description", answers.description ?? ""],
    ["type", answers.type ?? "TREASURY"],
    ["amount", answers.amount ?? ""],
    ["cadence", answers.cadence ?? "MONTHLY"],
    ["dueDay", answers.dueDay ?? "1"],
    ["quorumPct", answers.quorumPct ?? "60"],
  ];

  // A checkbox in the original form: present when on, absent when off.
  if (answers.membersCanPropose !== "no") fields.push(["membersCanPropose", "on"]);

  const thresholds = resolveThresholds(answers);
  for (const action of ALL_GOVERNED_ACTIONS) {
    fields.push([thresholdId(action), String(thresholds[action])]);
  }

  return fields;
}
