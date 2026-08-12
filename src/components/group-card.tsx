import Link from "next/link";
import type { GroupSummary } from "@/modules/groups/service";
import { Money } from "@/lib/money";

const CADENCE_LABEL = { WEEKLY: "weekly", MONTHLY: "monthly" } as const;

/**
 * A group at a glance. The balance is the hero; everything else is context.
 * Balance is zero until the ledger lands in Phase 2 — shown rather than hidden
 * so the shape of the card is honest from the start.
 */
export function GroupCard({ group }: { group: GroupSummary }) {
  return (
    <Link
      href={`/groups/${group.id}`}
      className="block rounded-[var(--radius-card)] border border-border bg-surface p-5 transition-colors duration-150 hover:border-border-strong hover:bg-raised"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-medium text-ink">{group.name}</h3>
          <p className="mt-0.5 text-sm text-ink-muted">
            {group.memberCount} member{group.memberCount === 1 ? "" : "s"}
            {group.role !== "MEMBER" && (
              <> · {group.role === "OWNER" ? "Owner" : "Admin"}</>
            )}
          </p>
        </div>
        <TypeBadge type={group.type} />
      </div>

      <div className="mt-4 flex items-end justify-between gap-3">
        <div>
          <p className="text-2xl font-semibold tracking-tight text-ink">
            {Money.zero().format({ compact: true })}
          </p>
          <p className="text-xs text-ink-faint">group balance</p>
        </div>
        <p className="text-right text-sm text-ink-muted">
          {group.contributionAmount.format({ compact: true })}
          <span className="text-ink-faint"> {CADENCE_LABEL[group.cadence]}</span>
        </p>
      </div>
    </Link>
  );
}

function TypeBadge({ type }: { type: GroupSummary["type"] }) {
  const rotating = type === "ROTATING";
  return (
    <span
      className={
        "shrink-0 rounded-full px-2.5 py-1 text-[0.6875rem] font-medium " +
        (rotating
          ? "bg-locked-soft text-locked"
          : "bg-accent-soft text-accent")
      }
    >
      {rotating ? "Rotating" : "Treasury"}
    </span>
  );
}
