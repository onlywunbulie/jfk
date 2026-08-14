"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { createProposalAction } from "../actions";
import { initialCreateProposalState } from "../state";

export function ProposalForm({
  groupId,
  available,
  largeThreshold,
  smallThreshold,
  largeAbove,
}: {
  groupId: string;
  available: string;
  largeThreshold: string;
  smallThreshold: string;
  largeAbove: string;
}) {
  const [state, formAction] = useActionState(
    createProposalAction,
    initialCreateProposalState,
  );

  const errorFor = (field: string) =>
    state.field === field ? state.error : undefined;

  return (
    <form action={formAction} className="space-y-6">
      <input type="hidden" name="groupId" value={groupId} />

      <Field
        label="What are you proposing?"
        name="title"
        placeholder="Buy a generator for the office"
        maxLength={80}
        autoFocus
        required
        error={errorFor("title")}
      />

      <div className="space-y-2">
        <label htmlFor="reason" className="block text-sm font-medium text-ink-muted">
          Why should the group agree?
        </label>
        <textarea
          id="reason"
          name="reason"
          rows={4}
          maxLength={1000}
          required
          placeholder="The office loses power three days a week and we're paying for a shared generator anyway. This one is ours."
          className="w-full resize-none rounded-xl border border-border bg-surface px-4 py-3 text-ink placeholder:text-ink-faint focus:border-accent"
        />
        {errorFor("reason") ? (
          <p role="alert" className="text-sm text-danger">
            {errorFor("reason")}
          </p>
        ) : (
          <p className="text-sm text-ink-faint">
            People are being asked to spend shared money. Give them enough to
            decide on.
          </p>
        )}
      </div>

      <Field
        label="How much?"
        name="amount"
        inputMode="decimal"
        placeholder="120000"
        required
        error={errorFor("amount")}
        hint={`${available} is available to spend right now.`}
      />

      <Field
        label="Where is it going?"
        name="destination"
        placeholder="Ade's Electricals, or Chuka's account"
        maxLength={120}
        error={errorFor("destination")}
        hint="Optional, but the group will want to know."
      />

      <Field
        label="How long should voting stay open?"
        name="voteDays"
        type="number"
        min={1}
        max={30}
        defaultValue={3}
        required
        error={errorFor("voteDays")}
        hint="Days. Three is usually enough for a group chat to notice."
      />

      <div className="rounded-xl border border-border bg-surface p-4 text-sm">
        <p className="font-medium text-ink">How much agreement you&rsquo;ll need</p>
        <p className="mt-1.5 leading-relaxed text-ink-muted">
          Up to {largeAbove}, <strong className="text-ink">{smallThreshold}</strong>{" "}
          of the votes cast must be in favour. Above that it counts as a large
          withdrawal and needs <strong className="text-ink">{largeThreshold}</strong>.
          The app picks which applies — you can&rsquo;t choose the easier one.
        </p>
      </div>

      {state.error && !state.field && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}

      <SubmitButton />
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" fullWidth loading={pending}>
      Put it to the group
    </Button>
  );
}
