import { cn } from "@/lib/cn";

/**
 * The mark: three interlocking rings — the homeboys, and the pooled fund they
 * hold between them. Drawn rather than imported so it stays crisp at any size
 * and inherits the accent token.
 */
export function Logo({
  className,
  showWordmark = true,
}: {
  className?: string;
  showWordmark?: boolean;
}) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <svg
        viewBox="0 0 40 40"
        className="size-9 shrink-0"
        role="img"
        aria-label="JFK"
      >
        <circle cx="14" cy="14" r="9" className="fill-accent/70" />
        <circle cx="26" cy="14" r="9" className="fill-accent/40" />
        <circle cx="20" cy="25" r="9" className="fill-accent" />
      </svg>

      {showWordmark && (
        <span className="text-xl font-semibold tracking-tight text-ink">JFK</span>
      )}
    </div>
  );
}
