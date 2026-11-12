"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Route } from "next";
import { cn } from "@/lib/cn";
import {
  CHANNEL_SECTIONS,
  DEFAULT_CHANNEL,
  GearIcon,
  HomeIcon,
  MenuIcon,
  PeopleIcon,
  PlusIcon,
  WalletIcon,
  findChannel,
} from "./channels";

export interface ShellGroup {
  id: string;
  name: string;
  memberCount: number;
  /** Already formatted in the group's currency, e.g. "$15,000". */
  balance: string;
  /** Open votes this person hasn't cast yet. Drives the badge. */
  waiting: number;
}

/**
 * Rallied's frame, from the wireframe of 12 November 2026: a rail of square
 * group icons with settings at the foot, then two floating cards, the group's
 * sidebar and the main card with the open channel's name across its top.
 *
 * On a phone the rail and sidebar live in a menu that slides in from the
 * left, and the main card fills the screen.
 */
export function AppShell({ groups, children }: { groups: ShellGroup[]; children: ReactNode }) {
  const pathname = usePathname();
  const match = pathname.match(/^\/groups\/([^/]+)(?:\/([^/]+))?/);
  const current = groups.find((group) => group.id === match?.[1]) ?? null;
  const title = titleFor(pathname, current, match?.[2]);
  const [menuOpen, setMenuOpen] = useState(false);

  // Going somewhere closes the menu. Keyed on the path, so it only fires on a
  // real navigation.
  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    setMenuOpen(false);
  }

  const nav = (
    <>
      <Rail groups={groups} currentId={current?.id ?? null} pathname={pathname} />
      <SidebarCard current={current} pathname={pathname} />
    </>
  );

  return (
    <div className="flex min-h-dvh bg-canvas">
      {/* Desktop: rail plus the sidebar card, always there. */}
      <div className="sticky top-0 hidden h-dvh shrink-0 lg:flex">{nav}</div>

      {/* Phone: the same, sliding in over the page. */}
      <MobileMenu open={menuOpen} onClose={() => setMenuOpen(false)}>
        {nav}
      </MobileMenu>

      <main className="flex min-h-dvh min-w-0 flex-1 flex-col lg:h-dvh lg:py-3 lg:pr-3">
        <section
          aria-label={title.label}
          className="flex min-h-0 flex-1 flex-col bg-surface lg:rounded-[var(--radius-card)] lg:border lg:border-border"
        >
          <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-4 lg:static lg:rounded-t-[var(--radius-card)]">
            <button
              type="button"
              onClick={() => setMenuOpen(true)}
              aria-label="Open groups and channels"
              className="press -ml-2 grid size-10 place-items-center rounded-[var(--radius-control)] text-ink-muted hover:text-ink lg:hidden"
            >
              <MenuIcon />
            </button>
            {title.icon && <span className="text-ink-faint">{title.icon}</span>}
            <h1 className="min-w-0 truncate text-base font-semibold">{title.label}</h1>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 lg:px-8">{children}</div>
        </section>
      </main>
    </div>
  );
}

/** What the main card's header says for the page you're on. */
function titleFor(pathname: string, group: ShellGroup | null, segment: string | undefined) {
  const channel = group ? findChannel(segment ?? DEFAULT_CHANNEL) : undefined;
  if (channel) return { label: channel.label, icon: channel.icon };
  if (pathname === "/groups/new") return { label: "new group", icon: <PlusIcon /> };
  if (pathname === "/groups") return { label: "all groups", icon: <HomeIcon /> };
  if (pathname.startsWith("/wallet")) return { label: "settings", icon: <GearIcon /> };
  if (group) return { label: group.name, icon: null };
  return { label: "Rallied", icon: null };
}

// ---------------------------------------------------------------------------
// The rail
// ---------------------------------------------------------------------------

function Rail({ groups, currentId, pathname }: { groups: ShellGroup[]; currentId: string | null; pathname: string }) {
  return (
    <nav
      aria-label="Your groups"
      className="flex h-full w-[var(--rail-width)] flex-col items-center gap-2 bg-rail py-3"
    >
      <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-2 overflow-y-auto">
        <RailItem href="/groups" label="Home: all your groups" selected={currentId === null && pathname === "/groups"}>
          <HomeIcon />
        </RailItem>
        <span aria-hidden="true" className="my-1 h-px w-6 bg-border-strong" />

        {groups.map((group) => (
          <RailItem
            key={group.id}
            href={`/groups/${group.id}/${DEFAULT_CHANNEL}` as Route}
            label={group.waiting > 0 ? `${group.name}: ${group.waiting} waiting on you` : group.name}
            selected={group.id === currentId}
            badge={group.waiting}
          >
            <span className="text-sm font-semibold">{initials(group.name)}</span>
          </RailItem>
        ))}

        <RailItem href="/groups/new" label="Create a group" selected={pathname === "/groups/new"}>
          <PlusIcon />
        </RailItem>
      </div>

      <RailItem href="/wallet" label="Settings" selected={pathname.startsWith("/wallet")}>
        <GearIcon />
      </RailItem>
    </nav>
  );
}

