-- Money held back is always a reservation now, never a "lock".
--
-- Two different things used to share one label. Money set aside deliberately
-- ("save ₦250,000 until December") and money an approved proposal is about to
-- spend both showed as "locked", so a member could not tell how much was
-- savings and how much was already on its way out. Deliberate saving is gone,
-- so the remaining concept gets the accurate name.
--
-- Hand-written rather than generated. drizzle-kit's version casts existing
-- rows straight into the new enums, which fails the moment a row still holds
-- 'GROUP_LOCKED' or 'CHANGE_LOCK_RULE' — i.e. on every database that has ever
-- been seeded. The old values are migrated first here.

-- ---------------------------------------------------------------------------
-- 1. account_purpose: GROUP_LOCKED becomes GROUP_RESERVED.
--
-- A plain value rename, so existing ledger accounts and every entry pointing
-- at them keep working untouched. No balances move.
-- ---------------------------------------------------------------------------

ALTER TYPE "public"."account_purpose" RENAME VALUE 'GROUP_LOCKED' TO 'GROUP_RESERVED';
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. fund_locks was never written to. Nothing to preserve.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS "fund_locks";
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. governed_action: drop CHANGE_LOCK_RULE.
--
-- Postgres cannot remove a value from an enum in place, so the type is
-- rebuilt. Any rule or proposal referencing the dead action is cleared first,
-- otherwise the cast below fails.
--
-- Deleting these rows is safe in a way that deleting ledger rows would not be:
-- a governance rule is current configuration, not history.
-- ---------------------------------------------------------------------------

DELETE FROM "governance_rules" WHERE "action" = 'CHANGE_LOCK_RULE';
--> statement-breakpoint
DELETE FROM "votes" WHERE "proposal_id" IN (
  SELECT "id" FROM "proposals" WHERE "action" = 'CHANGE_LOCK_RULE'
);
--> statement-breakpoint
DELETE FROM "proposals" WHERE "action" = 'CHANGE_LOCK_RULE';
--> statement-breakpoint

ALTER TABLE "governance_rules" ALTER COLUMN "action" SET DATA TYPE text;
--> statement-breakpoint
ALTER TABLE "proposals" ALTER COLUMN "action" SET DATA TYPE text;
--> statement-breakpoint
DROP TYPE "public"."governed_action";
--> statement-breakpoint
CREATE TYPE "public"."governed_action" AS ENUM('FUND_RELEASE_SMALL', 'FUND_RELEASE_LARGE', 'CHANGE_CONTRIBUTION', 'CHANGE_GOVERNANCE', 'REMOVE_MEMBER', 'REMOVE_ADMIN', 'ROTATION_ORDER_CHANGE', 'DISSOLVE_GROUP');
--> statement-breakpoint
ALTER TABLE "governance_rules" ALTER COLUMN "action" SET DATA TYPE "public"."governed_action" USING "action"::"public"."governed_action";
--> statement-breakpoint
ALTER TABLE "proposals" ALTER COLUMN "action" SET DATA TYPE "public"."governed_action" USING "action"::"public"."governed_action";

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Rebuild the no-negative-balance guard.
--
-- CRITICAL. The function body from 0001 hard-codes the purpose names as string
-- literals, and renaming an enum value does not rewrite functions that mention
-- it. Left alone, the check would compare against 'GROUP_LOCKED', never match a
-- reserved account, return early, and silently stop protecting the one thing it
-- exists to protect — with no error to notice.
--
-- A renamed enum value is exactly the kind of change that looks cosmetic and
-- isn't.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION jfk_assert_no_negative_group_balance()
RETURNS TRIGGER AS $$
DECLARE
  account_purpose TEXT;
  net             BIGINT;
BEGIN
  SELECT purpose INTO account_purpose
  FROM ledger_accounts WHERE id = NEW.account_id;

  IF account_purpose NOT IN ('GROUP_AVAILABLE', 'GROUP_RESERVED') THEN
    RETURN NULL;
  END IF;

  net := NEW.credits - NEW.debits;

  IF net < 0 THEN
    RAISE EXCEPTION
      'Account % (%) would go negative: credits % - debits % = %',
      NEW.account_id, account_purpose, NEW.credits, NEW.debits, net
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Deliberately NOT changed: ledger_transaction_type still lists FUND_LOCK and
-- FUND_UNLOCK.
--
-- Ledger transactions are append-only, enforced by a trigger, so historical
-- rows of those types can never be deleted — which means the enum values can
-- never be removed. That is the append-only guarantee working as intended: the
-- past is not editable to suit a rename. Nothing produces them any more.
-- ---------------------------------------------------------------------------
