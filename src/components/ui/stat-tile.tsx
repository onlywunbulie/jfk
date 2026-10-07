import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * A boxed number with its label underneath.
 *
 * Used in rows of two to four. The number is the point, so it gets the size
 * and the label gets out of the way — a list of "Label: value" pairs reads as
 * a form, whereas this reads as a dashboard.
 */
export function StatTile({
  value,
  label,
  icon,
  tone = "default",
  className,
}: {
  value: ReactNode;
  label: string;
  icon?: ReactNode;
  tone?: "default" | "inflow" | "held" | "pending" | "danger";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "glass-subtle relative rounded-[var(--radius-card)] px-4 py-3.5",
        className,
      )}
    >
      {icon && (
        <span
          aria-hidden="true"
          className="absolute top-3.5 right-3.5 text-ink-faint"
        >
          {icon}
        </span>
      )}
      <p
        className={cn(
          "text-[1.375rem] leading-tight font-semibold tracking-tight tabular-nums",
          TONES[tone],
        )}
      >
        {value}
      </p>
      <p className="mt-1 text-xs text-ink-muted">{label}</p>
    </div>
  );
}

const TONES = {
  default: "text-ink",
  inflow: "text-inflow",
  held: "text-held",
  pending: "text-pending",
  danger: "text-danger",
} as const;

/** A row of tiles that stays readable from two columns up to four. */
export function StatRow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * A small green or red delta, as seen beside a balance.
 * Neutral changes are not worth colouring.
 */
export function Delta({ children, up }: { children: ReactNode; up: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs font-medium",
        up ? "bg-inflow-soft text-inflow" : "bg-danger-soft text-danger",
      )}
    >
      <span aria-hidden="true">{up ? "▲" : "▼"}</span>
      {children}
    </span>
  );
}
