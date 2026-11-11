"use client";

import { useActionState, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/cn";
import { EXPLORER_URL, shortAddress } from "@/lib/chain/addresses";
import type { FeedItem, ProposalCard as Card } from "@/modules/chat/feed";
import { castVoteAction } from "../proposals/actions";
import { initialVoteState } from "../proposals/state";
import { sendMessageAction } from "./actions";

/** How often an open chat checks for news, while the tab is in view. */
const POLL_MS = 4000;
/** Messages from the same person this close together share one header. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

export function ChatRoom({
  groupId,
  groupName,
  meId,
  initialFeed,
}: {
  groupId: string;
  groupName: string;
  meId: string;
  initialFeed: FeedItem[];
}) {
  const router = useRouter();
  const [feed, setFeed] = useState(initialFeed);
  const [pending, setPending] = useState<{ id: string; body: string }[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/groups/${groupId}/chat`, { cache: "no-store" });
    if (!response.ok) return;
    const { feed: fresh } = (await response.json()) as { feed: FeedItem[] };
    setFeed(fresh);
  }, [groupId]);

  // Poll while the tab is visible; check at once when it comes back.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = window.setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refresh]);

  // Stay pinned to the newest message, unless the reader has scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [feed, pending]);

  async function send(body: string) {
    const temp = { id: `pending-${Date.now()}`, body };
    setPending((list) => [...list, temp]);
    atBottom.current = true;
    const result = await sendMessageAction({ groupId, body }).catch(() => ({
      ok: false as const,
      error: "That didn't send. Check your connection and try again.",
    }));
    setPending((list) => list.filter((p) => p.id !== temp.id));
    if (result.ok) {
      // Shown at once from what the server saved; the next poll brings
      // anyone else's news.
      setFeed((list) => (list.some((item) => item.id === result.item.id) ? list : [...list, result.item]));
      void refresh();
    }
    return result;
  }

  const items = feed;

  return (
    // A full-height column inside the shell: messages scroll, the box stays.
    <div className="-mt-6 -mb-10 flex h-[calc(100dvh-3.5rem)] flex-col lg:-mt-8 lg:-mb-16 lg:h-dvh">
      <header className="hidden h-14 shrink-0 items-center gap-2 border-b border-border lg:flex">
        <span aria-hidden="true" className="text-2xl leading-none text-ink-faint">
          #
        </span>
        <h1 className="text-base font-semibold">general</h1>
        <span className="mx-2 h-5 w-px bg-border" aria-hidden="true" />
        <p className="truncate text-sm text-ink-muted">Talk, and see every vote and payment as it happens</p>
      </header>

      <div
        ref={scroller}
        onScroll={(event) => {
          const el = event.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto py-4"
      >
        <Welcome groupName={groupName} />

        <ol aria-live="polite" className="space-y-1">
          {items.map((item, index) => {
            const previous = items[index - 1];
            const compact =
              item.kind === "text" &&
              previous?.kind === "text" &&
              previous.authorId === item.authorId &&
              Date.parse(item.at) - Date.parse(previous.at) < GROUP_WINDOW_MS;
            return (
              <li key={item.id}>
                <FeedRow item={item} compact={compact} isMine={item.kind === "text" && item.authorId === meId} groupId={groupId} onVoted={async () => {
                  await refresh();
                  router.refresh();
                }} />
              </li>
            );
          })}
          {pending.map((p) => (
            <li key={p.id} className="animate-arrive pl-14 text-base text-ink-faint">
              {p.body}
            </li>
          ))}
        </ol>
      </div>

      <Composer channel="general" onSend={send} />
    </div>
  );
}

function Welcome({ groupName }: { groupName: string }) {
  return (
    <div className="mb-6 border-b border-border pb-6">
      <span aria-hidden="true" className="grid size-16 place-items-center rounded-full bg-raised text-3xl text-ink-muted">
        #
      </span>
      <h2 className="mt-3 text-2xl font-semibold">Welcome to #general</h2>
      <p className="mt-1 text-sm text-ink-muted">
        The start of {groupName}&rsquo;s chat. Votes, payments and new members show up here as they happen.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function FeedRow({
  item,
  compact,
  isMine,
  groupId,
  onVoted,
}: {
  item: FeedItem;
  compact: boolean;
  isMine: boolean;
  groupId: string;
  onVoted: () => Promise<void>;
}) {
  if (item.kind === "text") {
    if (compact) {
      return (
        <div className="group/msg flex gap-4 rounded-[var(--radius-control)] px-2 py-0.5 hover:bg-surface">
          <span className="w-10 shrink-0 pt-1 text-right text-[0.625rem] text-ink-faint opacity-0 group-hover/msg:opacity-100">
            {time(item.at)}
          </span>
          <p className="min-w-0 text-base break-words whitespace-pre-wrap text-ink">{item.body}</p>
        </div>
      );
    }
    return (
      <div className="mt-3 flex gap-4 rounded-[var(--radius-control)] px-2 py-1 hover:bg-surface">
        <span
          aria-hidden="true"
          className={cn(
            "grid size-10 shrink-0 place-items-center rounded-full text-sm font-semibold",
            isMine ? "bg-accent text-accent-ink" : "bg-overlay text-ink",
          )}
        >
          {initials(item.authorName)}
        </span>
        <div className="min-w-0">
          <p className="flex items-baseline gap-2">
            <span className="font-semibold text-ink">{item.authorName}</span>
            <span className="text-xs text-ink-faint">{when(item.at)}</span>
          </p>
          <p className="text-base break-words whitespace-pre-wrap text-ink">{item.body}</p>
        </div>
      </div>
    );
  }

  if (item.kind === "proposal") {
    return <ProposalCard card={item.proposal} at={item.at} groupId={groupId} onVoted={onVoted} />;
  }

  return (
    <div className="flex items-center gap-3 px-2 py-2 text-sm text-ink-muted">
      <span aria-hidden="true" className="w-10 shrink-0 text-center text-base">
        {item.kind === "decided"
          ? item.outcome === "approved"
            ? "✅"
            : item.outcome === "expired"
              ? "⌛"
              : "✖️"
          : item.kind === "joined"
            ? "👋"
            : "🔗"}
      </span>
      <p className="min-w-0">
        {item.kind === "decided" && (
          <>
            <span className="font-semibold text-ink">{item.title}</span>{" "}
            {item.outcome === "approved"
              ? "passed."
              : item.outcome === "expired"
                ? "closed without enough people voting."
                : "didn't pass."}
          </>
        )}
        {item.kind === "joined" && (
          <>
            <span className="font-semibold text-ink">{item.name}</span> joined the group.
          </>
        )}
        {item.kind === "started" && (
          <>
            The group started on Base. Its money now sits in its own shared wallet,{" "}
            <a
              href={`${EXPLORER_URL}/address/${item.safeAddress}`}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-ink underline decoration-ink-faint underline-offset-4 hover:decoration-ink"
            >
              {shortAddress(item.safeAddress)}
            </a>
            .
          </>
        )}{" "}
        <span className="text-xs text-ink-faint">{when(item.at)}</span>
      </p>
    </div>
  );
}

/**
 * A proposal, as a card in the chat, with its live tally and the vote
 * buttons right there.
 */
function ProposalCard({
  card,
  at,
  groupId,
  onVoted,
}: {
  card: Card;
  at: string;
  groupId: string;
  onVoted: () => Promise<void>;
}) {
  const [state, vote] = useActionState(async (prev: typeof initialVoteState, form: FormData) => {
    const next = await castVoteAction(prev, form);
    await onVoted();
    return next;
  }, initialVoteState);

  const open = card.status === "OPEN";
  const voted = card.yes + card.no + card.abstain;

  return (
    <div className="my-3 ml-14 max-w-xl rounded-[var(--radius-card)] border border-border bg-surface p-4">
      <p className="text-xs text-ink-faint">
        🗳️ {card.proposer} opened a vote · {when(at)}
      </p>
      <p className="mt-2 text-lg font-semibold text-ink">
        {card.amount ? `${card.amount}: ` : ""}
        {card.title}
      </p>

      <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-overlay" aria-hidden="true">
        <span className="bg-inflow" style={{ width: `${(card.yes / card.eligible) * 100}%` }} />
        <span className="bg-danger" style={{ width: `${(card.no / card.eligible) * 100}%` }} />
        <span className="bg-ink-faint" style={{ width: `${(card.abstain / card.eligible) * 100}%` }} />
      </div>
      <p className="mt-2 text-sm text-ink-muted">
        {card.yes} yes · {card.no} no · {voted} of {card.eligible} voted · needs {card.needs} to pass
      </p>

      {open && card.canVote ? (
        <form action={vote} className="mt-4 flex flex-wrap gap-2">
          <input type="hidden" name="proposalId" value={card.id} />
          <input type="hidden" name="groupId" value={groupId} />
          <VoteButton choice="YES" mine={card.yourVote === "YES"} label="Vote yes" />
          <VoteButton choice="NO" mine={card.yourVote === "NO"} label="Vote no" />
          <VoteButton choice="ABSTAIN" mine={card.yourVote === "ABSTAIN"} label="Not sure" />
        </form>
      ) : (
        <p className="mt-3 text-sm text-ink-muted">{statusLine(card.status)}</p>
      )}

      {open && card.yourVote && (
        <p className="mt-2 text-xs text-ink-faint">
          You voted {card.yourVote === "ABSTAIN" ? "not sure" : card.yourVote.toLowerCase()}. You can change it
          until {closing(card.closesAt)}.
        </p>
      )}
      {open && !card.yourVote && <p className="mt-2 text-xs text-ink-faint">Closes {closing(card.closesAt)}.</p>}
      {state.error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {state.error}
        </p>
      )}
    </div>
  );
}

