import type { LedgerEntryView } from "@/modules/ledger/service";
import { cn } from "@/lib/cn";

/**
 * One line of a statement.
 *
 * The amount is the loudest thing on the row and carries its own sign and
 * colour: green in, plain out. Locks and reservations read as neutral because
 * the money hasn't left the group — it has only moved out of reach.
 */
export function TransactionRow({ entry }: { entry: LedgerEntryView }) {
  const presentation = PRESENTATION[entry.type];
  const isIncrease = entry.amount.isPositive();

  return (
    <li className="flex items-center gap-3 px-4 py-3.5">
      <span
        aria-hidden="true"
        className={cn(
          "grid size-9 shrink-0 place-items-center rounded-full",
          presentation.chip,
        )}
      >
        {presentation.icon}
      </span>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-ink">
          {presentation.label}
        </p>
        <p className="truncate text-xs text-ink-faint">
          <time dateTime={entry.occurredAt.toISOString()}>
            {formatWhen(entry.occurredAt)}
          </time>
        </p>
      </div>

      <p
        className={cn(
          "shrink-0 text-sm font-medium tabular-nums",
          presentation.neutral
            ? "text-ink-muted"
            : isIncrease
              ? "text-inflow"
              : "text-ink",
        )}
      >
        {isIncrease ? "+" : ""}
        {entry.amount.format({ compact: true })}
      </p>
    </li>
  );
}

const PRESENTATION: Record<
  LedgerEntryView["type"],
  { label: string; chip: string; icon: string; neutral?: boolean }
> = {
  CONTRIBUTION: {
    label: "Contribution received",
    chip: "bg-inflow-soft text-inflow",
    icon: "↓",
  },
  FUND_LOCK: {
    label: "Funds locked",
    chip: "bg-locked-soft text-locked",
    icon: "🔒",
    neutral: true,
  },
  FUND_UNLOCK: {
    label: "Funds unlocked",
    chip: "bg-locked-soft text-locked",
    icon: "🔓",
    neutral: true,
  },
  RESERVATION: {
    label: "Reserved for a proposal",
    chip: "bg-pending-soft text-pending",
    icon: "⏳",
    neutral: true,
  },
  RESERVATION_RELEASE: {
    label: "Reservation released",
    chip: "bg-pending-soft text-pending",
    icon: "↺",
    neutral: true,
  },
  PAYOUT: {
    label: "Funds released",
    chip: "bg-raised text-ink-muted",
    icon: "↑",
  },
  REFUND: {
    label: "Refund",
    chip: "bg-inflow-soft text-inflow",
    icon: "↓",
  },
  REVERSAL: {
    label: "Correction",
    chip: "bg-danger-soft text-danger",
    icon: "↺",
  },
  ADJUSTMENT: {
    label: "Adjustment",
    chip: "bg-raised text-ink-muted",
    icon: "±",
  },
};

/** Relative for the last week, absolute after that. */
function formatWhen(date: Date): string {
  const elapsed = Date.now() - date.getTime();
  const day = 24 * 60 * 60 * 1000;

  if (elapsed < 60_000) return "just now";
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < day) return `${Math.floor(elapsed / (60 * 60_000))}h ago`;
  if (elapsed < 7 * day) return `${Math.floor(elapsed / day)}d ago`;

  return date.toLocaleDateString("en-NG", {
    day: "numeric",
    month: "short",
    year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
}
