"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import type { Route } from "next";
import { cn } from "@/lib/cn";
import { DEFAULT_CHANNEL, MenuIcon, findChannel, sectionsFor, type GroupKind } from "./channels";
import { AiNudge } from "./ai-nudge";
import { GroupProfile } from "./group-profile";
import { EditPencilIcon, GroupIcon, WalletIcon } from "@/components/ui/iconoir";
import { ProfileModal } from "./profile-modal";

export interface ShellGroup {
  id: string;
  name: string;
  /** The group picture for the rail; null shows the first letter. */
  avatarUrl: string | null;
  /** The sidebar banner; null shows the empty banner. */
  bannerUrl: string | null;
  /** Owners and admins: may change the picture and banner. */
  canEdit: boolean;
  memberCount: number;
  /** Shared pot or rotating savings: decides which channels it has. */
  kind: GroupKind;
  /** Already formatted as the sidebar shows it, e.g. "$15,000.00". */
  balance: string;
  /** Open votes this person hasn't cast yet. */
  waiting: number;
  /**
   * What's waiting for this person, by channel slug: their AI's drafts, and
   * votes they haven't cast. Drives the sidebar counts and the rail's dot.
   */
  needsYou: Partial<Record<string, number>>;
}

/**
 * Rallied's frame, built from the Figma wireframe (frame 19:11):
 *
 *   rail | panel [ sidebar card | main card ]
 *
 * The rail sits on the page: blank group squares, settings pinned at the
 * foot. The panel holds the two cards. Every size here is the frame's own
 * measurement: 18px page edge (34px right, 30px top and bottom), a 43×48
 * square rail, an 18px gap, a panel padded 20/18 with 36px between cards,
 * and a 322px sidebar card.
 *
 * On a phone the rail and sidebar card live in a menu that slides in from
 * the left, and the main card fills the screen.
 */
