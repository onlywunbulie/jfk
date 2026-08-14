CREATE TYPE "public"."lock_rule" AS ENUM('DATE', 'CYCLE_COUNT', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."lock_status" AS ENUM('LOCKED', 'ELIGIBLE', 'RELEASED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."proposal_status" AS ENUM('OPEN', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'EXECUTING', 'EXECUTED', 'EXECUTION_FAILED');--> statement-breakpoint
CREATE TYPE "public"."release_status" AS ENUM('PENDING', 'EXECUTING', 'EXECUTED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."vote_choice" AS ENUM('YES', 'NO', 'ABSTAIN');--> statement-breakpoint
CREATE TABLE "fund_locks" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"amount" bigint NOT NULL,
	"rule_type" "lock_rule" NOT NULL,
	"unlock_at" timestamp with time zone,
	"unlock_after_cycle" integer,
	"status" "lock_status" DEFAULT 'LOCKED' NOT NULL,
	"reason" text,
	"created_by" text,
	"created_via_proposal_id" text,
	"became_eligible_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fund_releases" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"proposal_id" text NOT NULL,
	"amount" bigint NOT NULL,
	"destination" text NOT NULL,
	"status" "release_status" DEFAULT 'PENDING' NOT NULL,
	"payment_id" text,
	"recorded_manually" boolean DEFAULT false NOT NULL,
	"executed_by" text,
	"executed_at" timestamp with time zone,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"created_by" text NOT NULL,
	"action" "governed_action" NOT NULL,
	"title" text NOT NULL,
	"reason" text NOT NULL,
	"amount" bigint,
	"destination" text,
	"payload" jsonb,
	"threshold_permille_snapshot" smallint NOT NULL,
	"quorum_pct_snapshot" smallint NOT NULL,
	"eligible_voter_count" integer NOT NULL,
	"status" "proposal_status" DEFAULT 'OPEN' NOT NULL,
	"opens_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closes_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"outcome_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "votes" (
	"id" text PRIMARY KEY NOT NULL,
	"proposal_id" text NOT NULL,
	"member_id" text NOT NULL,
	"user_id" text NOT NULL,
	"choice" "vote_choice" NOT NULL,
	"reason" text,
	"cast_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fund_locks" ADD CONSTRAINT "fund_locks_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_locks" ADD CONSTRAINT "fund_locks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_locks" ADD CONSTRAINT "fund_locks_created_via_proposal_id_proposals_id_fk" FOREIGN KEY ("created_via_proposal_id") REFERENCES "public"."proposals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_releases" ADD CONSTRAINT "fund_releases_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_releases" ADD CONSTRAINT "fund_releases_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_releases" ADD CONSTRAINT "fund_releases_executed_by_users_id_fk" FOREIGN KEY ("executed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_member_id_group_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."group_members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fund_locks_group_status_idx" ON "fund_locks" USING btree ("group_id","status");--> statement-breakpoint
CREATE INDEX "fund_locks_due_idx" ON "fund_locks" USING btree ("unlock_at") WHERE "fund_locks"."status" = 'LOCKED';--> statement-breakpoint
CREATE UNIQUE INDEX "fund_releases_proposal_unique" ON "fund_releases" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "fund_releases_group_idx" ON "fund_releases" USING btree ("group_id","created_at");--> statement-breakpoint
CREATE INDEX "proposals_group_status_idx" ON "proposals" USING btree ("group_id","status");--> statement-breakpoint
CREATE INDEX "proposals_closing_idx" ON "proposals" USING btree ("closes_at") WHERE "proposals"."status" = 'OPEN';--> statement-breakpoint
CREATE UNIQUE INDEX "votes_proposal_member_unique" ON "votes" USING btree ("proposal_id","member_id");--> statement-breakpoint
CREATE INDEX "votes_proposal_idx" ON "votes" USING btree ("proposal_id");