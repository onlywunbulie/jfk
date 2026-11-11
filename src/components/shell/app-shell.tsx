"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Route } from "next";
import { cn } from "@/lib/cn";
import { signOutAction } from "@/app/(app)/actions";

export interface ShellGroup {
  id: string;
  name: string;
  memberCount: number;
  /** Already formatted in the group's currency, e.g. "$1,800". */
  balance: string;
  /** Open votes this person hasn't cast yet. Drives the badge. */
  waiting: number;
}

export interface ShellUser {
  displayName: string;
  /** Their Base wallet, shortened, or null for an email-only account. */
  wallet: string | null;
}

/**
 * The app's frame, after Discord: a rail of group icons, the open group's
 * channels beside it, and a profile bar at the bottom. On a phone the rail
 * and channels live in a menu that slides in from the left.
 */
export function AppShell({
  groups,
  user,
  children,
}: {
  groups: ShellGroup[];
  user: ShellUser;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const currentId = pathname.match(/^\/groups\/([^/]+)/)?.[1];
  const current = groups.find((group) => group.id === currentId) ?? null;
  const [menuOpen, setMenuOpen] = useState(false);

  // Going somewhere closes the menu. Keyed on the path, so it only fires on a
  // real navigation.
  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    setMenuOpen(false);
  }

  const nav = <Navigation groups={groups} current={current} pathname={pathname} user={user} />;

  return (
    <div className="min-h-dvh">
      {/* Desktop: always there. */}
      <div className="fixed inset-y-0 left-0 z-40 hidden lg:flex">{nav}</div>

      {/* Phone: slides in over the page. */}
      <MobileMenu open={menuOpen} onClose={() => setMenuOpen(false)}>
        {nav}
      </MobileMenu>

      <div className="flex min-h-dvh flex-col lg:pl-[calc(var(--rail-width)+var(--sidebar-width))]">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-canvas px-4 lg:hidden">
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            aria-label="Open groups and channels"
            className="press -ml-2 grid size-10 place-items-center rounded-[var(--radius-control)] text-ink-muted hover:text-ink"
          >
            <MenuIcon />
          </button>
          <p className="min-w-0 truncate text-base font-semibold">
            {current ? current.name : "JFK"}
          </p>
          {current && current.waiting > 0 && (
            <span className="ml-auto grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1.5 text-[0.625rem] font-bold text-accent-ink">
              {current.waiting}
            </span>
          )}
        </header>

        <div className="mx-auto w-full max-w-lg flex-1 px-4 pt-6 pb-10 lg:mx-0 lg:max-w-none lg:px-8 lg:pt-8 lg:pb-16 2xl:max-w-[112rem] 2xl:px-12">
          {children}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rail + channels + profile: the same on desktop and in the phone menu
// ---------------------------------------------------------------------------

function Navigation({
  groups,
  current,
  pathname,
  user,
}: {
  groups: ShellGroup[];
  current: ShellGroup | null;
  pathname: string;
  user: ShellUser;
}) {
  return (
    <div className="flex h-full">
      <Rail groups={groups} currentId={current?.id ?? null} />
      <aside
        aria-label={current ? `${current.name} channels` : "Home"}
        className="flex h-full w-[var(--sidebar-width)] flex-col border-r border-border bg-surface"
      >
        <div className="min-h-0 flex-1 overflow-y-auto">
          {current ? (
            <GroupChannels group={current} pathname={pathname} />
          ) : (
            <HomeChannels pathname={pathname} />
          )}
        </div>
        <ProfileBar user={user} />
      </aside>
    </div>
  );
}

function Rail({ groups, currentId }: { groups: ShellGroup[]; currentId: string | null }) {
  return (
    <nav
      aria-label="Your groups"
      className="flex h-full w-[var(--rail-width)] flex-col items-center gap-2 overflow-y-auto bg-rail py-3"
    >
      <RailItem href="/groups" label="Home: all your groups" selected={currentId === null}>
        <Mark />
      </RailItem>
      <span aria-hidden="true" className="my-1 h-0.5 w-8 rounded-full bg-border" />

      {groups.map((group) => (
        <RailItem
          key={group.id}
          href={`/groups/${group.id}` as Route}
          label={group.waiting > 0 ? `${group.name}: ${group.waiting} waiting on you` : group.name}
          selected={group.id === currentId}
          badge={group.waiting}
        >
          <span className="text-base font-semibold">{initials(group.name)}</span>
        </RailItem>
      ))}

      <RailItem href="/groups/new" label="Create a group" selected={false} quiet>
        <PlusIcon />
      </RailItem>
    </nav>
  );
}

/**
 * A round icon that becomes a rounded square when selected, with the orange
 * marker on the rail's left edge, as Discord does it.
 */
function RailItem({
  href,
  label,
  selected,
  badge = 0,
  quiet = false,
  children,
}: {
  href: Route;
  label: string;
  selected: boolean;
  badge?: number;
  quiet?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="group/rail relative flex w-full justify-center">
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-1/2 left-0 w-1 -translate-y-1/2 rounded-r-full bg-accent transition-[height] duration-300 ease-[var(--ease-spring)]",
          selected ? "h-10" : "h-0 group-hover/rail:h-5",
        )}
      />
      <Link
        href={href}
        title={label}
        aria-label={label}
        aria-current={selected ? "page" : undefined}
        className={cn(
          "press relative grid size-12 place-items-center transition-[border-radius,background-color,color] duration-300 ease-[var(--ease-spring)]",
          selected
            ? "rounded-[var(--radius-card)] bg-accent text-accent-ink"
            : quiet
              ? "rounded-full bg-raised text-inflow hover:rounded-[var(--radius-card)] hover:bg-inflow hover:text-canvas"
              : "rounded-full bg-raised text-ink hover:rounded-[var(--radius-card)] hover:bg-overlay",
        )}
      >
        {children}
        {badge > 0 && (
          <span className="absolute -right-1 -bottom-1 grid h-5 min-w-5 place-items-center rounded-full border-[3px] border-rail bg-accent px-1 text-[0.625rem] font-bold text-accent-ink">
            {badge > 99 ? "99+" : badge}
          </span>
        )}
      </Link>
    </div>
  );
}