/** A square icon on the rail. Selected turns orange with a marker at the rail's edge. */
function RailItem({
  href,
  label,
  selected,
  badge = 0,
  children,
}: {
  href: Route;
  label: string;
  selected: boolean;
  badge?: number;
  children: ReactNode;
}) {
  return (
    <div className="group/rail relative flex w-full shrink-0 justify-center">
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-1/2 left-0 w-1 -translate-y-1/2 rounded-r-full bg-accent transition-[height] duration-300 ease-[var(--ease-spring)]",
          selected ? "h-8" : "h-0 group-hover/rail:h-4",
        )}
      />
      <Link
        href={href}
        title={label}
        aria-label={label}
        aria-current={selected ? "page" : undefined}
        className={cn(
          "press relative grid size-11 place-items-center rounded-[var(--radius-control)] transition-colors",
          selected ? "bg-accent text-accent-ink" : "bg-raised text-ink-muted hover:bg-overlay hover:text-ink",
        )}
      >
        {children}
        {badge > 0 && (
          <span className="absolute -top-1.5 -right-1.5 grid h-5 min-w-5 place-items-center rounded-full border-2 border-rail bg-accent px-1 text-[0.625rem] font-semibold text-accent-ink">
            {badge > 99 ? "99+" : badge}
          </span>
        )}
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The sidebar card
// ---------------------------------------------------------------------------

function SidebarCard({ current, pathname }: { current: ShellGroup | null; pathname: string }) {
  return (
    <div className="h-full py-3 pr-3 lg:pl-0">
      <aside
        aria-label={current ? `${current.name} channels` : "Home"}
        className="flex h-full w-[var(--sidebar-width)] flex-col overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface"
      >
        <div className="min-h-0 flex-1 overflow-y-auto pb-3">
          {current ? <GroupSidebar group={current} pathname={pathname} /> : <HomeSidebar pathname={pathname} />}
        </div>
      </aside>
    </div>
  );
}

function GroupSidebar({ group, pathname }: { group: ShellGroup; pathname: string }) {
  const base = `/groups/${group.id}`;
  return (
    <>
      {/* The banner stays blank until a member uploads a real image. */}
      <div className="h-20 bg-raised" aria-hidden="true" />
      <p className="truncate px-4 pt-3 text-base font-semibold">{group.name}</p>

      <Section label="Group stats">
        <Stat icon={<WalletIcon />}>Balance: {group.balance}</Stat>
        <Stat icon={<PeopleIcon />}>Members: {group.memberCount}</Stat>
      </Section>

      {CHANNEL_SECTIONS.map((section) => (
        <Section key={section.label} label={section.label}>
          {section.channels.map((channel) => {
            const href = `${base}/${channel.slug}`;
            return (
              <ChannelLink key={channel.slug} href={href as Route} active={pathname === href} icon={channel.icon}>
                {channel.label}
              </ChannelLink>
            );
          })}
        </Section>
      ))}
    </>
  );
}

function HomeSidebar({ pathname }: { pathname: string }) {
  return (
    <>
      <div className="h-20 bg-raised" aria-hidden="true" />
      <p className="px-4 pt-3 text-base font-semibold">Home</p>
      <Section label="You">
        <ChannelLink href="/groups" active={pathname === "/groups"} icon={<HomeIcon />}>
          all groups
        </ChannelLink>
        <ChannelLink href="/groups/new" active={pathname === "/groups/new"} icon={<PlusIcon />}>
          new group
        </ChannelLink>
        <ChannelLink href="/wallet" active={pathname.startsWith("/wallet")} icon={<GearIcon />}>
          settings
        </ChannelLink>
      </Section>
    </>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="px-2 pt-6">
      <p className="mb-1 px-2 text-xs font-semibold text-ink-faint">{label}</p>
      <ul className="space-y-1">{children}</ul>
    </div>
  );
}

/** Group stats are information, not links, so they never look clickable. */
function Stat({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex h-8 items-center gap-2 px-2 text-sm text-ink-muted">
      <span className="text-ink-faint">{icon}</span>
      <span className="truncate tabular-nums">{children}</span>
    </li>
  );
}

function ChannelLink({
  href,
  active,
  icon,
  children,
}: {
  href: Route;
  active: boolean;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <li>
      <Link
        href={href}
        aria-current={active ? "page" : undefined}
        className={cn(
          "press flex h-9 items-center gap-2 rounded-[var(--radius-control)] px-2 text-sm transition-colors",
          active ? "bg-ink font-semibold text-canvas" : "text-ink-muted hover:bg-raised hover:text-ink",
        )}
      >
        <span className={active ? "text-canvas" : "text-ink-faint"}>{icon}</span>
        <span className="min-w-0 truncate">{children}</span>
      </Link>
    </li>
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
          "absolute inset-y-0 left-0 flex max-w-[calc(100vw-3.5rem)] overflow-hidden bg-canvas",
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
