"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { createGroupAction } from "../actions";
import { initialCreateGroupState } from "../state";
import {
  answer,
  buildScript,
  describeThreshold,
  formatNaira,
  resolveThresholds,
  rulesFor,
  summariseTurnout,
  toFormFields,
  type Answers,
  type ChoiceQuestion,
  type Question,
  type TextQuestion,
} from "./script";

/**
 * Creating a group as a conversation: one question, one answer, then the next.
 *
 * The thread is only a way of collecting the same fields the wizard used to.
 * Nothing is saved until the end, when the answers are posted in one go — so
 * the server action stays dumb, no half-made group ever sits in the database,
 * and changing an earlier answer costs nothing.
 *
 * The box you type in never moves: it stays at the bottom of the screen, live
 * when the question needs typing and switched off when it needs a tap.
 */
export function CreateGroupChat({ heading }: { heading: React.ReactNode }) {
  const [state, formAction] = useActionState(
    createGroupAction,
    initialCreateGroupState,
  );

  const [answers, setAnswers] = useState<Answers>({});
  // Set while an earlier answer is being changed; otherwise the conversation
  // is simply at its first unanswered question.
  const [editing, setEditing] = useState<string | null>(null);

  const script = buildScript(answers);
  const firstOpen = script.findIndex((q) => answers[q.id] === undefined);
  const editingIndex = editing ? script.findIndex((q) => q.id === editing) : -1;
  const currentIndex = editingIndex >= 0 ? editingIndex : firstOpen;
  const finished = currentIndex === -1;
  const current = finished ? null : script[currentIndex];

  // Everything up to the question in hand. Later answers are kept while an
  // earlier one is being changed; they come back once it is answered.
  const visible = finished ? script : script.slice(0, currentIndex + 1);

  const respond = (question: Question, value: string) => {
    setAnswers((prev) => answer(prev, question.id, value));
    setEditing(null);
  };

  // Keep the newest part of the conversation in view as it grows.
  const endRef = useRef<HTMLDivElement>(null);
  const currentId = current?.id ?? "summary";
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [currentId]);

  return (
    // A frame exactly as tall as the space left on screen, so the page itself
    // never scrolls: only the conversation inside it does. That is what keeps
    // the typing box and the summary where they are however long the thread
    // gets. The subtracted heights are the shell above and below this frame
    // (top bar and back link; tab bar on a phone).
    //
    // The conversation stops growing at a comfortable reading width; the
    // summary takes whatever is left, out to the edge of the screen.
    <div className="flex h-[calc(100dvh-10.5rem-env(safe-area-inset-bottom))] flex-col gap-4 lg:grid lg:h-[calc(100dvh-8.75rem)] lg:grid-cols-[minmax(0,56rem)_minmax(18rem,1fr)] lg:grid-rows-1 lg:gap-6 xl:grid-cols-[minmax(0,56rem)_minmax(21rem,1fr)] xl:gap-8">
      <div className="flex min-h-0 flex-1 flex-col lg:h-full">
        {/* The page title heads this column, so the summary beside it starts
            level with the title rather than below it. */}
        <div className="mb-7 hidden shrink-0 lg:block">{heading}</div>

        <div className="-mr-2 min-h-0 flex-1 overflow-y-auto pr-2 [scrollbar-width:thin]">
          {/* On a phone the title scrolls away with the thread; there is no
              height to spare for keeping it. */}
          <div className="mb-6 lg:hidden">{heading}</div>
          <ol role="log" aria-live="polite" className="space-y-5">
            {visible.map((question, index) => {
              const isCurrent = index === currentIndex;
              const given = answers[question.id];

              return (
                <li key={question.id} className="animate-rise space-y-3">
                  <AgentBubble
                    counter={isCurrent ? `${index + 1} of ${script.length}` : undefined}
                  >
                    <p className="text-ink">{question.ask}</p>
                    {question.facts && <Facts rows={question.facts} />}
                    {question.detail && (
                      <p
                        className={cn(
                          "text-sm leading-relaxed text-ink-muted",
                          question.facts ? "mt-3" : "mt-1.5",
                        )}
                      >
                        {question.detail}
                      </p>
                    )}
                  </AgentBubble>

                  {isCurrent
                    ? question.kind === "choice" && (
                        <ChoiceAnswer
                          question={question}
                          selected={given}
                          onAnswer={(value) => respond(question, value)}
                        />
                      )
                    : given !== undefined && (
                        <UserBubble onEdit={() => setEditing(question.id)}>
                          {question.display(given)}
                        </UserBubble>
                      )}
                </li>
              );
            })}

            {finished && (
              <li className="animate-rise space-y-3">
                <AgentBubble>
                  {/* With the live summary alongside, repeating it here would
                      only be noise; without it, this is the one place to check. */}
                  <p className="hidden text-ink lg:block">
                    That&rsquo;s everything. Check the summary on the right, and
                    tap anything you want to change.
                  </p>
                  <div className="lg:hidden">
                    <p className="text-ink">
                      That&rsquo;s everything. Here is your group. Tap any answer
                      above if you want to change it.
                    </p>
                    <Summary answers={answers} />
                  </div>
                </AgentBubble>

                <form action={formAction} className="space-y-3 pl-11">
                  {toFormFields(answers).map(([name, value]) => (
                    <input key={name} type="hidden" name={name} value={value} />
                  ))}

                  {state.error && (
                    <p role="alert" className="text-sm text-danger">
                      {state.error}
                    </p>
                  )}

                  <SubmitButton />
                </form>
              </li>
            )}
          </ol>

          <div ref={endRef} className="h-4" />
        </div>

        <Composer
          // A fresh box for each question, pre-filled when an answer is being
          // changed.
          key={currentId}
          question={current?.kind === "text" ? current : null}
          idleHint={
            finished
              ? "All done. Check your answers above."
              : "Tap one of the options above."
          }
          initial={current ? (answers[current.id] ?? "") : ""}
          onAnswer={(value) => current && respond(current, value)}
        />
      </div>

      <LiveSummary
        answers={answers}
        script={script}
        currentId={current?.id ?? null}
        onEdit={setEditing}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The summary beside the conversation
// ---------------------------------------------------------------------------

/** What each answer is called once it is on the summary. */
const SUMMARY_LABELS: Record<string, string> = {
  name: "Name",
  description: "What it's for",
  type: "How the money works",
  amount: "Each person pays",
  cadence: "How often",
  dueDay: "Pay by",
  quorumPct: "Must take part in a vote",
  membersCanPropose: "Who can suggest spending",
};

const SUMMARY_SECTIONS: { title: string; ids: string[] }[] = [
  { title: "The group", ids: ["name", "description", "type"] },
  { title: "Paying in", ids: ["amount", "cadence", "dueDay"] },
];

/**
 * The group so far, filling in as the questions are answered.
 *
 * Every line is there from the start, empty, so it is obvious what is still
 * to come and nothing jumps around as answers arrive. A filled line is also a
 * way back: tapping it reopens that question.
 */
function LiveSummary({
  answers,
  script,
  currentId,
  onEdit,
}: {
  answers: Answers;
  script: Question[];
  currentId: string | null;
  onEdit: (id: string) => void;
}) {
  const answered = script.filter((q) => answers[q.id] !== undefined).length;
  const percent = Math.round((answered / script.length) * 100);
  const custom = answers.rules === "custom";
  const thresholds = resolveThresholds(answers);

  const row = (id: string, label = SUMMARY_LABELS[id]) => {
    const question = script.find((q) => q.id === id);
    const given = answers[id];
    return (
      <SummaryRow
        key={id}
        label={label}
        value={question && given !== undefined ? question.display(given) : null}
        current={currentId === id}
        onEdit={() => onEdit(id)}
      />
    );
  };

  const count = (
    <p className="shrink-0 text-xs text-ink-muted tabular-nums">
      {answered} of {script.length} answered
    </p>
  );

  const progress = (
    <div
      className="mt-3 h-1 overflow-hidden rounded-full bg-black/40"
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`${percent}% answered`}
    >
      <div
        className="h-full rounded-full bg-ink transition-[width] duration-500 ease-[var(--ease-out-quint)]"
        style={{ width: `${percent}%` }}
      />
    </div>
  );

  const sections = (
    <>
      {SUMMARY_SECTIONS.map((section) => (
        <SummarySection key={section.title} title={section.title}>
          {section.ids.map((id) => row(id))}
        </SummarySection>
      ))}

      <SummarySection title="How many must say yes">
        {answers.rules === undefined ? (
          <SummaryRow
            label="For each kind of decision"
            value={null}
            current={currentId === "rules"}
            onEdit={() => onEdit("rules")}
          />
        ) : (
          rulesFor(answers).map(({ action, label }) => {
            const id = `threshold.${action}`;
            // Hand-picked rules fill in one at a time; suggested ones are all
            // known the moment "Use these" is tapped.
            const known = !custom || answers[id] !== undefined;
            return (
              <SummaryRow
                key={action}
                label={label}
                value={known ? describeThreshold(thresholds[action]) : null}
                current={currentId === id}
                onEdit={() => onEdit(custom ? id : "rules")}
              />
            );
          })
        )}
      </SummarySection>

      <SummarySection title="Voting">
        {row("quorumPct")}
        {row("membersCanPropose")}
      </SummarySection>
    </>
  );

  return (
    <>
      {/* Beside the conversation wherever there is room for both. */}
      <aside
        aria-label="Your group so far"
        // The full height of the frame: level with the title at the top and
        // with the typing box at the bottom. A long set of rules scrolls
        // inside the card rather than moving it.
        className="glass hidden h-full overflow-y-auto rounded-[var(--radius-card)] p-5 [scrollbar-width:thin] lg:block"
      >
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-[0.9375rem] font-medium text-ink">
            Your group so far
          </h2>
          {count}
        </div>
        {progress}
        {sections}
      </aside>

      {/* On a phone there is no "beside", so the same summary folds into a
          bar that stays at the top of the conversation and opens on a tap. */}
      <details className="glass-strong group order-first shrink-0 rounded-[var(--radius-card)] bg-overlay px-4 py-3 lg:hidden">
        <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
          <span className="flex items-baseline justify-between gap-3">
            <span className="text-sm font-medium text-ink">
              Your group so far
              <span className="ml-2 text-xs font-normal text-ink-muted group-open:hidden">
                Tap to see
              </span>
              <span className="ml-2 hidden text-xs font-normal text-ink-muted group-open:inline">
                Tap to hide
              </span>
            </span>
            {count}
          </span>
          {progress}
        </summary>
        <div className="-mx-2 max-h-[45dvh] overflow-x-hidden overflow-y-auto px-2">{sections}</div>
      </details>
    </>
  );
}

