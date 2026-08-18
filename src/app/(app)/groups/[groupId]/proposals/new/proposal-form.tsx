"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { createProposalAction } from "../actions";
import { initialCreateProposalState } from "../state";
import {
  KIND_LABELS,
  THRESHOLD_ACTION_LABELS,
  type ProposalKind,
} from "@/modules/governance/kinds";
import { THRESHOLD_CHOICES } from "../../../new/governance-options";

export interface ProposalFormMember {
  userId: string;
  displayName: string;
  role: string;
}

/**
 * Raising a proposal of any kind.
 *
 * Everything the group is allowed to vote on goes through this one form. The
 * kind decides both which fields appear and which threshold applies — and the
 * threshold is derived on the server, so choosing "spend" for a large
 * withdrawal cannot buy you the lower bar.
 */
export function ProposalForm({
  groupId,
  available,
  members,
  currentThresholds,
  contribution,
}: {
  groupId: string;
  available: string;
  members: ProposalFormMember[];
  currentThresholds: { action: string; permille: number }[];
  contribution: { amount: string; cadence: string; dueDay: number };
}) {
  const [state, formAction] = useActionState(
    createProposalAction,
    initialCreateProposalState,
  );
  const [kind, setKind] = useState<ProposalKind>("SPEND");

  const errorFor = (field: string) =>
    state.field === field ? state.error : undefined;

  const admins = members.filter((m) => m.role === "ADMIN");
  const removable = members.filter((m) => m.role !== "OWNER");

  return (
    <form action={formAction} className="space-y-7">
      <input type="hidden" name="groupId" value={groupId} />
      <input type="hidden" name="kind" value={kind} />

      <fieldset className="space-y-2">
        <legend className="mb-3 text-sm font-medium text-ink-muted">
          What are you asking the group to do?
        </legend>

        {(Object.keys(KIND_LABELS) as ProposalKind[]).map((option) => (
          <KindCard
            key={option}
            selected={kind === option}
            onSelect={() => setKind(option)}
            title={KIND_LABELS[option].title}
            description={KIND_LABELS[option].blurb}
          />
        ))}
      </fieldset>

      <Field
        label="Title"
        name="title"
        placeholder={
          kind === "SPEND" ? "Buy a generator" : "Raise the monthly contribution"
        }
        maxLength={80}
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
          placeholder="Give people enough to decide on."
          className="w-full resize-none rounded-xl border border-border bg-surface px-4 py-3 text-ink placeholder:text-ink-faint focus:border-accent"
        />
        {errorFor("reason") && (
          <p role="alert" className="text-sm text-danger">
            {errorFor("reason")}
          </p>
        )}
      </div>

      {/* --- Spend ----------------------------------------------------- */}
      {kind === "SPEND" && (
        <>
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
            hint="Optional, but the group will want to know."
          />
        </>
      )}

      {/* --- Change the contribution ----------------------------------- */}
      {kind === "CHANGE_CONTRIBUTION" && (
        <div className="space-y-6 rounded-xl border border-border bg-surface p-5">
          <p className="text-sm text-ink-muted">
            Currently {contribution.amount} {contribution.cadence.toLowerCase()},
            due on day {contribution.dueDay}.
          </p>
          <Field
            label="New amount per person"
            name="newAmount"
            inputMode="decimal"
            placeholder="80000"
            required
            error={errorFor("newAmount")}
            hint="In naira."
          />
          <div className="space-y-2">
            <label
              htmlFor="newCadence"
              className="block text-sm font-medium text-ink-muted"
            >
              How often
            </label>
            <select
              id="newCadence"
              name="newCadence"
              defaultValue={contribution.cadence}
              className="h-12 w-full rounded-xl border border-border bg-canvas px-4 text-ink focus:border-accent"
            >
              <option value="MONTHLY">Monthly</option>
              <option value="WEEKLY">Weekly</option>
            </select>
          </div>
          <Field
            label="Due day"
            name="newDueDay"
            type="number"
            min={1}
            max={28}
            defaultValue={contribution.dueDay}
            required
            hint="1–28 for monthly, 1–7 for weekly."
          />
        </div>
      )}

      {/* --- Change a threshold ---------------------------------------- */}
      {kind === "CHANGE_THRESHOLD" && (
        <div className="space-y-6 rounded-xl border border-border bg-surface p-5">
          <div className="space-y-2">
            <label
              htmlFor="thresholdAction"
              className="block text-sm font-medium text-ink-muted"
            >
              Which rule?
            </label>
            <select
              id="thresholdAction"
              name="thresholdAction"
              className="h-12 w-full rounded-xl border border-border bg-canvas px-4 text-ink focus:border-accent"
            >
              {currentThresholds.map((rule) => (
                <option key={rule.action} value={rule.action}>
                  {THRESHOLD_ACTION_LABELS[
                    rule.action as keyof typeof THRESHOLD_ACTION_LABELS
                  ] ?? rule.action}{" "}
                  — now {(rule.permille / 10).toFixed(1)}%
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <label
              htmlFor="newThreshold"
              className="block text-sm font-medium text-ink-muted"
            >
              Change it to
            </label>
            <select
              id="newThreshold"
              name="newThreshold"
              defaultValue={667}
              className="h-12 w-full rounded-xl border border-border bg-canvas px-4 text-ink focus:border-accent"
            >
              {THRESHOLD_CHOICES.map((choice) => (
                <option key={choice.permille} value={choice.permille}>
                  {choice.label} · {choice.hint}
                </option>
              ))}
            </select>
            <p className="text-sm text-ink-faint">
              Can&rsquo;t go below half — a minority should never be able to
              move the group&rsquo;s money.
            </p>
          </div>
        </div>
      )}

      {/* --- Remove someone -------------------------------------------- */}
      {(kind === "REMOVE_MEMBER" || kind === "REMOVE_ADMIN") && (
        <div className="space-y-4 rounded-xl border border-border bg-surface p-5">
          <MemberPicker
            options={kind === "REMOVE_ADMIN" ? admins : removable}
            emptyMessage={
              kind === "REMOVE_ADMIN"
                ? "There are no admins besides the owner."
                : "There is nobody to remove."
            }
          />
          <p className="text-sm text-ink-faint">
            {kind === "REMOVE_ADMIN"
              ? "They stay in the group as a member — only the admin rights go."
              : "Their contribution history stays on the record. Returning any money is a separate proposal."}
          </p>
        </div>
      )}

      <Field
        label="How long should voting stay open?"
        name="voteDays"
        type="number"
        min={1}
        max={30}
        defaultValue={3}
        required
        hint="Days. Three is usually enough for a group chat to notice."
      />

      {state.error && !state.field && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}

      <SubmitButton />
    </form>
  );
}

function MemberPicker({
  options,
  emptyMessage,
}: {
  options: ProposalFormMember[];
  emptyMessage: string;
}) {
  if (options.length === 0) {
    return <p className="text-sm text-ink-muted">{emptyMessage}</p>;
  }

  return (
    <div className="space-y-2">
      <label htmlFor="targetUserId" className="block text-sm font-medium text-ink-muted">
        Who?
      </label>
      <select
        id="targetUserId"
        name="targetUserId"
        required
        className="h-12 w-full rounded-xl border border-border bg-canvas px-4 text-ink focus:border-accent"
      >
        {options.map((member) => (
          <option key={member.userId} value={member.userId}>
            {member.displayName}
          </option>
        ))}
      </select>
    </div>
  );
}

function KindCard({
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
        "w-full rounded-xl border p-4 text-left transition-colors",
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
      <span className="mt-1 block pl-[1.625rem] text-sm text-ink-muted">
        {description}
      </span>
    </button>
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
