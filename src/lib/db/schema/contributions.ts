import { sql } from "drizzle-orm";
import {
  bigint,
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
import { groups, groupMembers } from "./groups";
import { payments } from "./payments";

/**
 * Contributions. See BLUEPRINT.md §6.
 *
 * A **cycle** is one period of the group's schedule — "March 2026". Opening a
 * cycle creates one **contribution** row per active member: their obligation
 * for that period. Those rows are the source of truth for who owes what, who
 * has paid, and who is behind.
 */

export const cycleStatusEnum = pgEnum("cycle_status", [
  "SCHEDULED",
  "OPEN",
  "CLOSED",
  "SETTLED",
]);

/**
 * PENDING    — owed, not yet attempted
 * PROCESSING — a charge is in flight; the webhook will decide
 * PAID       — settled and posted to the ledger
 * FAILED     — an attempt failed; the retry ladder may try again
 * MISSED     — the ladder gave up, or the cycle closed unpaid. Arrears.
 * WAIVED     — the group excused it (joined mid-cycle, agreed exemption)
 */
export const contributionStatusEnum = pgEnum("contribution_status", [
  "PENDING",
  "PROCESSING",
  "PAID",
  "FAILED",
  "MISSED",
  "WAIVED",
]);

// ---------------------------------------------------------------------------
// contribution_cycles
// ---------------------------------------------------------------------------

export const contributionCycles = pgTable(
  "contribution_cycles",
  {
    id: primaryId(),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),

    /** 1, 2, 3… within the group. Human-facing and stable. */
    sequenceNo: integer("sequence_no").notNull(),

    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),

    /** After this, an unpaid contribution counts as missed. */
    gracePeriodEndsAt: timestamp("grace_period_ends_at", {
      withTimezone: true,
    }).notNull(),

    status: cycleStatusEnum("status").notNull().default("SCHEDULED"),

    /** What the group should collect: amount × active members at open time. */
    expectedTotal: bigint("expected_total", { mode: "bigint" })
      .notNull()
      .default(sql`0`),

    /** The per-member figure, snapshotted so a later rule change is not retroactive. */
    contributionAmount: bigint("contribution_amount", { mode: "bigint" })
      .notNull()
      .default(sql`0`),

    /** ROTATING groups only: whose turn it is to collect the pot. */
    beneficiaryMemberId: text("beneficiary_member_id").references(
      () => groupMembers.id,
      { onDelete: "set null" },
    ),

    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("contribution_cycles_group_sequence_unique").on(
      table.groupId,
      table.sequenceNo,
    ),
    index("contribution_cycles_due_idx").on(table.status, table.dueAt),
  ],
);

// ---------------------------------------------------------------------------
// contributions
// ---------------------------------------------------------------------------

export const contributions = pgTable(
  "contributions",
  {
    id: primaryId(),
    cycleId: text("cycle_id")
      .notNull()
      .references(() => contributionCycles.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    memberId: text("member_id")
      .notNull()
      .references(() => groupMembers.id, { onDelete: "restrict" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),

    /** What this member owes for this cycle. */
    amount: bigint("amount", { mode: "bigint" }).notNull(),

    status: contributionStatusEnum("status").notNull().default("PENDING"),

    /** The payment that settled it, once one has. */
    paymentId: text("payment_id").references(() => payments.id, {
      onDelete: "set null",
    }),

    attemptCount: smallint("attempt_count").notNull().default(0),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    lastFailureReason: text("last_failure_reason"),

    paidAt: timestamp("paid_at", { withTimezone: true }),
    waivedReason: text("waived_reason"),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /**
     * The duplicate-charge guard (BLUEPRINT.md §8, invariant 5). One
     * obligation per member per cycle, enforced by the database — so no bug in
     * the scheduler can bill someone twice for the same month.
     */
    uniqueIndex("contributions_cycle_member_unique").on(
      table.cycleId,
      table.memberId,
    ),
    index("contributions_group_status_idx").on(table.groupId, table.status),
    index("contributions_user_idx").on(table.userId, table.status),
    index("contributions_retry_idx")
      .on(table.nextRetryAt)
      .where(sql`${table.status} = 'FAILED' and ${table.nextRetryAt} is not null`),
  ],
);

// ---------------------------------------------------------------------------
// job_runs
// ---------------------------------------------------------------------------

/**
 * One row per (job, logical occurrence).
 *
 * Every scheduled job must be safe to run twice — schedulers double-fire, and
 * a human will inevitably run one by hand. The key names the occurrence
 * (`collect:2026-03-01`), so a repeat is a no-op rather than a second round of
 * charges.
 */
export const jobRuns = pgTable(
  "job_runs",
  {
    id: primaryId(),
    jobName: text("job_name").notNull(),
    jobKey: text("job_key").notNull(),
    status: text("status").notNull().default("RUNNING"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    result: jsonb("result"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("job_runs_key_unique").on(table.jobKey),
    index("job_runs_name_idx").on(table.jobName, table.startedAt),
  ],
);

export type ContributionCycle = typeof contributionCycles.$inferSelect;
export type Contribution = typeof contributions.$inferSelect;
export type JobRun = typeof jobRuns.$inferSelect;
export type CycleStatus = (typeof cycleStatusEnum.enumValues)[number];
export type ContributionStatus =
  (typeof contributionStatusEnum.enumValues)[number];

/**
 * The retry ladder (BLUEPRINT.md §10). Hours after the failed attempt.
 * Only soft declines walk it; a dead card stops immediately.
 */
export const RETRY_LADDER_HOURS = [6, 24, 72] as const;

/** How many days before the due date to remind people. */
export const REMINDER_DAYS_BEFORE = 3;
