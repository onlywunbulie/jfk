import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  /** Lifts the card off the ground — for the one thing that matters on screen. */
  raised?: boolean;
  inset?: boolean;
}

export function Card({
  children,
  raised = false,
  inset = true,
  className,
  ...props
}: CardProps) {
  return (
    <div
      {...props}
      className={cn(
        "rounded-[var(--radius-card)]",
        raised ? "glass-strong" : "glass",
        inset && "p-5",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  icon,
  action,
}: {
  title: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2.5">
        {icon && <IconTile>{icon}</IconTile>}
        <h2 className="truncate text-[0.9375rem] font-medium text-ink">{title}</h2>
      </div>
      {action}
    </div>
  );
}

/** The small square that sits beside a card's title. */
export function IconTile({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className="glass-subtle grid size-8 shrink-0 place-items-center rounded-lg text-ink-muted"
    >
      {children}
    </span>
  );
}