export function AppShell({
  groups,
  userInitial,
  profile,
  aiNudge = false,
  children,
}: {
  groups: ShellGroup[];
  /** The signed-in user's initial, for the profile square. */
  userInitial: string;
  /** The profile's contents, rendered on the server, shown in the modal. */
  profile: ReactNode;
  /** No AI connected yet: show the reminder above the page. */
  aiNudge?: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const match = pathname.match(/^\/groups\/([^/]+)(?:\/([^/]+))?/);
  const current = groups.find((group) => group.id === match?.[1]) ?? null;
  const title = titleFor(pathname, current, match?.[2]);
  // Channels and create group are headed by a hashtag; anything else by the dot.
  const isChannel =
    (current !== null && findChannel(match?.[2] ?? DEFAULT_CHANNEL) !== undefined) || pathname === "/groups/new";
  const [menuOpen, setMenuOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  // The group profile (picture and banner): owners and admins only.
  const [groupProfileOpen, setGroupProfileOpen] = useState(false);
  const [groupDirty, setGroupDirty] = useState(false);
  const [attention, setAttention] = useState(0);
  useRefreshOnReturn();
  const openProfile = () => {
    setMenuOpen(false);
    setProfileOpen(true);
  };
  const openGroupProfile = () => {
    setMenuOpen(false);
    setAttention(0);
    setGroupProfileOpen(true);
  };
  // Leaving with changes unsaved shakes the save bar instead, as in Discord.
  const closeGroupProfile = () => {
    if (groupDirty) setAttention((n) => n + 1);
    else setGroupProfileOpen(false);
  };

  // Going somewhere closes the menu. Keyed on the path, so it only fires on a
  // real navigation.
  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    setMenuOpen(false);
  }

  return (
    <div className="flex h-dvh bg-canvas lg:gap-[18px] lg:py-[30px] lg:pr-[34px] lg:pl-[18px]">
      {/* Desktop: the rail, level with the cards inside the panel. */}
      <div className="hidden shrink-0 py-5 lg:flex">
        <Rail
          groups={groups}
          currentId={current?.id ?? null}
          pathname={pathname}
          userInitial={userInitial}
          profileOpen={profileOpen}
          onOpenProfile={openProfile}
        />
      </div>

      <ProfileModal open={profileOpen} onClose={() => setProfileOpen(false)}>
        {profile}
      </ProfileModal>
      {/* Any link ending in ?profile=1 opens the profile over the current screen. */}
      <Suspense fallback={null}>
        <OpenProfileFromLink onOpen={openProfile} />
      </Suspense>

      {current?.canEdit && (
        <ProfileModal
          open={groupProfileOpen}
          onClose={closeGroupProfile}
          labelledBy="group-profile-title"
          closeLabel="Close the group profile"
          wide
        >
          {/* Keyed by group, so moving between groups starts afresh. */}
          <GroupProfile key={current.id} group={current} attention={attention} onDirtyChange={setGroupDirty} />
        </ProfileModal>
      )}
      {current?.canEdit && (
        <Suspense fallback={null}>
          <OpenProfileFromLink onOpen={openGroupProfile} param="group-profile" />
        </Suspense>
      )}

      {/* Phone: the rail and, inside a group, its sidebar card, sliding in over the page. */}
      <MobileMenu open={menuOpen} onClose={() => setMenuOpen(false)}>
        <Rail
          groups={groups}
          currentId={current?.id ?? null}
          pathname={pathname}
          userInitial={userInitial}
          profileOpen={profileOpen}
          onOpenProfile={openProfile}
        />
        {current && (
          <div className="flex min-w-0 flex-1 rounded-[var(--radius-control)] bg-raised p-3">
            <SidebarCard current={current} pathname={pathname} onEditProfile={openGroupProfile} />
          </div>
        )}
      </MobileMenu>

      <div className="flex min-w-0 flex-1 lg:gap-[18px] lg:rounded-[var(--radius-control)] lg:bg-raised lg:px-[18px] lg:py-5">
        {/* The channels card belongs to a group. Outside one (settings, profile), the main card takes the space. */}
        {current && (
          <div className="hidden w-[var(--sidebar-width)] shrink-0 lg:flex">
            <SidebarCard current={current} pathname={pathname} onEditProfile={openGroupProfile} />
          </div>
        )}

        <main
          aria-label={title}
          className="flex min-w-0 flex-1 flex-col bg-canvas lg:rounded-[var(--radius-control)]"
        >
          <header className="flex h-14 shrink-0 items-center border-b border-border pr-4 pl-1 lg:pl-4">
            <button
              type="button"
              onClick={() => setMenuOpen(true)}
              aria-label="Open groups and channels"
              className="press grid size-10 place-items-center rounded-[var(--radius-control)] text-ink-muted hover:text-ink lg:hidden"
            >
              <MenuIcon />
            </button>
            <h1 className="flex min-w-0 items-center gap-[7px] px-[10px] text-base font-normal text-ink">
              {isChannel ? <Hash /> : <Dot />}
              <span className="truncate">{title}</span>
            </h1>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 lg:px-8">
            {aiNudge && <AiNudge onConnect={openProfile} />}
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

/**
 * Coming back to Rallied (from Claude, say) quietly reloads what's on screen,
 * so a draft the AI just made shows up, with its count, without a manual
 * refresh. At most once every 10 seconds, so flicking between tabs is cheap.
 */
function useRefreshOnReturn() {
  const router = useRouter();
  const last = useRef(0);
  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - last.current < 10_000) return;
      last.current = now;
      router.refresh();
    };
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    return () => {
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
    };
  }, [router]);
}

/**
 * Opens the profile when the address ends in ?profile=1, then tidies the
 * address so a refresh doesn't reopen it. Kept apart so reading the query
 * sits inside its own Suspense boundary.
 */
