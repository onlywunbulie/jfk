"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { castVoteAction } from "../actions";
import { initialVoteState } from "../state";
import type { VoteChoice } from "@/lib/db/schema";

/**
 * Yes / No / Abstain.
 *
 * All three are equally weighted visually. Making "Yes" the obvious button
 * would be a thumb on the scale, and this is the screen where the group
 * decides what happens to its money.
 */
export function VotePanel({
  proposalId,
  groupId,
  yourVote,
  canVote,
}: {
  proposalId: string;
  groupId: string;
  yourVote: VoteChoice | null;
  canVote: boolean;
}) {
  const [state, vote] = useActionState(castVoteAction, initialVoteState);

  if (!canVote) {
    return yourVote ? (
      <p className="text-sm text-ink-muted">
        You voted <strong className="text-ink">{LABEL[yourVote]}</strong>.
      </p>
    ) : (
      <p className="text-sm text-ink-muted">Voting has closed.</p>
    );
  }

  return (
    <div className="space-y-3">
      <form action={vote} className="space-y-3">
        <input type="hidden" name="proposalId" value={proposalId} />
        <input type="hidden" name="groupId" value={groupId} />

        <div className="grid grid-cols-3 gap-2">
          {(["YES", "NO", "ABSTAIN"] as const).map((choice) => (
            <ChoiceButton
              key={choice}
              choice={choice}
              selected={yourVote === choice}
            />
          ))}
        </div>

        <textarea
          name="reason"
          rows={2}
          maxLength={500}
          placeholder="Say why, if you want to (optional)"
          className="w-full resize-none rounded-xl border border-border bg-surface px-4 py-3 text-sm text-ink placeholder:text-ink-faint focus:border-white/40"
        />
      </form>

      {yourVote && (
        <p className="text-xs text-ink-faint">
          You voted {LABEL[yourVote]}. You can change your mind until voting
          closes.
        </p>
      )}

      {state.message && (
        <p role="status" className="text-sm text-inflow">
          {state.message}
        </p>
      )}
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
    </div>
  );
}

function ChoiceButton({
  choice,
  selected,
}: {
  choice: VoteChoice;
  selected: boolean;
}) {
  const { pending } = useFormStatus();
  const style = STYLES[choice];

  return (
    <Button
      type="submit"
      name="choice"
      value={choice}
      variant="secondary"
      disabled={pending}
      className={cn(
        "h-12 w-full",
        selected ? style.selected : "text-ink-muted",
      )}
    >
      {LABEL[choice]}
    </Button>
  );
}

const LABEL: Record<VoteChoice, string> = {
  YES: "For",
  NO: "Against",
  ABSTAIN: "Abstain",
};

const STYLES: Record<VoteChoice, { selected: string }> = {
  YES: { selected: "border-inflow bg-inflow-soft text-inflow" },
  NO: { selected: "border-danger bg-danger-soft text-danger" },
  ABSTAIN: { selected: "border-border-strong bg-raised text-ink" },
};
