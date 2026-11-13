import { cn } from "@/lib/cn";

/**
 * How many have said yes, against a white marker at the share the decision
 * needs. Green once there are enough yes votes to pass.
 */
export function VoteBar({ yes, members, need }: { yes: number; members: number; need: string }) {
  const share = Math.round((yes / members) * 100);
  const needed = Number.parseFloat(need);
  const passing = share >= needed;
  return (
    <div>
      <div
        role="meter"
        aria-valuemin={0}
        aria-valuemax={members}
        aria-valuenow={yes}
        aria-label={`${yes} of ${members} voted yes, ${need} needed`}
        className="relative h-2 rounded-full bg-overlay"
      >
        <div
          className={cn("h-full rounded-full transition-[width] duration-500", passing ? "bg-inflow" : "bg-ink-muted")}
          style={{ width: `${share}%` }}
        />
        {/* The line it has to cross. */}
        <span aria-hidden="true" className="absolute -top-1 -bottom-1 w-0.5 rounded-full bg-ink" style={{ left: `${needed}%` }} />
      </div>
      <p className="mt-2 text-sm tabular-nums">
        <span className="text-ink">
          {yes} of {members} yes
        </span>
        <span className="text-ink-muted"> · {need} needed</span>
        {passing && <span className="text-inflow"> · enough to pass</span>}
      </p>
    </div>
  );
}
