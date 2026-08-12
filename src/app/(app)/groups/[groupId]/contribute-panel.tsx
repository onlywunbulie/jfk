"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { contributeAction } from "../actions";
import { initialContributeState } from "../state";

export function ContributePanel({
  groupId,
  target,
  charged,
  fee,
  grossUp,
  hasCard,
}: {
  groupId: string;
  target: string;
  charged: string;
  fee: string;
  grossUp: boolean;
  hasCard: boolean;
}) {
  const [state, contribute] = useActionState(
    contributeAction,
    initialContributeState,
  );

  if (!hasCard) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-ink-muted">
          Add a card to contribute {target} to this group.
        </p>
        <Link
          href="/wallet"
          className="inline-block text-sm text-accent transition-opacity hover:opacity-80"
        >
          Add a card →
        </Link>
      </div>
    );
  }

  if (state.status === "pending") {
    return (
      <div className="space-y-2">
        {/* Money in flight is its own visual state — amber and breathing. */}
        <p className="animate-pending text-sm font-medium text-pending">
          {state.charged} on its way
        </p>
        <p className="text-sm text-ink-muted">
          We&rsquo;ll confirm as soon as your bank does. The group balance
          updates then, not before.
        </p>
      </div>
    );
  }

  return (
    <form action={contribute} className="space-y-4">
      <input type="hidden" name="groupId" value={groupId} />

      <dl className="space-y-2 text-sm">
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-ink-muted">The group receives</dt>
          <dd className="font-medium text-ink">{target}</dd>
        </div>
        {grossUp && (
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-ink-muted">Card fee</dt>
            <dd className="text-ink-muted">{fee}</dd>
          </div>
        )}
        <div className="flex items-baseline justify-between gap-4 border-t border-border pt-2">
          <dt className="text-ink-muted">Your card is charged</dt>
          <dd className="font-medium text-ink">{charged}</dd>
        </div>
      </dl>

      <SubmitButton charged={charged} />

      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}

      <p className="text-xs leading-relaxed text-ink-faint">
        {grossUp
          ? "The card fee is added on top so the group's books stay at a round number."
          : "Paystack's fee comes out of this, so the group receives slightly less."}
      </p>
    </form>
  );
}

function SubmitButton({ charged }: { charged: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" fullWidth loading={pending}>
      Pay {charged}
    </Button>
  );
}
