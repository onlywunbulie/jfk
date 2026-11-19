import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { rateLimits } from "@/lib/db/schema";

/**
 * How often one caller may do one thing: at most `limit` times per `windowSeconds`,
 * counted in Postgres so it holds across every server instance.
 *
 * One atomic statement per check, so a burst of parallel requests can't slip
 * past the count. A window that has run out restarts in place. When the
 * database itself fails, the check lets the request through (the caller's own
 * checks still apply): a broken counter must not lock everyone out.
 */

export type RateLimitResult = { ok: true } | { ok: false; retryAfterSeconds: number };

export async function rateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  try {
    const now = new Date();
    const windowStartsAfter = new Date(now.getTime() - windowSeconds * 1000);
    const [row] = await db
      .insert(rateLimits)
      .values({ key, windowStart: now, count: 1 })
      .onConflictDoUpdate({
        target: rateLimits.key,
        set: {
          // A window that has run out starts again at 1; otherwise count on.
          count: sql`case when ${rateLimits.windowStart} <= ${windowStartsAfter} then 1 else ${rateLimits.count} + 1 end`,
          windowStart: sql`case when ${rateLimits.windowStart} <= ${windowStartsAfter} then ${now} else ${rateLimits.windowStart} end`,
        },
      })
      .returning({ count: rateLimits.count, windowStart: rateLimits.windowStart });
    if (row.count <= limit) return { ok: true };
    const resetsAt = new Date(row.windowStart).getTime() + windowSeconds * 1000;
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((resetsAt - now.getTime()) / 1000)) };
  } catch (cause) {
    console.error("[rate-limit] couldn't count; letting the request through", cause);
    return { ok: true };
  }
}

/** The limits Rallied uses, in one place so they're easy to see and tune. */
export const LIMITS = {
  /** A fresh sign-in nonce: per visitor address. */
  signInStart: { limit: 30, windowSeconds: 600 },
  /** Checking a signed sign-in message: per visitor address. */
  signInFinish: { limit: 20, windowSeconds: 600 },
  /** An AI app registering itself: per visitor address. */
  oauthRegister: { limit: 10, windowSeconds: 3600 },
  /** Swapping a code or refresh token for access: per visitor address. */
  oauthToken: { limit: 60, windowSeconds: 600 },
  /** Claude's requests: per Rallied account. Generous for a conversation, tight for a script. */
  mcp: { limit: 120, windowSeconds: 60 },
  /** Asking Rallied to pay a fee: per wallet. */
  paymaster: { limit: 30, windowSeconds: 60 },
  /** Preparing anything for the wallet, or Rallied acting on Base for you: per account. */
  chainAction: { limit: 30, windowSeconds: 60 },
  /** Uploading a group picture or banner: per account. Each one is a stored file. */
  imageUpload: { limit: 20, windowSeconds: 3600 },
} as const;

/**
 * For actions that prepare a wallet call or make Rallied act on Base: a plain
 * sentence when the account is going too fast, else null.
 */
export async function chainActionLimit(userId: string): Promise<string | null> {
  const limited = await rateLimit(`chain:user:${userId}`, LIMITS.chainAction.limit, LIMITS.chainAction.windowSeconds);
  return limited.ok ? null : `That's a lot at once. Try again in ${limited.retryAfterSeconds} seconds.`;
}
