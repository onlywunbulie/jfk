"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import type { OnChainMember } from "@/modules/groups/onchain";
import { startOnChainAction } from "../actions";
import { initialStartOnChainState } from "../state";

/**
 * Shown while a group is still gathering. Lists who's in and whether each
 * person has a wallet yet; the owner starts the group once everyone does.
 */
export function StartOnChain({
  groupId,
  isOwner,
  members,
  inviteHref,
}: {
  groupId: string;
  isOwner: boolean;
  members: OnChainMember[];
  inviteHref: string;
}) {
  const [state, action] = useActionState(startOnChainAction, initialStartOnChainState);
  const waiting = members.filter((m) => !m.hasWallet);
  const ready = waiting.length === 0;

  return (
    <Card raised>
      <CardHeader title="Start the group" />
      <p className="text-sm leading-relaxed text-ink-muted">
        Right now the group is just a list of people. Starting it creates its
        shared wallet on Base, with everyone below as a member. After that,
        nobody, including you, can move the money without the group&rsquo;s
        vote. The app pays the network fee.
      </p>

      <ul className="mt-4 space-y-2">
        {members.map((member, index) => (
          <li key={index} className="flex items-center justify-between gap-3 text-sm">
            <span className="truncate text-ink">
              {member.displayName}
              {member.isYou && <span className="text-ink-faint"> (you)</span>}
            </span>
            <span
              className={cn(
                "shrink-0 rounded-full px-2 py-0.5 text-[0.6875rem] font-medium",
                member.hasWallet ? "bg-inflow-soft text-inflow" : "bg-pending-soft text-pending",
              )}
            >
              {member.hasWallet ? "Wallet ready" : "Needs to sign in with Base"}
            </span>
          </li>
        ))}
      </ul>

      <p className="mt-4 text-xs leading-relaxed text-ink-faint">
        Invite everyone before you start. Once the group is on-chain, each new
        member has to be voted in.{" "}
        <a href={inviteHref} className="text-ink-muted underline decoration-white/30 underline-offset-4 hover:text-ink">
          Invite people
        </a>
      </p>

      {isOwner ? (
        <form action={action} className="mt-5 space-y-3">
          <input type="hidden" name="groupId" value={groupId} />
          <StartButton disabled={!ready} />
          {!ready && (
            <p className="text-sm text-ink-muted">
              Waiting on {waiting.length} {waiting.length === 1 ? "person" : "people"} to sign in with Base.
            </p>
          )}
          {state.error && (
            <p role="alert" className="text-sm text-danger">
              {state.error}
            </p>
          )}
        </form>
      ) : (
        <p className="mt-5 text-sm text-ink-muted">
          The person who created the group starts it once everyone is in.
        </p>
      )}
    </Card>
  );
}

function StartButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" loading={pending} disabled={disabled}>
      {pending ? "Creating the group's wallet…" : "Start the group"}
    </Button>
  );
}