function VoteButton({ choice, mine, label }: { choice: "YES" | "NO" | "ABSTAIN"; mine: boolean; label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name="choice"
      value={choice}
      disabled={pending}
      aria-pressed={mine}
      className={cn(
        "press h-9 rounded-[var(--radius-control)] px-4 text-sm font-medium transition-colors disabled:opacity-60",
        mine
          ? "bg-accent text-accent-ink"
          : choice === "YES"
            ? "border border-border bg-raised text-ink hover:border-inflow hover:text-inflow"
            : "border border-border bg-raised text-ink hover:bg-overlay",
      )}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// The message box
// ---------------------------------------------------------------------------

function Composer({ channel, onSend }: { channel: string; onSend: (body: string) => Promise<{ ok: boolean; error?: string }> }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const empty = value.trim().length === 0;

  // Grow with the text, up to about six lines.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [value]);

  async function submit() {
    if (empty) return;
    const body = value;
    setValue("");
    setError(null);
    const result = await onSend(body);
    if (!result.ok) {
      setValue(body);
      setError(result.error ?? "That didn't send. Try again.");
    }
  }

  return (
    <div className="shrink-0 pb-4 pb-safe">
      {error && (
        <p role="alert" className="mb-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex items-end gap-2 rounded-[var(--radius-card)] border border-border bg-raised p-2">
        <textarea
          ref={box}
          rows={1}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends; Shift+Enter starts a new line.
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder={`Message #${channel}`}
          aria-label={`Message #${channel}`}
          className="min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-base text-ink outline-none placeholder:text-ink-faint"
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={empty}
          aria-label="Send"
          className="press grid size-10 shrink-0 place-items-center rounded-[var(--radius-control)] bg-accent text-accent-ink transition-colors disabled:bg-overlay disabled:text-ink-faint"
        >
          <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h13m-6-6 6 6-6 6" />
          </svg>
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}

/** "14:02" today, "Yesterday 14:02", or "3 Nov 14:02", in Lagos time. */
function when(iso: string): string {
  const date = new Date(iso);
  const day = (d: Date) => d.toLocaleDateString("en-NG", { timeZone: "Africa/Lagos" });
  const now = new Date();
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (day(date) === day(now)) return `Today ${time(iso)}`;
  if (day(date) === day(yesterday)) return `Yesterday ${time(iso)}`;
  return `${date.toLocaleDateString("en-NG", { day: "numeric", month: "short", timeZone: "Africa/Lagos" })} ${time(iso)}`;
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-NG", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Africa/Lagos",
  });
}

function closing(iso: string): string {
  return new Date(iso).toLocaleDateString("en-NG", {
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Africa/Lagos",
  });
}

function statusLine(status: Card["status"]): string {
  const lines: Record<Card["status"], string> = {
    OPEN: "Voting is open.",
    APPROVED: "Passed. Waiting to be paid out.",
    EXECUTING: "Passed. Being paid out now.",
    EXECUTED: "Passed and done.",
    EXECUTION_FAILED: "Passed, but the payout didn't go through.",
    REJECTED: "Didn't pass.",
    EXPIRED: "Closed without enough people voting.",
    CANCELLED: "Cancelled.",
  };
  return lines[status];
}
