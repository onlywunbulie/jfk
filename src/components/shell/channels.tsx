import type { ReactNode } from "react";

/**
 * Every channel a group has, in sidebar order. One list feeds the sidebar,
 * the main card's header and each channel's page, so a channel's name and
 * icon can't drift between them.
 *
 * This step is UI only: each channel opens a designed screen saying what it
 * will show. Nothing in the sidebar is a dead link.
 */

/** The kinds of group, as stored: a shared pot, or rotating savings. */
export type GroupKind = "TREASURY" | "ROTATING";

export interface ChannelDef {
  slug: string;
  label: string;
  icon: ReactNode;
  /** One line on what the channel is for, shown on its screen. */
  promise: string;
  /** Only in this kind of group. Omitted: in every group. */
  only?: GroupKind;
}

export interface ChannelSection {
  label: string;
  channels: ChannelDef[];
}

export const CHANNEL_SECTIONS: ChannelSection[] = [
  {
    label: "Welcome",
    channels: [
      {
        slug: "about",
        label: "about",
        icon: <InfoIcon />,
        promise: "What this group is for, who started it, and how it works.",
      },
      {
        slug: "rules",
        label: "rules",
        icon: <BookIcon />,
        promise: "The group's rules in plain words: how much everyone pays, when, and how many must agree.",
      },
      {
        slug: "verify",
        label: "verify & connect",
        icon: <ShieldIcon />,
        promise: "Connect your wallet, and your own AI (Claude, ChatGPT or Grok), to this group.",
      },
      {
        slug: "roles",
        label: "roles",
        icon: <BadgeIcon />,
        promise: "Who's who: members, admins, and any agents acting for them.",
      },
    ],
  },
  {
    label: "Ledger",
    channels: [
      {
        slug: "general",
        label: "general",
        icon: <LedgerIcon />,
        promise: "The group's money at a glance: what's in the pot, what came in, what went out, and what's waiting.",
      },
      {
        slug: "transactions",
        label: "transactions",
        icon: <ArrowsIcon />,
        promise: "Every dollar in and out of the group, each with a link to check it on Base.",
      },
    ],
  },
  {
    label: "Decisions",
    channels: [
      {
        slug: "propose",
        label: "propose",
        icon: <PlusCircleIcon />,
        promise: "Ask the group to decide: a spend from the pot, or closing the group. Everyone gets a say before anything moves.",
      },
      {
        slug: "payout-order",
        label: "payout order",
        icon: <ArrowsIcon />,
        promise: "Who gets paid each round, whose turn is next, swap requests, and anyone who owes after their turn.",
        only: "ROTATING",
      },
      {
        slug: "manage-roles",
        label: "manage roles",
        icon: <UserCogIcon />,
        promise: "Change who can do what. Every change needs the group's vote.",
      },
      {
        slug: "edit-rules",
        label: "edit rules",
        icon: <SlidersIcon />,
        promise: "Change how much people pay or how many must agree. Changes need a vote too.",
      },
      {
        slug: "votes",
        label: "votes",
        icon: <BadgeIcon />,
        promise: "Every open vote in the group, and the ones waiting on you.",
      },
    ],
  },
];

export const ALL_CHANNELS = CHANNEL_SECTIONS.flatMap((section) => section.channels);

/** Where a group opens: its ledger overview. */
export const DEFAULT_CHANNEL = "general";

export function findChannel(slug: string | undefined): ChannelDef | undefined {
  return ALL_CHANNELS.find((channel) => channel.slug === slug);
}

/** The sidebar for one kind of group: every section, minus the other kind's channels. */
export function sectionsFor(kind: GroupKind): ChannelSection[] {
  return CHANNEL_SECTIONS.map((section) => ({
    ...section,
    channels: section.channels.filter((channel) => !channel.only || channel.only === kind),
  }));
}

/** Whether a channel exists in this kind of group. */
export function channelBelongs(channel: ChannelDef, kind: GroupKind): boolean {
  return !channel.only || channel.only === kind;
}

// ---------------------------------------------------------------------------
// One icon set: 24px grid, 1.75 stroke, outline.
// ---------------------------------------------------------------------------

function Icon({ children, className = "size-5" }: { children: ReactNode; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export function InfoIcon() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </Icon>
  );
}

export function BookIcon() {
  return (
    <Icon>
      <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5v-15Z" />
      <path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3M9 7h6M9 10.5h6" />
    </Icon>
  );
}

export function ShieldIcon() {
  return (
    <Icon>
      <path d="M12 3 5 6v5c0 4.4 3 8.3 7 10 4-1.7 7-5.6 7-10V6l-7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </Icon>
  );
}

export function BadgeIcon() {
  return (
    <Icon>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="m16.5 11 1.5 1.5 3-3" />
    </Icon>
  );
}

export function LedgerIcon() {
  return (
    <Icon>
      <rect x="4" y="3" width="16" height="18" rx="2.5" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </Icon>
  );
}

export function ArrowsIcon() {
  return (
    <Icon>
      <path d="M7 4v16m0 0-3.5-3.5M7 20l3.5-3.5M17 20V4m0 0-3.5 3.5M17 4l3.5 3.5" />
    </Icon>
  );
}

export function SparkIcon() {
  return (
    <Icon>
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M12 8l1.5 2.5L16 12l-2.5 1.5L12 16l-1.5-2.5L8 12l2.5-1.5L12 8Z" />
    </Icon>
  );
}

export function PlusCircleIcon() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v8M8 12h8" />
    </Icon>
  );
}

export function UserCogIcon() {
  return (
    <Icon>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 10.5-5.1" />
      <circle cx="18" cy="17" r="2.5" />
      <path d="M18 13.5v1M18 19.5v1M21.5 17h-1M15.5 17h-1" />
    </Icon>
  );
}

export function SlidersIcon() {
  return (
    <Icon>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </Icon>
  );
}

export function WalletIcon() {
  return (
    <Icon>
      <rect x="3" y="6" width="18" height="13" rx="3" />
      <path d="M3 10h18" />
      <circle cx="16.5" cy="14.5" r="1" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function PeopleIcon() {
  return (
    <Icon>
      <circle cx="9" cy="8.5" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 5.2a3.5 3.5 0 0 1 0 6.6M18 14.4a6.5 6.5 0 0 1 3.5 5.6" />
    </Icon>
  );
}

export function GearIcon() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </Icon>
  );
}

export function HomeIcon() {
  return (
    <Icon>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5.5 9.5V20h13V9.5" />
    </Icon>
  );
}

export function PlusIcon() {
  return (
    <Icon className="size-6">
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

export function MenuIcon() {
  return (
    <Icon className="size-6">
      <path d="M4 7h16M4 12h16M4 17h16" />
    </Icon>
  );
}

export function LogOutIcon() {
  return (
    <Icon>
      <path d="M15 17v1.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2V7" />
      <path d="M19 12H9m10 0-3-3m3 3-3 3" />
    </Icon>
  );
}
