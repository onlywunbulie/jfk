"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { simulateContributionAction } from "../actions";
import { initialContributeState } from "../state";

/**
 * Development-only control.
 *
 * Deliberately styled as a warning rather than a normal action: this fabricates
 * a Paystack webhook, and it must never be mistaken for a real payment. The
 * server refuses it in production regardless of what the UI does.
 */
export function SimulatePanel({ groupId }: { groupId: string }) {
  const [state, simulate] = useActionState(
    simulateContributionAction,
    initialContributeState,
  );

  return (
    <div className="rounded-[var(--radius-card)] border border-dashed border-pending/40 bg-pending-soft/40 p-5">
      <p className="text-sm font-medium text-pending">Developer tools</p>
      <p className="mt-1.5 text-sm text-ink-muted">
        No Paystack account needed. This builds the webhook Paystack would send
        and runs it through the real pipeline — signature check, duplicate
        guard, ledger posting. Only available outside production.
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <form action={simulate}>
          <input type="hidden" name="groupId" value={groupId} />
          <SubmitButton>Simulate a contribution</SubmitButton>
        </form>

        <form action={simulate}>
          <input type="hidden" name="groupId" value={groupId} />
          <input type="hidden" name="fail" value="1" />
          <SubmitButton variant="ghost">Simulate a decline</SubmitButton>
        </form>
      </div>

      {state.message && (
        <p className="mt-3 text-sm text-inflow" role="status">
          {state.message}
        </p>
      )}
      {state.error && (
        <p className="mt-3 text-sm text-danger" role="alert">
          {state.error}
        </p>
      )}
    </div>
  );
}

function SubmitButton({
  children,
  variant = "secondary",
}: {
  children: React.ReactNode;
  variant?: "secondary" | "ghost";
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" variant={variant} loading={pending}>
      {children}
    </Button>
  );
}