function GroupChannels({ group, pathname }: { group: ShellGroup; pathname: string }) {
  const base = `/groups/${group.id}`;
  return (
    <>
      {/* The banner stays blank until a member uploads a real image. */}
      <div aria-hidden="true" className="h-20 border-b border-border bg-raised" />
      <div className="border-b border-border px-4 py-3">
        <p className="truncate text-base font-semibold">{group.name}</p>
        <p className="mt-0.5 text-xs text-ink-muted">
          {group.memberCount} member{group.memberCount === 1 ? "" : "s"} · {group.balance}
        </p>
      </div>

      <Section label="💬 Chat">
        <Channel href={`${base}/chat` as Route} pathname={pathname}>
          general
        </Channel>
      </Section>
      <Section label="💰 Money">
        <Channel href={base as Route} pathname={pathname} exact>
          overview
        </Channel>
      </Section>
      <Section label="🗳️ Decisions">
        <Channel href={`${base}/proposals` as Route} pathname={pathname} badge={group.waiting}>
          votes
        </Channel>
      </Section>
      <Section label="👥 People">
        <Channel href={`${base}/members` as Route} pathname={pathname}>
          members
        </Channel>
      </Section>
    </>
  );
}

function HomeChannels({ pathname }: { pathname: string }) {
  return (
    <>
      <div className="border-b border-border px-4 py-4">
        <p className="text-base font-semibold">Home</p>
        <p className="mt-0.5 text-xs text-ink-muted">Everything across your groups</p>
      </div>
      <Section label="🏠 You">
        <Channel href="/groups" pathname={pathname} exact>
          all groups
        </Channel>
        <Channel href="/wallet" pathname={pathname}>
          wallet
        </Channel>
        <Channel href="/groups/new" pathname={pathname}>
          new group
        </Channel>
      </Section>
    </>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="px-2 pt-5">
      <p className="mb-1 px-2 text-xs font-semibold tracking-wide text-ink-faint uppercase">{label}</p>
      <ul className="space-y-0.5">{children}</ul>
    </div>
  );
}

function Channel({
  href,
  pathname,
  exact = false,
  badge = 0,
  children,
}: {
  href: Route;
  pathname: string;
  exact?: boolean;
  badge?: number;
  children: ReactNode;
}) {
  const active = exact ? pathname === href : pathname.startsWith(href);
  return (
    <li>
      <Link
        href={href}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex h-9 items-center gap-2 rounded-[var(--radius-control)] px-2 text-base transition-colors",
          active
            ? "bg-raised font-semibold text-ink"
            : badge > 0
              ? "font-semibold text-ink hover:bg-raised"
              : "text-ink-muted hover:bg-raised hover:text-ink",
        )}
      >
        <span aria-hidden="true" className="text-xl leading-none text-ink-faint">
          #
        </span>
        <span className="min-w-0 flex-1 truncate">{children}</span>
        {badge > 0 && (
          <span className="grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1.5 text-[0.625rem] font-bold text-accent-ink">
            {badge}
          </span>
        )}
      </Link>
    </li>
  );
}

