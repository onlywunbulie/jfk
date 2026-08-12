"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import type { PaymentMethodView } from "@/modules/payments/service";
import {
  removeCardAction,
  setDefaultCardAction,
  startAddCardAction,
} from "./actions";
import { initialAddCardState } from "./state";

export function PaymentMethods({ methods }: { methods: PaymentMethodView[] }) {
  const [state, addCard] = useActionState(startAddCardAction, initialAddCardState);

  return (
    <div className="space-y-4">
      {methods.length === 0 ? (
        <p className="text-sm text-ink-muted">
          No card yet. Add one so your contributions can be collected
          automatically.
        </p>
      ) : (
        <ul className="space-y-2">
          {methods.map((method) => (
            <li
              key={method.id}
              className="flex items-center gap-3 rounded-xl border border-border bg-base p-3.5"
            >
              <CardGlyph brand={method.brand} />

              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-ink">
                  •••• {method.last4 ?? "????"}
                  {method.bank && (
                    <span className="text-ink-faint"> · {method.bank}</span>
                  )}
                </p>
                <p className="text-xs text-ink-faint">
                  {method.expMonth && method.expYear
                    ? `Expires ${String(method.expMonth).padStart(2, "0")}/${String(
                        method.expYear,
                      ).slice(-2)}`
                    : "Saved card"}
                  {method.isDefault && " · Default"}
                </p>
                {method.expiringSoon && (
                  <p className="mt-1 text-xs text-pending">
                    Expiring soon — add a new card to avoid a missed
                    contribution.
                  </p>
                )}
              </div>

              <div className="flex shrink-0 gap-1">
                {!method.isDefault && (
                  <form action={setDefaultCardAction}>
                    <input type="hidden" name="methodId" value={method.id} />
                    <Button type="submit" size="sm" variant="ghost">
                      Default
                    </Button>
                  </form>
                )}
                <form action={removeCardAction}>
                  <input type="hidden" name="methodId" value={method.id} />
                  <Button type="submit" size="sm" variant="ghost">
                    Remove
                  </Button>
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}

      <form action={addCard}>
        <AddButton hasCards={methods.length > 0} />
      </form>

      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}

      <p className="text-xs leading-relaxed text-ink-faint">
        Your card details go straight to Paystack — JFK never sees or stores
        them. A small amount is charged and refunded to set the card up.
      </p>
    </div>
  );
}

function AddButton({ hasCards }: { hasCards: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" variant={hasCards ? "secondary" : "primary"} loading={pending}>
      {hasCards ? "Add another card" : "Add a card"}
    </Button>
  );
}

function CardGlyph({ brand }: { brand: string | null }) {
  const label = (brand ?? "card").slice(0, 4).toUpperCase();
  return (
    <span
      aria-hidden="true"
      className="grid h-8 w-11 shrink-0 place-items-center rounded-md bg-raised text-[0.5625rem] font-semibold tracking-wide text-ink-muted"
    >
      {label}
    </span>
  );
}
