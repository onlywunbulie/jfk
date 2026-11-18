"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { deleteGroupAction } from "@/app/(app)/groups/actions";

/**
 * Deleting a group that never went on Base. Two taps, the second saying
 * plainly that it can't be undone; no browser pop-up.
 */
export function DeleteGroup({ groupId, groupName }: { groupId: string; groupName: string }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="text-sm text-ink-muted underline underline-offset-4 hover:text-ink"
      >
        Delete this group
      </button>
    );
  }

  return (
    <div className="rounded-[var(--radius-card)] border border-border bg-surface p-4 text-sm">
      <p className="font-semibold text-ink">Delete {groupName}?</p>
      <p className="mt-1 text-ink-muted">It isn&rsquo;t on Base and holds no money, so no vote is needed. Everyone in it loses it, and it can&rsquo;t be undone.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          type="button"
          variant="danger"
          size="sm"
          loading={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await deleteGroupAction(groupId);
              if (result && !result.ok) setError(result.error);
            })
          }
        >
          Delete it
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>
          Keep it
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
