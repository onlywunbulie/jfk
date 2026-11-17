"use client";

import Link from "next/link";
import type { Route } from "next";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { AiLogo } from "@/components/ai-logos";
import { PinnedTabs } from "./pinned-tabs";
import { useDraftActions } from "./use-draft-actions";
import { ChannelIntro, Detail, RallMessage } from "./parts";

/**
 * #manage roles: everything about who's in the group and who looks after it.
 * Agent-first like #propose a spend: changes are asked for through Claude.
 *
 * A pinned row of plain-text tabs (People · Waiting · Voting · History) keeps
 * every section one tap away instead of stacked down a long page.
 *
 * All real: the drafts Claude made, Discard, each member's connected AI, and
 * the history (decided membership votes, read from Base).
 */

export type Assistant = "Claude" | "ChatGPT" | "Grok" | null;

/** A role-change draft, ready to show: formatted on the server. */
export interface RoleDraftView {
  id: string;
  /** "Make Tunde an admin" */
  label: string;
  change: "make_admin" | "remove_admin" | "remove_member";
  /** "Drafted by Claude · 16 Nov, 11:40" */
  made: string;
}

export interface Person {
  id: string;
  name: string;
  admin: boolean;
  startedGroup: boolean;
  isYou: boolean;
  assistant: Assistant;
}

export interface RoleRules {
  admin: string;
  addMember: string;
  removeMember: string;
  replaceWallet: string;
}

type Tab = "people" | "waiting" | "history";

/** A decided membership vote, from Base. */
export interface PastRoleChange {
  what: string;
  /** "Passed · 2 of 3 yes" */
  detail: string;
  passed: boolean;
}

