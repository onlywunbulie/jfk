CREATE TYPE "public"."payment_direction" AS ENUM('IN', 'OUT');--> statement-breakpoint
CREATE TYPE "public"."payment_method_status" AS ENUM('ACTIVE', 'EXPIRED', 'REVOKED');--> statement-breakpoint
CREATE TYPE "public"."payment_provider" AS ENUM('PAYSTACK');--> statement-breakpoint
CREATE TYPE "public"."payment_purpose" AS ENUM('CARD_TOKENIZATION', 'CONTRIBUTION', 'PAYOUT');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('INITIATED', 'PENDING', 'SUCCESS', 'FAILED', 'REVERSED');--> statement-breakpoint
CREATE TABLE "bank_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"bank_code" text NOT NULL,
	"account_number" text NOT NULL,
	"resolved_name" text NOT NULL,
	"provider_recipient_code" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_methods" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" "payment_provider" DEFAULT 'PAYSTACK' NOT NULL,
	"provider_auth_code" text NOT NULL,
	"signature" text,
	"last4" text,
	"brand" text,
	"bank" text,
	"exp_month" smallint,
	"exp_year" smallint,
	"is_default" boolean DEFAULT false NOT NULL,
	"status" "payment_method_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" "payment_provider" DEFAULT 'PAYSTACK' NOT NULL,
	"reference" text NOT NULL,
	"provider_ref" text,
	"direction" "payment_direction" NOT NULL,
	"purpose" "payment_purpose" NOT NULL,
	"status" "payment_status" DEFAULT 'INITIATED' NOT NULL,
	"amount" bigint NOT NULL,
	"fee" bigint DEFAULT 0 NOT NULL,
	"user_id" text,
	"group_id" text,
	"payment_method_id" text,
	"bank_account_id" text,
	"ledger_transaction_id" text,
	"failure_reason" text,
	"raw" jsonb,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" "payment_provider" DEFAULT 'PAYSTACK' NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"signature_valid" boolean NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_payment_method_id_payment_methods_id_fk" FOREIGN KEY ("payment_method_id") REFERENCES "public"."payment_methods"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_accounts_owner_number_unique" ON "bank_accounts" USING btree ("owner_type","owner_id","bank_code","account_number");--> statement-breakpoint
CREATE INDEX "payment_methods_user_idx" ON "payment_methods" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_methods_user_signature_unique" ON "payment_methods" USING btree ("user_id","signature") WHERE "payment_methods"."signature" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_reference_unique" ON "payments" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "payments_status_idx" ON "payments" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "payments_group_idx" ON "payments" USING btree ("group_id","created_at");--> statement-breakpoint
CREATE INDEX "payments_user_idx" ON "payments" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_provider_event_unique" ON "webhook_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "webhook_events_unprocessed_idx" ON "webhook_events" USING btree ("created_at") WHERE "webhook_events"."processed_at" is null;