"use client";

import Link from "next/link";
import type { Route } from "next";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { ChannelIntro } from "./parts";
import { PinnedTabs } from "./pinned-tabs";
import { useDraftActions } from "./use-draft-actions";

/**
 * #edit rules: only about changes. The rules themselves live in #rules, and
 * changes being voted on live in #votes. Here: Claude's drafts waiting for
 * the user, and the history of past changes, each shown as before → after.
 *
 * Money changes start from the next round; everything else applies as soon
 * as the vote passes.
 *
 * Real: the drafts Claude made, Discard, and the percentages needed. Still a
 * sample: the history, and sending (which goes on Base with the contract step).
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

interface Past {
  id: string;
  rule: string;
  before: string;
  after: string;
  passed: boolean;
  result: string;
}

const PAST: Past[] = [
  { id: "h1", rule: "Due day", before: "1st", after: "5th", passed: true, result: "Passed 2 Oct · 7 of 8" },
  { id: "h2", rule: "Votes stay open", before: "3 days", after: "5 days", passed: true, result: "Passed 14 Sep · 6 of 8" },
  { id: "h3", rule: "What everyone pays", before: "USDC 80", after: "USDC 100", passed: false, result: "Didn't pass 1 Sep · 3 of 8" },
];

export function EditRules({
  base,
  needs,
  voting,
  drafts,
}: {
  base: string;
  needs: EditRulesNeeds;
  voting: number;
  drafts: RuleDraftView[];
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

        <div className="mt-8 max-w-xl space-y-4">
          {tab === "waiting" &&
            drafts.map((draft) => (
              <ChangeCard key={draft.id} change={draft} eyebrow={draft.made}>
                <p className="mt-4 text-sm text-ink-muted">
                  {needFor(draft)} must agree · voting closes 3 days after it&rsquo;s sent
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button type="button" size="sm" onClick={() => actions.send(draft.id)}>
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
            <ul className="divide-y divide-border">
              {PAST.map((past) => (
                <li key={past.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-3 text-sm">
                  <span className="w-36 shrink-0 text-ink">{past.rule}</span>
                  <span className="min-w-0 flex-1 tabular-nums">
                    <BeforeAfter before={past.before} after={past.after} strong={false} dim={!past.passed} />
                  </span>
                  <span className={cn("shrink-0 text-xs", past.passed ? "text-inflow" : "text-ink-faint")}>{past.result}</span>
                </li>
              ))}
            </ul>
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
