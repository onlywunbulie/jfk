ALTER TABLE "groups" ADD COLUMN "safe_address" text;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "started_on_chain_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "groups_safe_address_unique" ON "groups" USING btree ("safe_address");