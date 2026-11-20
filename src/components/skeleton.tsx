import { cn } from "@/lib/cn";

/**
 * A placeholder block in the shape of what's loading. A slow, quiet pulse
 * (the same breath as money in flight) so the screen reads as working, not
 * stuck. Purely visual: the loading screen carries one status line for
 * screen readers.
 */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn("animate-pending block rounded-[var(--radius-control)] bg-raised", className)} />;
}
