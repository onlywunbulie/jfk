import type { MonthlyRaised } from "@/modules/ledger/service";
import { Money, minorPerMajor, symbolOf, type Currency } from "@/lib/money";
import { cn } from "@/lib/cn";
import { Card, CardHeader } from "@/components/ui/card";
import { BarsIcon } from "@/components/ui/icons";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * What the group successfully raised, month by month.
 *
 * Server-rendered and script-free: the bars are plain boxes and the tooltips
 * are CSS, so it works before hydration and costs the phone nothing. The
 * current month is the only bar in the brand colour — every other bar is
 * context for it.
 *
 * Heights are ratios of integer kobo; no amount is ever turned into a float.
 */
export function MonthlyRaisedChart({ months }: { months: MonthlyRaised[] }) {
  const peak = months.reduce(
    (max, row) => (row.raised.minor > max ? row.raised.minor : max),
    0n,
  );
  const currency = months[0]?.raised.currency ?? "USDC";
  const ceiling = niceCeiling(peak, currency);
  const nothingYet = peak === 0n;
  const lastIndex = months.length - 1;

  return (
    <Card>
      <CardHeader
        title="Raised each month"
        icon={<BarsIcon />}
        action={
          <div className="flex shrink-0 items-center gap-3 text-xs text-ink-muted">
            <span className="hidden items-center gap-1.5 sm:flex">
              <span aria-hidden="true" className="h-3 w-1 rounded-full bg-accent" />
              This month
            </span>
            <span className="glass-subtle rounded-md px-2 py-1">
              Last {months.length} months
            </span>
          </div>
        }
      />

      <div className="flex gap-3">
        {/* Scale. Top to bottom, so it lines up with the gridlines beside it. */}
        <div
          aria-hidden="true"
          className="flex h-44 flex-col justify-between text-right text-[0.625rem] text-ink-faint tabular-nums"
        >
          {[4n, 3n, 2n, 1n, 0n].map((step) => (
            <span key={step} className="leading-none">
              {axisLabel((ceiling * step) / 4n, currency)}
            </span>
          ))}
        </div>

        <div className="min-w-0 flex-1">
          <div className="group/chart relative h-44">
            <div
              aria-hidden="true"
              className="absolute inset-0 flex flex-col justify-between"
            >
              {[0, 1, 2, 3, 4].map((line) => (
                <span key={line} className="h-px bg-white/[0.05]" />
              ))}
            </div>

            <ul className="relative flex h-full items-end gap-1.5 sm:gap-2.5">
              {months.map((row, index) => {
                const isCurrent = index === lastIndex;
                const empty = row.raised.isZero();
                // Tenths of a percent, so short bars still differ visibly.
                const height = Number((row.raised.minor * 1000n) / ceiling) / 10;

                return (
                  <li
                    key={row.month}
                    tabIndex={0}
                    className="group/bar relative flex h-full flex-1 items-end rounded-md outline-offset-4"
                  >
                    <span className="sr-only">
                      {longLabel(row.month)}: {row.raised.format({ compact: true })}
                    </span>

                    <span
                      aria-hidden="true"
                      className={cn(
                        "w-full rounded-t-md rounded-b-sm transition-[filter,background-color] duration-150",
                        isCurrent
                          ? "bg-gradient-to-b from-accent to-accent/15 shadow-[0_0_24px_-4px_var(--color-accent)]"
                          : "bg-white/[0.07] group-hover/bar:bg-white/[0.16] group-focus-visible/bar:bg-white/[0.16]",
                      )}
                      style={{ height: empty ? "3px" : `max(${height}%, 6px)` }}
                    />

                    <span
                      aria-hidden="true"
                      className={cn(
                        "glass-strong pointer-events-none absolute z-10 mb-2 rounded-lg px-2.5 py-1.5 whitespace-nowrap transition-opacity duration-150",
                        "group-hover/bar:opacity-100! group-focus-visible/bar:opacity-100!",
                        // The current month speaks for itself until you point
                        // at another one.
                        isCurrent && !empty
                          ? "opacity-100 group-hover/chart:opacity-0"
                          : "opacity-0",
                        index < 2
                          ? "left-0"
                          : index > lastIndex - 2
                            ? "right-0"
                            : "left-1/2 -translate-x-1/2",
                      )}
                      style={{
                        bottom: empty ? "3px" : `max(${height}%, 6px)`,
                      }}
                    >
                      <span className="block text-[0.625rem] text-ink-muted">
                        {longLabel(row.month)}
                      </span>
                      <span className="block text-sm font-semibold text-ink tabular-nums">
                        {row.raised.format({ compact: true })}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>

          <ul
            aria-hidden="true"
            className="mt-2 flex gap-1.5 text-center text-[0.625rem] sm:gap-2.5 sm:text-xs"
          >
            {months.map((row, index) => (
              <li
                key={row.month}
                className={cn(
                  "flex-1",
                  index === lastIndex ? "font-medium text-ink" : "text-ink-faint",
                )}
              >
                {MONTHS[Number(row.month.slice(5)) - 1]}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {nothingYet && (
        <p className="mt-4 text-xs text-ink-faint">
          Nothing raised yet. Each month fills in as contributions settle.
        </p>
      )}
    </Card>
  );
}

/** "2026-08" → "Aug 2026" */
function longLabel(month: string): string {
  return `${MONTHS[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}`;
}

/**
 * The top of the scale: the smallest round figure at or above the tallest bar
 * that also divides into four tidy gridlines. Worked out in whole units of the
 * group's currency, then turned back into minor units.
 */
function niceCeiling(peakMinor: bigint, currency: Currency): bigint {
  const unit = minorPerMajor(currency);
  const major = (peakMinor + unit - 1n) / unit;
  if (major <= 4n) return 4n * unit;

  const magnitude = 10n ** BigInt(major.toString().length - 1);
  for (const step of [1n, 2n, 4n, 6n, 8n, 10n]) {
    if (step * magnitude >= major) return step * magnitude * unit;
  }
  return magnitude * 10n * unit;
}

/** Compact scale label: $40, ₦7.5k, $1.2m. */
function axisLabel(minor: bigint, currency: Currency): string {
  const major = minor / minorPerMajor(currency);
  if (major < 1000n) return Money.fromMinor(minor, currency).format({ compact: true });

  const unit = major >= 1_000_000n ? 1_000_000n : 1000n;
  const whole = major / unit;
  const tenth = ((major % unit) * 10n) / unit;
  const suffix = unit === 1000n ? "k" : "m";
  return `${symbolOf(currency)}${whole}${tenth === 0n ? "" : `.${tenth}`}${suffix}`;
}
