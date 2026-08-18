import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createdAt, primaryId, updatedAt, users } from "./identity";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * TREASURY — money accumulates, stays locked, leaves only by proposal + vote.
 * ROTATING — classic Ajo: each cycle the pot pays out to one member in order.
 *
 * Both share one contribution and ledger engine; they differ only in what
 * happens when a cycle closes.
 */
export const groupTypeEnum = pgEnum("group_type", ["TREASURY", "ROTATING"]);

export const groupStatusEnum = pgEnum("group_status", [
  "ACTIVE",
  "DISSOLVING",
  "DISSOLVED",
]);

export const memberRoleEnum = pgEnum("member_role", ["OWNER", "ADMIN", "MEMBER"]);

export const memberStatusEnum = pgEnum("member_status", [
  "INVITED",
  "ACTIVE",
  "LEFT",
  "REMOVED",
]);

export const cadenceEnum = pgEnum("cadence", ["WEEKLY", "MONTHLY"]);

/**
 * Actions whose approval threshold the group controls. Anything listed here
 * cannot be done by an admin alone — it needs a proposal that clears the
 * configured percentage.
 */
export const governedActionEnum = pgEnum("governed_action", [
  "FUND_RELEASE_SMALL",
  "FUND_RELEASE_LARGE",
  "CHANGE_CONTRIBUTION",
  "CHANGE_GOVERNANCE",
  "REMOVE_MEMBER",
  "REMOVE_ADMIN",
  "ROTATION_ORDER_CHANGE",
  "DISSOLVE_GROUP",
]);

// ---------------------------------------------------------------------------
// groups
// ---------------------------------------------------------------------------

export const groups = pgTable(
  "groups",
  {
    id: primaryId(),
    name: text("name").notNull(),
    description: text("description"),
    avatarUrl: text("avatar_url"),
    type: groupTypeEnum("type").notNull().default("TREASURY"),
    currency: text("currency").notNull().default("NGN"),

    /** Exactly one owner. Denormalised for cheap lookups; group_members is truth. */
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),

    status: groupStatusEnum("status").notNull().default("ACTIVE"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("groups_owner_idx").on(table.ownerId)],
);

// ---------------------------------------------------------------------------
// group_members
// ---------------------------------------------------------------------------

export const groupMembers = pgTable(
  "group_members",
  {
    id: primaryId(),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),

    role: memberRoleEnum("role").notNull().default("MEMBER"),
    status: memberStatusEnum("status").notNull().default("ACTIVE"),

    /**
     * Payout order for ROTATING groups, 1-based. Null for TREASURY groups and
     * for members who have left.
     */
    rotationPosition: integer("rotation_position"),

    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    exitedAt: timestamp("exited_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // One membership row per person per group, ever. Rejoining reactivates the
    // existing row so contribution history is never orphaned.
    uniqueIndex("group_members_group_user_unique").on(table.groupId, table.userId),
    index("group_members_user_idx").on(table.userId, table.status),
    index("group_members_group_idx").on(table.groupId, table.status),
  ],
);

// ---------------------------------------------------------------------------
// group_settings
// ---------------------------------------------------------------------------

export const groupSettings = pgTable("group_settings", {
  groupId: text("group_id")
    .primaryKey()
    .references(() => groups.id, { onDelete: "cascade" }),

  /**
   * Contribution amount in minor units (kobo). Always a `Money` in app code.
   * The default is written as SQL because drizzle-kit cannot serialise a
   * BigInt literal into a migration snapshot.
   */
  contributionAmount: bigint("contribution_amount", { mode: "bigint" })
    .notNull()
    .default(sql`0`),

  cadence: cadenceEnum("cadence").notNull().default("MONTHLY"),

  /** Day the contribution is due: 1–28 for monthly, 1–7 (Mon–Sun) for weekly. */
  dueDay: smallint("due_day").notNull().default(1),

  /** Days after the due date before a contribution counts as missed. */
  graceDays: smallint("grace_days").notNull().default(3),

  membersCanPropose: boolean("members_can_propose").notNull().default(true),
  defaultVoteDays: smallint("default_vote_days").notNull().default(3),

  /** Percent of eligible voters who must respond for a vote to count. */
  quorumPct: smallint("quorum_pct").notNull().default(60),

  autoChargeEnabled: boolean("auto_charge_enabled").notNull().default(true),

  /**
   * When true the member is charged slightly more so the treasury receives the
   * full round contribution amount after gateway fees. See BLUEPRINT.md §8.
   */
  grossUpFees: boolean("gross_up_fees").notNull().default(true),

  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------------
// governance_rules
// ---------------------------------------------------------------------------

export const governanceRules = pgTable(
  "governance_rules",
  {
    id: primaryId(),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    action: governedActionEnum("action").notNull(),

    /**
     * Approval percentage, in tenths of a percent, so 66.7% is 667. Integers
     * only — a float threshold is a rounding argument waiting to happen when
     * a vote lands exactly on the line.
     */
    thresholdPermille: smallint("threshold_permille").notNull(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("governance_rules_group_action_unique").on(
      table.groupId,
      table.action,
    ),
  ],
);

// ---------------------------------------------------------------------------
// group_invites
// ---------------------------------------------------------------------------

export const groupInvites = pgTable(
  "group_invites",
  {
    id: primaryId(),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),

    /** Null means an open link anyone with the code may use. */
    email: text("email"),

    maxUses: integer("max_uses").notNull().default(1),
    uses: integer("uses").notNull().default(0),

    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("group_invites_code_unique").on(table.code),
    index("group_invites_group_idx").on(table.groupId),
  ],
);

export type Group = typeof groups.$inferSelect;
export type NewGroup = typeof groups.$inferInsert;
export type GroupMember = typeof groupMembers.$inferSelect;
export type GroupSettings = typeof groupSettings.$inferSelect;
export type GovernanceRule = typeof governanceRules.$inferSelect;
export type GroupInvite = typeof groupInvites.$inferSelect;

export type GroupType = (typeof groupTypeEnum.enumValues)[number];
export type MemberRole = (typeof memberRoleEnum.enumValues)[number];
export type MemberStatus = (typeof memberStatusEnum.enumValues)[number];
export type Cadence = (typeof cadenceEnum.enumValues)[number];
export type GovernedAction = (typeof governedActionEnum.enumValues)[number];

/**
 * Default approval thresholds, in permille (667 = 66.7%).
 *
 * Chosen in BLUEPRINT.md §9. Editing them is itself governed at 75%, so a
 * simple majority cannot quietly lower the bar for everything else.
 */
export const DEFAULT_GOVERNANCE: Record<GovernedAction, number> = {
  FUND_RELEASE_SMALL: 500,
  FUND_RELEASE_LARGE: 667,
  CHANGE_CONTRIBUTION: 667,
  CHANGE_GOVERNANCE: 750,
  REMOVE_MEMBER: 667,
  REMOVE_ADMIN: 750,
  ROTATION_ORDER_CHANGE: 667,
  DISSOLVE_GROUP: 800,
};

/** A release above this share of the treasury needs the higher threshold. */
export const LARGE_RELEASE_SHARE_PERMILLE = 200;

/** Below this size, removing someone is an admin call rather than a vote. */
export const GOVERNED_REMOVAL_MIN_MEMBERS = 3;

export const INVITE_TTL_DAYS = 14;