export function ManageRoles({
  base,
  people,
  rules,
  startedBy,
  startedOn,
  voting,
  drafts,
  history,
}: {
  base: string;
  people: Person[];
  rules: RoleRules;
  startedBy: string;
  startedOn: string;
  /** Role changes being voted on, which live in #votes. */
  voting: number;
  /** The user's role-change drafts from their AI, waiting to be sent. */
  drafts: RoleDraftView[];
  /** Decided membership votes on Base, newest first. */
  history: PastRoleChange[];
}) {
  const [tab, setTab] = useState<Tab>("people");
  const actions = useDraftActions();

  const tabs: { value: Tab; label: string; count?: number }[] = [
    { value: "people", label: "People", count: people.length },
    { value: "waiting", label: "Waiting", count: drafts.length },
    { value: "history", label: "History" },
  ];

  return (
    <div className="flex min-h-full flex-col">
      <PinnedTabs label="Manage roles" tabs={tabs} active={tab} onChange={setTab} />

      <div role="tabpanel" className="pt-6">
        <ChannelIntro title="Manage roles">Who&rsquo;s in the group and who looks after it. Every change needs a vote.</ChannelIntro>
        {voting > 0 && (
          <p className="mt-4 text-sm text-ink-muted">
            {voting} role {voting === 1 ? "change is" : "changes are"} being voted on in{" "}
            <Link
              href={`${base}/votes` as Route}
              className="text-ink underline decoration-ink-faint underline-offset-4 hover:decoration-ink"
            >
              #votes
            </Link>
            .
          </p>
        )}

        {tab === "people" && (
          <>
            {/* What the roles mean, and how to change them. */}
            <RallMessage time="Pinned" body="text" footnote={null}>
              <p className="text-ink">Admins keep the group tidy. They never control the money.</p>
              <div className="mt-3 grid gap-x-8 gap-y-1 sm:grid-cols-2">
                <ul className="space-y-1" aria-label="Admins can">
                  {["Edit the about text and banner", "Invite people", "Moderate #chat", "Start the group on Base"].map((item) => (
                    <li key={item} className="flex gap-2">
                      <span aria-hidden="true" className="text-inflow">✓</span>
                      <span className="text-ink-muted">{item}</span>
                    </li>
                  ))}
                </ul>
                <ul className="space-y-1" aria-label="Admins can't">
                  {["Move money", "Change the rules alone", "Remove members alone", "Make themselves admin"].map((item) => (
                    <li key={item} className="flex gap-2">
                      <span aria-hidden="true" className="text-danger">✗</span>
                      <span className="text-ink-muted">{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <p className="mt-3 text-ink-muted">
                Changing who&rsquo;s in the group takes a vote: adding someone needs {rules.addMember}, removing someone{" "}
                {rules.removeMember}, replacing a lost wallet {rules.replaceWallet}, and making or removing an admin {rules.admin}.
              </p>
              <p className="mt-3 text-ink-muted">
                To ask for a change, tell your Claude, for example:{" "}
                <span className="text-ink">&ldquo;Propose making Tunde an admin.&rdquo;</span>
              </p>
            </RallMessage>

            <ul className="mt-6 max-w-xl space-y-1">
              {people.map((person) => (
                <li key={person.id} className="flex items-center gap-3 py-1.5 text-sm">
                  <span
                    aria-hidden="true"
                    className="grid size-8 shrink-0 place-items-center rounded-full bg-overlay text-xs font-semibold text-ink"
                  >
                    {person.name.trim().charAt(0).toUpperCase() || "?"}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-ink">{person.name}</span>
                      <AssistantLabel assistant={person.assistant} />
                      {person.isYou && <span className="text-xs text-ink-faint">you</span>}
                      {person.admin && (
                        <span className="shrink-0 rounded-[4px] bg-overlay px-1.5 py-px text-[0.6875rem] leading-4 font-semibold text-ink-muted">
                          ADMIN
                        </span>
                      )}
                    </span>
                    {person.startedGroup && <span className="block text-xs text-ink-faint">Started the group</span>}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}

        {tab === "waiting" &&
          (drafts.length > 0 ? (
            drafts.map((draft) => (
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
                    {actions.noticeFor(draft.id) && (
                      <p role="status" className="text-xs text-ink-muted">
                        {actions.noticeFor(draft.id)}
                      </p>
                    )}
                  </div>
                }
              >
                <Detail label="Change">{draft.label}</Detail>
                <Detail label="To pass">
                  {draft.change === "remove_member" ? rules.removeMember : rules.admin} must agree
                  <span className="text-ink-muted"> · voting closes 3 days after it&rsquo;s sent</span>
                </Detail>
              </RallMessage>
            ))
          ) : (
            <p className="mt-6 text-sm text-ink-muted">No drafts. When Claude prepares a change, it appears here.</p>
          ))}

        {tab === "history" && (
          <ul className="mt-6 max-w-xl space-y-1">
            {history.map((row, i) => (
              <ChangeRow
                key={`${row.what}-${i}`}
                base={base}
                what={row.what}
                detail={row.detail}
                status={row.passed ? "Done" : "Didn't pass"}
                tone={row.passed ? "inflow" : "muted"}
              />
            ))}
            <li className="py-2 text-sm">
              <span className="block truncate text-ink">Group started by {startedBy}</span>
              <span className="block text-xs text-ink-faint">{startedOn}</span>
            </li>
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * Which AI the person uses, as its logo in a small round tile. The name is
 * kept for screen readers and as a hover tooltip. No AI: an empty dashed ring.
 */
function AssistantLabel({ assistant }: { assistant: Assistant }) {
  const label = assistant ? `Uses ${assistant}` : "No AI connected";
  return (
    <span
      title={label}
      className={cn(
        "grid size-5 shrink-0 place-items-center rounded-full text-ink",
        assistant ? "bg-overlay" : "border border-dashed border-border-strong",
      )}
    >
      {assistant ? <AiLogo name={assistant} className="size-3" /> : null}
      <span className="sr-only">{label}</span>
    </span>
  );
}

function ChangeRow({
  base,
  what,
  detail,
  status,
  tone,
}: {
  base: string;
  what: string;
  detail: string;
  status: string;
  tone: "pending" | "inflow" | "muted";
}) {
  return (
    <li>
      <Link
        href={`${base}/votes` as Route}
        className="press -mx-3 flex items-center gap-3 rounded-[var(--radius-control)] px-3 py-2 text-sm transition-colors hover:bg-raised"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-ink">{what}</span>
          <span className="block text-xs text-ink-faint">{detail}</span>
        </span>
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-xs",
            tone === "inflow" ? "bg-inflow-soft text-inflow" : tone === "muted" ? "bg-overlay text-ink-faint" : "bg-pending-soft text-pending",
          )}
        >
          {status}
        </span>
      </Link>
    </li>
  );
}
