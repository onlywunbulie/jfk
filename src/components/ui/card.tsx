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
        "rounded-[var(--radius-card)] border border-border",
        raised ? "bg-raised" : "bg-surface",
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
  action,
}: {
  title: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <h2 className="text-sm font-medium tracking-wide text-ink-muted uppercase">
        {title}
      </h2>
      {action}
    </div>
  );
}
