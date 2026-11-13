"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { AiLogo, type AiName } from "@/components/ai-logos";
import { cn } from "@/lib/cn";
import { ChannelIntro } from "./parts";
import { PinnedTabs } from "./pinned-tabs";
import { BeforeAfter } from "./edit-rules";
import { VoteBar } from "./vote-bar";

/**
 * #votes: the one place every decision is voted on: spends, roles and rule
 * changes. Each card shows what's being decided, the vote bar, who voted
 * which way (with the AI that cast it), and the user's own vote. The user's
 * AI votes within their limits; anything outside them waits here for a tap.
 *
 * UI only: the votes are samples and nothing is recorded. The percentages
 * needed are the group's real ones.
 */

export interface VoteNeeds {
  smallSpend: string;
  largeSpend: string;
  admin: string;
  rules: string;
  contribution: string;
}

type Kind = "SPEND" | "ROLE" | "RULE" | "ORDER";
type Tab = "needs" | "open" | "closed";

interface Voter {
  name: string;
  ai: AiName | null;
}

interface Vote {
  id: string;
  kind: Kind;
  title: string;
  /** Spends: amount and recipient. Roles: the change. */
  detail?: string;
  receipt?: string;
  change?: { before: string; after: string };
  need: keyof VoteNeeds;
  members: number;
  yes: Voter[];
  no: Voter[];
  closes: string;
  /** The user's vote: cast by their AI, or waiting for them, and why. */
  mine: { vote: "yes" | "no"; by: string } | { waiting: string };
}

interface Closed {
  id: string;
  kind: Kind;
  title: string;
  passed: boolean;
  result: string;
}

const OPEN: Vote[] = [
  {
    id: "v1",
    kind: "SPEND",
    title: "Airbnb deposit for December",
    detail: "USDC 400 to Kemi",
    receipt: "https://www.airbnb.com/rooms/sample",
    need: "smallSpend",
    members: 8,
    yes: [
      { name: "Ade", ai: "Claude" },
      { name: "Tunde", ai: "Claude" },
      { name: "Kemi", ai: "ChatGPT" },
      { name: "Amaka", ai: "Claude" },
    ],
    no: [{ name: "Femi", ai: null }],
    closes: "Friday",
    mine: { waiting: "It's above your limit, so it needs you." },
  },
  {
    id: "v2",
    kind: "RULE",
    title: "Large spends",
    change: { before: "67% must agree", after: "75% must agree" },
    need: "rules",
    members: 8,
    yes: [
      { name: "Amaka", ai: "Claude" },
      { name: "Bisi", ai: null },
      { name: "You", ai: "Claude" },
    ],
    no: [],
    closes: "Monday",
    mine: { vote: "yes", by: "your Claude, 2h ago" },
  },
  {
    id: "v3",
    kind: "ROLE",
    title: "Remove Femi as admin",
    need: "admin",
    members: 8,
    yes: [
      { name: "Tunde", ai: "Claude" },
      { name: "Chidi", ai: "Grok" },
      { name: "Kemi", ai: "ChatGPT" },
      { name: "You", ai: "Claude" },
    ],
    no: [{ name: "Femi", ai: null }],
    closes: "Friday",
    mine: { vote: "yes", by: "your Claude, yesterday" },
  },
];

/** Rotating savings: no spends; swaps and order changes instead. */
const ROTATING_OPEN: Vote[] = [
  {
    id: "r1",
    kind: "ORDER",
    title: "Swap turns: Kemi and Chidi",
    change: { before: "Kemi round 5, Chidi round 7", after: "Chidi round 5, Kemi round 7" },
    need: "rules",
    members: 8,
    yes: [
      { name: "Kemi", ai: "ChatGPT" },
      { name: "Chidi", ai: "Grok" },
      { name: "Ade", ai: "Claude" },
    ],
    no: [],
    closes: "Thursday",
    mine: { waiting: "Your limits say changes to the order need you." },
  },
  OPEN[2],
];

const ROTATING_CLOSED: Closed[] = [
  { id: "rc1", kind: "ORDER", title: "Swap turns: Ade and Bisi", passed: true, result: "Passed 20 Aug · 7 of 8" },
  { id: "rc2", kind: "ROLE", title: "Make Tunde an admin", passed: true, result: "Passed 3 Oct · 6 of 8" },
];

const CLOSED: Closed[] = [
  { id: "c1", kind: "SPEND", title: "Generator repair · USDC 400 to Musa", passed: true, result: "Passed 12 Nov · 6 of 8" },
  { id: "c2", kind: "ROLE", title: "Make Tunde an admin", passed: true, result: "Passed 3 Oct · 6 of 8" },
  { id: "c3", kind: "RULE", title: "What everyone pays · USDC 80 → 100", passed: false, result: "Didn't pass 1 Sep · 3 of 8" },
];

