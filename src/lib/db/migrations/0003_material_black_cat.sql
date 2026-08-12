CREATE TYPE "public"."account_kind" AS ENUM('ASSET', 'LIABILITY', 'INCOME', 'EXPENSE');--> statement-breakpoint
CREATE TYPE "public"."account_owner_type" AS ENUM('USER', 'GROUP', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "public"."account_purpose" AS ENUM('PSP_SETTLEMENT', 'GROUP_AVAILABLE', 'GROUP_LOCKED', 'USER_WALLET', 'FEE_EXPENSE', 'FEE_RECOVERY', 'EXTERNAL', 'SUSPENSE');--> statement-breakpoint
CREATE TYPE "public"."entry_direction" AS ENUM('DEBIT', 'CREDIT');--> statement-breakpoint
CREATE TYPE "public"."ledger_transaction_type" AS ENUM('CONTRIBUTION', 'FUND_LOCK', 'FUND_UNLOCK', 'RESERVATION', 'RESERVATION_RELEASE', 'PAYOUT', 'REFUND', 'REVERSAL', 'ADJUSTMENT');--> statement-breakpoint
CREATE TABLE "account_balances" (
	"account_id" text PRIMARY KEY NOT NULL,
	"debits" bigint DEFAULT 0 NOT NULL,
	"credits" bigint DEFAULT 0 NOT NULL,
	"entry_count" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_type" "account_owner_type" NOT NULL,
	"owner_id" text,
	"purpose" "account_purpose" NOT NULL,
	"kind" "account_kind" NOT NULL,
	"currency" text DEFAULT 'NGN' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"transaction_id" text NOT NULL,
	"account_id" text NOT NULL,
	"direction" "entry_direction" NOT NULL,
	"amount" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_amount_positive" CHECK ("ledger_entries"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"type" "ledger_transaction_type" NOT NULL,
	"group_id" text,
	"idempotency_key" text NOT NULL,
	"description" text NOT NULL,
	"metadata" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_balances" ADD CONSTRAINT "account_balances_account_id_ledger_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_ledger_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_identity_unique" ON "ledger_accounts" USING btree ("owner_type",coalesce("owner_id", ''),"purpose","currency");--> statement-breakpoint
CREATE INDEX "ledger_accounts_owner_idx" ON "ledger_accounts" USING btree ("owner_type","owner_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_account_idx" ON "ledger_entries" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "ledger_entries_transaction_idx" ON "ledger_entries" USING btree ("transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_transactions_idempotency_unique" ON "ledger_transactions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "ledger_transactions_group_idx" ON "ledger_transactions" USING btree ("group_id","occurred_at");