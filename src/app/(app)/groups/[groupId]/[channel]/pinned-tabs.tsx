"use client";

import { cn } from "@/lib/cn";

/**
 * A row of plain-text tabs pinned flush with the main card's top edge, so
 * every section of a channel is one tap away. Active: white and underlined
 * (the label only; the count sits beside it). The negative margins cancel the
 * main card's padding so the band runs edge to edge.
 */
export function PinnedTabs<T extends string>({
  label,
  tabs,
  active,
  onChange,
}: {
  label: string;
  tabs: { value: T; label: string; count?: number }[];
  active: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="sticky -top-6 z-10 -mx-4 -mt-6 border-b border-border bg-canvas px-4 py-3 lg:-mx-8 lg:px-8">
      <div role="tablist" aria-label={label} className="flex flex-wrap gap-5">
        {tabs.map((tab) => (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={active === tab.value}
            onClick={() => onChange(tab.value)}
            className={cn("press py-1 text-sm transition-colors", active === tab.value ? "text-ink" : "text-ink-muted hover:text-ink")}
          >
            <span className={cn(active === tab.value && "underline decoration-ink decoration-2 underline-offset-[6px]")}>
              {tab.label}
            </span>
            {tab.count ? <span className="ml-1.5 text-ink-faint tabular-nums">{tab.count}</span> : null}
          </button>
        ))}
      </div>
    </div>
  );
}
