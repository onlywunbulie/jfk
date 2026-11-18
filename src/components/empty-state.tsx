import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** The unDraw scenes in public/illustrations, recoloured for Rallied (scripts/illustrations.mts). */
export type Illustration =
  | "no-groups"
  | "no-votes"
  | "no-transactions"
  | "no-proposals"
  | "no-rule-changes"
  | "no-role-changes"
  | "not-on-base"
  | "sent-to-vote"
  | "dues-paid"
  | "all-set";

/**
 * An empty screen, designed: an illustration that shows the moment, a short
 * title, one line of help, and the next step where there's an obvious one.
 * One illustration set everywhere (unDraw, in Rallied's colours).
 *
 * `size="sm"` for a section inside a channel (no drafts waiting), the default
 * for a whole screen (no groups yet).
 */
export function EmptyState({
  illustration,
  title,
  children,
  action,
  size = "md",
  className,
}: {
  illustration: Illustration;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center text-center", size === "md" ? "gap-2 py-12" : "gap-2 py-8", className)}>
      {/* Decorative: the title says what it means. A small static SVG: the image optimiser adds nothing. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/illustrations/${illustration}.svg`}
        alt=""
        aria-hidden="true"
        className={cn("mb-4 w-auto object-contain", size === "md" ? "h-40" : "h-28")}
      />
      <p className={cn("font-semibold text-ink", size === "md" ? "text-xl" : "text-base")}>{title}</p>
      {children && <p className="max-w-[36ch] text-sm text-pretty text-ink-muted">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
