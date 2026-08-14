import "server-only";
import { auditLogs } from "@/lib/db/schema";
import type { Database, Transaction } from "@/lib/db";

/**
 * Audit actions. Enumerated rather than free-text so the log stays queryable
 * and a typo can't quietly create a category nobody ever greps for.
 */
export type AuditAction =
  | "group.created"
  | "group.settings.updated"
  | "group.dissolved"
  | "member.invited"
  | "member.joined"
  | "member.removed"
  | "member.left"
  | "member.role_changed"
  | "invite.created"
  | "invite.revoked"
  | "payment.started"
  | "payment.settled"
  | "payment.failed"
  | "payment_method.added"
  | "payment_method.removed"
  | "cycle.opened"
  | "cycle.closed"
  | "contribution.paid"
  | "contribution.missed"
  | "contribution.waived"
  | "proposal.created"
  | "proposal.approved"
  | "proposal.rejected"
  | "proposal.executed"
  | "vote.cast"
  | "funds.released"
  | "funds.locked"
  | "session.created"
  | "session.revoked";

export interface AuditEntry {
  action: AuditAction;
  actorId?: string | null;
  actorIp?: string | null;
  groupId?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
  before?: unknown;
  after?: unknown;
}

/**
 * Write an audit record.
 *
 * Takes the database handle explicitly so it can be called with a transaction:
 * an audited action and its audit row must commit together, or the log is a
 * record of what *usually* happened. Never call this with the global `db` from
 * inside a transaction — pass the `tx`.
 *
 * The table rejects UPDATE and DELETE at the database level, so this is the
 * only way rows ever get there.
 */
export async function recordAudit(
  executor: Database | Transaction,
  entry: AuditEntry,
): Promise<void> {
  await executor.insert(auditLogs).values({
    action: entry.action,
    actorId: entry.actorId ?? null,
    actorIp: entry.actorIp ?? null,
    groupId: entry.groupId ?? null,
    subjectType: entry.subjectType ?? null,
    subjectId: entry.subjectId ?? null,
    before: serialise(entry.before),
    after: serialise(entry.after),
  });
}

/** BigInt is not JSON-serialisable, and money columns are BigInt. */
function serialise(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value, (_key, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
}
