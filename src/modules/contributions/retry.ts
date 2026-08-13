import { RETRY_LADDER_HOURS } from "@/lib/db/schema";

/**
 * The retry ladder. See BLUEPRINT.md §10.
 *
 * Pure, and deliberately in its own module: both the collection job and the
 * webhook handler need it, and importing it from `collect.ts` — which itself
 * imports the payments service — would make the two modules circular.
 */

export type DeclineKind = "soft" | "hard";

/**
 * Soft means "might work later": insufficient funds, a timeout, a bank having
 * a bad morning. Hard means the card itself is finished, and retrying is pure
 * noise for the member and their issuer.
 *
 * An unrecognised reason counts as soft. Being wrong costs at most three
 * attempts, whereas wrongly marking a working card dead blocks someone's
 * contributions until they notice.
 */
export function classifyDecline(reason: string | null | undefined): DeclineKind {
  if (!reason) return "soft";
  const text = reason.toLowerCase();

  const hardSignals = [
    "expired",
    "invalid card",
    "invalid_card",
    "card not supported",
    "do not honour",
    "do not honor",
    "stolen",
    "lost card",
    "revoked",
    "blacklisted",
    "restricted card",
    "pick up card",
    "closed account",
    "invalid account",
  ];

  return hardSignals.some((signal) => text.includes(signal)) ? "hard" : "soft";
}

/**
 * When to try again, or null when the ladder is exhausted.
 * `attemptCount` is the number of attempts already made.
 */
export function nextRetryAt(
  attemptCount: number,
  from: Date = new Date(),
): Date | null {
  const hours = RETRY_LADDER_HOURS[attemptCount - 1];
  if (hours === undefined) return null;
  return new Date(from.getTime() + hours * 60 * 60 * 1000);
}
