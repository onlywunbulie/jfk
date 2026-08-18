"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { createGroupAction } from "../actions";
import { initialCreateGroupState } from "../state";
import { DEFAULT_GOVERNANCE, type GovernedAction } from "@/lib/db/schema";
import {
  GOVERNANCE_GROUPS,
  QUORUM_CHOICES,
  THRESHOLD_CHOICES,
} from "./governance-options";

type Step = "details" | "money" | "rules" | "review";
const STEPS: { id: Step; label: string }[] = [
  { id: "details", label: "Details" },
  { id: "money", label: "Money" },
  { id: "rules", label: "Rules" },
  { id: "review", label: "Review" },
];

/**
 * Creating a group, as four decisions instead of one long form.
 *
 * Every field stays mounted across steps — hidden, not unmounted — so the
 * whole thing is a single form post at the end. That keeps the server action
 * dumb, avoids holding a half-made group in the database, and means the back
 * button never loses what you typed.
 */
export function CreateGroupForm() {
  const [state, formAction] = useActionState(
    createGroupAction,
    initialCreateGroupState,
  );

  const [step, setStep] = useState<Step>("details");
  const [type, setType] = useState<"TREASURY" | "ROTATING">("TREASURY");
  const [cadence, setCadence] = useState<"WEEKLY" | "MONTHLY">("MONTHLY");
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("50000");
  const [quorum, setQuorum] = useState(60);
  const [thresholds, setThresholds] = useState<Record<string, number>>(
    () => ({ ...DEFAULT_GOVERNANCE }),
  );

  const index = STEPS.findIndex((s) => s.id === step);
  const errorFor = (field: string) =>
    state.field === field ? state.error : undefined;

  // Keep people from stepping past an empty name only to be bounced back by
  // the server. Everything else has a usable default.
  const canLeaveDetails = name.trim().length >= 2;

  return (
    <form action={formAction} className="space-y-8">
      <Stepper current={index} onJump={(s) => setStep(s)} reached={index} />

      {/* ---------------------------------------------------------------- */}
      <Panel show={step === "details"}>
        <Field
          label="Group name"
          name="name"
          placeholder="JFK Empire"
          maxLength={60}
          value={name}
          onChange={(e) => setName(e.target.value)}
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
          <legend className="mb-3 text-sm font-medium text-ink-muted">
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
      </Panel>

      {/* ---------------------------------------------------------------- */}
      <Panel show={step === "money"}>
        <Field
          label="Contribution per person"
          name="amount"
          inputMode="decimal"
          placeholder="50000"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          required
          error={errorFor("amount")}
          hint="In naira. Everyone contributes the same amount."
        />

        <fieldset>
          <legend className="mb-3 text-sm font-medium text-ink-muted">
            How often?
          </legend>
          <input type="hidden" name="cadence" value={cadence} />
          <div className="flex gap-2">
            {(["MONTHLY", "WEEKLY"] as const).map((option) => (
              <SegmentButton
                key={option}
                selected={cadence === option}
                onClick={() => setCadence(option)}
              >
                {option === "MONTHLY" ? "Monthly" : "Weekly"}
              </SegmentButton>
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
      </Panel>

      {/* ---------------------------------------------------------------- */}
      <Panel show={step === "rules"}>
        <div className="rounded-xl border border-border bg-surface p-4 text-sm">
          <p className="font-medium text-ink">Set these now, carefully</p>
          <p className="mt-1.5 leading-relaxed text-ink-muted">
            You can pick any of these while the group is empty. Once it&rsquo;s
            live, changing one needs a vote — otherwise an admin could quietly
            lower the bar and spend the treasury alone.
          </p>
        </div>

        {GOVERNANCE_GROUPS.map((section) => (
          <fieldset key={section.title} className="space-y-3">
            <legend className="text-sm font-medium text-ink">
              {section.title}
            </legend>
            <p className="text-sm text-ink-muted">{section.blurb}</p>

            <div className="space-y-2">
              {section.actions.map(({ action, label, hint }) => (
                <ThresholdRow
                  key={action}
                  action={action}
                  label={label}
                  hint={hint}
                  value={thresholds[action]}
                  onChange={(permille) =>
                    setThresholds((prev) => ({ ...prev, [action]: permille }))
                  }
                />
              ))}
            </div>
          </fieldset>
        ))}

        <fieldset className="space-y-3">
          <legend className="text-sm font-medium text-ink">Turnout</legend>
          <p className="text-sm text-ink-muted">
            How much of the group has to vote at all for a result to count.
            Abstaining counts toward this.
          </p>
          <input type="hidden" name="quorumPct" value={quorum} />
          <div className="flex flex-wrap gap-2">
            {QUORUM_CHOICES.map((choice) => (
              <SegmentButton
                key={choice.pct}
                selected={quorum === choice.pct}
                onClick={() => setQuorum(choice.pct)}
              >
                {choice.label}
              </SegmentButton>
            ))}
          </div>
        </fieldset>

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
              Turn this off to let only admins raise them. Voting is always open
              to everyone.
            </span>
          </span>
        </label>
      </Panel>

      {/* ---------------------------------------------------------------- */}
      <Panel show={step === "review"}>
        <div className="rounded-[var(--radius-card)] border border-border bg-surface p-5">
          <p className="text-lg font-semibold text-ink">
            {name.trim() || "Untitled group"}
          </p>
          <p className="mt-1 text-sm text-ink-muted">
            {type === "ROTATING" ? "Rotating (Ajo)" : "Treasury"}
          </p>

          <div className="mt-5 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
            <ReviewTile
              value={`₦${Number(amount || 0).toLocaleString("en-NG")}`}
              label="Each"
            />
            <ReviewTile
              value={cadence === "MONTHLY" ? "Monthly" : "Weekly"}
              label="How often"
            />
            <ReviewTile value={`${quorum}%`} label="Must vote" />
          </div>
        </div>

        <div className="rounded-[var(--radius-card)] border border-border bg-surface p-5">
          <p className="text-sm font-medium text-ink">Approval thresholds</p>
          <dl className="mt-3 space-y-2 text-sm">
            {GOVERNANCE_GROUPS.flatMap((s) => s.actions).map(
              ({ action, label }) => (
                <div
                  key={action}
                  className="flex items-baseline justify-between gap-4"
                >
                  <dt className="text-ink-muted">{label}</dt>
                  <dd className="text-ink">
                    {labelFor(thresholds[action])}
                  </dd>
                </div>
              ),
            )}
          </dl>
          <p className="mt-4 text-xs leading-relaxed text-ink-faint">
            After this, changing any of them needs{" "}
            {labelFor(thresholds.CHANGE_GOVERNANCE)} of the group to agree.
          </p>
        </div>
      </Panel>

      {/* Each ThresholdRow emits its own hidden input, and panels are hidden
          rather than unmounted, so every threshold is in the post regardless
          of which step is on screen. */}

      {state.error && !state.field && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}

      <div className="flex items-center justify-between gap-3">
        {index > 0 ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => setStep(STEPS[index - 1].id)}
          >
            Back
          </Button>
        ) : (
          <span />
        )}

        {step === "review" ? (
          <SubmitButton />
        ) : (
          <Button
            type="button"
            disabled={step === "details" && !canLeaveDetails}
            onClick={() => setStep(STEPS[index + 1].id)}
          >
            Next
          </Button>
        )}
      </div>
    </form>
  );
}

/**
 * Steps stay in the DOM when hidden.
 *
 * Unmounting them would drop every uncontrolled input's value the moment you
 * pressed Back, and would stop the browser submitting fields from steps you
 * are not currently looking at.
 */
function Panel({
  show,
  children,
}: {
  show: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn("space-y-6", show ? "animate-rise" : "hidden")}
      aria-hidden={!show}
    >
      {children}
    </div>
  );
}

