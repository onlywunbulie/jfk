import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { aiGroupOptouts, oauthClients, oauthTokens } from "@/lib/db/schema";
import { getMembership } from "@/modules/groups/service";

/**
 * A user's AI connection as Rallied sees it: whether an AI app holds a live
 * token for them, since when, and which of their groups it's been kept out
 * of. The tokens themselves live in `oauth.ts`; this module only reads them
 * and switches access off.
 */

export interface AiConnection {
  /** What the app called itself when it registered, e.g. "Claude". */
  appName: string;
  connectedAt: Date;
  lastUsedAt: Date | null;
}

/**
 * The user's live connection, or null. "Live" means not revoked and still
 * refreshable: an hour-old access token alone doesn't end a connection.
 * With several (e.g. re-connected), the most recent is shown.
 */
export async function getAiConnection(userId: string, now: Date = new Date()): Promise<AiConnection | null> {
  const [row] = await db
    .select({ appName: oauthClients.name, connectedAt: oauthTokens.createdAt, lastUsedAt: oauthTokens.lastUsedAt })
    .from(oauthTokens)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthTokens.clientId))
    .where(and(eq(oauthTokens.userId, userId), isNull(oauthTokens.revokedAt), gt(oauthTokens.refreshExpiresAt, now)))
    .orderBy(desc(oauthTokens.createdAt))
    .limit(1);
  return row ?? null;
}

/** Whether the user's AI may see this group (true unless they've switched it off here). */
export async function aiAllowedInGroup(userId: string, groupId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: aiGroupOptouts.id })
    .from(aiGroupOptouts)
    .where(and(eq(aiGroupOptouts.userId, userId), eq(aiGroupOptouts.groupId, groupId)))
    .limit(1);
  return !row;
}

/** Every group the user has kept their AI out of. */
export async function aiOptedOutGroups(userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ groupId: aiGroupOptouts.groupId })
    .from(aiGroupOptouts)
    .where(eq(aiGroupOptouts.userId, userId));
  return new Set(rows.map((row) => row.groupId));
}

/**
 * Let the user's AI into one group, or keep it out. Only for groups the user
 * is a member of; anyone else gets "not_member", the same as a group that
 * doesn't exist.
 */
export async function setAiInGroup(
  userId: string,
  groupId: string,
  allowed: boolean,
): Promise<{ ok: true } | { ok: false; reason: "not_member" }> {
  const membership = await getMembership(groupId, userId);
  if (!membership || membership.role === null) return { ok: false, reason: "not_member" };

  if (allowed) {
    await db.delete(aiGroupOptouts).where(and(eq(aiGroupOptouts.userId, userId), eq(aiGroupOptouts.groupId, groupId)));
  } else {
    await db.insert(aiGroupOptouts).values({ userId, groupId }).onConflictDoNothing();
  }
  return { ok: true };
}