function ProfileBar({ user }: { user: ShellUser }) {
  return (
    <div className="flex items-center gap-2 border-t border-border bg-rail/60 px-2 py-2">
      <span
        aria-hidden="true"
        className="grid size-9 shrink-0 place-items-center rounded-full bg-accent text-sm font-semibold text-accent-ink"
      >
        {initials(user.displayName)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{user.displayName}</p>
        <p className={cn("truncate text-xs text-ink-faint", user.wallet && "font-mono")}>
          {user.wallet ?? "Signed in with email"}
        </p>
      </div>
      <Link
        href="/wallet"
        title="Wallet and profile"
        aria-label="Wallet and profile"
        className="press grid size-9 place-items-center rounded-[var(--radius-control)] text-ink-muted hover:bg-raised hover:text-ink"
      >
        <GearIcon />
      </Link>
      <form action={signOutAction}>
        <button
          type="submit"
          title="Log out"
          aria-label="Log out"
          className="press grid size-9 place-items-center rounded-[var(--radius-control)] text-ink-muted hover:bg-raised hover:text-ink"
        >
          <LogOutIcon />
        </button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The phone menu
// ---------------------------------------------------------------------------

/**
 * Slides in from the left on the shared spring, over a dim that eases in.
 * Closes the way it came: tap the dim, press Escape, or swipe it left. A
 * swipe has to travel a clear distance before it moves anything, and a short
 * one springs back.
 */
function MobileMenu({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startX: number; startY: number; dx: number; active: boolean } | null>(null);

  useEffect(() => {
    if (!open) return;
    // Hand movement back to the open/closed classes after any swipe.
    panel.current?.style.removeProperty("transform");
    panel.current?.style.removeProperty("transition");
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    // The page behind stays still while the menu is open.
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [open, onClose]);

  const setOffset = (px: number, animate: boolean) => {
    const el = panel.current;
    if (!el) return;
    el.style.transition = animate ? "transform 600ms var(--ease-spring)" : "none";
    el.style.transform = `translateX(${px}px)`;
  };

  return (
    <div className={cn("fixed inset-0 z-50 lg:hidden", open ? "" : "pointer-events-none")} aria-hidden={!open}>
      <div
        onClick={onClose}
        className={cn(
          "absolute inset-0 bg-black/60",
          open ? "opacity-100 transition-opacity duration-[240ms]" : "opacity-0 transition-opacity duration-200",
        )}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Groups and channels"
        onPointerDown={(event) => {
          drag.current = { startX: event.clientX, startY: event.clientY, dx: 0, active: false };
        }}
        onPointerMove={(event) => {
          const d = drag.current;
          if (!d) return;
          const dx = event.clientX - d.startX;
          const dy = event.clientY - d.startY;
          // Start dragging only after a clear sideways move, so taps and
          // scrolling the channel list never shift the menu.
          if (!d.active) {
            if (Math.abs(dy) > 12) {
              drag.current = null;
              return;
            }
            if (dx > -12) return;
            d.active = true;
          }
          d.dx = Math.min(0, dx);
          setOffset(d.dx, false);
        }}
        onPointerUp={() => {
          const d = drag.current;
          drag.current = null;
          if (!d?.active) return;
          if (d.dx < -60) {
            // Carry on out from where the finger left it, rather than jumping.
            const el = panel.current;
            if (el) {
              el.style.transition = "transform 300ms var(--ease-depart)";
              el.style.transform = "translateX(-100%)";
            }
            onClose();
          } else {
            setOffset(0, true);
          }
        }}
        style={{ touchAction: "pan-y" }}
        className={cn(
          "absolute inset-y-0 left-0 flex max-w-[calc(100vw-3.5rem)] overflow-hidden",
          open
            ? "translate-x-0 transition-transform duration-[600ms] ease-[var(--ease-spring)]"
            : "-translate-x-full transition-transform duration-300 ease-[var(--ease-depart)]",
        )}
      >
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** "Lagos Boys" → "LB", "Brothers" → "B". */
function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => word[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}

function Mark() {
  return (
    <svg viewBox="0 0 40 40" className="size-7" role="img" aria-label="JFK">
      <circle cx="14" cy="14" r="9" className="fill-current opacity-70" />
      <circle cx="26" cy="14" r="9" className="fill-current opacity-40" />
      <circle cx="20" cy="25" r="9" className="fill-current" />
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

function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-6" aria-hidden="true" {...stroke}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-6" aria-hidden="true" {...stroke}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true" {...stroke}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </svg>
  );
}

function LogOutIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true" {...stroke}>
      <path d="M15 17v1.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2V7" />
      <path d="M19 12H9m10 0-3-3m3 3-3 3" />
    </svg>
  );
}
