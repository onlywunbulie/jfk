import "server-only";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { db } from "@/lib/db";
import { chatMessages, users, type ChatEvent } from "@/lib/db/schema";
import { getMembership } from "@/modules/groups/service";

/**
 * A group's chat. Members read it and write in it; the app writes events
 * into it through `announce` (./events.ts).
 */

export const MAX_MESSAGE_LENGTH = 2000;
const PAGE = 50;

export interface ChatItem {
  id: string;
  kind: "TEXT" | "EVENT";
  authorId: string | null;
  authorName: string | null;
  body: string | null;
  event: ChatEvent | null;
  createdAt: Date;
}

/**
 * The latest messages, oldest first, or only those after `after` (an id the
 * screen already has) for polling. Null for someone who isn't in the group:
 * from outside, a group you aren't in looks like no group at all.
 */
export async function listMessages(
  groupId: string,
  viewerId: string,
  options: { after?: string } = {},
): Promise<ChatItem[] | null> {
  const membership = await getMembership(groupId, viewerId);
  if (!membership || membership.role === null || !membership.isActive) return null;

  const base = db
    .select({
      id: chatMessages.id,
      kind: chatMessages.kind,
      authorId: chatMessages.authorId,
      authorName: users.displayName,
      body: chatMessages.body,
      event: chatMessages.event,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .leftJoin(users, eq(users.id, chatMessages.authorId));

  if (options.after) {
    return base
      .where(and(eq(chatMessages.groupId, groupId), gt(chatMessages.id, options.after)))
      .orderBy(asc(chatMessages.id))
      .limit(PAGE);
  }

  const latest = await base
    .where(eq(chatMessages.groupId, groupId))
    .orderBy(desc(chatMessages.id))
    .limit(PAGE);
  return latest.reverse();
}

export type PostMessageResult =
  | { ok: true; message: ChatItem }
  | { ok: false; reason: "not_member" | "empty" | "too_long" };

/** Only members still in the group can speak in it. */
export async function postMessage(groupId: string, authorId: string, text: string): Promise<PostMessageResult> {
  const body = text.trim();
  if (body.length === 0) return { ok: false, reason: "empty" };
  if (body.length > MAX_MESSAGE_LENGTH) return { ok: false, reason: "too_long" };

  const membership = await getMembership(groupId, authorId);
  if (!membership || membership.role === null || !membership.isActive) {
    return { ok: false, reason: "not_member" };
  }

  const [row] = await db
    .insert(chatMessages)
    .values({ groupId, authorId, kind: "TEXT", body })
    .returning();
  const [author] = await db
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, authorId))
    .limit(1);

  return {
    ok: true,
    message: {
      id: row.id,
      kind: row.kind,
      authorId: row.authorId,
      authorName: author?.displayName ?? null,
      body: row.body,
      event: row.event,
      createdAt: row.createdAt,
    },
  };
}
