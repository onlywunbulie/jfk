import { cn } from "@/lib/cn";
import type { ProposalStatus } from "@/lib/db/schema";

/**
 * A proposal as a process rather than a form.
 *
 * The single most useful pattern borrowed from Squads: three fixed stages, so
 * you can see at a glance not just where a proposal is but where it still has
 * to go. The data was always there — it was previously rendered as loose
 * numbers, which made a vote look like a form you had filled in.
 */

export interface TimelineProps {
  status: ProposalStatus;
  createdAt: Date;
  createdBy: string;
  yes: number;
  no: number;
  eligibleVoters: number;
  thresholdLabel: string;
  decidedAt: Date | null;
  executedAt: Date | null;
}

type StageState = "done" | "active" | "pending" | "failed";

export function ProposalTimeline(props: TimelineProps) {
  const stages = deriveStages(props);

  return (
    <ol className="relative space-y-5">
      {stages.map((stage, index) => (
        <li key={stage.title} className="relative flex gap-3.5">
          {/* The connecting rail, drawn behind every marker but the last. */}
          {index < stages.length - 1 && (
            <span
              aria-hidden="true"
              className={cn(
                "absolute top-5 left-[0.4375rem] h-[calc(100%+0.35rem)] w-px",
                stage.state === "done" ? "bg-accent/40" : "bg-border-strong",
              )}
            />
          )}

          <Marker state={stage.state} />

          <div className="min-w-0 flex-1 pb-0.5">
            <p
              className={cn(
                "text-sm font-medium",
                stage.state === "pending" ? "text-ink-faint" : "text-ink",
              )}
            >
              {stage.title}
            </p>
            {stage.detail && (
              <p className="mt-0.5 text-xs text-ink-muted">{stage.detail}</p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Marker({ state }: { state: StageState }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative z-10 mt-0.5 grid size-3.5 shrink-0 place-items-center rounded-full border-2",
        state === "done" && "border-accent bg-accent",
        state === "active" && "border-pending bg-canvas",
        state === "failed" && "border-danger bg-danger",
        state === "pending" && "border-border-strong bg-canvas",
      )}
    >
      {state === "active" && (
        <span className="animate-pending size-1.5 rounded-full bg-pending" />
      )}
    </span>
  );
}

function deriveStages(props: TimelineProps): {
  title: string;
  detail: string | null;
  state: StageState;
}[] {
  const {
    status,
    createdAt,
    createdBy,
    yes,
    no,
    eligibleVoters,
    thresholdLabel,
    decidedAt,
    executedAt,
  } = props;

  const cast = yes + no;
  const settled = status !== "OPEN";
  const approved = status !== "OPEN" && status !== "REJECTED" && status !== "EXPIRED";
  const paidOut = status === "EXECUTED";
  const payoutFailed = status === "EXECUTION_FAILED";

  return [
    {
      title: "Proposed",
      detail: `${createdBy} · ${formatWhen(createdAt)}`,
      state: "done",
    },
    {
      title: settled ? decisionTitle(status) : "Voting",
      detail: settled
        ? `${yes} for, ${no} against${decidedAt ? ` · ${formatWhen(decidedAt)}` : ""}`
        : `${cast} of ${eligibleVoters} voted · ${thresholdLabel} needed`,
      state: settled ? (approved ? "done" : "failed") : "active",
    },
    {
      title: paidOut ? "Paid out" : payoutFailed ? "Payout failed" : "Payout",
      detail: paidOut
        ? executedAt
          ? formatWhen(executedAt)
          : null
        : payoutFailed
          ? "The money went back to the group"
          : approved
            ? "Waiting for an admin"
            : null,
      state: paidOut
        ? "done"
        : payoutFailed
          ? "failed"
          : approved
            ? "active"
            : "pending",
    },
  ];
}

function decisionTitle(status: ProposalStatus): string {
  if (status === "REJECTED") return "Rejected";
  if (status === "EXPIRED") return "Expired";
  return "Approved";
}

function formatWhen(date: Date): string {
  return date.toLocaleDateString("en-NG", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}
