CREATE TYPE "public"."contribution_status" AS ENUM('PENDING', 'PROCESSING', 'PAID', 'FAILED', 'MISSED', 'WAIVED');--> statement-breakpoint
CREATE TYPE "public"."cycle_status" AS ENUM('SCHEDULED', 'OPEN', 'CLOSED', 'SETTLED');--> statement-breakpoint
CREATE TABLE "contribution_cycles" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"sequence_no" integer NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"grace_period_ends_at" timestamp with time zone NOT NULL,
	"status" "cycle_status" DEFAULT 'SCHEDULED' NOT NULL,
	"expected_total" bigint DEFAULT 0 NOT NULL,
	"contribution_amount" bigint DEFAULT 0 NOT NULL,
	"beneficiary_member_id" text,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contributions" (
	"id" text PRIMARY KEY NOT NULL,
	"cycle_id" text NOT NULL,
	"group_id" text NOT NULL,
	"member_id" text NOT NULL,
	"user_id" text NOT NULL,
	"amount" bigint NOT NULL,
	"status" "contribution_status" DEFAULT 'PENDING' NOT NULL,
	"payment_id" text,
	"attempt_count" smallint DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"last_failure_reason" text,
	"paid_at" timestamp with time zone,
	"waived_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"job_name" text NOT NULL,
	"job_key" text NOT NULL,
	"status" text DEFAULT 'RUNNING' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contribution_cycles" ADD CONSTRAINT "contribution_cycles_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contribution_cycles" ADD CONSTRAINT "contribution_cycles_beneficiary_member_id_group_members_id_fk" FOREIGN KEY ("beneficiary_member_id") REFERENCES "public"."group_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_cycle_id_contribution_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."contribution_cycles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_member_id_group_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."group_members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contribution_cycles_group_sequence_unique" ON "contribution_cycles" USING btree ("group_id","sequence_no");--> statement-breakpoint
CREATE INDEX "contribution_cycles_due_idx" ON "contribution_cycles" USING btree ("status","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "contributions_cycle_member_unique" ON "contributions" USING btree ("cycle_id","member_id");--> statement-breakpoint
CREATE INDEX "contributions_group_status_idx" ON "contributions" USING btree ("group_id","status");--> statement-breakpoint
CREATE INDEX "contributions_user_idx" ON "contributions" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "contributions_retry_idx" ON "contributions" USING btree ("next_retry_at") WHERE "contributions"."status" = 'FAILED' and "contributions"."next_retry_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "job_runs_key_unique" ON "job_runs" USING btree ("job_key");--> statement-breakpoint
CREATE INDEX "job_runs_name_idx" ON "job_runs" USING btree ("job_name","started_at");