"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { requestCodeAction, verifyCodeAction } from "./actions";
import { initialSignInState, type SignInState } from "./state";

export function SignInForm() {
  const [state, formAction] = useActionState<SignInState, FormData>(
    // One action slot, two steps — the current step decides which runs, so the
    // form keeps its state across the transition without a client-side router.
    async (prev, formData) =>
      prev.step === "email"
        ? requestCodeAction(prev, formData)
        : verifyCodeAction(prev, formData),
    initialSignInState,
  );

  const onCodeStep = state.step === "code";

  return (
    <form action={formAction} className="space-y-5">
      {onCodeStep ? (
        <>
          <Field
            key="code"
            label="6-digit code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            placeholder="000000"
            autoFocus
            required
            error={state.error}
            hint={`Sent to ${state.email}. It expires in 10 minutes.`}
            className="text-center font-mono text-xl tracking-[0.4em]"
          />

          {state.devCode && (
            <p className="rounded-xl border border-pending/30 bg-pending-soft px-4 py-3 text-sm text-pending">
              No email provider configured, so here&rsquo;s the code:{" "}
              <span className="font-mono font-semibold">{state.devCode}</span>
            </p>
          )}
        </>
      ) : (
        <Field
          key="email"
          label="Email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="you@example.com"
          defaultValue={state.email}
          autoFocus
          required
          error={state.error}
          hint="We'll send you a code. No password to remember."
        />
      )}

      <SubmitButton label={onCodeStep ? "Verify and continue" : "Send me a code"} />
    </form>
  );
}

/** Split out so `useFormStatus` reads the enclosing form's pending state. */
function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" fullWidth loading={pending}>
      {label}
    </Button>
  );
}
