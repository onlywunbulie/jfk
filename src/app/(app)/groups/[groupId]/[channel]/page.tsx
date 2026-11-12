import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import type { Route } from "next";
import type { ReactNode } from "react";
import { requireUser } from "@/lib/auth/session";
import { getGroupDetail, listMembers } from "@/modules/groups/service";
import { findChannel } from "@/components/shell/channels";
import { EXPLORER_URL } from "@/lib/chain/addresses";
import type { GroupType } from "@/lib/db/schema/groups";

export async function generateMetadata({
  params,
}: PageProps<"/groups/[groupId]/[channel]">): Promise<Metadata> {
  const { channel } = await params;
  return { title: findChannel(channel)?.label ?? "Group" };
}

/**
 * Every channel's screen. Only #about is designed so far; the rest are empty
 * under the header, as in the wireframe. Members only; anyone else sees a
 * 404, the same as a group that doesn't exist.
 */
export default async function ChannelPage({ params }: PageProps<"/groups/[groupId]/[channel]">) {
  const { groupId, channel: slug } = await params;
  const channel = findChannel(slug);
  if (!channel) notFound();

  const user = await requireUser();
  const [group, members] = await Promise.all([getGroupDetail(groupId, user.id), listMembers(groupId, user.id)]);
  if (!group || !members) notFound();

  if (channel.slug === "about") {
    const owner = members.find((member) => member.role === "OWNER");
    const admins = members.filter((member) => member.role === "ADMIN").map((member) => member.displayName);
    const amount = `${group.currency} ${group.contributionAmount
      .format({ compact: true, showSymbol: false })
      .replaceAll(",", "")}`;

    return (
      // Like the start of a chat, the content sits at the bottom of the card.
      <div className="flex min-h-full flex-col justify-end">
        <ChannelIntro title={`Welcome to ${group.name}`}>
          <span className="text-ink">{USE_CASES[group.type].label}</span> - {USE_CASES[group.type].description}
        </ChannelIntro>
        <DateDivider date={group.createdAt} />
        <RallMessage
          sentAt={group.createdAt}
          footnote={group.safeAddress ? <VaultFootnote address={group.safeAddress} /> : null}
        >
          <Detail label="Started by">
            {owner?.displayName ?? "Unknown"} on {longDate(group.createdAt)}
          </Detail>
          <Detail label="Members">
            {group.memberCount}
            {admins.length > 0 && <span className="text-ink-muted"> · Admins: {admins.join(", ")}</span>}
          </Detail>
          <Detail label="Pays">
            {amount} every {group.cadence === "MONTHLY" ? "month" : "week"}
          </Detail>
          <Detail label="Money out">
            Only when the group votes. Full rules in{" "}
            <Link
              href={`/groups/${group.id}/rules` as Route}
              className="text-ink underline decoration-ink-faint underline-offset-4 hover:decoration-ink"
            >
              #rules
            </Link>
          </Detail>
        </RallMessage>
      </div>
    );
  }

  if (channel.slug === "rules") {
    const amount = `${group.currency} ${group.contributionAmount
      .format({ compact: true, showSymbol: false })
      .replaceAll(",", "")}`;
    const due =
      group.cadence === "MONTHLY"
        ? `every month, due on the ${ordinal(group.dueDay)}`
        : `every week, due on ${WEEKDAYS[group.dueDay - 1] ?? "Monday"}`;
    const thresholds = group.governance.filter(
      // The payout order only exists in rotating groups.
      (rule) => rule.action !== "ROTATION_ORDER_CHANGE" || group.type === "ROTATING",
    );

    return (
      <div className="flex min-h-full flex-col justify-end">
        <ChannelIntro title={`The rules of ${group.name}`}>
          What everyone agreed to. Changing any of it takes a vote.
        </ChannelIntro>
        <DateDivider date={group.createdAt} />
        <RallMessage
          sentAt={group.createdAt}
          footnote={group.safeAddress ? <VaultFootnote address={group.safeAddress} /> : null}
        >
          <Detail label="Pays">
            {amount} {due}
          </Detail>
          <Detail label="Proposals">{group.membersCanPropose ? "Any member can ask the group to spend" : "Only admins can ask the group to spend"}</Detail>
          <Detail label="Votes count">When at least {group.quorumPct}% of members vote</Detail>
          <Detail label="To pass">
            <ul className="space-y-1">
              {thresholds.map((rule) => (
                <li key={rule.action}>
                  {ACTION_LABELS[rule.action] ?? rule.action}{" "}
                  <span className="text-ink-muted">· {percent(rule.thresholdPermille)} must agree</span>
                </li>
              ))}
            </ul>
          </Detail>
          <Detail label="Leaving">You give up what you&rsquo;ve paid in</Detail>
          <Detail label="Voted out">You get back what you paid in</Detail>
          <Detail label="Closing">The pot is split by how much each person paid in</Detail>
        </RallMessage>
      </div>
    );
  }

  return null;
}

