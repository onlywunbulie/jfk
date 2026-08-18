import Link from "next/link";
import type { ProposalSummary } from "@/modules/governance/service";
import { formatPermille } from "@/modules/governance/threshold";
import { cn } from "@/lib/cn";

/**
 * A proposal in a list. The vote bar is the point: at a glance you should see
 * how close it is and whether you have had your say.
 */
export function ProposalCard({
  proposal,
  groupId,
}: {
  proposal: ProposalSummary;
  groupId: string;
}) {
  const { yes, no, abstain } = proposal.tally;
  const cast = yes + no + abstain;
  const status = STATUS[proposal.status];

  return (
    <Link
      href={`/groups/${groupId}/proposals/${proposal.id}`}
      className="block rounded-[var(--radius-card)] border border-border bg-surface p-5 transition-colors hover:border-border-strong hover:bg-raised"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-medium text-ink">{proposal.title}</h3>
          {proposal.amount && (
            <p className="mt-0.5 text-lg font-semibold text-ink">
              {proposal.amount.format({ compact: true })}
            </p>
          )}
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full px-2.5 py-1 text-[0.6875rem] font-medium",
            status.chip,
          )}
        >
          {status.label}
        </span>
      </div>

      <VoteBar tally={proposal.tally} eligible={proposal.eligibleVoterCount} />

      <div className="mt-2.5 flex items-center justify-between gap-3 text-xs">
        <span className="text-ink-muted">
          {cast} of {proposal.eligibleVoterCount} voted ·{" "}
          {formatPermille(proposal.thresholdPermille)} needed
        </span>
        {proposal.yourVote ? (
          <span className="text-ink-faint">You voted {CHOICE[proposal.yourVote]}</span>
        ) : proposal.status === "OPEN" ? (
          <span className="font-medium text-accent">Your vote needed</span>
        ) : null}
      </div>
    </Link>
  );
}

/**
 * Yes / no / abstain as one stacked bar, sized against the whole membership so
 * the grey remainder is "people who haven't voted" rather than empty space.
 */
export function VoteBar({
  tally,
  eligible,
  className,
}: {
  tally: { yes: number; no: number; abstain: number };
  eligible: number;
  className?: string;
}) {
  const total = Math.max(eligible, tally.yes + tally.no + tally.abstain, 1);
  const pct = (n: number) => (n / total) * 100;

  return (
    <div
      className={cn("mt-4 flex h-2 gap-0.5 overflow-hidden rounded-full bg-canvas", className)}
      role="img"
      aria-label={`${tally.yes} for, ${tally.no} against, ${tally.abstain} abstained, of ${eligible} members`}
    >
      {tally.yes > 0 && (
        <div className="h-full bg-inflow" style={{ width: `${pct(tally.yes)}%` }} />
      )}
      {tally.no > 0 && (
        <div className="h-full bg-danger" style={{ width: `${pct(tally.no)}%` }} />
      )}
      {tally.abstain > 0 && (
        <div
          className="h-full bg-border-strong"
          style={{ width: `${pct(tally.abstain)}%` }}
        />
      )}
    </div>
  );
}

const CHOICE = { YES: "for", NO: "against", ABSTAIN: "abstain" } as const;

const STATUS: Record<ProposalSummary["status"], { label: string; chip: string }> = {
  OPEN: { label: "Voting", chip: "bg-accent-soft text-accent" },
  APPROVED: { label: "Approved", chip: "bg-inflow-soft text-inflow" },
  REJECTED: { label: "Rejected", chip: "bg-danger-soft text-danger" },
  EXPIRED: { label: "Expired", chip: "bg-raised text-ink-muted" },
  CANCELLED: { label: "Cancelled", chip: "bg-raised text-ink-muted" },
  EXECUTING: { label: "Paying out", chip: "bg-pending-soft text-pending" },
  EXECUTED: { label: "Paid out", chip: "bg-inflow-soft text-inflow" },
  EXECUTION_FAILED: { label: "Payout failed", chip: "bg-danger-soft text-danger" },
};

export { STATUS as PROPOSAL_STATUS };
