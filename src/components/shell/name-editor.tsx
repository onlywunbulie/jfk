"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { setNameAction, type WelcomeState } from "@/app/(app)/actions";
import { isWalletName } from "@/lib/names";

/**
 * The user's name, in the profile, with a way to change it. Someone still
 * going by their wallet address is asked to add one: it's what their group
 * sees on every vote and payout.
 */
export function NameEditor({ name }: { name: string }) {
  const router = useRouter();
  const unnamed = isWalletName(name);
  const [editing, setEditing] = useState(false);
  const [state, action, pending] = useActionState<WelcomeState, FormData>(setNameAction, {});
  // The result as it stood when editing began: a newer "saved" closes the form.
  const [startedWith, setStartedWith] = useState(state);

  // Saved: show the new name everywhere, and close the form.
  useEffect(() => {
    if (state.saved) router.refresh();
  }, [state, router]);
  const open = editing && !(state.saved && state !== startedWith);

  if (!open) {
    return (
      <Button
        type="button"
        variant={unnamed ? "primary" : "secondary"}
        size="sm"
        onClick={() => {
          setStartedWith(state);
          setEditing(true);
        }}
      >
        {unnamed ? "Add your name" : "Change name"}
      </Button>
    );
  }

  return (
    <form action={action} className="space-y-3">
      <Field
        label="Your name"
        name="name"
        defaultValue={unnamed ? "" : name}
        placeholder="Amaka"
        maxLength={40}
        autoFocus
        autoComplete="given-name"
        hint="What your groups call you."
        error={state.error}
      />
      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={pending}>
          Save
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
