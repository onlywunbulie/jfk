import "server-only";
import { sql } from "drizzle-orm";
import { db, type Transaction } from "@/lib/db";

/**
 * Reconciliation.
 *
 * Re-derives every balance from the entries and asserts the invariants in
 * BLUEPRINT.md §8. Runs nightly; a non-clean result is an alert, not a log
 * line, because it means the books can no longer be trusted.
 *
 * Every check reads only — reconciliation must never "fix" anything. A
 * discrepancy is a bug to investigate, and silently repairing it would destroy
 * the evidence.
 */

/**
 * Shapes of the raw query results.
 *
 * Declared explicitly because Drizzle's `execute<T>()` type does not survive
 * the driver-shape normalisation in `rowsOf`. Every numeric column is cast to
 * text in SQL and parsed with BigInt here — a money total must never pass
 * through a JS number.
 */
interface UnbalancedRow {
  transaction_id: string;
  debits: string;
  credits: string;
}

interface NetRow {
  net: string;
}

interface DriftRow {
  account_id: string;
  purpose: string;
  cached_debits: string;
  cached_credits: string;
  derived_debits: string;
  derived_credits: string;
}

interface NegativeRow {
  account_id: string;
  owner_id: string;
  purpose: string;
  net: string;
}

export interface ReconciliationFinding {
  invariant: string;
  detail: string;
  severity: "critical" | "warning";
}

export interface ReconciliationReport {
  clean: boolean;
  checkedAt: Date;
  accountsChecked: number;
  transactionsChecked: number;
  findings: ReconciliationFinding[];
}