function OpenProfileFromLink({ onOpen, param = "profile" }: { onOpen: () => void; param?: string }) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const wanted = params.get(param) === "1";

  useEffect(() => {
    if (!wanted) return;
    onOpen();
    const rest = new URLSearchParams(params.toString());
    rest.delete(param);
    const query = rest.toString();
    router.replace((query ? `${pathname}?${query}` : pathname) as Route, { scroll: false });
    // onOpen is stable enough for this: it only sets state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted]);

  return null;
}

/** What the main card's header says for the page you're on. */
function titleFor(pathname: string, group: ShellGroup | null, segment: string | undefined): string {
  const channel = group ? findChannel(segment ?? DEFAULT_CHANNEL) : undefined;
  if (channel) return channel.label;
  if (pathname === "/groups/new") return "create group";
  if (pathname === "/groups") return "all groups";
  if (group) return group.name;
  return "Rallied";
}

/** Marks a channel's name, in the sidebar and in the main card's header. */
function Hash() {
  return (
    <svg
      viewBox="0 0 20 20"
      aria-hidden="true"
      className="size-5 shrink-0 text-ink-faint"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
    >
      <path d="M8 3.5 6.5 16.5M13.5 3.5 12 16.5M4 7.5h12.5M3.5 12.5H16" />
    </svg>
  );
}

/** The wireframe's round placeholder, used for every item until icons are drawn. */
function Dot({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn("size-5 shrink-0 rounded-full bg-border-strong", className)} />;
}

// ---------------------------------------------------------------------------
// The rail
// ---------------------------------------------------------------------------

/**
 * Top: + (the only way to start a group), then the user's groups. Bottom:
 * the user's profile, which opens as a modal over the current screen.
 */
function Rail({
  groups,
  currentId,
  pathname,
  userInitial,
  profileOpen,
  onOpenProfile,
}: {
  groups: ShellGroup[];
  currentId: string | null;
  pathname: string;
  userInitial: string;
  profileOpen: boolean;
  onOpenProfile: () => void;
}) {
  return (
    <nav aria-label="Your groups" className="flex h-full w-[var(--rail-width)] shrink-0 flex-col justify-between gap-4">
      <div className="flex min-h-0 flex-col gap-4">
        <RailItem href="/groups/new" label="Start a group" selected={pathname === "/groups/new"}>
          <svg viewBox="0 0 20 20" aria-hidden="true" className="size-5" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round">
            <path d="M10 4v12M4 10h12" />
          </svg>
        </RailItem>
        <ul className="flex min-h-0 flex-col gap-4 overflow-y-auto">
          {groups.map((group) => (
            <li key={group.id}>
              <RailItem
                href={`/groups/${group.id}/${DEFAULT_CHANNEL}` as Route}
                label={group.name}
                selected={group.id === currentId}
                hasNew={Object.values(group.needsYou).some((n) => (n ?? 0) > 0)}
              >
                <GroupMark name={group.name} avatarUrl={group.avatarUrl} />
              </RailItem>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-col gap-4">
        <button
          type="button"
          onClick={onOpenProfile}
          title="Your profile"
          aria-label="Your profile"
          aria-haspopup="dialog"
          aria-expanded={profileOpen}
          className={cn(
            "press grid h-[41px] w-[var(--rail-width)] place-items-center rounded-[var(--radius-control)] border-2 bg-raised transition-colors",
            profileOpen ? "border-accent" : "border-transparent hover:bg-overlay",
          )}
        >
          <span className="grid size-7 place-items-center rounded-full bg-overlay text-sm font-semibold text-ink">{userInitial}</span>
        </button>
      </div>
    </nav>
  );
}

/**
 * The group in the rail: its picture filling the square, or its first letter
 * when there isn't one. The picture is decorative; the square's label names it.
 */
function GroupMark({ name, avatarUrl }: { name: string; avatarUrl: string | null }) {
  if (avatarUrl) {
    // A user upload on Blob, already resized to a small square: the image optimiser adds nothing.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={avatarUrl} alt="" aria-hidden="true" className="absolute inset-0 size-full rounded-[8px] object-cover" />;
  }
  const letter = Array.from(name.trim())[0]?.toUpperCase() ?? "?";
  return <span className="text-base font-semibold">{letter}</span>;
}

/** A 43×41 square (the wireframe's 48px less 15%). Selected gets a 2px ice-blue outline. */
function RailItem({
  href,
  label,
  selected,
  hasNew = false,
  children,
}: {
  href: Route;
  label: string;
  selected: boolean;
  /** Something in this group is waiting for the user: a small red dot on the square's corner. */
  hasNew?: boolean;
  children?: ReactNode;
}) {
  const name = hasNew ? `${label}, something is waiting for you` : label;
  return (
    <Link
      href={href}
      title={name}
      aria-label={name}
      aria-current={selected ? "page" : undefined}
      className={cn(
        "press relative grid h-[41px] w-[var(--rail-width)] place-items-center rounded-[var(--radius-control)] border-2 bg-raised text-ink-muted transition-colors hover:text-ink",
        selected ? "border-accent" : "border-transparent hover:bg-overlay",
      )}
    >
      {children}
      {hasNew && (
        <span
          aria-hidden="true"
          className="absolute -top-1 -right-1 size-3 rounded-full border-2 border-canvas bg-danger"
        />
      )}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// The sidebar card
// ---------------------------------------------------------------------------

function SidebarCard({ current, pathname, onEditProfile }: { current: ShellGroup; pathname: string; onEditProfile: () => void }) {
  return (
    <aside
      aria-label={`${current.name} channels`}
      className="flex h-full w-full flex-col overflow-hidden rounded-[var(--radius-control)] bg-canvas"
    >
      {/* The banner stays put and spans the whole card; only the channels below it scroll. */}
      <div className="relative shrink-0">
        <Banner url={current.bannerUrl} />
        {current.canEdit && (
          <button
            type="button"
            onClick={onEditProfile}
            title="Edit the group picture and banner"
            aria-label="Edit the group picture and banner"
            className="press absolute top-2 right-2 grid size-8 place-items-center rounded-[var(--radius-control)] bg-black/45 text-white/85 backdrop-blur-sm transition-colors hover:bg-black/65 hover:text-white"
          >
            <EditPencilIcon className="size-4" />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-[27px]">
        <div className="mt-[15px] p-[10px]">
          <div className="flex flex-col gap-8 px-[6px]">
            <GroupSections group={current} pathname={pathname} />
          </div>
        </div>
      </div>
    </aside>
  );
}

/**
 * The group's banner, or, before one is added, an empty one: a quiet wash of
 * the accent over a fine dot grid, so the top of the card is designed, not grey.
 */
function Banner({ url }: { url: string | null }) {
  const frame = "block h-28 w-full shrink-0 overflow-hidden";
  if (url) {
    // eslint-disable-next-line @next/next/no-img-element -- a user upload on Blob, already resized
    return <img src={url} alt="" aria-hidden="true" className={cn(frame, "w-full object-cover")} />;
  }
  return (
<div aria-hidden="true" className={cn(frame, "empty-banner bg-raised")} />
  );
}

function GroupSections({ group, pathname }: { group: ShellGroup; pathname: string }) {
  const base = `/groups/${group.id}`;
  return (
    <>
      <Section label="Group Stats" gap="gap-4">
        <Stat icon={<WalletIcon className="size-5" />}>Balance: {group.balance}</Stat>
        <Stat icon={<GroupIcon className="size-5" />}>Members: {group.memberCount}</Stat>
      </Section>

      {sectionsFor(group.kind).map((section) => (
        <Section key={section.label} label={section.label}>
          {section.channels.map((channel) => {
            const href = `${base}/${channel.slug}`;
            return (
              <ChannelLink key={channel.slug} href={href as Route} active={pathname === href} count={group.needsYou[channel.slug] ?? 0}>
                {channel.label}
              </ChannelLink>
            );
          })}
        </Section>
      ))}
    </>
  );
}

/** A heading at the same size, weight and colour as its items, 20px above them. */
function Section({ label, gap = "gap-3", children }: { label: string; gap?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-5">
      <h2 className="px-[10px] text-base leading-5 font-normal text-ink">{label}</h2>
      <ul className={cn("flex flex-col", gap)}>{children}</ul>
    </section>
  );
}

/** Group stats are information, not links, so they never look clickable. */
function Stat({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex h-5 items-center gap-[7px] px-[10px] text-base text-ink">
      <span className="shrink-0 text-ink-muted">{icon}</span>
      <span className="truncate tabular-nums">{children}</span>
    </li>
  );
}

/**
 * A channel in the sidebar. With something waiting for the user (`count`), its
 * name turns white and a small red count sits at the row's right end.
 */
function ChannelLink({ href, active, count = 0, children }: { href: Route; active: boolean; count?: number; children: ReactNode }) {
  return (
    <li>
      <Link
        href={href}
        aria-current={active ? "page" : undefined}
        className={cn(
          "press relative flex h-10 items-center lg:h-7 gap-[7px] rounded-[4px] px-[10px] text-base transition-colors",
          active || count > 0 ? "text-ink" : "text-ink-muted",
          !active && "hover:bg-raised",
        )}
      >
        {/* The selected channel's tag: a small ice-blue bar at the row's left edge. */}
        <span
          aria-hidden="true"
          className={cn(
            "absolute top-1/2 left-0 h-4 w-[3px] -translate-y-1/2 rounded-full bg-accent transition-transform duration-300 ease-[var(--ease-spring)]",
            active ? "scale-y-100" : "scale-y-0",
          )}
        />
        <Hash />
        <span className="min-w-0 flex-1 truncate">{children}</span>
        {count > 0 && (
          <span className="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-danger px-1.5 text-xs font-semibold text-white tabular-nums">
            {count > 99 ? "99+" : count}
            <span className="sr-only"> waiting for you</span>
          </span>
        )}
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
          "absolute inset-y-0 left-0 flex w-[min(calc(100vw-3.5rem),24rem)] gap-3 bg-canvas p-4",
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