export function Votes({ needs, rotating }: { needs: VoteNeeds; rotating: boolean }) {
  const open = rotating ? ROTATING_OPEN : OPEN;
  const closed = rotating ? ROTATING_CLOSED : CLOSED;
  // The user's taps on votes waiting for them, kept on screen only.
  const [cast, setCast] = useState<Record<string, "yes" | "no">>({});
  const needsYou = open.filter((vote) => "waiting" in vote.mine && !cast[vote.id]);
  const [tab, setTab] = useState<Tab>(needsYou.length > 0 ? "needs" : "open");

  const tabs: { value: Tab; label: string; count?: number }[] = [
    ...(needsYou.length > 0 ? [{ value: "needs" as const, label: "Needs you", count: needsYou.length }] : []),
    { value: "open", label: "Open", count: open.length },
    { value: "closed", label: "Closed" },
  ];

  const shown = tab === "needs" ? needsYou : open;

  return (
    <div className="flex min-h-full flex-col">
      <PinnedTabs label="Votes" tabs={tabs} active={tab} onChange={setTab} />

      <div role="tabpanel" className="pt-6">
        <ChannelIntro title="Votes">
          Every decision the group is making. Your Claude votes within your limits; anything outside them waits here for you.
        </ChannelIntro>

        <div className="mt-8 max-w-xl space-y-4">
          {tab !== "closed" &&
            shown.map((vote) => (
              <VoteCard
                key={vote.id}
                vote={vote}
                need={needs[vote.need]}
                tapped={cast[vote.id]}
                onVote={(choice) => {
                  const next = { ...cast, [vote.id]: choice };
                  setCast(next);
                  const left = open.filter((v) => "waiting" in v.mine && !next[v.id]);
                  if (tab === "needs" && left.length === 0) setTab("open");
                }}
              />
            ))}

          {tab === "closed" && (
            <ul className="divide-y divide-border">
              {closed.map((vote) => (
                <li key={vote.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-3 text-sm">
                  <KindTag kind={vote.kind} />
                  <span className="min-w-0 flex-1 text-ink">{vote.title}</span>
                  <span className={cn("shrink-0 text-xs", vote.passed ? "text-inflow" : "text-ink-faint")}>{vote.result}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function KindTag({ kind }: { kind: Kind }) {
  return (
    <span className="shrink-0 rounded-[4px] bg-overlay px-1.5 py-px text-[0.6875rem] leading-4 font-semibold tracking-wide text-ink-muted">
      {kind}
    </span>
  );
}

function VoteCard({
  vote,
  need,
  tapped,
  onVote,
}: {
  vote: Vote;
  need: string;
  tapped: "yes" | "no" | undefined;
  onVote: (choice: "yes" | "no") => void;
}) {
  // A tap adds the user to the tally on screen.
  const yes = tapped === "yes" ? [...vote.yes, { name: "You", ai: null }] : vote.yes;
  const no = tapped === "no" ? [...vote.no, { name: "You", ai: null }] : vote.no;

  return (
    <article className="rounded-[var(--radius-card)] border border-border bg-surface p-5">
      <div className="flex items-center justify-between gap-3">
        <KindTag kind={vote.kind} />
        <span className="text-xs text-ink-faint">closes {vote.closes}</span>
      </div>

      <h3 className="mt-3 text-lg font-semibold text-ink">{vote.title}</h3>
      {vote.change && (
        <p className="mt-1 text-base tabular-nums">
          <BeforeAfter before={vote.change.before} after={vote.change.after} />
        </p>
      )}
      {vote.detail && <p className="mt-1 text-sm text-ink-muted tabular-nums">{vote.detail}</p>}
      {vote.receipt && (
        <p className="mt-1 text-sm">
          <a
            href={vote.receipt}
            target="_blank"
            rel="noreferrer"
            className="text-ink-muted underline decoration-ink-faint underline-offset-4 hover:text-ink hover:decoration-ink"
          >
            Receipt: {vote.receipt.replace(/^https?:\/\/(www\.)?/, "")}
          </a>
        </p>
      )}

      <div className="mt-5">
        <VoteBar yes={yes.length} members={vote.members} need={need} />
      </div>

      <dl className="mt-4 space-y-1.5 text-sm">
        <Voters label="Yes" voters={yes} />
        <Voters label="No" voters={no} />
      </dl>

      <div className="mt-5 border-t border-border pt-4 text-sm">
        <p className="text-ink-muted">
          Your vote{" "}
          {tapped ? (
            <span className="text-ink">{tapped === "yes" ? "Yes" : "No"} · just now</span>
          ) : "vote" in vote.mine ? (
            <span className="text-ink">
              {vote.mine.vote === "yes" ? "Yes" : "No"} · by {vote.mine.by}
            </span>
          ) : (
            <span className="text-pending">Waiting for you</span>
          )}
        </p>
        {!tapped && "waiting" in vote.mine && (
          <>
            <p className="mt-1 text-xs text-ink-faint">{vote.mine.waiting}</p>
            <div className="mt-3 flex gap-2">
              <Button type="button" size="sm" onClick={() => onVote("yes")}>
                Yes
              </Button>
              <Button type="button" variant="secondary" size="sm" onClick={() => onVote("no")}>
                No
              </Button>
            </div>
          </>
        )}
        {tapped && <p className="mt-1 text-xs text-ink-faint">Shown here only for now. Voting for real comes in a later step.</p>}
      </div>
    </article>
  );
}

/** Who voted one way, each with the logo of the AI that cast it, if any. */
function Voters({ label, voters }: { label: string; voters: Voter[] }) {
  return (
    <div className="flex gap-3">
      <dt className="w-8 shrink-0 text-ink-muted">{label}</dt>
      <dd className="flex min-w-0 flex-wrap gap-x-3 gap-y-1">
        {voters.length === 0 ? (
          <span className="text-ink-faint">Nobody yet</span>
        ) : (
          voters.map((voter) => (
            <span key={voter.name} className="inline-flex items-center gap-1 text-ink">
              {voter.name}
              {voter.ai && (
                <span title={`Voted by ${voter.name}'s ${voter.ai}`} className="inline-grid size-4 place-items-center">
                  <AiLogo name={voter.ai} className="size-3" />
                  <span className="sr-only">(by {voter.ai})</span>
                </span>
              )}
            </span>
          ))
        )}
      </dd>
    </div>
  );
}
