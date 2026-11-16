CREATE TYPE "public"."agent_draft_kind" AS ENUM('SPEND', 'RULE_CHANGE', 'ROLE_CHANGE');--> statement-breakpoint
CREATE TYPE "public"."agent_draft_status" AS ENUM('WAITING', 'SENT', 'DISCARDED');--> statement-breakpoint
CREATE TABLE "agent_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"group_id" text NOT NULL,
	"kind" "agent_draft_kind" NOT NULL,
	"details" jsonb NOT NULL,
	"made_by" text NOT NULL,
	"status" "agent_draft_status" DEFAULT 'WAITING' NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_drafts" ADD CONSTRAINT "agent_drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_drafts" ADD CONSTRAINT "agent_drafts_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_drafts_user_group_status_idx" ON "agent_drafts" USING btree ("user_id","group_id","status");