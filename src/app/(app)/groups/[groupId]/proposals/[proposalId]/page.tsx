import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/session";
import { getProposal } from "@/modules/governance/service";
import { formatPermille } from "@/modules/governance/threshold";
import { Card, CardHeader } from "@/components/ui/card";
import { VoteBar, PROPOSAL_STATUS } from "@/components/proposal-card";
import { VotePanel } from "./vote-panel";
import { ExecutePanel } from "./execute-panel";
import { getReleaseForProposal } from "@/modules/releases/service";
import { getMembership } from "@/modules/groups/service";
import { can } from "@/lib/auth/policy";
import { cn } from "@/lib/cn";

export async function generateMetadata({
  params,
}: PageProps<"/groups/[groupId]/proposals/[proposalId]">): Promise<Metadata> {
  const { proposalId } = await params;
  const user = await requireUser();
  const proposal = await getProposal(proposalId, user.id);
  return { title: proposal?.title ?? "Proposal" };
}

export default async function ProposalPage({
  params,
}: PageProps<"/groups/[groupId]/proposals/[proposalId]">) {
  const { groupId, proposalId } = await params;
  const user = await requireUser();

  const proposal = await getProposal(proposalId, user.id);
  if (!proposal) notFound();

  const [release, membership] = await Promise.all([
    getReleaseForProposal(proposalId),
    getMembership(groupId, user.id),
  ]);

  // Admins execute; the group decides. The server re-checks on submit.
  const canExecute = membership ? can("proposal.execute", membership).allowed : false;

  const status = PROPOSAL_STATUS[proposal.status];
  const { yes, no, abstain } = proposal.tally;

  return (
    <main className="animate-rise space-y-6">
      <div>
        <Link
          href={`/groups/${groupId}/proposals`}
          className="text-sm text-ink-muted transition-colors hover:text-ink"
        >
          ← Proposals
        </Link>

        <div className="mt-3 flex items-start justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            {proposal.title}
          </h1>
          <span
            className={cn(
              "mt-1 shrink-0 rounded-full px-2.5 py-1 text-[0.6875rem] font-medium",
              status.chip,
            )}
          >
            {status.label}
          </span>
        </div>

        <p className="mt-1 text-sm text-ink-muted">
          Proposed by {proposal.createdByName}
        </p>
      </div>

      {proposal.amount && (
        <Card raised>
          <p className="text-sm text-ink-muted">Amount requested</p>
          <p className="mt-1 text-[2rem] leading-tight font-semibold tracking-tight">
            {proposal.amount.format({ compact: true })}
          </p>
          {proposal.destination && (
            <p className="mt-2 text-sm text-ink-muted">
              To: <span className="text-ink">{proposal.destination}</span>
            </p>
          )}
        </Card>
      )}

      <Card>
        <CardHeader title="Why" />
        <p className="text-sm leading-relaxed whitespace-pre-wrap text-ink">
          {proposal.reason}
        </p>
      </Card>

      <Card>
        <CardHeader title="The vote" />

        <VoteBar
          tally={proposal.tally}
          eligible={proposal.eligibleVoterCount}
          className="mt-0"
        />

        <dl className="mt-4 grid grid-cols-3 gap-3 text-center">
          <Stat label="For" value={yes} tone="text-inflow" />
          <Stat label="Against" value={no} tone="text-danger" />
          <Stat label="Abstain" value={abstain} tone="text-ink-muted" />
        </dl>

        <p className="mt-4 text-sm text-ink-muted">
          {formatPermille(proposal.thresholdPermille)} of the decisive votes must
          be in favour, and {proposal.quorumPct}% of{" "}
          {proposal.eligibleVoterCount} members must vote.
        </p>

        {proposal.status === "OPEN" && (
          <p className="mt-2 text-sm text-ink-faint">
            {describeNeeded(proposal)} · {timeLeft(proposal.closesAt)}
          </p>
        )}

        {proposal.outcomeReason && (
          <p
            className={cn(
              "mt-4 rounded-lg px-3 py-2 text-sm",
              proposal.status === "APPROVED"
                ? "bg-inflow-soft text-inflow"
                : "bg-raised text-ink-muted",
            )}
          >
            {proposal.outcomeReason}
          </p>
        )}
      </Card>

      <Card>
        <CardHeader title="Your vote" />
        <VotePanel
          proposalId={proposalId}
          groupId={groupId}
          yourVote={proposal.yourVote}
          canVote={proposal.canVote}
        />
      </Card>

      {proposal.votes.length > 0 && (
        <Card inset={false}>
          <div className="px-5 pt-5">
            <CardHeader title="Who voted" />
          </div>
          <ul className="divide-y divide-border">
            {proposal.votes.map((vote) => (
              <li key={vote.userId} className="px-5 py-3.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-sm text-ink">
                    {vote.displayName}
                    {vote.isYou && <span className="text-ink-faint"> (you)</span>}
                  </span>
                  <span className={cn("shrink-0 text-sm", CHOICE_TONE[vote.choice])}>
                    {CHOICE_LABEL[vote.choice]}
                  </span>
                </div>
                {vote.reason && (
                  <p className="mt-1 text-sm text-ink-muted">{vote.reason}</p>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {proposal.status === "APPROVED" && proposal.amount && (
        <Card>
          <CardHeader title="Pay it out" />
          {canExecute ? (
            <ExecutePanel
              proposalId={proposalId}
              groupId={groupId}
              amount={proposal.amount.format({ compact: true })}
              destination={proposal.destination ?? "the agreed destination"}
            />
          ) : (
            <p className="text-sm text-ink-muted">
              The group approved this and{" "}
              {proposal.amount.format({ compact: true })} is reserved. An admin
              has to make the payment.
            </p>
          )}
        </Card>
      )}

      {release && (
        <Card>
          <CardHeader title="Payout" />
          <dl className="space-y-3 text-sm">
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-ink-muted">Status</dt>
              <dd
                className={
                  release.status === "EXECUTED" ? "text-inflow" : "text-danger"
                }
              >
                {release.status === "EXECUTED" ? "Sent" : "Failed"}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-ink-muted">To</dt>
              <dd className="text-right text-ink">{release.destination}</dd>
            </div>
            {release.executedByName && (
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-ink-muted">
                  {release.recordedManually ? "Recorded by" : "Sent by"}
                </dt>
                <dd className="text-ink">{release.executedByName}</dd>
              </div>
            )}
          </dl>
          {release.failureReason && (
            <p className="mt-4 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
              {release.failureReason} The money went back to the group. A fresh
              proposal is needed to try again.
            </p>
          )}
        </Card>
      )}
    </main>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: string;
}) {
  return (
    <div>
      <dd className={cn("text-2xl font-semibold tabular-nums", tone)}>{value}</dd>
      <dt className="mt-0.5 text-xs text-ink-muted">{label}</dt>
    </div>
  );
}

const CHOICE_LABEL = { YES: "For", NO: "Against", ABSTAIN: "Abstained" } as const;
const CHOICE_TONE = {
  YES: "text-inflow",
  NO: "text-danger",
  ABSTAIN: "text-ink-muted",
} as const;

function describeNeeded(proposal: {
  needed: { moreYesVotes: number; moreVotesForQuorum: number };
}): string {
  const { moreYesVotes, moreVotesForQuorum } = proposal.needed;

  if (moreYesVotes === 0 && moreVotesForQuorum === 0) {
    return "It has the support it needs";
  }
  if (moreYesVotes > 0) {
    return `${moreYesVotes} more ${moreYesVotes === 1 ? "vote" : "votes"} in favour needed`;
  }
  return `${moreVotesForQuorum} more ${moreVotesForQuorum === 1 ? "member" : "members"} must vote`;
}

function timeLeft(closesAt: Date): string {
  const ms = closesAt.getTime() - Date.now();
  if (ms <= 0) return "voting has closed";

  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 1) return "closes within the hour";
  if (hours < 24) return `closes in ${hours} hours`;

  const days = Math.round(hours / 24);
  return `closes in ${days} ${days === 1 ? "day" : "days"}`;
}