export async function reconcileLedger(
  executor: Transaction | typeof db = db,
): Promise<ReconciliationReport> {
  const findings: ReconciliationFinding[] = [];

  // -------------------------------------------------------------------------
  // Invariant 1 — every transaction balances to zero.
  // -------------------------------------------------------------------------
  const unbalanced = await executor.execute<{
    transaction_id: string;
    debits: string;
    credits: string;
  }>(sql`
    select
      transaction_id,
      sum(case when direction = 'DEBIT' then amount else 0 end) as debits,
      sum(case when direction = 'CREDIT' then amount else 0 end) as credits
    from ledger_entries
    group by transaction_id
    having sum(case when direction = 'DEBIT' then amount else 0 end)
        <> sum(case when direction = 'CREDIT' then amount else 0 end)
  `);

  for (const row of rowsOf<UnbalancedRow>(unbalanced)) {
    findings.push({
      invariant: "transaction_balances",
      severity: "critical",
      detail: `Transaction ${row.transaction_id} has debits ${row.debits} but credits ${row.credits}`,
    });
  }

  // -------------------------------------------------------------------------
  // Invariant 7 — the whole system sums to zero.
  //
  // The single strongest signal that the ledger is intact: if debits and
  // credits across every account do not cancel, money has been invented or
  // destroyed somewhere.
  // -------------------------------------------------------------------------
  const systemTotal = await executor.execute<{ net: string }>(sql`
    select coalesce(
      sum(case when direction = 'DEBIT' then amount else -amount end), 0
    )::text as net
    from ledger_entries
  `);

  const net = BigInt(rowsOf<NetRow>(systemTotal)[0]?.net ?? "0");
  if (net !== 0n) {
    findings.push({
      invariant: "system_sums_to_zero",
      severity: "critical",
      detail: `System-wide debits minus credits is ${net}, expected 0`,
    });
  }

  // -------------------------------------------------------------------------
  // The cache matches what the entries say.
  //
  // `account_balances` is an optimisation. Any drift means a posting updated
  // entries and the cache inconsistently, and every balance shown in the app
  // is suspect until it is explained.
  // -------------------------------------------------------------------------
  const drift = await executor.execute<{
    account_id: string;
    purpose: string;
    cached_debits: string;
    derived_debits: string;
    cached_credits: string;
    derived_credits: string;
  }>(sql`
    select
      a.id as account_id,
      a.purpose,
      b.debits::text  as cached_debits,
      b.credits::text as cached_credits,
      coalesce(d.debits, 0)::text  as derived_debits,
      coalesce(d.credits, 0)::text as derived_credits
    from ledger_accounts a
    join account_balances b on b.account_id = a.id
    left join (
      select
        account_id,
        sum(case when direction = 'DEBIT'  then amount else 0 end) as debits,
        sum(case when direction = 'CREDIT' then amount else 0 end) as credits
      from ledger_entries
      group by account_id
    ) d on d.account_id = a.id
    where b.debits  <> coalesce(d.debits, 0)
       or b.credits <> coalesce(d.credits, 0)
  `);

  for (const row of rowsOf<DriftRow>(drift)) {
    findings.push({
      invariant: "cache_matches_entries",
      severity: "critical",
      detail:
        `Account ${row.account_id} (${row.purpose}) cache says ` +
        `${row.cached_debits}/${row.cached_credits} but entries say ` +
        `${row.derived_debits}/${row.derived_credits}`,
    });
  }

  // -------------------------------------------------------------------------
  // Invariant 4 — no group account is negative.
  // -------------------------------------------------------------------------
  const negative = await executor.execute<{
    account_id: string;
    owner_id: string;
    purpose: string;
    net: string;
  }>(sql`
    select
      a.id as account_id,
      a.owner_id,
      a.purpose,
      (coalesce(d.credits, 0) - coalesce(d.debits, 0))::text as net
    from ledger_accounts a
    left join (
      select
        account_id,
        sum(case when direction = 'DEBIT'  then amount else 0 end) as debits,
        sum(case when direction = 'CREDIT' then amount else 0 end) as credits
      from ledger_entries
      group by account_id
    ) d on d.account_id = a.id
    where a.purpose in ('GROUP_AVAILABLE', 'GROUP_LOCKED')
      and coalesce(d.credits, 0) - coalesce(d.debits, 0) < 0
  `);

  for (const row of rowsOf<NegativeRow>(negative)) {
    findings.push({
      invariant: "no_negative_group_balance",
      severity: "critical",
      detail: `Group ${row.owner_id} has ${row.net} in ${row.purpose}`,
    });
  }

  // -------------------------------------------------------------------------
  // Every transaction has at least two entries.
  // -------------------------------------------------------------------------
  const singleSided = await executor.execute<{ transaction_id: string }>(sql`
    select t.id as transaction_id
    from ledger_transactions t
    left join ledger_entries e on e.transaction_id = t.id
    group by t.id
    having count(e.id) < 2
  `);

  for (const row of rowsOf<{ transaction_id: string }>(singleSided)) {
    findings.push({
      invariant: "double_entry",
      severity: "critical",
      detail: `Transaction ${row.transaction_id} has fewer than two entries`,
    });
  }

  // -------------------------------------------------------------------------
  // Suspense should be empty. Money sitting here is money we could not
  // attribute — a warning rather than corruption, but it needs a human.
  // -------------------------------------------------------------------------
  const suspense = await executor.execute<{ net: string }>(sql`
    select coalesce(sum(
      case when e.direction = 'CREDIT' then e.amount else -e.amount end
    ), 0)::text as net
    from ledger_entries e
    join ledger_accounts a on a.id = e.account_id
    where a.purpose = 'SUSPENSE'
  `);

  const suspenseNet = BigInt(rowsOf<NetRow>(suspense)[0]?.net ?? "0");
  if (suspenseNet !== 0n) {
    findings.push({
      invariant: "suspense_empty",
      severity: "warning",
      detail: `Suspense account holds ${suspenseNet} kobo that has not been attributed`,
    });
  }

  const accountsChecked = await countRows(executor, "ledger_accounts");
  const transactionsChecked = await countRows(executor, "ledger_transactions");

  return {
    clean: findings.every((f) => f.severity !== "critical"),
    checkedAt: new Date(),
    accountsChecked,
    transactionsChecked,
    findings,
  };
}

/**
 * Drizzle's `execute` returns the driver's native shape, which differs between
 * postgres.js (an array) and PGlite (`{ rows }`). Normalise once here rather
 * than at every call site.
 */
/** Row count for a ledger table. The name is interpolated, never user input. */
async function countRows(
  executor: Transaction | typeof db,
  table: "ledger_accounts" | "ledger_transactions",
): Promise<number> {
  const result = await executor.execute(
    sql`select count(*)::text as count from ${sql.identifier(table)}`,
  );
  return Number(rowsOf<{ count: string }>(result)[0]?.count ?? 0);
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

/** Format a report for a log line or an alert. */
export function describeReport(report: ReconciliationReport): string {
  if (report.clean && report.findings.length === 0) {
    return `Ledger clean — ${report.accountsChecked} accounts, ${report.transactionsChecked} transactions`;
  }
  const lines = report.findings.map(
    (f) => `  [${f.severity}] ${f.invariant}: ${f.detail}`,
  );
  return `Ledger reconciliation found ${report.findings.length} issue(s):\n${lines.join("\n")}`;
}
