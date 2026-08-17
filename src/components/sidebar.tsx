"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Route } from "next";
import { cn } from "@/lib/cn";

export interface SidebarGroup {
  id: string;
  name: string;
  balance: string;
  memberCount: number;
  threshold: string;
  isCurrent: boolean;
}

/**
 * The desktop shell's left rail.
 *
 * Holds the thing every screen needs and none of them should have to repeat:
 * which group you are in, what it holds, and what the group's bar for spending
 * is. On mobile this collapses away entirely and `TabBar` takes over.
 */
export function Sidebar({
  groups,
  user,
}: {
  groups: SidebarGroup[];
  user: { displayName: string; email: string };
}) {
  const pathname = usePathname();
  const current = groups.find((group) => group.isCurrent);

  return (
    <aside
      className="fixed inset-y-0 left-0 z-40 hidden w-[var(--sidebar-width)] flex-col border-r border-border bg-surface lg:flex"
      aria-label="Sidebar"
    >
      <div className="flex items-center gap-2.5 px-5 py-5">
        <Mark />
        <span className="text-[0.9375rem] font-semibold tracking-tight text-ink">
          JFK
        </span>
      </div>

      {/* The group you are looking at, and its money, always in view. */}
      {current && (
        <div className="mx-3 rounded-[var(--radius-card)] bg-raised p-4">
          <p className="truncate text-sm font-medium text-ink">{current.name}</p>
          <p className="mt-1 text-xl font-semibold tracking-tight text-ink">
            {current.balance}
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <Pill>{current.memberCount} members</Pill>
            <Pill>{current.threshold} to pass</Pill>
          </div>
        </div>
      )}

      <nav className="mt-5 flex-1 overflow-y-auto px-3" aria-label="Primary">
        {current ? (
          <ul className="space-y-0.5">
            <NavItem
              href={`/groups/${current.id}` as Route}
              pathname={pathname}
              icon={<DashboardIcon />}
              exact
            >
              Dashboard
            </NavItem>
            <NavItem
              href={`/groups/${current.id}/proposals` as Route}
              pathname={pathname}
              icon={<ProposalsIcon />}
            >
              Proposals
            </NavItem>
            <NavItem
              href={`/groups/${current.id}/members` as Route}
              pathname={pathname}
              icon={<MembersIcon />}
            >
              Members
            </NavItem>
          </ul>
        ) : null}

        <p className="mt-6 mb-2 px-3 text-[0.6875rem] font-medium tracking-wider text-ink-faint uppercase">
          Your groups
        </p>
        <ul className="space-y-0.5">
          {groups.map((group) => (
            <li key={group.id}>
              <Link
                href={`/groups/${group.id}` as Route}
                className={cn(
                  "flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm transition-colors",
                  group.isCurrent
                    ? "text-ink"
                    : "text-ink-muted hover:bg-raised hover:text-ink",
                )}
              >
                <span className="truncate">{group.name}</span>
                <span className="shrink-0 text-xs text-ink-faint">
                  {group.balance}
                </span>
              </Link>
            </li>
          ))}
        </ul>

        <Link
          href="/groups/new"
          className="mt-2 flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-ink-muted transition-colors hover:bg-raised hover:text-ink"
        >
          <span className="grid size-4 place-items-center text-base leading-none">
            +
          </span>
          New group
        </Link>
      </nav>

      <div className="border-t border-border p-3">
        <ul className="space-y-0.5">
          <NavItem href="/" pathname={pathname} icon={<HomeIcon />} exact>
            All groups
          </NavItem>
          <NavItem href="/wallet" pathname={pathname} icon={<WalletIcon />}>
            Wallet
          </NavItem>
        </ul>

        <div className="mt-2 flex items-center gap-2.5 rounded-lg px-3 py-2">
          <Avatar name={user.displayName} />
          <div className="min-w-0">
            <p className="truncate text-sm text-ink">{user.displayName}</p>
            <p className="truncate text-xs text-ink-faint">{user.email}</p>
          </div>
        </div>
      </div>
    </aside>
  );
}

function NavItem({
  href,
  pathname,
  icon,
  children,
  exact = false,
}: {
  href: Route;
  pathname: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  exact?: boolean;
}) {
  const active = exact ? pathname === href : pathname.startsWith(href);

  return (
    <li>
      <Link
        href={href}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors",
          active
            ? "bg-raised font-medium text-ink"
            : "text-ink-muted hover:bg-raised hover:text-ink",
        )}
      >
        <span className={cn("shrink-0", active ? "text-accent" : "text-ink-faint")}>
          {icon}
        </span>
        {children}
      </Link>
    </li>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-md bg-surface px-2 py-1 text-[0.6875rem] text-ink-muted">
      {children}
    </span>
  );
}

function Avatar({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <span
      aria-hidden="true"
      className="grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-[0.6875rem] font-medium text-accent"
    >
      {initials || "?"}
    </span>
  );
}

function Mark() {
  return (
    <svg viewBox="0 0 40 40" className="size-6" role="img" aria-label="JFK">
      <circle cx="14" cy="14" r="9" className="fill-accent/70" />
      <circle cx="26" cy="14" r="9" className="fill-accent/40" />
      <circle cx="20" cy="25" r="9" className="fill-accent" />
    </svg>
  );
}

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

function DashboardIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-[1.125rem]" aria-hidden="true" {...stroke}>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </svg>
  );
}

function ProposalsIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-[1.125rem]" aria-hidden="true" {...stroke}>
      <path d="M13 3 4 14h7l-1 7 9-11h-7l1-7Z" />
    </svg>
  );
}

function MembersIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-[1.125rem]" aria-hidden="true" {...stroke}>
      <circle cx="9" cy="8.5" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 5.2a3.5 3.5 0 0 1 0 6.6M18 14.4a6.5 6.5 0 0 1 3.5 5.6" />
    </svg>
  );
}

function HomeIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-[1.125rem]" aria-hidden="true" {...stroke}>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5.5 9.5V20h13V9.5" />
    </svg>
  );
}

function WalletIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-[1.125rem]" aria-hidden="true" {...stroke}>
      <rect x="3" y="6" width="18" height="13" rx="3" />
      <path d="M3 10h18" />
      <circle cx="16.5" cy="14.5" r="1.25" fill="currentColor" stroke="none" />
    </svg>
  );
}
