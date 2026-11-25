import "server-only";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { notifications, pushSubscriptions, type NotificationRow } from "@/lib/db/schema";
import { listGroupsForUser, listGroupsOnBaseWithMembers } from "@/modules/groups/service";
import { noticesFor, type Notice } from "./detect";
import { sendPush, type Device } from "./push";

/**
 * Telling members what needs them: Rallied checks Base (right after anything
 * is sent, and every morning), stores each new thing once, and alerts the
 * member's devices about it. The same list is what Rallied shows and what
 * Claude's whats_new reads, so the two never disagree.
 *
 * No email: the user decided Rallied doesn't send any.
 */

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export async function saveDevice(userId: string, device: Device): Promise<void> {
  await db
    .insert(pushSubscriptions)
    .values({ userId, ...device })
    // The same browser subscribing again (or after someone else signed out of it) is now this user's.
    .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { userId, p256dh: device.p256dh, auth: device.auth } });
}

export async function forgetDevice(userId: string, endpoint: string): Promise<void> {
  await db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)));
}

// ---------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------

export interface CheckRun {
  groups: number;
  created: number;
  pushed: number;
  /** Everything that applies right now, new or not (only filled for checkUser). */
  current: (Notice & { groupId: string })[];
}

/** One group, every member: after something was sent to Base there. */
export async function checkGroup(groupId: string, now: Date = new Date()): Promise<CheckRun> {
  return checkGroups(await listGroupsOnBaseWithMembers(groupId), now);
}

/** Every group on Base: the morning job. */
export async function checkAllGroups(now: Date = new Date()): Promise<CheckRun> {
  return checkGroups(await listGroupsOnBaseWithMembers(), now);
}

/** One user, all their groups: before Claude reports what's new. */
export async function checkUser(userId: string, now: Date = new Date()): Promise<CheckRun> {
  const groups = (await listGroupsForUser(userId)).filter((group) => group.safeAddress !== null);
  return checkGroups(groups.map((group) => ({ groupId: group.id, userIds: [userId] })), now, true);
}

async function checkGroups(targets: { groupId: string; userIds: string[] }[], now: Date, keepCurrent = false): Promise<CheckRun> {
  const run: CheckRun = { groups: targets.length, created: 0, pushed: 0, current: [] };
  for (const { groupId, userIds } of targets) {
    for (const userId of userIds) {
      try {
        const notices = await noticesFor(userId, groupId, now);
        if (keepCurrent) run.current.push(...notices.map((notice) => ({ ...notice, groupId })));
        const fresh = await record(userId, groupId, notices);
        run.created += fresh.length;
        run.pushed += await alert(userId, fresh, now);
      } catch (cause) {
        // One member's check failing (Base unreachable, say) never stops the rest.
        console.error("[notifications] check failed", groupId, cause);
      }
    }
  }
  return run;
}

/** Stores what's new for this member; returns only the rows that weren't there before. */
async function record(userId: string, groupId: string, notices: Notice[]): Promise<NotificationRow[]> {
  if (notices.length === 0) return [];
  return db
    .insert(notifications)
    .values(notices.map((notice) => ({ userId, groupId, ...notice })))
    .onConflictDoNothing({ target: [notifications.userId, notifications.key] })
    .returning();
}

async function alert(userId: string, fresh: NotificationRow[], now: Date): Promise<number> {
  if (fresh.length === 0) return 0;
  const devices = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
  if (devices.length === 0) return 0;

  let sent = 0;
  const gone = new Set<string>();
  for (const row of fresh) {
    for (const device of devices) {
      if (gone.has(device.endpoint)) continue;
      const outcome = await sendPush(device, { title: row.title, body: row.body, url: row.url, tag: row.key });
      if (outcome === "sent") sent++;
      if (outcome === "gone") gone.add(device.endpoint);
    }
  }
  if (gone.size > 0) await db.delete(pushSubscriptions).where(inArray(pushSubscriptions.endpoint, [...gone]));
  if (sent > 0) {
    await db.update(notifications).set({ pushedAt: now }).where(inArray(notifications.id, fresh.map((row) => row.id)));
  }
  return sent;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** The member's most recent notifications, newest first. */
export async function listNotifications(userId: string, limit = 30): Promise<NotificationRow[]> {
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.id))
    .limit(limit);
}

/** Opening the bell: everything in it is no longer new. */
export async function markAllRead(userId: string, now: Date = new Date()): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: now })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
}
