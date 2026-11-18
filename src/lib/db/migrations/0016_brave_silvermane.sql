CREATE TABLE "dues_autopay" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"user_id" text NOT NULL,
	"set_up_tx" text NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"stopped_at" timestamp with time zone,
	"last_collected_at" timestamp with time zone,
	"last_problem" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dues_autopay" ADD CONSTRAINT "dues_autopay_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dues_autopay" ADD CONSTRAINT "dues_autopay_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dues_autopay_group_user_unique" ON "dues_autopay" USING btree ("group_id","user_id");