function Stepper({
  current,
  reached,
  onJump,
}: {
  current: number;
  reached: number;
  onJump: (step: Step) => void;
}) {
  return (
    <ol className="flex gap-1">
      {STEPS.map((step, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={step.id} className="flex-1">
            <button
              type="button"
              disabled={i > reached}
              onClick={() => onJump(step.id)}
              className={cn(
                "w-full border-t-2 pt-2.5 text-left text-xs transition-colors",
                active && "border-accent text-ink",
                done && "border-accent/40 text-ink-muted hover:text-ink",
                !active && !done && "border-border text-ink-faint",
              )}
            >
              {step.label}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function ThresholdRow({
  action,
  label,
  hint,
  value,
  onChange,
}: {
  action: GovernedAction;
  label: string;
  hint: string;
  value: number;
  onChange: (permille: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-surface px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm text-ink">{label}</p>
        {hint && <p className="text-xs text-ink-faint">{hint}</p>}
      </div>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="shrink-0 rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-ink focus:border-accent"
      >
        {THRESHOLD_CHOICES.map((choice) => (
          <option key={choice.permille} value={choice.permille}>
            {choice.label} · {choice.hint}
          </option>
        ))}
      </select>
      <input type="hidden" name={`threshold.${action}`} value={value} />
    </div>
  );
}

function ReviewTile({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-xl bg-raised px-4 py-3">
      <p className="text-lg font-semibold tracking-tight text-ink">{value}</p>
      <p className="mt-0.5 text-xs text-ink-muted">{label}</p>
    </div>
  );
}

function SegmentButton({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "h-11 flex-1 rounded-xl border px-4 text-sm font-medium transition-colors",
        selected
          ? "border-accent bg-accent-soft text-accent"
          : "border-border bg-surface text-ink-muted hover:border-border-strong",
      )}
    >
      {children}
    </button>
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

function labelFor(permille: number): string {
  return (
    THRESHOLD_CHOICES.find((c) => c.permille === permille)?.hint ??
    `${(permille / 10).toFixed(1)}%`
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" loading={pending}>
      Create group
    </Button>
  );
}
