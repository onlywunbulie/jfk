import {
  index,
  inet,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { uuidv7 } from "@/lib/ids";

/** Shared column builders. Every table is time-stamped and UUIDv7-keyed. */
export const primaryId = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => uuidv7());

export const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

export const users = pgTable(
  "users",
  {
    id: primaryId(),
    /**
     * Null for someone who signed in with their wallet and hasn't given an
     * email. Email is then only for notifications, never for signing in.
     */
    email: text("email"),
    /**
     * The member's smart wallet on Base, lowercased. This is who they are
     * on-chain: the address the group's Safe lists as an owner.
     */
    walletAddress: text("wallet_address"),
    phone: text("phone"),
    displayName: text("display_name").notNull(),
    avatarUrl: text("avatar_url"),

    /**
     * Transaction PIN, Argon2id. Separate from sign-in on purpose: session
     * theft alone must not be enough to move money. Null until the user sets
     * one, which is required before joining any group.
     */
    pinHash: text("pin_hash"),
    pinFailedAttempts: smallint("pin_failed_attempts").notNull().default(0),
    pinLockedUntil: timestamp("pin_locked_until", { withTimezone: true }),

    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // Emails are stored lowercased by the service layer; this enforces it.
    uniqueIndex("users_email_unique").on(table.email),
    uniqueIndex("users_wallet_address_unique").on(table.walletAddress),
  ],
);

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

export const sessions = pgTable(
  "sessions",
  {
    id: primaryId(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    /**
     * SHA-256 of the session token. The raw token exists only in the user's
     * cookie, so a database leak does not hand over live sessions.
     */
    tokenHash: text("token_hash").notNull(),

    ip: inet("ip"),
    userAgent: text("user_agent"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_unique").on(table.tokenHash),
    index("sessions_user_id_idx").on(table.userId),
  ],
);

// ---------------------------------------------------------------------------
// login_codes — email OTP
// ---------------------------------------------------------------------------

export const loginCodes = pgTable(
  "login_codes",
  {
    id: primaryId(),
    email: text("email").notNull(),

    /** SHA-256 of the 6-digit code. Never stored in the clear. */
    codeHash: text("code_hash").notNull(),

    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),

    /** Verification attempts against this code. Burned after 5. */
    attempts: smallint("attempts").notNull().default(0),

    requestedIp: inet("requested_ip"),
    createdAt: createdAt(),
  },
  (table) => [index("login_codes_email_idx").on(table.email, table.createdAt)],
);

// ---------------------------------------------------------------------------
// audit_logs — append-only
// ---------------------------------------------------------------------------

/**
 * Every privileged or financial action lands here. Written in the same
 * database transaction as the action itself, so an action cannot succeed
 * without its audit record.
 *
 * The migration that creates this table also REVOKEs UPDATE and DELETE from
 * the application role — see `src/lib/db/migrations`. Append-only is a grant,
 * not a convention.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: primaryId(),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    actorIp: inet("actor_ip"),
    groupId: text("group_id"),
    action: text("action").notNull(),
    subjectType: text("subject_type"),
    subjectId: text("subject_id"),
    before: text("before"),
    after: text("after"),
    createdAt: createdAt(),
  },
  (table) => [
    index("audit_logs_group_idx").on(table.groupId, table.createdAt),
    index("audit_logs_actor_idx").on(table.actorId, table.createdAt),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type LoginCode = typeof loginCodes.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;

/** Sessions last 30 days, refreshed on use. */
export const SESSION_TTL_DAYS = 30;
/** OTP codes are short-lived by design. */
export const LOGIN_CODE_TTL_MINUTES = 10;
/** Verification attempts before a code is burned. */
export const LOGIN_CODE_MAX_ATTEMPTS = 5;
/** Login codes requestable per email per hour. */
export const LOGIN_CODE_RATE_LIMIT_PER_HOUR = 5;
export const PIN_MAX_ATTEMPTS = 5;
export const PIN_LOCKOUT_MINUTES = 15;
