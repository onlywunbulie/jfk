import type { Cadence, GovernedAction } from "@/lib/db/schema";

/**
 * What a proposal can ask the group to do.
 *
 * Until now every proposal was a spend, so the app could tell you an action
 * "needs a vote" and then give you no way to hold one. A kind carries both the
 * governed action (which decides the threshold) and a typed payload (which
 * says what to actually change when it passes).
 *
 * Money is deliberately different from everything else: a passed spend
 * *reserves* funds and waits for a human to send them, because moving money is
 * irreversible. A passed rule change applies immediately — the group voted, and
 * writing a number to a settings row needs no second pair of hands.
 */

export type ProposalKind =
  | "SPEND"
  | "CHANGE_CONTRIBUTION"
  | "CHANGE_THRESHOLD"
  | "REMOVE_MEMBER"
  | "REMOVE_ADMIN";

export type ProposalPayload =
  | { kind: "SPEND" }
  | {
      kind: "CHANGE_CONTRIBUTION";
      /** Kobo, as a string — BigInt is not JSON-serialisable. */
      amountMinor: string;
      cadence: Cadence;
      dueDay: number;
    }
  | {
      kind: "CHANGE_THRESHOLD";
      action: GovernedAction;
      thresholdPermille: number;
    }
  | { kind: "REMOVE_MEMBER"; userId: string; displayName: string }
  | { kind: "REMOVE_ADMIN"; userId: string; displayName: string };

/**
 * Which governed action each kind is judged against — and therefore which
 * threshold applies. Spends are the exception: their action depends on how
 * much of the treasury they would take, so it is derived from the amount.
 */
export const KIND_ACTION: Record<
  Exclude<ProposalKind, "SPEND">,
  GovernedAction
> = {
  CHANGE_CONTRIBUTION: "CHANGE_CONTRIBUTION",
  CHANGE_THRESHOLD: "CHANGE_GOVERNANCE",
  REMOVE_MEMBER: "REMOVE_MEMBER",
  REMOVE_ADMIN: "REMOVE_ADMIN",
};

/** True when passing this proposal changes the group rather than moving money. */
export function isRuleChange(kind: ProposalKind): boolean {
  return kind !== "SPEND";
}

export const KIND_LABELS: Record<
  ProposalKind,
  { title: string; blurb: string }
> = {
  SPEND: {
    title: "Spend money",
    blurb: "Send some of the group's money somewhere.",
  },
  CHANGE_CONTRIBUTION: {
    title: "Change the contribution",
    blurb: "How much everyone puts in, and how often.",
  },
  CHANGE_THRESHOLD: {
    title: "Change a threshold",
    blurb: "How much of the group has to agree before something can happen.",
  },
  REMOVE_MEMBER: {
    title: "Remove a member",
    blurb: "Take someone out of the group.",
  },
  REMOVE_ADMIN: {
    title: "Remove an admin",
    blurb: "Take admin rights away, leaving them a member.",
  },
};

/** One-line summary of what a proposal will do, for lists and review screens. */
export function describePayload(
  payload: ProposalPayload | null,
  formatMoney: (minor: bigint) => string,
): string | null {
  if (!payload) return null;

  switch (payload.kind) {
    case "CHANGE_CONTRIBUTION":
      return `${formatMoney(BigInt(payload.amountMinor))} ${
        payload.cadence === "MONTHLY" ? "monthly" : "weekly"
      }, due on day ${payload.dueDay}`;
    case "CHANGE_THRESHOLD":
      return `${THRESHOLD_ACTION_LABELS[payload.action]} → ${formatPct(
        payload.thresholdPermille,
      )}`;
    case "REMOVE_MEMBER":
    case "REMOVE_ADMIN":
      return payload.displayName;
    default:
      return null;
  }
}

export const THRESHOLD_ACTION_LABELS: Record<GovernedAction, string> = {
  FUND_RELEASE_SMALL: "Routine spend",
  FUND_RELEASE_LARGE: "Large withdrawal",
  CHANGE_CONTRIBUTION: "Change the contribution",
  CHANGE_GOVERNANCE: "Change thresholds",
  REMOVE_MEMBER: "Remove a member",
  REMOVE_ADMIN: "Remove an admin",
  ROTATION_ORDER_CHANGE: "Change payout order",
  DISSOLVE_GROUP: "Dissolve the group",
};

function formatPct(permille: number): string {
  const percent = permille / 10;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;
}

/**
 * Narrow whatever came out of the `payload` jsonb column.
 *
 * Stored JSON has no type guarantees, and a proposal written by an older
 * version of the app may not match today's shape — so a payload that does not
 * parse is treated as absent rather than trusted.
 */
export function parsePayload(value: unknown): ProposalPayload | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;

  switch (candidate.kind) {
    case "SPEND":
      return { kind: "SPEND" };

    case "CHANGE_CONTRIBUTION":
      if (
        typeof candidate.amountMinor === "string" &&
        (candidate.cadence === "MONTHLY" || candidate.cadence === "WEEKLY") &&
        typeof candidate.dueDay === "number"
      ) {
        return {
          kind: "CHANGE_CONTRIBUTION",
          amountMinor: candidate.amountMinor,
          cadence: candidate.cadence,
          dueDay: candidate.dueDay,
        };
      }
      return null;

    case "CHANGE_THRESHOLD":
      if (
        typeof candidate.action === "string" &&
        candidate.action in THRESHOLD_ACTION_LABELS &&
        typeof candidate.thresholdPermille === "number"
      ) {
        return {
          kind: "CHANGE_THRESHOLD",
          action: candidate.action as GovernedAction,
          thresholdPermille: candidate.thresholdPermille,
        };
      }
      return null;

    case "REMOVE_MEMBER":
    case "REMOVE_ADMIN":
      if (
        typeof candidate.userId === "string" &&
        typeof candidate.displayName === "string"
      ) {
        return {
          kind: candidate.kind,
          userId: candidate.userId,
          displayName: candidate.displayName,
        };
      }
      return null;

    default:
      return null;
  }
}
