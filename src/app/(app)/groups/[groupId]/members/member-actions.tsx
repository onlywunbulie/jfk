"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { grantAdminAction, removeMemberAction } from "../../actions";
import { initialMemberActionState } from "../../state";

/**
 * Role and removal controls for one member.
 *
 * Both buttons are shown to whoever the server said may see them; the server
 * re-checks on submit regardless, so a stale page cannot grant anything.
 */
export function MemberActions({
  groupId,
  userId,
  canGrantAdmin,
  canRemove,
}: {
  groupId: string;
  userId: string;
  canGrantAdmin: boolean;
  canRemove: boolean;
}) {
  const [grantState, grant] = useActionState(
    grantAdminAction,
    initialMemberActionState,
  );
  const [removeState, remove] = useActionState(
    removeMemberAction,
    initialMemberActionState,
  );

  const feedback = grantState.error ?? removeState.error;

  if (!canGrantAdmin && !canRemove) return null;

  return (
    <div className="mt-3 space-y-2">
      <div className="flex gap-2">
        {canGrantAdmin && (
          <form action={grant}>
            <input type="hidden" name="groupId" value={groupId} />
            <input type="hidden" name="userId" value={userId} />
            <PendingButton variant="secondary">Make admin</PendingButton>
          </form>
        )}
        {canRemove && (
          <form action={remove}>
            <input type="hidden" name="groupId" value={groupId} />
            <input type="hidden" name="userId" value={userId} />
            <PendingButton variant="danger">Remove</PendingButton>
          </form>
        )}
      </div>

      {feedback && (
        <p role="alert" className="text-xs text-ink-muted">
          {feedback}
        </p>
      )}
    </div>
  );
}

function PendingButton({
  children,
  variant,
}: {
  children: React.ReactNode;
  variant: "secondary" | "danger";
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" variant={variant} loading={pending}>
      {children}
    </Button>
  );
}
