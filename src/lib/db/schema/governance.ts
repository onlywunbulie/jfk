import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createdAt, primaryId, updatedAt, users } from "./identity";
import { groupMembers, groups, governedActionEnum } from "./groups";

/**
 * Proposals, votes and fund releases. See BLUEPRINT.md §9.
 *
 * This is where the product's central promise is kept: money leaves a group
 * only when the group says so. The guarantee is structural —
 * `fund_releases.proposal_id` is NOT NULL, so a release without an approved
 * proposal cannot be represented in the database at all.
 */

export const proposalStatusEnum = pgEnum("proposal_status", [
  "OPEN",
  "APPROVED",
  "REJECTED",
  "EXPIRED",
  "CANCELLED",
  "EXECUTING",
  "EXECUTED",
  "EXECUTION_FAILED",
]);

export const voteChoiceEnum = pgEnum("vote_choice", ["YES", "NO", "ABSTAIN"]);

export const lockStatusEnum = pgEnum("lock_status", [
  "LOCKED",
  "ELIGIBLE",
  "RELEASED",
  "CANCELLED",
]);

export const lockRuleEnum = pgEnum("lock_rule", ["DATE", "CYCLE_COUNT", "MANUAL"]);

export const releaseStatusEnum = pgEnum("release_status", [
  "PENDING",
  "EXECUTING",
  "EXECUTED",
  "FAILED",
]);

// ---------------------------------------------------------------------------
// proposals
// ---------------------------------------------------------------------------

export const proposals = pgTable(
  "proposals",
  {
    id: primaryId(),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),

    action: governedActionEnum("action").notNull(),
    title: text("title").notNull(),
    reason: text("reason").notNull(),

    /** For spending proposals. Null for rule changes. */
    amount: bigint("amount", { mode: "bigint" }),

    /** Free-form destination. Phase 6 resolves this to a bank account. */
    destination: text("destination"),

    /** Action-specific payload, e.g. the proposed new contribution amount. */
    payload: jsonb("payload"),

    /**
     * The rules are frozen when the proposal opens.
     *
     * Without this, a group could change its threshold or add members
     * mid-vote and retroactively flip an outcome. Snapshotting means the
     * question everyone answered is the question that gets counted.
     */
    thresholdPermilleSnapshot: smallint("threshold_permille_snapshot").notNull(),
    quorumPctSnapshot: smallint("quorum_pct_snapshot").notNull(),
    eligibleVoterCount: integer("eligible_voter_count").notNull(),

    status: proposalStatusEnum("status").notNull().default("OPEN"),

    opensAt: timestamp("opens_at", { withTimezone: true }).notNull().defaultNow(),
    closesAt: timestamp("closes_at", { withTimezone: true }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    executedAt: timestamp("executed_at", { withTimezone: true }),

    /** Why it ended the way it did — shown to the group. */
    outcomeReason: text("outcome_reason"),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("proposals_group_status_idx").on(table.groupId, table.status),
    index("proposals_closing_idx")
      .on(table.closesAt)
      .where(sql`${table.status} = 'OPEN'`),
  ],
);

// ---------------------------------------------------------------------------
// votes
// ---------------------------------------------------------------------------

export const votes = pgTable(
  "votes",
  {
    id: primaryId(),
    proposalId: text("proposal_id")
      .notNull()
      .references(() => proposals.id, { onDelete: "cascade" }),
    memberId: text("member_id")
      .notNull()
      .references(() => groupMembers.id, { onDelete: "restrict" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),

    choice: voteChoiceEnum("choice").notNull(),
    /** Optional note, so a dissent can be explained rather than just counted. */
    reason: text("reason"),

    castAt: timestamp("cast_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (table) => [
    // One vote per member per proposal. Changing your mind means updating this
    // row, never adding a second.
    uniqueIndex("votes_proposal_member_unique").on(table.proposalId, table.memberId),
    index("votes_proposal_idx").on(table.proposalId),
  ],
);

// ---------------------------------------------------------------------------
// fund_locks
// ---------------------------------------------------------------------------

export const fundLocks = pgTable(
  "fund_locks",
  {
    id: primaryId(),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),

    amount: bigint("amount", { mode: "bigint" }).notNull(),
    ruleType: lockRuleEnum("rule_type").notNull(),

    /** For DATE locks. */
    unlockAt: timestamp("unlock_at", { withTimezone: true }),
    /** For CYCLE_COUNT locks. */
    unlockAfterCycle: integer("unlock_after_cycle"),

    status: lockStatusEnum("status").notNull().default("LOCKED"),
    reason: text("reason"),

    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    /** Set when a vote created or changed this lock. */
    createdViaProposalId: text("created_via_proposal_id").references(
      () => proposals.id,
      { onDelete: "set null" },
    ),

    becameEligibleAt: timestamp("became_eligible_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("fund_locks_group_status_idx").on(table.groupId, table.status),
    index("fund_locks_due_idx")
      .on(table.unlockAt)
      .where(sql`${table.status} = 'LOCKED'`),
  ],
);

// ---------------------------------------------------------------------------
// fund_releases
// ---------------------------------------------------------------------------

/**
 * Money leaving the group.
 *
 * `proposalId` is **NOT NULL and UNIQUE**. That single constraint is the
 * product's central promise expressed as schema: a release cannot exist
 * without an approved proposal behind it, and one proposal can authorise
 * exactly one release. No code path, no migration and no manual query can
 * work around it.
 */
export const fundReleases = pgTable(
  "fund_releases",
  {
    id: primaryId(),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "restrict" }),

    proposalId: text("proposal_id")
      .notNull()
      .references(() => proposals.id, { onDelete: "restrict" }),

    amount: bigint("amount", { mode: "bigint" }).notNull(),
    destination: text("destination").notNull(),

    status: releaseStatusEnum("status").notNull().default("PENDING"),

    /** Set for a real transfer. Null for a payout recorded as done by hand. */
    paymentId: text("payment_id"),

    /**
     * True when a human moved the money outside the app and recorded it here.
     *
     * The governance gate is identical either way — the difference is only who
     * pushed the button at the bank. This keeps the group's books honest when
     * automatic transfers are unavailable.
     */
    recordedManually: boolean("recorded_manually").notNull().default(false),

    executedBy: text("executed_by").references(() => users.id, {
      onDelete: "set null",
    }),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    failureReason: text("failure_reason"),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("fund_releases_proposal_unique").on(table.proposalId),
    index("fund_releases_group_idx").on(table.groupId, table.createdAt),
  ],
);

export type Proposal = typeof proposals.$inferSelect;
export type Vote = typeof votes.$inferSelect;
export type FundLock = typeof fundLocks.$inferSelect;
export type FundRelease = typeof fundReleases.$inferSelect;
export type ProposalStatus = (typeof proposalStatusEnum.enumValues)[number];
export type VoteChoice = (typeof voteChoiceEnum.enumValues)[number];
export type ReleaseStatus = (typeof releaseStatusEnum.enumValues)[number];
export type LockStatus = (typeof lockStatusEnum.enumValues)[number];

/** Default voting window, in days. */
export const DEFAULT_VOTE_DAYS = 3;
