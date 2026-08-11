-- Audit logs are append-only (BLUEPRINT.md §7, §16).
--
-- A trigger rather than a REVOKE: the guard must hold no matter which role
-- connects, including the superuser used in local development and any future
-- migration runner. Silent tampering with the audit trail is the one failure
-- mode that would make every other financial control unverifiable.
--
-- Deliberately no exception path. If a row is ever genuinely wrong, the fix is
-- a new corrective row, exactly as with the ledger.

CREATE OR REPLACE FUNCTION jfk_forbid_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    '% on % is forbidden: this table is append-only',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION jfk_forbid_mutation();
--> statement-breakpoint

CREATE TRIGGER audit_logs_no_delete
  BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION jfk_forbid_mutation();
