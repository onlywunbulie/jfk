"use client";

import Link from "next/link";
import type { Route } from "next";
import { useDraftActions } from "./use-draft-actions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { DateDivider, Detail, RallMessage } from "./parts";
import { EmptyState } from "@/components/empty-state";

/**
 * #propose a spend, agent-first: there's no form. The user asks their Claude
 * to propose; Claude's drafts land here as Rall's summary, and the user sends
 * each one to a vote with a tap (the Face ID step Claude can't do). Below the
 * drafts, the user's recent proposals and how they're going.
 *
 * All real: the drafts Claude made, Discard, Send to vote, and the user's
 * recent spend proposals (read from Base).
 */

export interface ProposeRules {
  /** The pot today, in whole dollars. A spend over 20% of it is "large". */
  pot: number;
  smallPercent: string;
  largePercent: string;
  votingDays: number;
}

const LARGE_SPEND_SHARE = 0.2; // JfkModule.LARGE_SPEND_PERMILLE = 200

/** A spend draft, ready to show: formatted on the server. */
export interface SpendDraftView {
  id: string;
  what: string;
  /** "$400.00" */
  amountLabel: string;
  /** For the small/large spend rule. */
  amountMajor: number;
  /** "Kemi (member)" or "0x4fcb…1234 (outside the group)" */
  paidTo: string;
  receipt: string | null;
  /** "Drafted by Claude · 16 Nov, 11:40" */
  made: string;
}

/** One of the user's spend proposals on Base, for the "recent" list. */
export interface RecentProposal {
  id: string;
  what: string;
  amount: string;
  status: string;
  detail: string;
  tone: "inflow" | "pending" | "muted";
}

/** A whole-group decision draft (closing the group), ready to show. */
export interface DecisionDraftView {
  id: string;
  /** "Close Detty December" */
  label: string;
  /** What happens if it passes. */
  detail: string;
  /** "80%" must agree */
  need: string;
  made: string;
}

export function ProposeChannel({
  base,
  rules,
  drafts,
  decisions,
  recent,
  rotating,
}: {
  base: string;
  rules: ProposeRules;
  drafts: SpendDraftView[];
  decisions: DecisionDraftView[];
  recent: RecentProposal[];
  /** Rotating savings: every round's money already has a destination, so no spends. */
  rotating: boolean;
}) {
  const actions = useDraftActions();

  return (
    <>
      {/* How to propose: through Claude. */}
      <RallMessage time="Pinned" body="text" footnote={null}>
        <p className="text-ink">Ask your Claude to propose. For example:</p>
        <ul className="mt-2 space-y-1 text-ink-muted">
          {!rotating && (
            <>
              <li>&ldquo;Propose $400 for the Airbnb deposit, paid to Kemi.&rdquo;</li>
              <li>&ldquo;Ask the group to pay Musa $150 for the generator. Here&rsquo;s his invoice.&rdquo;</li>
            </>
          )}
          <li>&ldquo;Propose closing the group and sharing out the pot.&rdquo;</li>
        </ul>
        <p className="mt-2 text-ink-muted">Changes to who&rsquo;s in the group go in #manage roles; changes to the rules in #edit rules.</p>
        <p className="mt-2 text-ink-muted">Claude&rsquo;s draft shows up here for you to check and send.</p>
      </RallMessage>

      <DateDivider label="Waiting for you" />
      {decisions.map((decision) => {
        const notice = actions.noticeFor(decision.id);
        return (
          <RallMessage
            key={decision.id}
            time={decision.made}
            footnote={
              <div className="space-y-3 border-t border-border pt-4">
                <div className="flex flex-wrap gap-2">
                  <Button type="button" size="sm" loading={Boolean(actions.sending(decision.id))} onClick={() => void actions.send(decision.id)}>
                    Send to vote
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    loading={actions.discarding(decision.id)}
                    onClick={() => actions.discard(decision.id)}
                  >
                    Discard
                  </Button>
                </div>
                {notice && (
                  <p role="status" className="text-xs text-ink-muted">
                    {notice}
                  </p>
                )}
              </div>
            }
          >
            <Detail label="Decision">{decision.label}</Detail>
            <Detail label="If it passes">{decision.detail}</Detail>
            <Detail label="To pass">{decision.need} must agree</Detail>
          </RallMessage>
        );
      })}
      {drafts.length === 0 && decisions.length === 0 ? (
        <EmptyState illustration="no-proposals" size="sm" title="No drafts waiting">
          When your AI prepares a proposal, it lands here for you to check and send to a vote.
        </EmptyState>
      ) : (
        drafts.map((draft) => {
          const large = draft.amountMajor > rules.pot * LARGE_SPEND_SHARE;
          const notice = actions.noticeFor(draft.id);
          return (
            <RallMessage
              key={draft.id}
              time={draft.made}
              footnote={
                <div className="space-y-3 border-t border-border pt-4">
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" loading={Boolean(actions.sending(draft.id))} onClick={() => void actions.send(draft.id)}>
                      Send to vote
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      loading={actions.discarding(draft.id)}
                      onClick={() => actions.discard(draft.id)}
                    >
                      Discard
                    </Button>
                  </div>
                  {notice && (
                    <p role="status" className="text-xs text-ink-muted">
                      {notice}
                    </p>
                  )}
                </div>
              }
            >
              <Detail label="For">{draft.what}</Detail>
              <Detail label="Amount">
                <span className="tabular-nums">{draft.amountLabel}</span>
              </Detail>
              <Detail label="Paid to">{draft.paidTo}</Detail>
              {draft.receipt && (
                <Detail label="Receipt">
                  <a
                    href={draft.receipt}
                    target="_blank"
                    rel="noreferrer"
                    className="break-all underline decoration-ink-faint underline-offset-4 hover:decoration-ink"
                  >
                    {draft.receipt.replace(/^https?:\/\/(www\.)?/, "")}
                  </a>
                </Detail>
              )}
              <Detail label="To pass">
                {large ? "A large spend" : "A small spend"}
                <span className="text-ink-muted"> · {large ? rules.largePercent : rules.smallPercent} must agree</span>
              </Detail>
              <Detail label="Voting">Closes {rules.votingDays} days after it&rsquo;s sent</Detail>
            </RallMessage>
          );
        })
      )}

      <DateDivider label="Your recent proposals" />
      {recent.length === 0 && <p className="mt-4 text-sm text-ink-muted">None yet. Spends you send to a vote show here.</p>}
      <ul className="mt-4 max-w-xl space-y-1">
        {recent.map((proposal) => (
          <li key={proposal.id}>
            <Link
              href={`${base}/votes` as Route}
              className="press -mx-3 flex items-center gap-3 rounded-[var(--radius-control)] px-3 py-2 text-sm transition-colors hover:bg-raised"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ink">{proposal.what}</span>
                <span className="block text-xs text-ink-faint">{proposal.detail}</span>
              </span>
              <span className="shrink-0 tabular-nums text-ink-muted">{proposal.amount}</span>
              <span
                className={cn(
                  "shrink-0 rounded-[4px] px-2 py-0.5 text-xs",
                  proposal.tone === "inflow" ? "bg-inflow-soft text-inflow" : proposal.tone === "muted" ? "bg-overlay text-ink-faint" : "bg-pending-soft text-pending",
                )}
              >
                {proposal.status}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
