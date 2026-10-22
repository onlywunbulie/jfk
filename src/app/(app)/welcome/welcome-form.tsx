"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { setNameAction } from "../actions";

export function WelcomeForm({ initialName }: { initialName: string }) {
  const [state, action] = useActionState(setNameAction, {});

  return (
    <form action={action} className="space-y-4">
      <Field
        label="Your name"
        name="name"
        defaultValue={initialName}
        placeholder="Amaka"
        maxLength={40}
        autoFocus
        autoComplete="given-name"
        error={state.error}
      />
      <Submit />
    </form>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" loading={pending}>
      Continue
    </Button>
  );
}