function SummarySection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-5 border-t border-white/[0.07] pt-4">
      <h3 className="mb-1.5 text-[0.6875rem] font-medium tracking-wider text-ink-faint uppercase">
        {title}
      </h3>
      <div>{children}</div>
    </section>
  );
}

function SummaryRow({
  label,
  value,
  current,
  onEdit,
}: {
  label: string;
  value: string | null;
  current: boolean;
  onEdit: () => void;
}) {
  const body = (
    <>
      <span className={cn("text-left", current ? "text-ink" : "text-ink-muted")}>
        {label}
      </span>
      <span
        className={cn(
          "max-w-[60%] text-right break-words",
          value === null
            ? current
              ? "shrink-0 whitespace-nowrap text-ink-muted"
              : "shrink-0 whitespace-nowrap text-ink-faint"
            : "font-medium text-ink",
        )}
      >
        {value ?? (current ? "Answering…" : "Not yet")}
      </span>
    </>
  );

  const layout =
    "-mx-2 flex w-[calc(100%+1rem)] items-baseline justify-between gap-4 rounded-lg px-2 py-1.5 text-sm";

  // Only something already answered can be reopened.
  return value === null ? (
    <div className={cn(layout, current && "bg-white/[0.05]")}>{body}</div>
  ) : (
    <button
      type="button"
      onClick={onEdit}
      title="Change this answer"
      className={cn(
        layout,
        "transition-colors hover:bg-white/[0.07]",
        current && "bg-white/[0.05]",
      )}
    >
      {body}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Bubbles
// ---------------------------------------------------------------------------

function AgentBubble({
  counter,
  children,
}: {
  counter?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <span
        aria-hidden="true"
        className="glass-subtle grid size-8 shrink-0 place-items-center rounded-full"
      >
        <svg viewBox="0 0 40 40" className="size-4">
          <circle cx="14" cy="14" r="9" className="fill-accent/70" />
          <circle cx="26" cy="14" r="9" className="fill-accent/40" />
          <circle cx="20" cy="25" r="9" className="fill-accent" />
        </svg>
      </span>

      <div className="min-w-0 max-w-[44rem]">
        <span className="sr-only">JFK asks: </span>
        <div className="glass rounded-2xl rounded-tl-md px-4 py-3">{children}</div>
        {counter && (
          <p className="mt-1.5 pl-1 text-[0.6875rem] text-ink-faint">{counter}</p>
        )}
      </div>
    </div>
  );
}

/** An answer already given. Tapping it reopens the question. */
function UserBubble({
  onEdit,
  children,
}: {
  onEdit: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex justify-end">
      <button
        type="button"
        onClick={onEdit}
        className="group max-w-[85%] text-right"
      >
        <span className="sr-only">You answered: </span>
        <span className="inline-block rounded-2xl rounded-tr-md bg-ink px-4 py-2.5 text-left font-medium break-words text-canvas transition-colors group-hover:bg-white">
          {children}
        </span>
        <span className="mt-1 block pr-1 text-[0.6875rem] text-ink-faint transition-colors group-hover:text-ink-muted">
          Change
        </span>
      </button>
    </div>
  );
}

function Facts({ rows }: { rows: { label: string; value: string }[] }) {
  return (
    <dl className="mt-3 space-y-1.5 border-y border-white/[0.07] py-3 text-sm">
      {rows.map((row) => (
        <div key={row.label} className="flex items-baseline justify-between gap-4">
          <dt className="text-ink-muted">{row.label}</dt>
          <dd className="shrink-0 text-ink">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Answering
// ---------------------------------------------------------------------------

/**
 * The typing box, fixed to the bottom of the conversation.
 *
 * It is always there so the screen never jumps, but it only works when the
 * question in hand is one you type an answer to. For a question you answer
 * with a tap it is switched off entirely — a live box beside a row of buttons
 * would suggest that typing is an option when it is not.
 */
function Composer({
  question,
  idleHint,
  initial,
  onAnswer,
}: {
  question: TextQuestion | null;
  idleHint: string;
  initial: string;
  onAnswer: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const active = question !== null;

  const submit = () => {
    if (!question) return;
    const tidy = question.normalise(value);
    const problem = question.validate(tidy);
    if (problem) {
      setError(problem);
      return;
    }
    onAnswer(tidy);
  };

  return (
    // The last row of the frame, so it is always at the bottom of the screen.
    <div className="mt-3 shrink-0">
      {error && (
        <p role="alert" className="mb-2 pl-1 text-sm text-danger">
          {error}
        </p>
      )}

      <div
        className={cn(
          // Solid enough that the thread scrolling underneath never shows
          // through the box you are typing in.
          "glass-strong flex items-center gap-2 rounded-2xl bg-overlay p-2",
          !active && "[&>*]:opacity-50",
        )}
      >
        <input
          autoFocus={active}
          disabled={!active}
          aria-label={question?.ask ?? idleHint}
          aria-invalid={error ? true : undefined}
          value={active ? value : ""}
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
          // Enter sends the answer. There is no surrounding form to submit,
          // so it cannot accidentally create the group early.
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={question?.placeholder ?? idleHint}
          inputMode={question?.inputMode}
          maxLength={question?.maxLength}
          enterKeyHint="send"
          autoComplete="off"
          className="h-11 min-w-0 flex-1 rounded-xl bg-transparent px-3 text-ink outline-none placeholder:text-ink-faint disabled:cursor-not-allowed disabled:placeholder:text-ink-muted"
        />

        {question?.skipLabel && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => onAnswer("")}
            className="h-11 shrink-0 px-3"
          >
            {question.skipLabel}
          </Button>
        )}
        <Button
          type="button"
          onClick={submit}
          disabled={!active}
          className="h-11 shrink-0"
        >
          Send
        </Button>
      </div>
    </div>
  );
}

function ChoiceAnswer({
  question,
  selected,
  onAnswer,
}: {
  question: ChoiceQuestion;
  selected: string | undefined;
  onAnswer: (value: string) => void;
}) {
  // Choices that explain themselves get a full-width card each; bare labels
  // sit side by side as chips.
  const descriptive = question.choices.some((choice) => choice.hint);

  return (
    <div
      role="group"
      aria-label={question.ask}
      className={cn(
        "pl-11",
        descriptive ? "max-w-[46.75rem] space-y-2" : "flex flex-wrap gap-2",
      )}
    >
      {question.choices.map((choice) => (
        <button
          key={choice.value}
          type="button"
          onClick={() => onAnswer(choice.value)}
          aria-pressed={selected === choice.value}
          className={cn(
            "glass-subtle rounded-xl text-left transition-colors duration-150",
            "hover:border-white/40 hover:bg-white/[0.09]",
            selected === choice.value && "border-white/40 bg-white/[0.09]",
            descriptive ? "block w-full p-4" : "px-4 py-2.5",
          )}
        >
          <span className="text-sm font-medium text-ink">{choice.label}</span>
          {choice.hint && (
            <span className="mt-1 block text-sm leading-relaxed text-ink-muted">
              {choice.hint}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The end of the conversation
// ---------------------------------------------------------------------------

function Summary({ answers }: { answers: Answers }) {
  const thresholds = resolveThresholds(answers);
  const weekly = answers.cadence === "WEEKLY";

  return (
    <div className="mt-3 border-t border-white/[0.07] pt-3">
      <p className="text-lg font-semibold text-ink">{answers.name}</p>
      <p className="mt-0.5 text-sm text-ink-muted">
        {answers.type === "ROTATING" ? "Take turns (Ajo)" : "Save together"}
        {answers.description ? ` · ${answers.description}` : null}
      </p>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <Tile value={formatNaira(answers.amount ?? "0")} label="Each person pays" />
        <Tile value={weekly ? "Once a week" : "Once a month"} label="How often" />
      </div>

      <p className="mt-4 text-sm font-medium text-ink">
        How many members must say yes
      </p>
      <dl className="mt-2 space-y-1.5 text-sm">
        {rulesFor(answers).map(({ action, label }) => (
          <div key={action} className="flex items-baseline justify-between gap-4">
            <dt className="text-ink-muted">{label}</dt>
            <dd className="shrink-0 text-ink">
              {describeThreshold(thresholds[action])}
            </dd>
          </div>
        ))}
      </dl>

      <dl className="mt-4 space-y-1.5 border-t border-white/[0.07] pt-3 text-sm">
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-ink-muted">Must take part for a vote to count</dt>
          <dd className="shrink-0 text-ink">{summariseTurnout(answers)}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-ink-muted">Who can suggest spending</dt>
          <dd className="shrink-0 text-ink">
            {answers.membersCanPropose === "no" ? "Admins only" : "Any member"}
          </dd>
        </div>
      </dl>

      <p className="mt-4 text-xs leading-relaxed text-ink-faint">
        You are creating this group, but the money belongs to everyone in it.
        Not even you can take it out without a vote.
      </p>
    </div>
  );
}

function Tile({ value, label }: { value: string; label: string }) {
  return (
    <div className="glass-subtle rounded-xl px-3 py-2.5">
      <p className="truncate font-semibold tracking-tight text-ink">{value}</p>
      <p className="mt-0.5 text-xs text-ink-muted">{label}</p>
    </div>
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