/** Each vote-governed action, in plain words. */
const ACTION_LABELS: Record<string, string> = {
  FUND_RELEASE_SMALL: "A small spend",
  FUND_RELEASE_LARGE: "A large spend",
  CHANGE_CONTRIBUTION: "Changing what everyone pays",
  CHANGE_GOVERNANCE: "Changing the rules",
  REMOVE_MEMBER: "Removing a member",
  REMOVE_ADMIN: "Removing an admin",
  ROTATION_ORDER_CHANGE: "Changing the payout order",
  DISSOLVE_GROUP: "Closing the group",
};

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** 500 → "50%", 667 → "66.7%". */
function percent(permille: number): string {
  return permille % 10 === 0 ? `${permille / 10}%` : `${(permille / 10).toFixed(1)}%`;
}

/** 1 → "1st", 22 → "22nd", 13 → "13th". */
function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

// Dates are shown in Lagos time, rendered on the server, so every member
// sees the same thing.
const TIME_ZONE = "Africa/Lagos";

function longDate(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: TIME_ZONE }).format(date);
}

function stamp(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: TIME_ZONE,
  }).format(date);
}

/**
 * What kind of group this is. Rallied groups do one of three things.
 * `PAYOUTS` has no database type yet; its copy is written so it's ready when
 * automated payouts arrive.
 */
type UseCaseKind = GroupType | "PAYOUTS";

const USE_CASES: Record<UseCaseKind, { label: string; description: string }> = {
  ROTATING: {
    label: "Rotating savings",
    description: "Everyone pays in, and the pot goes to one member at a time, in turn.",
  },
  TREASURY: {
    label: "Shared pot",
    description: "Everyone pays into one pot. Money only leaves when the group votes.",
  },
  PAYOUTS: {
    label: "Automated payouts",
    description: "The group pays the same people on a schedule, automatically.",
  },
};

/**
 * The top of a designed channel: a round # tile, a large title, then one
 * line underneath.
 */
function ChannelIntro({ title, children }: { title: string; children: ReactNode }) {
  return (
    <header>
      <span aria-hidden="true" className="grid size-[68px] place-items-center rounded-full bg-raised text-ink">
        <svg viewBox="0 0 20 20" className="size-10" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
          <path d="M8 3.5 6.5 16.5M13.5 3.5 12 16.5M4 7.5h12.5M3.5 12.5H16" />
        </svg>
      </span>
      <h2 className="mt-4 text-[2rem] leading-tight font-extrabold tracking-tight text-balance text-ink">
        {title}
      </h2>
      <p className="mt-2 max-w-2xl text-base leading-relaxed text-pretty text-ink-muted">{children}</p>
    </header>
  );
}

/** A hairline across the card with the day the group was created in the middle. */
function DateDivider({ date }: { date: Date }) {
  return (
    <div role="separator" aria-label={`Created ${longDate(date)}`} className="mt-6 flex items-center gap-2">
      <span className="h-px flex-1 bg-border" />
      <time dateTime={date.toISOString()} className="text-xs font-semibold text-ink-faint">
        {longDate(date)}
      </time>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/**
 * The group's details, posted by Rall, Rallied's agent: avatar, name with an
 * AGENT tag and the time, then the details in a rounded bubble.
 */
function RallMessage({ sentAt, footnote, children }: { sentAt: Date; footnote: ReactNode; children: ReactNode }) {
  return (
    <article aria-label="Message from Rall" className="mt-4 flex gap-4 py-1">
      <span
        aria-hidden="true"
        className="grid size-10 shrink-0 place-items-center rounded-full bg-accent text-base font-bold text-accent-ink"
      >
        R
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-base font-semibold text-ink">Rall</span>
          <span className="rounded-[4px] bg-raised px-1.5 py-px text-[0.6875rem] leading-4 font-semibold text-ink-muted">
            AGENT
          </span>
          <time dateTime={sentAt.toISOString()} className="text-xs text-ink-faint">
            {stamp(sentAt)}
          </time>
        </p>

        <div className="mt-2 w-fit max-w-xl space-y-3 rounded-3xl bg-raised px-5 py-4 text-sm leading-relaxed">
          <dl className="space-y-2">{children}</dl>
          {footnote}
        </div>
      </div>
    </article>
  );
}

/**
 * Only once the group's vault exists on Base: a small line at the foot of
 * Rall's message that opens the vault in the chain's explorer (BaseScan), so
 * anyone can check the money for themselves.
 */
function VaultFootnote({ address }: { address: string }) {
  return (
    <p className="border-t border-border pt-3 text-xs text-ink-faint">
      <a
        href={`${EXPLORER_URL}/address/${address}`}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 underline decoration-ink-faint/50 underline-offset-4 transition-colors hover:text-ink hover:decoration-ink"
      >
        BaseScan
      </a>
    </p>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
      <dt className="shrink-0 text-ink-muted sm:w-28">{label}</dt>
      <dd className="min-w-0 text-pretty text-ink">{children}</dd>
    </div>
  );
}
