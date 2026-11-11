import { index, jsonb, pgEnum, pgTable, text } from "drizzle-orm/pg-core";
import { createdAt, primaryId, users } from "./identity";
import { groups } from "./groups";

/**
 * A group's chat: what people say, and what happens to the money, in one
 * stream. Owned by `modules/chat`.
 *
 * Events are written by the app, never typed by a person: a proposal opening,
 * a vote being decided, someone joining, the group starting on-chain. Each one
 * stores only a reference (a proposal id, say); the screen reads the live
 * state, so a proposal card always shows the current tally.
 *
 * Append-only by convention for now: nobody edits or deletes yet.
 */
export const chatMessageKindEnum = pgEnum("chat_message_kind", ["TEXT", "EVENT"]);

export type ChatEvent =
  | { type: "proposal_opened"; proposalId: string }
  | { type: "proposal_decided"; proposalId: string; outcome: "approved" | "rejected" | "expired" }
  | { type: "member_joined"; userId: string }
  | { type: "group_started"; safeAddress: string };

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: primaryId(),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    /** Null for app-written events. */
    authorId: text("author_id").references(() => users.id, { onDelete: "set null" }),
    kind: chatMessageKindEnum("kind").notNull(),
    body: text("body"),
    event: jsonb("event").$type<ChatEvent>(),
    createdAt: createdAt(),
  },
  // Ids are UUIDv7, so they sort by time: "everything after this id" is the
  // cheap way to fetch only what's new.
  (table) => [index("chat_messages_group_idx").on(table.groupId, table.id)],
);

export type ChatMessageRow = typeof chatMessages.$inferSelect;
