"use client";

import Link from "next/link";
import type { Route } from "next";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { DateDivider, Detail, RallMessage } from "./parts";

/**
 * #propose a spend, agent-first: there's no form. The user asks their Claude
 * to propose; Claude's drafts land here as Rall's summary, and the user sends
 * each one to a vote with a tap (the Face ID step Claude can't do). Below the
 * drafts, the user's recent proposals and how they're going.
 *
 * UI only: the draft and the proposals are samples, and nothing is sent.
 */

export interface ProposeRules {
  /** The pot today, in whole dollars. A spend over 20% of it is "large". */
  pot: number;
  smallPercent: string;
  largePercent: string;
  votingDays: number;
}

const LARGE_SPEND_SHARE = 0.2; // JfkModule.LARGE_SPEND_PERMILLE = 200

interface Draft {
  id: string;
  what: string;
  amount: number;
  paidTo: string;
  receipt: string | null;
}

const SAMPLE_DRAFTS: Draft[] = [
  {
    id: "d1",
    what: "Airbnb deposit for December",
    amount: 400,
    paidTo: "Kemi (member)",
    receipt: "https://www.airbnb.com/rooms/sample",
  },
];

const SAMPLE_PROPOSALS = [
  { id: "p1", what: "Generator repair", amount: "USDC 400", status: "Passed", detail: "6 of 8 voted yes", tone: "inflow" as const },
  { id: "p2", what: "Birthday cake for Bisi", amount: "USDC 60", status: "Voting", detail: "3 of 8 so far · closes Friday", tone: "pending" as const },
];

export function ProposeChannel({ base, rules }: { base: string; rules: ProposeRules }) {
  const [drafts, setDrafts] = useState(SAMPLE_DRAFTS);
  const [notice, setNotice] = useState<string | null>(null);

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
          const large = draft.amount > rules.pot * LARGE_SPEND_SHARE;
          return (
            <RallMessage
              key={draft.id}
             
              time="Drafted by your Claude · just now"
              footnote={
                <div className="space-y-3 border-t border-border pt-4">
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => setNotice("Sending to a vote comes in a later step. Nothing was sent.")}
                    >
                      Send to vote
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setDrafts((current) => current.filter((d) => d.id !== draft.id));
                        setNotice(null);
                      }}
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
                <span className="tabular-nums">USDC {draft.amount.toLocaleString("en-US")}</span>
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
