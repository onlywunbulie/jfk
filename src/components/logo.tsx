import { cn } from "@/lib/cn";

/**
 * The mark: an ice-blue circle with an uppercase R, the same face Rall wears in
 * every group. Drawn rather than imported so it stays crisp at any size and
 * follows the accent token.
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
      <span
        role="img"
        aria-label="Rallied"
        className="grid size-9 shrink-0 place-items-center rounded-full bg-accent text-lg font-bold text-accent-ink"
      >
        <span aria-hidden="true">R</span>
      </span>

      {showWordmark && <span className="text-xl font-semibold tracking-tight text-ink">Rallied</span>}
    </div>
  );
}
