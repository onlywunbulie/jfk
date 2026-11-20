"use client";

import Link from "next/link";
import type { Route } from "next";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { ChannelIntro } from "./parts";
import { PinnedTabs } from "./pinned-tabs";
import { useDraftActions } from "./use-draft-actions";
import { EmptyState } from "@/components/empty-state";

/**
 * #edit rules: only about changes. The rules themselves live in #rules, and
 * changes being voted on live in #votes. Here: Claude's drafts waiting for
 * the user, and the history of past changes, each shown as before → after.
 *
 * Money changes start from the next round; everything else applies as soon
 * as the vote passes.
 *
 * All real: the drafts Claude made, Discard, Send to vote, the percentages
 * needed, and the history (the group's decided rule votes, read from Base).
 */

export interface EditRulesNeeds {
  /** Share needed to change what everyone pays, e.g. "60%". */
  contribution: string;
  /** Share needed to change any other rule. */
  rules: string;
}

type Tab = "waiting" | "history";

/** A rule-change draft, ready to show: formatted on the server. */
export interface RuleDraftView {
  id: string;
  rule: string;
  before: string;
  after: string;
  /** When it takes effect if it passes. */
  starts: string;
  money: boolean;
  /** "Drafted by Claude · 16 Nov, 11:40" */
  made: string;
}

type Change = Omit<RuleDraftView, "made">;

/** A decided rule vote, from Base. */
export interface PastChange {
  id: string;
  rule: string;
  /** "Now $2.00", when it passed and says what it became. */
  outcome: string | null;
  passed: boolean;
  /** "Passed · 1 of 1 yes" */
  result: string;
}

export function EditRules({
  base,
  needs,
  voting,
  drafts,
  history,
}: {
  base: string;
  needs: EditRulesNeeds;
  voting: number;
  drafts: RuleDraftView[];
  history: PastChange[];
}) {
  const actions = useDraftActions();
  const [chosen, setTab] = useState<Tab>(drafts.length > 0 ? "waiting" : "history");
  // Once the last draft is discarded there's no Waiting tab to stay on.
  const tab: Tab = chosen === "waiting" && drafts.length === 0 ? "history" : chosen;

  const tabs: { value: Tab; label: string; count?: number }[] = [
    ...(drafts.length > 0 ? [{ value: "waiting" as const, label: "Waiting", count: drafts.length }] : []),
    { value: "history", label: "History" },
  ];

  const needFor = (change: Change) => (change.money ? needs.contribution : needs.rules);

  return (
    <div className="flex min-h-full flex-col">
      <PinnedTabs label="Rule changes" tabs={tabs} active={tab} onChange={setTab} />

      <div role="tabpanel" className="pt-6">
        <ChannelIntro title="Edit rules">
          Changes to the group&rsquo;s rules. Ask your Claude to propose one, for example{" "}
          <span className="text-ink">&ldquo;Propose moving the due day to the 1st.&rdquo;</span> Today&rsquo;s rules are in #rules.
        </ChannelIntro>

        {voting > 0 && (
          <p className="mt-4 text-sm text-ink-muted">
            {voting} rule {voting === 1 ? "change is" : "changes are"} being voted on in{" "}
            <Link
              href={`${base}/votes` as Route}
              className="text-ink underline decoration-ink-faint underline-offset-4 hover:decoration-ink"
            >
              #votes
            </Link>
            .
          </p>
        )}

        {/* Empty history: centred across the whole channel, not inside the narrow list column. */}
        {tab === "history" && history.length === 0 && (
          <EmptyState illustration="no-rule-changes" size="sm" title="No rule changes yet" className="mt-8">
            Changes show here once their vote on Base closes.
          </EmptyState>
        )}

        <div className="mt-8 max-w-xl space-y-4">
          {tab === "waiting" &&
            drafts.map((draft) => (
              <ChangeCard key={draft.id} change={draft} eyebrow={draft.made}>
                <p className="mt-4 text-sm text-ink-muted">
                  {needFor(draft)} must agree · voting closes 3 days after it&rsquo;s sent
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
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
                {actions.noticeFor(draft.id) && (
                  <p role="status" className="mt-3 text-xs text-ink-muted">
                    {actions.noticeFor(draft.id)}
                  </p>
                )}
              </ChangeCard>
            ))}

          {tab === "history" && (
            history.length === 0 ? null : (
              <ul className="divide-y divide-border">
                {history.map((past) => (
                  <li key={past.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-3 text-sm">
                    <span className="w-44 shrink-0 text-ink">{past.rule}</span>
                    <span className={cn("min-w-0 flex-1 tabular-nums", past.passed ? "text-ink" : "text-ink-faint")}>{past.outcome ?? ""}</span>
                    <span className={cn("shrink-0 text-xs", past.passed ? "text-inflow" : "text-ink-faint")}>{past.result}</span>
                  </li>
                ))}
              </ul>
            )
          )}
        </div>
      </div>
    </div>
  );
}

/** The old value struck through, an arrow, then the new value. */
export function BeforeAfter({
  before,
  after,
  strong = true,
  dim = false,
}: {
  before: string;
  after: string;
  strong?: boolean;
  dim?: boolean;
}) {
  return (
    <>
      <span className="text-ink-faint line-through">{before}</span>
      <span aria-hidden="true" className="mx-2 text-ink-faint">
        →
      </span>
      <span className="sr-only"> changed to </span>
      <span className={cn(dim ? "text-ink-muted" : "text-ink", strong && "font-semibold")}>{after}</span>
    </>
  );
}

/** One proposed change: which rule, old value struck through → new value, and when it starts. */
function ChangeCard({ change, eyebrow, children }: { change: Change; eyebrow?: string; children: ReactNode }) {
  return (
    <article className="rounded-[var(--radius-card)] border border-border bg-surface p-5">
      {eyebrow && <p className="mb-2 text-xs text-ink-faint">{eyebrow}</p>}
      <h3 className="text-sm text-ink-muted">{change.rule}</h3>
      <p className="mt-1 text-lg tabular-nums">
        <BeforeAfter before={change.before} after={change.after} />
      </p>
      <p className="mt-1 text-sm text-ink-muted">{change.starts}</p>
      {children}
    </article>
  );
}
