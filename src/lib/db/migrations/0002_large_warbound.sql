CREATE TYPE "public"."cadence" AS ENUM('WEEKLY', 'MONTHLY');--> statement-breakpoint
CREATE TYPE "public"."governed_action" AS ENUM('FUND_RELEASE_SMALL', 'FUND_RELEASE_LARGE', 'CHANGE_CONTRIBUTION', 'CHANGE_GOVERNANCE', 'REMOVE_MEMBER', 'REMOVE_ADMIN', 'CHANGE_LOCK_RULE', 'ROTATION_ORDER_CHANGE', 'DISSOLVE_GROUP');--> statement-breakpoint
CREATE TYPE "public"."group_status" AS ENUM('ACTIVE', 'DISSOLVING', 'DISSOLVED');--> statement-breakpoint
CREATE TYPE "public"."group_type" AS ENUM('TREASURY', 'ROTATING');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('OWNER', 'ADMIN', 'MEMBER');--> statement-breakpoint
CREATE TYPE "public"."member_status" AS ENUM('INVITED', 'ACTIVE', 'LEFT', 'REMOVED');--> statement-breakpoint
CREATE TABLE "governance_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"action" "governed_action" NOT NULL,
	"threshold_permille" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_invites" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"code" text NOT NULL,
	"created_by" text NOT NULL,
	"email" text,
	"max_uses" integer DEFAULT 1 NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_members" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" "member_role" DEFAULT 'MEMBER' NOT NULL,
	"status" "member_status" DEFAULT 'ACTIVE' NOT NULL,
	"rotation_position" integer,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"exited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_settings" (
	"group_id" text PRIMARY KEY NOT NULL,
	"contribution_amount" bigint DEFAULT 0 NOT NULL,
	"cadence" "cadence" DEFAULT 'MONTHLY' NOT NULL,
	"due_day" smallint DEFAULT 1 NOT NULL,
	"grace_days" smallint DEFAULT 3 NOT NULL,
	"members_can_propose" boolean DEFAULT true NOT NULL,
	"default_vote_days" smallint DEFAULT 3 NOT NULL,
	"quorum_pct" smallint DEFAULT 60 NOT NULL,
	"auto_charge_enabled" boolean DEFAULT true NOT NULL,
	"gross_up_fees" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"avatar_url" text,
	"type" "group_type" DEFAULT 'TREASURY' NOT NULL,
	"currency" text DEFAULT 'NGN' NOT NULL,
	"owner_id" text NOT NULL,
	"status" "group_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "governance_rules" ADD CONSTRAINT "governance_rules_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_invites" ADD CONSTRAINT "group_invites_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_invites" ADD CONSTRAINT "group_invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_settings" ADD CONSTRAINT "group_settings_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "governance_rules_group_action_unique" ON "governance_rules" USING btree ("group_id","action");--> statement-breakpoint
CREATE UNIQUE INDEX "group_invites_code_unique" ON "group_invites" USING btree ("code");--> statement-breakpoint
CREATE INDEX "group_invites_group_idx" ON "group_invites" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "group_members_group_user_unique" ON "group_members" USING btree ("group_id","user_id");--> statement-breakpoint
CREATE INDEX "group_members_user_idx" ON "group_members" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "group_members_group_idx" ON "group_members" USING btree ("group_id","status");--> statement-breakpoint
CREATE INDEX "groups_owner_idx" ON "groups" USING btree ("owner_id");