import { Skeleton } from "@/components/skeleton";

/** All groups while they load: the greeting, the total, then the cards. */
export default function GroupsLoading() {
  return (
    <div role="status" aria-label="Loading" className="space-y-8">
      <div>
        <Skeleton className="h-4 w-40" />
        <Skeleton className="mt-3 h-10 w-48" />
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <Skeleton className="h-32 rounded-[var(--radius-card)]" />
        <Skeleton className="h-32 rounded-[var(--radius-card)]" />
      </div>
    </div>
  );
}
