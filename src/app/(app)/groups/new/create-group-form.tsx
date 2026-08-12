"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { createGroupAction } from "../actions";
import { initialCreateGroupState } from "../state";

export function CreateGroupForm() {
  const [state, formAction] = useActionState(
    createGroupAction,
    initialCreateGroupState,
  );
  const [type, setType] = useState<"TREASURY" | "ROTATING">("TREASURY");
  const [cadence, setCadence] = useState<"WEEKLY" | "MONTHLY">("MONTHLY");

  const errorFor = (field: string) =>
    state.field === field ? state.error : undefined;

  return (
    <form action={formAction} className="space-y-7">
      <Field
        label="Group name"
        name="name"
        placeholder="JFK Empire"
        maxLength={60}
        autoFocus
        required
        error={errorFor("name")}
      />

      <Field
        label="What's it for?"
        name="description"
        placeholder="Building the empire, one month at a time"
        maxLength={280}
        error={errorFor("description")}
        hint="Optional"
      />

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-ink-muted">
          How does the money work?
        </legend>
        <input type="hidden" name="type" value={type} />

        <ChoiceCard
          selected={type === "TREASURY"}
          onSelect={() => setType("TREASURY")}
          title="Treasury"
          description="Money pools up and stays locked. It only leaves when the group votes to release it."
        />
        <ChoiceCard
          selected={type === "ROTATING"}
          onSelect={() => setType("ROTATING")}
          title="Rotating (Ajo)"
          description="Every cycle the full pot goes to one member, in turn, until everyone has collected."
        />
      </fieldset>

      <Field
        label="Contribution per person"
        name="amount"
        inputMode="decimal"
        placeholder="50000"
        defaultValue="50000"
        required
        error={errorFor("amount")}
        hint="In naira. Everyone contributes the same amount."
      />

      <fieldset className="space-y-3">
        <legend className="mb-3 text-sm font-medium text-ink-muted">
          How often?
        </legend>
        <input type="hidden" name="cadence" value={cadence} />

        <div className="flex gap-2">
          {(["MONTHLY", "WEEKLY"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setCadence(option)}
              aria-pressed={cadence === option}
              className={cn(
                "h-11 flex-1 rounded-xl border text-sm font-medium transition-colors",
                cadence === option
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-border bg-surface text-ink-muted hover:border-border-strong",
              )}
            >
              {option === "MONTHLY" ? "Monthly" : "Weekly"}
            </button>
          ))}
        </div>
      </fieldset>

      <Field
        label={cadence === "MONTHLY" ? "Day of the month" : "Day of the week"}
        name="dueDay"
        type="number"
        min={1}
        max={cadence === "MONTHLY" ? 28 : 7}
        defaultValue={1}
        required
        error={errorFor("dueDay")}
        hint={
          cadence === "MONTHLY"
            ? "1–28, so it lands every month including February."
            : "1 is Monday, 7 is Sunday."
        }
      />

      <label className="flex items-start gap-3 rounded-xl border border-border bg-surface p-4">
        <input
          type="checkbox"
          name="membersCanPropose"
          defaultChecked
          className="mt-0.5 size-4 accent-[var(--color-accent)]"
        />
        <span className="text-sm">
          <span className="font-medium text-ink">
            Any member can start a proposal
          </span>
          <span className="mt-0.5 block text-ink-muted">
            Turn this off to let only admins raise them. Voting is always open to
            everyone.
          </span>
        </span>
      </label>

      {state.error && !state.field && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}

      <div className="space-y-3">
        <SubmitButton />
        <p className="text-center text-xs text-ink-faint">
          You can invite people once the group exists. Contribution rules can be
          changed later by a vote.
        </p>
      </div>
    </form>
  );
}

function ChoiceCard({
  selected,
  onSelect,
  title,
  description,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "w-full rounded-xl border p-4 text-left transition-colors duration-150",
        selected
          ? "border-accent bg-accent-soft"
          : "border-border bg-surface hover:border-border-strong",
      )}
    >
      <span className="flex items-center gap-2.5">
        <span
          className={cn(
            "grid size-4 shrink-0 place-items-center rounded-full border-2",
            selected ? "border-accent" : "border-border-strong",
          )}
        >
          {selected && <span className="size-2 rounded-full bg-accent" />}
        </span>
        <span className={cn("font-medium", selected ? "text-accent" : "text-ink")}>
          {title}
        </span>
      </span>
      <span className="mt-1.5 block pl-[1.625rem] text-sm text-ink-muted">
        {description}
      </span>
    </button>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" fullWidth loading={pending}>
      Create group
    </Button>
  );
}
