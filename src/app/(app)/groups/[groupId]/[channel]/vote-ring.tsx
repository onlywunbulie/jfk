import { cn } from "@/lib/cn";

/**
 * A vote as a ring of seats: one block per member who may vote, filled ice
 * blue for each yes (from the top, clockwise), faded red for each no (from
 * the end, backwards), dark while still to vote. A white tick marks the seat
 * that passes it; the middle counts yes votes against what's needed.
 *
 * Counting people, not percentages: "2 of 2 needed" reads at a glance in a
 * group of three, and still works at twenty.
 */
export function VoteRing({
  yes,
  no,
  eligible,
  neededYes,
  className,
}: {
  yes: number;
  no: number;
  eligible: number;
  neededYes: number;
  className?: string;
}) {
  const seats = Math.max(1, eligible);
  const span = 360 / seats;
  // A little air between blocks; less when there are many.
  const gap = seats > 12 ? 4 : 8;
  const blocks = Array.from({ length: seats }, (_, i) => (i < yes ? "yes" : i >= seats - no ? "no" : "waiting"));
  const markAt = -90 + Math.min(neededYes, seats) * span;

  return (
    <div className={cn("relative size-[132px] shrink-0", className)}>
      <svg viewBox="0 0 132 132" className="size-full overflow-visible" role="img" aria-label={`${yes} of ${eligible} voted yes; ${neededYes} needed`}>
        {blocks.map((state, i) => (
          <path
            key={i}
            d={arc(-90 + i * span + gap / 2, -90 + (i + 1) * span - gap / 2)}
            fill="none"
            strokeWidth={10}
            className={cn(
              "transition-[stroke] duration-300",
              state === "yes" ? "stroke-accent" : state === "no" ? "stroke-danger/60" : "stroke-overlay",
            )}
          />
        ))}
        {/* The seat that passes it. */}
        <line
          x1={point(markAt, RADIUS - 9).x}
          y1={point(markAt, RADIUS - 9).y}
          x2={point(markAt, RADIUS + 9).x}
          y2={point(markAt, RADIUS + 9).y}
          strokeWidth={2}
          strokeLinecap="round"
          className="stroke-ink"
        />
      </svg>
      <div className="absolute inset-0 grid place-content-center text-center">
        <span className="text-[1.75rem] leading-none font-extrabold tracking-tight text-ink tabular-nums">{yes}</span>
        <span className="mt-1 text-xs text-ink-muted">of {neededYes} needed</span>
      </div>
    </div>
  );
}

const CENTRE = 66;
const RADIUS = 56;

function point(degrees: number, radius: number) {
  const radians = (degrees * Math.PI) / 180;
  return { x: +(CENTRE + radius * Math.cos(radians)).toFixed(2), y: +(CENTRE + radius * Math.sin(radians)).toFixed(2) };
}

function arc(from: number, to: number): string {
  const start = point(from, RADIUS);
  const end = point(to, RADIUS);
  return `M ${start.x} ${start.y} A ${RADIUS} ${RADIUS} 0 ${to - from > 180 ? 1 : 0} 1 ${end.x} ${end.y}`;
}
