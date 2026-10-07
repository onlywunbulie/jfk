import type { CycleView, ContributionView } from "@/modules/contributions/service";
import { Money } from "@/lib/money";
import { cn } from "@/lib/cn";
import { IconTile } from "@/components/ui/card";
import { TargetIcon } from "@/components/ui/icons";

/**
 * The current cycle at a glance: how much is in, who has paid, who hasn't.
 *
 * Arrears are visible but never humiliating — a muted dot and a plain label,
 * not a red banner with someone's name in it. People miss a month; the product
 * shouldn't make that a public shaming (BLUEPRINT.md §21).
 */
export function CycleCard({ cycle }: { cycle: CycleView }) {
  const paid = cycle.contributions.filter((c) => c.status === "PAID").length;
  const total = cycle.contributions.length;
  const percent = total === 0 ? 0 : Math.round((paid / total) * 100);

  return (
    <div className="glass rounded-[var(--radius-card)] p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <IconTile>
            <TargetIcon />
          </IconTile>
          <h2 className="truncate text-[0.9375rem] font-medium text-ink">
            {periodLabel(cycle)}
          </h2>
        </div>
        <span className="shrink-0 text-sm text-ink-muted">
          {paid}/{total} paid
        </span>
      </div>

      <div className="mt-4 flex items-baseline justify-between gap-3">
        <p className="text-lg font-semibold text-ink">
          {cycle.collected.format({ compact: true })}
          <span className="text-sm font-normal text-ink-faint">
            {" "}
            / {cycle.expectedTotal.format({ compact: true })}
          </span>
        </p>
        <span className="shrink-0 text-sm font-medium text-ink tabular-nums">
          {percent}%
        </span>
      </div>

      {/* Progress toward a fully funded cycle. */}
      <div
        className="mt-3 h-1.5 overflow-hidden rounded-full bg-black/40"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${percent}% collected`}
      >
        <div
          className="h-full rounded-full bg-inflow transition-[width] duration-500 ease-[var(--ease-out-quint)]"
          style={{ width: `${percent}%` }}
        />
      </div>

      {cycle.beneficiaryName && (
        <p className="mt-4 rounded-lg bg-held-soft px-3 py-2 text-sm text-held">
          This cycle pays out to <strong>{cycle.beneficiaryName}</strong> once
          everyone has contributed.
        </p>
      )}

      <ul className="mt-4 space-y-2">
        {cycle.contributions.map((contribution) => (
          <MemberRow key={contribution.id} contribution={contribution} />
        ))}
      </ul>

      <p className="mt-4 text-xs text-ink-faint">{dueLabel(cycle)}</p>
    </div>
  );
}

function MemberRow({ contribution }: { contribution: ContributionView }) {
  const presentation = STATUS[contribution.status];

  return (
    <li className="flex items-center gap-3">
      <span
        aria-hidden="true"
        className={cn("size-2 shrink-0 rounded-full", presentation.dot)}
      />
      <span className="min-w-0 flex-1 truncate text-sm text-ink">
        {contribution.displayName}
        {contribution.isYou && <span className="text-ink-faint"> (you)</span>}
      </span>

      <span className={cn("shrink-0 text-xs", presentation.text)}>
        {presentation.label}
      </span>
      <span className="w-20 shrink-0 text-right text-sm tabular-nums text-ink-muted">
        {contribution.amount.format({ compact: true })}
      </span>
    </li>
  );
}

const STATUS: Record<
  ContributionView["status"],
  { label: string; dot: string; text: string }
> = {
  PAID: { label: "Paid", dot: "bg-inflow", text: "text-inflow" },
  // Money in flight gets its own breathing state.
  PROCESSING: {
    label: "Processing",
    dot: "bg-pending animate-pending",
    text: "text-pending",
  },
  PENDING: { label: "Due", dot: "bg-border-strong", text: "text-ink-faint" },
  FAILED: { label: "Retrying", dot: "bg-pending", text: "text-pending" },
  MISSED: { label: "Missed", dot: "bg-danger/60", text: "text-ink-muted" },
  WAIVED: { label: "Waived", dot: "bg-border-strong", text: "text-ink-faint" },
};

function periodLabel(cycle: CycleView): string {
  if (cycle.cadence === "MONTHLY") {
    return cycle.periodStart.toLocaleDateString("en-NG", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
  }
  return `Week of ${cycle.periodStart.toLocaleDateString("en-NG", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  })}`;
}

function dueLabel(cycle: CycleView): string {
  if (cycle.status !== "OPEN") return "This cycle is closed.";

  const days = Math.ceil(
    (cycle.gracePeriodEndsAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000),
  );

  if (days < 0) return "Past the grace period — closing shortly.";
  if (days === 0) return "Last day of the grace period.";
  if (days === 1) return "Grace period ends tomorrow.";
  return `Grace period ends in ${days} days.`;
}

/** Compact summary for the home screen's group cards. */
export function CycleSummary({ cycle }: { cycle: CycleView | null }) {
  if (!cycle) return null;

  const outstanding = cycle.contributions.filter(
    (c) => c.status !== "PAID" && c.status !== "WAIVED",
  ).length;

  if (outstanding === 0) {
    return <span className="text-inflow">Everyone has paid</span>;
  }
  return (
    <span className="text-ink-faint">
      {outstanding} still to pay ·{" "}
      {cycle.expectedTotal.minus(cycle.collected).format({ compact: true })} to go
    </span>
  );
}

/** Zero-state when a group has no cycle yet. */
export function NoCycleYet({ amount }: { amount: Money }) {
  return (
    <div className="glass rounded-[var(--radius-card)] border-dashed p-5 text-center">
      <p className="text-sm text-ink-muted">
        No contribution cycle has started yet. The first one opens on the
        group&rsquo;s next due date, and everyone will owe{" "}
        {amount.format({ compact: true })}.
      </p>
    </div>
  );
}
