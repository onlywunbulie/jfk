import { index, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, primaryId, users } from "./identity";
import { groups } from "./groups";

/**
 * How a user's AI (Claude first) gets into Rallied: OAuth 2.1, the standard
 * Claude uses for custom connectors. Owned by `modules/agents`.
 *
 * Every secret here (sign-in codes, access and refresh tokens) is stored only
 * as a SHA-256 hash, like sessions: a database leak hands over nothing live.
 */

// ---------------------------------------------------------------------------
// oauth_clients: an AI app that registered itself (dynamic client registration)
// ---------------------------------------------------------------------------

export const oauthClients = pgTable("oauth_clients", {
  /** The public client_id the AI app sends with every request. */
  id: primaryId(),
  /** What the app calls itself, e.g. "Claude". Shown on the approval screen. */
  name: text("name").notNull(),
  /** Exact addresses the app may be sent back to. Anything else is refused. */
  redirectUris: jsonb("redirect_uris").$type<string[]>().notNull(),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// oauth_codes: a one-time code handed back after the user approves
// ---------------------------------------------------------------------------

export const oauthCodes = pgTable(
  "oauth_codes",
  {
    id: primaryId(),
    codeHash: text("code_hash").notNull(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    redirectUri: text("redirect_uri").notNull(),
    /** PKCE: the S256 challenge; the token request must prove it knows the verifier. */
    codeChallenge: text("code_challenge").notNull(),
    scope: text("scope").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Set when exchanged. A code works once. */
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("oauth_codes_code_hash_unique").on(table.codeHash)],
);

// ---------------------------------------------------------------------------
// oauth_tokens: a live connection between a user and their AI
// ---------------------------------------------------------------------------

export const oauthTokens = pgTable(
  "oauth_tokens",
  {
    id: primaryId(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    accessHash: text("access_hash").notNull(),
    accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }).notNull(),
    refreshHash: text("refresh_hash").notNull(),
    refreshExpiresAt: timestamp("refresh_expires_at", { withTimezone: true }).notNull(),
    /** Disconnecting sets this; every token from then on is refused. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("oauth_tokens_access_hash_unique").on(table.accessHash),
    uniqueIndex("oauth_tokens_refresh_hash_unique").on(table.refreshHash),
    index("oauth_tokens_user_id_idx").on(table.userId),
  ],
);

// ---------------------------------------------------------------------------
// ai_group_optouts: groups a user has taken their AI out of
// ---------------------------------------------------------------------------

/**
 * A user's AI connection is for their whole account; a row here keeps it out
 * of one group. The AI's tools then treat that group as if it didn't exist.
 * Deleting the row lets the AI back in.
 */
export const aiGroupOptouts = pgTable(
  "ai_group_optouts",
  {
    id: primaryId(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("ai_group_optouts_user_group_unique").on(table.userId, table.groupId)],
);

// ---------------------------------------------------------------------------
// agent_drafts: something a user's AI prepared, waiting for the user to send
// ---------------------------------------------------------------------------

export const agentDraftKindEnum = pgEnum("agent_draft_kind", ["SPEND", "RULE_CHANGE", "ROLE_CHANGE", "GROUP_CHANGE"]);
export const agentDraftStatusEnum = pgEnum("agent_draft_status", ["WAITING", "SENT", "DISCARDED"]);

/**
 * A draft is private to the user who asked for it: nobody else in the group
 * sees it, and nothing happens until they send it. `details` holds what the
 * draft says, already checked when it was made; its shape depends on `kind`
 * (see `modules/agents/drafts.ts`).
 */
export const agentDrafts = pgTable(
  "agent_drafts",
  {
    id: primaryId(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    kind: agentDraftKindEnum("kind").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull(),
    /** Which AI app made it, e.g. "Claude". */
    madeBy: text("made_by").notNull(),
    status: agentDraftStatusEnum("status").notNull().default("WAITING"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [index("agent_drafts_user_group_status_idx").on(table.userId, table.groupId, table.status)],
);

export type OauthClient = typeof oauthClients.$inferSelect;
export type AgentDraft = typeof agentDrafts.$inferSelect;
