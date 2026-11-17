"use client";

import { useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { EXPLORER_URL } from "@/lib/chain/addresses";
import { SEND_STAGE_TEXT, useSendToBase } from "@/lib/chain/use-send-to-base";
import type { ChainVote, ChainVotes } from "@/modules/groups/onchain-votes";
import { carryOutAction, prepareVoteAction } from "@/app/(app)/vote-actions";
import { ChannelIntro } from "./parts";
import { PinnedTabs } from "./pinned-tabs";
import { BeforeAfter } from "./edit-rules";
import { VoteBar } from "./vote-bar";

/**
 * #votes: every decision the group is making, read from Base. Each card
 * shows what's being decided, the vote bar, who voted which way, and the
 * user's own vote. Voting signs with the user's wallet; a vote that has
 * passed is carried out on Base by Rallied, straight after the deciding vote
 * or with a tap.
 */

type Tab = "needs" | "open" | "closed";

export function Votes({ live, base }: { live: ChainVotes; base: string }) {
  if (!live.ok) return <NoVotes reason={live.reason} base={base} />;

  return <VoteList votes={live.votes} safe={live.safe} base={base} />;
}

function VoteList({ votes, safe, base }: { votes: ChainVote[]; safe: string; base: string }) {
  const needsYou = votes.filter((vote) => vote.canVote);
  const open = votes.filter((vote) => vote.state === "OPEN" || vote.state === "PASSED");
  const closed = votes.filter((vote) => vote.state === "DONE" || vote.state === "FAILED");
  const [tab, setTab] = useState<Tab>(needsYou.length > 0 ? "needs" : "open");

  const tabs: { value: Tab; label: string; count?: number }[] = [
    ...(needsYou.length > 0 ? [{ value: "needs" as const, label: "Needs you", count: needsYou.length }] : []),
    { value: "open", label: "Open", count: open.length },
    { value: "closed", label: "Closed" },
  ];
  const shown = tab === "needs" ? needsYou : tab === "open" ? open : closed;

  return (
    <div className="flex min-h-full flex-col">
      <PinnedTabs label="Votes" tabs={tabs} active={tab} onChange={setTab} />

      <div role="tabpanel" className="pt-6">
        <ChannelIntro title="Votes">
          Every decision the group is making, straight from the group&rsquo;s vault on Base. Once a vote passes, Rallied carries it out.
        </ChannelIntro>

        <div className="mt-8 max-w-xl space-y-4">
          {shown.length === 0 && (
            <p className="text-sm text-ink-muted">
              {tab === "closed" ? (
                "Nothing decided yet."
              ) : (
                <>
                  Nothing being voted on. Ask your AI to draft a change, then send it from{" "}
                  <Link href={`${base}/edit-rules` as Route} className="text-ink underline decoration-ink-faint underline-offset-4 hover:decoration-ink">
                    #edit rules
                  </Link>{" "}
                  or{" "}
                  <Link href={`${base}/propose` as Route} className="text-ink underline decoration-ink-faint underline-offset-4 hover:decoration-ink">
                    #propose
                  </Link>
                  .
                </>
              )}
            </p>
          )}
          {shown.map((vote) => (
            <VoteCard key={vote.id} vote={vote} groupId={base.split("/").pop() ?? ""} />
          ))}
        </div>

        <p className="mt-8 text-sm text-ink-faint">
          Every vote is public on{" "}
          <a
            href={`${EXPLORER_URL}/address/${safe}`}
            target="_blank"
            rel="noreferrer"
            className="text-ink-muted underline decoration-ink-faint underline-offset-4 hover:text-ink"
          >
            BaseScan
          </a>
          .
        </p>
      </div>
    </div>
  );
}

function NoVotes({ reason, base }: { reason: Exclude<ChainVotes, { ok: true }>["reason"]; base: string }) {
  const text = {
    not_on_base: "Votes happen on Base, where nobody can change them afterwards. Start this group on Base first.",
    old_contract: "This group runs on Rallied's first contract, which this screen doesn't read. Start a new group to vote here.",
    unreachable: "Couldn't reach Base just now. Refresh in a moment.",
    not_found: "This group isn't available.",
  }[reason];
  return (
    <div className="pt-6">
      <ChannelIntro title="Votes">{text}</ChannelIntro>
      {reason === "not_on_base" && (
        <Link
          href={`${base}/about` as Route}
          className="mt-6 inline-block text-sm text-ink underline decoration-ink-faint underline-offset-4 hover:decoration-ink"
        >
          Go to #about to start it on Base
        </Link>
      )}
    </div>
  );
}

function KindTag({ kind }: { kind: ChainVote["kind"] }) {
  return (
    <span className="shrink-0 rounded-[4px] bg-overlay px-1.5 py-px text-[0.6875rem] leading-4 font-semibold tracking-wide text-ink-muted">
      {kind}
    </span>
  );
}

const STATE_TEXT: Record<ChainVote["state"], (vote: ChainVote) => string> = {
  OPEN: (vote) => `closes ${vote.closes}`,
  PASSED: () => "passed",
  DONE: () => "passed · carried out",
  FAILED: () => "didn't pass",
};

function VoteCard({ vote, groupId }: { vote: ChainVote; groupId: string }) {
  const router = useRouter();
  const sendToBase = useSendToBase();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Shown until the refreshed page (read from Base) catches up.
  const [justVoted, setJustVoted] = useState<"YES" | "NO" | null>(null);

  async function castVote(choice: "YES" | "NO") {
    setError(null);
    setBusy("Getting it ready…");
    try {
      const prepared = await prepareVoteAction(groupId, vote.id, choice);
      if (!prepared.ok) {
        setError(prepared.error);
        return;
      }
      const sent = await sendToBase({
        call: prepared.call,
        wallet: prepared.wallet,
        onStage: (stage, wallet) => setBusy(SEND_STAGE_TEXT[wallet][stage]),
      });
      if (!sent.ok) {
        setError(sent.error);
        return;
      }
      setJustVoted(choice);
      // If that was the deciding vote, Rallied carries it out straight away.
      setBusy("Checking the result…");
      await carryOutAction(groupId, vote.id);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function carryOut() {
    setError(null);
    setBusy("Carrying it out on Base…");
    try {
      const result = await carryOutAction(groupId, vote.id);
      if (!result.ok) setError(result.error);
      else router.refresh();
    } finally {
      setBusy(null);
    }
  }

  const yes = justVoted === "YES" && !vote.yes.includes("You") ? [...vote.yes, "You"] : vote.yes;
  const no = justVoted === "NO" && !vote.no.includes("You") ? [...vote.no, "You"] : vote.no;
  const mine = vote.mine ?? justVoted;

  return (
    <article className="rounded-[var(--radius-card)] border border-border bg-surface p-5">
      <div className="flex items-center justify-between gap-3">
        <KindTag kind={vote.kind} />
        <span className={cn("text-xs", vote.state === "PASSED" || vote.state === "DONE" ? "text-inflow" : "text-ink-faint")}>
          {STATE_TEXT[vote.state](vote)}
        </span>
      </div>

      <h3 className="mt-3 text-lg font-semibold text-ink">{vote.title}</h3>
      {vote.change && (
        <p className="mt-1 text-base tabular-nums">
          <BeforeAfter before={vote.change.before} after={vote.change.after} />
        </p>
      )}
      {vote.detail && <p className="mt-1 text-sm text-ink-muted tabular-nums">{vote.detail}</p>}

      <div className="mt-5">
        <VoteBar yes={yes.length} members={vote.eligible} need={vote.need} />
      </div>

      <dl className="mt-4 space-y-1.5 text-sm">
        <Voters label="Yes" voters={yes} />
        <Voters label="No" voters={no} />
      </dl>
      <p className="mt-3 text-xs text-ink-faint">Proposed by {vote.proposedBy}</p>

      <div className="mt-5 border-t border-border pt-4 text-sm">
        <p className="text-ink-muted">
          Your vote{" "}
          {mine ? (
            <span className="text-ink">{mine === "YES" ? "Yes" : mine === "NO" ? "No" : "Abstained"}</span>
          ) : vote.canVote ? (
            <span className="text-pending">Waiting for you</span>
          ) : (
            <span className="text-ink-faint">None</span>
          )}
        </p>

        {vote.canVote && !justVoted && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" disabled={busy !== null} onClick={() => castVote("YES")}>
              Yes
            </Button>
            <Button type="button" variant="secondary" size="sm" disabled={busy !== null} onClick={() => castVote("NO")}>
              No
            </Button>
          </div>
        )}

        {vote.state === "PASSED" && (
          <div className="mt-3">
            <Button type="button" size="sm" loading={busy !== null} onClick={carryOut}>
              Carry it out
            </Button>
            <p className="mt-1 text-xs text-ink-faint">It passed. Rallied runs it on Base and pays the fee.</p>
          </div>
        )}

        {busy && (
          <p role="status" className="mt-2 text-xs text-ink-muted">
            {busy}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-2 text-xs text-danger">
            {error}
          </p>
        )}
      </div>
    </article>
  );
}

/** Who voted one way. */
function Voters({ label, voters }: { label: string; voters: string[] }) {
  return (
    <div className="flex gap-3">
      <dt className="w-8 shrink-0 text-ink-muted">{label}</dt>
      <dd className="flex min-w-0 flex-wrap gap-x-3 gap-y-1">
        {voters.length === 0 ? <span className="text-ink-faint">Nobody yet</span> : voters.map((name) => <span key={name} className="text-ink">{name}</span>)}
      </dd>
    </div>
  );
}
