-- Ledger invariants, enforced by Postgres rather than by application code.
--
-- BLUEPRINT.md §8 lists seven invariants. The ones that can be expressed as
-- database constraints are expressed here, because a rule that lives only in
-- TypeScript is a rule that a future migration, a background job, or a
-- half-awake psql session can quietly break.

-- ---------------------------------------------------------------------------
-- Invariant 2: entries and transactions are append-only.
-- Corrections are reversing transactions, never edits.
-- ---------------------------------------------------------------------------

CREATE TRIGGER ledger_entries_no_update
  BEFORE UPDATE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION jfk_forbid_mutation();
--> statement-breakpoint

CREATE TRIGGER ledger_entries_no_delete
  BEFORE DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION jfk_forbid_mutation();
--> statement-breakpoint

CREATE TRIGGER ledger_transactions_no_update
  BEFORE UPDATE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION jfk_forbid_mutation();
--> statement-breakpoint

CREATE TRIGGER ledger_transactions_no_delete
  BEFORE DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION jfk_forbid_mutation();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Invariant 1: every transaction balances to zero.
--
-- A DEFERRABLE INITIALLY DEFERRED constraint trigger, so the check runs once
-- at COMMIT rather than after each entry insert — entries necessarily go in
-- one at a time, and a mid-transaction check would fail on the first one.
--
-- This makes an unbalanced transaction impossible to commit through any code
-- path, including a manual INSERT.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION jfk_assert_transaction_balances()
RETURNS TRIGGER AS $$
DECLARE
  total_debits  BIGINT;
  total_credits BIGINT;
  entry_count   INT;
BEGIN
  SELECT
    COALESCE(SUM(amount) FILTER (WHERE direction = 'DEBIT'), 0),
    COALESCE(SUM(amount) FILTER (WHERE direction = 'CREDIT'), 0),
    COUNT(*)
  INTO total_debits, total_credits, entry_count
  FROM ledger_entries
  WHERE transaction_id = NEW.transaction_id;

  -- A transaction whose entries were all rolled back is not a violation.
  IF entry_count = 0 THEN
    RETURN NULL;
  END IF;

  IF entry_count < 2 THEN
    RAISE EXCEPTION
      'Ledger transaction % has only % entry: double-entry requires at least two',
      NEW.transaction_id, entry_count
      USING ERRCODE = 'check_violation';
  END IF;

  IF total_debits <> total_credits THEN
    RAISE EXCEPTION
      'Ledger transaction % does not balance: debits % <> credits %',
      NEW.transaction_id, total_debits, total_credits
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER ledger_entries_must_balance
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION jfk_assert_transaction_balances();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Invariant 4: a group's balances can never go negative.
--
-- Checked against the balance cache, which is updated in the same transaction
-- as the entries. Deferred so the check sees the final state: a transfer from
-- available to locked touches both accounts, and an immediate check could fire
-- on the intermediate state.
--
-- GROUP_AVAILABLE and GROUP_LOCKED are liabilities, so a healthy balance is
-- credits - debits >= 0.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION jfk_assert_no_negative_group_balance()
RETURNS TRIGGER AS $$
DECLARE
  account_purpose TEXT;
  net             BIGINT;
BEGIN
  SELECT purpose INTO account_purpose
  FROM ledger_accounts WHERE id = NEW.account_id;

  IF account_purpose NOT IN ('GROUP_AVAILABLE', 'GROUP_LOCKED') THEN
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
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER account_balances_never_negative
  AFTER INSERT OR UPDATE ON account_balances
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION jfk_assert_no_negative_group_balance();
