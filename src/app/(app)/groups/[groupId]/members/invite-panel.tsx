"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { createInviteAction } from "../../actions";
import { initialInviteState } from "../../state";

export function InvitePanel({
  groupId,
  appUrl,
}: {
  groupId: string;
  appUrl: string;
}) {
  const [state, formAction] = useActionState(createInviteAction, initialInviteState);
  const [copied, setCopied] = useState(false);

  const link = state.code ? `${appUrl}/join/${state.code}` : null;

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked; the link is selectable either way.
      setCopied(false);
    }
  }

  return (
    <div className="space-y-4">
      {link ? (
        <div className="space-y-3">
          <p className="text-sm text-ink-muted">
            Share this link. It works once and expires in 14 days.
          </p>
          <div className="flex items-center gap-2 rounded-xl border border-border bg-canvas p-3">
            <code className="min-w-0 flex-1 truncate font-mono text-xs text-ink">
              {link}
            </code>
            <Button type="button" size="sm" variant="secondary" onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <form action={formAction}>
            <input type="hidden" name="groupId" value={groupId} />
            <Button type="submit" size="sm" variant="ghost">
              Create another
            </Button>
          </form>
        </div>
      ) : (
        <form action={formAction} className="space-y-3">
          <input type="hidden" name="groupId" value={groupId} />
          <input type="hidden" name="maxUses" value="1" />
          <p className="text-sm text-ink-muted">
            Generate a single-use link to bring someone into the group.
          </p>
          <SubmitButton />
        </form>
      )}

      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
    </div>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" loading={pending}>
      Create invite link
    </Button>
  );
}
