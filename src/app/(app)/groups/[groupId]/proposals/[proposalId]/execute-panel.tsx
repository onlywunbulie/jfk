"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { executeReleaseAction } from "../actions";
import { initialVoteState } from "../state";

/**
 * Paying out an approved proposal.
 *
 * Deliberately a second, separate act from the vote passing. The group decided
 * *that* the money should move; a person still has to decide *now*, and their
 * name goes on it.
 */
export function ExecutePanel({
  proposalId,
  groupId,
  amount,
  destination,
}: {
  proposalId: string;
  groupId: string;
  amount: string;
  destination: string;
}) {
  const [state, execute] = useActionState(executeReleaseAction, initialVoteState);
  const [confirming, setConfirming] = useState(false);

  if (state.message) {
    return (
      <p role="status" className="text-sm text-inflow">
        {state.message}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-muted">
        The group approved this and {amount} is reserved. Paying it out sends
        the money to <span className="text-ink">{destination}</span> and takes
        it out of the group&rsquo;s balance for good.
      </p>

      {!confirming ? (
        <Button type="button" onClick={() => setConfirming(true)} fullWidth>
          Pay out {amount}
        </Button>
      ) : (
        <div className="space-y-3 rounded-xl border border-border-strong bg-canvas p-4">
          <p className="text-sm font-medium text-ink">
            Send {amount} to {destination}?
          </p>
          <p className="text-xs leading-relaxed text-ink-muted">
            This can&rsquo;t be undone. If it fails, the money comes back and the
            group has to approve a fresh proposal to try again.
          </p>

          <form action={execute} className="space-y-2">
            <input type="hidden" name="proposalId" value={proposalId} />
            <input type="hidden" name="groupId" value={groupId} />

            <SubmitButton name="mode" value="transfer">
              Yes, send it
            </SubmitButton>
            <SubmitButton name="mode" value="manual" variant="secondary">
              I already sent it myself — just record it
            </SubmitButton>
            <SubmitButton name="mode" value="fail" variant="ghost">
              Simulate a failed transfer
            </SubmitButton>
          </form>

          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="w-full text-center text-sm text-ink-muted transition-colors hover:text-ink"
          >
            Cancel
          </button>
        </div>
      )}

      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
    </div>
  );
}

function SubmitButton({
  children,
  name,
  value,
  variant = "primary",
}: {
  children: React.ReactNode;
  name: string;
  value: string;
  variant?: "primary" | "secondary" | "ghost";
}) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      name={name}
      value={value}
      variant={variant}
      size="sm"
      fullWidth
      loading={pending}
    >
      {children}
    </Button>
  );
}
