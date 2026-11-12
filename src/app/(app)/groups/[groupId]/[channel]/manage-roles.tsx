"use client";

import Link from "next/link";
import type { Route } from "next";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { AiLogo } from "@/components/ai-logos";
import { ChannelIntro, Detail, RallMessage } from "./parts";

/**
 * #manage roles: everything about who's in the group and who looks after it.
 * Agent-first like #propose a spend: changes are asked for through Claude.
 *
 * A pinned row of plain-text tabs (People · Waiting · Voting · History) keeps
 * every section one tap away instead of stacked down a long page.
 *
 * UI only: the AIs, draft, votes and most of the history are samples.
 */

export type Assistant = "Claude" | "ChatGPT" | "Grok" | null;

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

type Tab = "people" | "waiting" | "voting" | "history";

const VOTING = [
  { what: "Remove Femi as admin", detail: "4 of 8 so far · closes Friday" },
  { what: "Replace Chidi's lost wallet", detail: "2 of 8 so far · closes Sunday" },
];

const PAST = [
  { what: "Tunde made an admin", detail: "Passed 3 Oct · 6 of 8" },
  { what: "Amaka joined", detail: "Passed 12 Sep · 7 of 8" },
];

export function ManageRoles({
  base,
  people,
  rules,
  startedBy,
  startedOn,
}: {
  base: string;
  people: Person[];
  rules: RoleRules;
  startedBy: string;
  startedOn: string;
}) {
  const [tab, setTab] = useState<Tab>("people");
  const [draftOpen, setDraftOpen] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  const tabs: { value: Tab; label: string; count?: number }[] = [
    { value: "people", label: "People", count: people.length },
    { value: "waiting", label: "Waiting", count: draftOpen ? 1 : 0 },
    { value: "voting", label: "Voting", count: VOTING.length },
    { value: "history", label: "History" },
  ];

  return (
    <div className="flex min-h-full flex-col">
      {/* Pinned flush with the main card's top edge, like #transactions. */}
      <div className="sticky -top-6 z-10 -mx-4 -mt-6 border-b border-border bg-canvas px-4 py-3 lg:-mx-8 lg:px-8">
        <div role="tablist" aria-label="Manage roles" className="flex flex-wrap gap-5">
          {tabs.map((option) => (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={tab === option.value}
              onClick={() => setTab(option.value)}
              className={cn(
                "press py-1 text-sm transition-colors",
                tab === option.value ? "text-ink" : "text-ink-muted hover:text-ink",
              )}
            >
              {/* Only the label is underlined; the count sits beside it. */}
              <span className={cn(tab === option.value && "underline decoration-ink decoration-2 underline-offset-[6px]")}>
                {option.label}
              </span>
              {option.count ? <span className="ml-1.5 text-ink-faint tabular-nums">{option.count}</span> : null}
            </button>
          ))}
        </div>
      </div>

      <div role="tabpanel" className="pt-6">
        <ChannelIntro title="Manage roles">Who&rsquo;s in the group and who looks after it. Every change needs a vote.</ChannelIntro>

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
          (draftOpen ? (
            <RallMessage
             
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
                        setDraftOpen(false);
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
              <Detail label="Change">Make Tunde an admin</Detail>
              <Detail label="To pass">
                {rules.admin} must agree<span className="text-ink-muted"> · voting closes 3 days after it&rsquo;s sent</span>
              </Detail>
            </RallMessage>
          ) : (
            <p className="mt-6 text-sm text-ink-muted">No drafts. When Claude prepares a change, it appears here.</p>
          ))}

        {tab === "voting" && (
          <ul className="mt-6 max-w-xl space-y-1">
            {VOTING.map((row) => (
              <ChangeRow key={row.what} base={base} what={row.what} detail={row.detail} status="Voting" tone="pending" />
            ))}
          </ul>
        )}

        {tab === "history" && (
          <ul className="mt-6 max-w-xl space-y-1">
            {PAST.map((row) => (
              <ChangeRow key={row.what} base={base} what={row.what} detail={row.detail} status="Done" tone="inflow" />
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
  tone: "pending" | "inflow";
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
            tone === "inflow" ? "bg-inflow-soft text-inflow" : "bg-pending-soft text-pending",
          )}
        >
          {status}
        </span>
      </Link>
    </li>
  );
}
