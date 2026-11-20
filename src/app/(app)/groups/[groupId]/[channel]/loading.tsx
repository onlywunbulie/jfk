import { Skeleton } from "@/components/skeleton";

/**
 * A channel while its data loads (reads from Base can take a moment): the
 * shape of the channel intro, then a Rall message, so nothing jumps when the
 * real thing arrives.
 */
export default function ChannelLoading() {
  return (
    <div role="status" aria-label="Loading">
      <Skeleton className="size-[68px] rounded-full" />
      <Skeleton className="mt-4 h-9 w-56" />
      <Skeleton className="mt-3 h-4 w-full max-w-md" />
      <Skeleton className="mt-2 h-4 w-2/3 max-w-sm" />

      <div className="mt-10 flex gap-4">
        <Skeleton className="size-10 shrink-0 rounded-full" />
        <div className="min-w-0 flex-1">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="mt-3 h-36 w-full max-w-xl rounded-[var(--radius-big)]" />
        </div>
      </div>
    </div>
  );
}
