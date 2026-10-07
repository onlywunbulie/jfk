import type { LedgerEntryView } from "@/modules/ledger/service";
import { cn } from "@/lib/cn";

/**
 * Column widths shared by the header and every row, so they cannot drift.
 * Date and status only appear from `sm` up; on a phone the row falls back to
 * label, relative time and amount.
 */
const DATE_COL = "hidden w-36 shrink-0 sm:block";
const AMOUNT_COL = "w-28 shrink-0 text-right";
const STATUS_COL = "hidden w-24 shrink-0 justify-end sm:flex";

/** Column titles for a list of `TransactionRow`s. */
export function TransactionHeader() {
  return (
    <div
      aria-hidden="true"
      className="mx-3 hidden items-center gap-3 rounded-lg bg-white/[0.04] px-3 py-2 text-xs text-ink-faint sm:flex"
    >
      <span className="min-w-0 flex-1">Activity</span>
      <span className={DATE_COL}>Date</span>
      <span className={AMOUNT_COL}>Amount</span>
      <span className={STATUS_COL}>Status</span>
    </div>
  );
}

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
    <li className="flex items-center gap-3 px-6 py-3.5">
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
        <p className="truncate text-xs text-ink-faint sm:hidden">
          <time dateTime={entry.occurredAt.toISOString()}>
            {formatWhen(entry.occurredAt)}
          </time>
        </p>
      </div>

      <time
        dateTime={entry.occurredAt.toISOString()}
        className={cn(DATE_COL, "text-sm text-ink-muted")}
      >
        {formatDate(entry.occurredAt)}
      </time>

      <p
        className={cn(
          AMOUNT_COL,
          "text-sm font-medium tabular-nums",
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

      <span className={STATUS_COL}>
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[0.6875rem] font-medium",
            presentation.chip,
          )}
        >
          <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
          {presentation.status}
        </span>
      </span>
    </li>
  );
}

const PRESENTATION: Record<
  LedgerEntryView["type"],
  { label: string; status: string; chip: string; icon: string; neutral?: boolean }
> = {
  CONTRIBUTION: {
    label: "Contribution received",
    status: "Received",
    chip: "bg-inflow-soft text-inflow",
    icon: "↓",
  },
  FUND_LOCK: {
    label: "Funds locked",
    status: "Locked",
    chip: "bg-held-soft text-held",
    icon: "🔒",
    neutral: true,
  },
  FUND_UNLOCK: {
    label: "Funds unlocked",
    status: "Unlocked",
    chip: "bg-held-soft text-held",
    icon: "🔓",
    neutral: true,
  },
  RESERVATION: {
    label: "Reserved for a proposal",
    status: "Reserved",
    chip: "bg-pending-soft text-pending",
    icon: "⏳",
    neutral: true,
  },
  RESERVATION_RELEASE: {
    label: "Reservation released",
    status: "Released",
    chip: "bg-pending-soft text-pending",
    icon: "↺",
    neutral: true,
  },
  PAYOUT: {
    label: "Funds released",
    status: "Sent",
    chip: "bg-white/10 text-ink-muted",
    icon: "↑",
  },
  REFUND: {
    label: "Refund",
    status: "Refunded",
    chip: "bg-inflow-soft text-inflow",
    icon: "↓",
  },
  REVERSAL: {
    label: "Correction",
    status: "Reversed",
    chip: "bg-danger-soft text-danger",
    icon: "↺",
  },
  ADJUSTMENT: {
    label: "Adjustment",
    status: "Adjusted",
    chip: "bg-white/10 text-ink-muted",
    icon: "±",
  },
};

/** "Wed, 12 Jun 2026", in Lagos time. */
function formatDate(date: Date): string {
  return date.toLocaleDateString("en-NG", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Africa/Lagos",
  });
}

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
