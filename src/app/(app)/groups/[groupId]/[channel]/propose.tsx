"use client";

import Link from "next/link";
import type { Route } from "next";
import { useDraftActions } from "./use-draft-actions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { DateDivider, Detail, RallMessage } from "./parts";

/**
 * #propose a spend, agent-first: there's no form. The user asks their Claude
 * to propose; Claude's drafts land here as Rall's summary, and the user sends
 * each one to a vote with a tap (the Face ID step Claude can't do). Below the
 * drafts, the user's recent proposals and how they're going.
 *
 * Real: the drafts Claude made, and Discard. Still a sample: the recent
 * proposals, and sending (which goes on Base with the contract step).
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
  /** "USDC 400" */
  amountLabel: string;
  /** For the small/large spend rule. */
  amountMajor: number;
  /** "Kemi (member)" or "0x4fcb…1234 (outside the group)" */
  paidTo: string;
  receipt: string | null;
  /** "Drafted by Claude · 16 Nov, 11:40" */
  made: string;
}

const SAMPLE_PROPOSALS = [
  { id: "p1", what: "Generator repair", amount: "USDC 400", status: "Passed", detail: "6 of 8 voted yes", tone: "inflow" as const },
  { id: "p2", what: "Birthday cake for Bisi", amount: "USDC 60", status: "Voting", detail: "3 of 8 so far · closes Friday", tone: "pending" as const },
];

export function ProposeChannel({ base, rules, drafts }: { base: string; rules: ProposeRules; drafts: SpendDraftView[] }) {
  const actions = useDraftActions();

  return (
    <>
      {/* How to propose: through Claude. */}
      <RallMessage time="Pinned" body="text" footnote={null}>
        <p className="text-ink">Ask your Claude to propose a spend. For example:</p>
        <ul className="mt-2 space-y-1 text-ink-muted">
          <li>&ldquo;Propose USDC 400 for the Airbnb deposit, paid to Kemi.&rdquo;</li>
          <li>&ldquo;Ask the group to pay Musa USDC 150 for the generator. Here&rsquo;s his invoice.&rdquo;</li>
        </ul>
        <p className="mt-2 text-ink-muted">Claude&rsquo;s draft shows up here for you to check and send.</p>
      </RallMessage>

      <DateDivider label="Waiting for you" />
      {drafts.length === 0 ? (
        <p className="mt-4 text-sm text-ink-muted">No drafts. When Claude prepares a proposal, it appears here.</p>
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
      <ul className="mt-4 max-w-xl space-y-1">
        {SAMPLE_PROPOSALS.map((proposal) => (
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
                  "shrink-0 rounded-full px-2 py-0.5 text-xs",
                  proposal.tone === "inflow" ? "bg-inflow-soft text-inflow" : "bg-pending-soft text-pending",
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
