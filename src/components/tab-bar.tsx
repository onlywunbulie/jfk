"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Route } from "next";
import { cn } from "@/lib/cn";

/**
 * The five-tab spine from BLUEPRINT.md §5. Groups and Activity are stubs until
 * Phases 1 and 7 — they're present so the shape of the app is real from day one.
 */
const TABS = [
  { href: "/groups", label: "Groups", icon: GroupsIcon },
  { href: "/activity", label: "Activity", icon: ActivityIcon },
  { href: "/wallet", label: "Wallet", icon: WalletIcon },
] satisfies ReadonlyArray<{
  href: Route;
  label: string;
  icon: (props: { className?: string }) => React.ReactNode;
}>;

export function TabBar() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary"
      className="pb-safe sticky bottom-0 z-40 glass border-x-0 border-b-0"
    >
      <ul className="mx-auto flex max-w-lg items-stretch">
        {TABS.map(({ href, label, icon: Icon }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);

          return (
            <li key={href} className="flex-1">
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex flex-col items-center gap-1 px-2 pt-2.5 pb-1.5",
                  "transition-colors duration-150",
                  active ? "text-accent" : "text-ink-faint hover:text-ink-muted",
                )}
              >
                <Icon className="size-6" />
                <span className="text-[0.6875rem] font-medium">{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/* Icons: inline, 24px grid, 1.75 stroke to match the type weight. */
const strokeProps = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

function GroupsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...strokeProps}>
      <circle cx="9" cy="8.5" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 5.2a3.5 3.5 0 0 1 0 6.6M18 14.4a6.5 6.5 0 0 1 3.5 5.6" />
    </svg>
  );
}

function ActivityIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...strokeProps}>
      <path d="M3 12h4l2.5-6 5 12 2.5-6h4" />
    </svg>
  );
}

function WalletIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...strokeProps}>
      <rect x="3" y="6" width="18" height="13" rx="3" />
      <path d="M3 10h18" />
      <circle cx="16.5" cy="14.5" r="1.25" fill="currentColor" stroke="none" />
    </svg>
  );
}
