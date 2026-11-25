import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, primaryId, users } from "./identity";
import { groups } from "./groups";

/**
 * What needs a member's attention, and the devices that get told about it.
 * Owned by `modules/notifications`.
 *
 * A notification is written once per thing (its `key`, unique per user), so
 * however often Rallied checks, nobody is told the same thing twice. The same
 * rows feed the phone alert, Rallied's own list, and Claude's whats_new.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: primaryId(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    groupId: text("group_id").references(() => groups.id, { onDelete: "cascade" }),
    /** What it's about, e.g. "vote-opened:<group>:12". One row per key per user. */
    key: text("key").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    /** Where tapping it goes, a path in Rallied ("/groups/…/votes"). */
    url: text("url").notNull(),
    createdAt: createdAt(),
    /** When it was sent to the member's devices; null when they had none. */
    pushedAt: timestamp("pushed_at", { withTimezone: true }),
    /** When the member opened the bell with this in it; null while it is new. */
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("notifications_user_key_idx").on(table.userId, table.key),
    index("notifications_user_idx").on(table.userId, table.id),
  ],
);

/** A browser or phone that said yes to alerts from Rallied. */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: primaryId(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The push service's address for this device; unique, so subscribing twice is one row. */
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("push_subscriptions_endpoint_idx").on(table.endpoint),
    index("push_subscriptions_user_idx").on(table.userId),
  ],
);

export type NotificationRow = typeof notifications.$inferSelect;
