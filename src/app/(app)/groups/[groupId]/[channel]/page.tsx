import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import type { Route } from "next";
import { requireUser } from "@/lib/auth/session";
import { getGroupDetail, listMembers } from "@/modules/groups/service";
import { channelBelongs, findChannel } from "@/components/shell/channels";
import { PayoutOrder } from "./payout-order";
import { EXPLORER_URL, shortAddress } from "@/lib/chain/addresses";
import { VerifyAi } from "./verify-ai";
import { DEFAULT_GOVERNANCE, type GovernedAction, type GroupType } from "@/lib/db/schema/groups";
import { contractThresholds } from "@/modules/groups/onchain-setup";
import { ChannelIntro, DateDivider, Detail, RallMessage, VaultFootnote, longDate } from "./parts";
import { Transactions } from "./transactions";
import { ProposeChannel } from "./propose";
import { ManageRoles, type Assistant, type Person } from "./manage-roles";
import { EditRules } from "./edit-rules";
import { Votes } from "./votes";

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
export default async function ChannelPage({ params, searchParams }: PageProps<"/groups/[groupId]/[channel]">) {
  const { groupId, channel: slug } = await params;
  const query = await searchParams;
  const channel = findChannel(slug);
  if (!channel) notFound();

  const user = await requireUser();
  const [group, members] = await Promise.all([getGroupDetail(groupId, user.id), listMembers(groupId, user.id)]);
  if (!group || !members) notFound();
  // A channel from the other kind of group doesn't exist here.
  if (!channelBelongs(channel, group.type)) notFound();
  const rotating = group.type === "ROTATING";

  if (channel.slug === "payout-order") return <PayoutOrder base={`/groups/${group.id}`} />;

  if (channel.slug === "verify") {
    // UI only: the AI connection is a sample (Claude, "Pay my dues, ask for
    // the rest"), matching the starting state in Settings.
    return (
      <div className="flex min-h-full flex-col justify-end">
        <ChannelIntro title="Verify & connect">Your wallet, and the AI that acts for you in this group.</ChannelIntro>
        <RallMessage
          time="Today"
          footnote={
            <p className="border-t border-border pt-3 text-xs text-ink-faint">
              <Link
                href={`/groups/${group.id}/verify?profile=1` as Route}
                className="underline decoration-ink-faint/50 underline-offset-4 transition-colors hover:text-ink hover:decoration-ink"
              >
                Limits and other groups: manage your AI in your profile
              </Link>
            </p>
          }
        >
          <Detail label="Wallet">
            {user.walletAddress ? (
              <>
                <span className="text-inflow">✓ Verified</span> · Base Account{" "}
                <a
                  href={`${EXPLORER_URL}/address/${user.walletAddress}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono underline decoration-ink-faint underline-offset-4 hover:decoration-ink"
                >
                  {shortAddress(user.walletAddress)}
                </a>
              </>
            ) : (
              <span className="text-pending">Not verified. Sign in with your Base Account to verify.</span>
            )}
          </Detail>
          <Detail label="Your AI">
            <VerifyAi ai="Claude" groupName={group.name} />
          </Detail>
          <Detail label="Your limits">Pay my dues, ask for the rest</Detail>
          <Detail label="This group">Members&rsquo; AIs can vote within their own limits</Detail>
        </RallMessage>
      </div>
    );
  }

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
            {rotating ? "Each round, to the member whose turn it is." : "Only when the group votes."} Full rules in{" "}
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
    // The same numbers the contract is set up with, in the contract's order,
    // so this list can't disagree with what's enforced on Base.
    const saved = Object.fromEntries(
      group.governance.map((rule) => [rule.action, rule.thresholdPermille]),
    ) as Partial<Record<GovernedAction, number>>;
    const onChain = contractThresholds(saved);
    const thresholds = [
      // The last rule, moving to a new version of the contract, isn't listed:
      // it only comes up when an update is offered, never as everyday rules.
      ...CONTRACT_RULES.slice(0, -1)
        .map((label, i) => ({ label, permille: onChain[i] }))
        // Rotating savings has no spends: each round's money goes to whoever's turn it is.
        .filter((rule) => !rotating || !rule.label.includes("spend")),
      // Admins live in Rallied, not in the contract, but changing them is still a vote.
      { label: "Adding or removing an admin", permille: saved.REMOVE_ADMIN ?? DEFAULT_GOVERNANCE.REMOVE_ADMIN },
      ...(rotating ? [{ label: "Changing the order or swapping turns", permille: onChain[6] }] : []),
    ];

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
          {rotating ? (
            <>
              {/* UI only: the order method is a sample until it's stored. */}
              <Detail label="Payout order">Random, drawn by Rallied. Changing it or swapping turns needs a vote.</Detail>
              <Detail label="After your turn">Keep paying every round until the cycle ends</Detail>
              <Detail label="Owing">Anyone who owes after their turn can&rsquo;t join the next cycle until it&rsquo;s settled. A friend can cover for them.</Detail>
              <Detail label="Cycle ends">When every member has had their turn</Detail>
            </>
          ) : (
            <Detail label="Proposals">{group.membersCanPropose ? "Any member can ask the group to spend" : "Only admins can ask the group to spend"}</Detail>
          )}
          <Detail label="Votes count">When at least {group.quorumPct}% of members vote</Detail>
          <Detail label="To pass">
            <ul className="space-y-1">
              {thresholds.map((rule) => (
                <li key={rule.label}>
                  {rule.label} <span className="text-ink-muted">· {percent(rule.permille)} must agree</span>
                </li>
              ))}
            </ul>
          </Detail>
          {/*
            The group's ceiling on AI. No setting exists yet, so this shows the
            default; when the group votes it on, it reads "Every vote needs a
            human tap".
          */}
          <Detail label="AI votes">Members&rsquo; AIs can vote within their own limits</Detail>
          <Detail label="Leaving">You give up what you&rsquo;ve paid in</Detail>
          <Detail label="Voted out">You get back what you paid in</Detail>
          <Detail label="Closing">The pot is split by how much each person paid in</Detail>
        </RallMessage>
      </div>
    );
  }

  if (channel.slug === "general") {
    // UI only: sample numbers until the vault's balance is read from Base.
    const s = GENERAL_SAMPLE;
    const now = new Date();
    return (
      <div className="flex min-h-full flex-col justify-end">
        <ChannelIntro title="The group's money">Where the money stands, updated by Rall every day.</ChannelIntro>
        <DateDivider date={now} label="Today" />
        <RallMessage
          sentAt={now}
          footnote={
            <p className="border-t border-border pt-3 text-xs text-ink-faint">
              <Link
                href={`/groups/${group.id}/transactions` as Route}
                className="underline decoration-ink-faint/50 underline-offset-4 transition-colors hover:text-ink hover:decoration-ink"
              >
                Everything in #transactions
              </Link>
            </p>
          }
        >
          {rotating ? (
            <>
              <Detail label="Round">
                <span className="font-semibold">{s.rotating.round}</span>
              </Detail>
              <Detail label="Getting paid">
                {s.payout.who} on {s.payout.when}, <span className="tabular-nums">{s.payout.amount}</span>
              </Detail>
            </>
          ) : (
            <Detail label="In the pot">
              <span className="font-semibold tabular-nums">{s.pot}</span> <span className="text-inflow tabular-nums">{s.change}</span>
            </Detail>
          )}
          <Detail label="This round">
            {s.paid} of {s.members} paid · {s.collected} of {s.expected}
            <span className="text-ink-muted"> · Late: {s.late.join(", ")}</span>
          </Detail>
          <Detail label="Next due">{s.nextDue}</Detail>
          {rotating ? (
            <Detail label="Owing">
              <span className="text-danger">{s.rotating.owing}</span>
            </Detail>
          ) : (
            <Detail label="Up for a vote">
              {s.vote.amount} for the {s.vote.what}
              <span className="text-ink-muted"> · closes {s.vote.closes}</span>
            </Detail>
          )}
          <Detail label="Latest">
            <ul className="space-y-1">
              {(rotating ? s.rotating.activity : s.activity).map((item) => (
                <li key={item.what}>
                  {item.what}{" "}
                  <span className={item.inflow ? "text-inflow tabular-nums" : "text-ink-muted tabular-nums"}>{item.amount}</span>
                </li>
              ))}
            </ul>
          </Detail>
        </RallMessage>
      </div>
    );
  }

  if (channel.slug === "propose") {
    const saved = Object.fromEntries(
      group.governance.map((rule) => [rule.action, rule.thresholdPermille]),
    ) as Partial<Record<GovernedAction, number>>;
    const [small, large] = contractThresholds(saved);
    return (
      <div className="flex min-h-full flex-col justify-end">
        <ChannelIntro title="Propose a spend">
          Ask your Claude to propose. Its drafts land here for you to check and send to a vote.
        </ChannelIntro>
        <ProposeChannel
          base={`/groups/${group.id}`}
          rules={{
            // UI only: the sample pot until the vault's balance is read from Base.
            pot: 4200,
            smallPercent: percent(small),
            largePercent: percent(large),
            votingDays: 3,
          }}
        />
      </div>
    );
  }

  if (channel.slug === "manage-roles") {
    const saved = Object.fromEntries(
      group.governance.map((rule) => [rule.action, rule.thresholdPermille]),
    ) as Partial<Record<GovernedAction, number>>;
    const onChain = contractThresholds(saved);
    const owner = members.find((member) => member.role === "OWNER");
    // UI only: which AI each person uses is a sample until connections exist.
    const sampleAssistants: Assistant[] = ["Claude", "ChatGPT", "Grok", null];
    const people: Person[] = members.map((member, i) => ({
      id: member.memberId,
      name: member.displayName,
      admin: member.role === "ADMIN",
      startedGroup: member.role === "OWNER",
      isYou: member.userId === user.id,
      assistant: member.userId === user.id ? "Claude" : sampleAssistants[i % sampleAssistants.length],
    }));
    return (
      <ManageRoles
          base={`/groups/${group.id}`}
          people={people}
          startedBy={owner?.displayName ?? "Unknown"}
          startedOn={longDate(group.createdAt)}
          // UI only: matches the one sample role change in #votes.
          voting={1}
          rules={{
            addMember: percent(onChain[2]),
            removeMember: percent(onChain[3]),
            replaceWallet: percent(onChain[4]),
            admin: percent(saved.REMOVE_ADMIN ?? DEFAULT_GOVERNANCE.REMOVE_ADMIN),
          }}
        />
    );
  }

  if (channel.slug === "edit-rules") {
    const saved = Object.fromEntries(
      group.governance.map((rule) => [rule.action, rule.thresholdPermille]),
    ) as Partial<Record<GovernedAction, number>>;
    const onChain = contractThresholds(saved);
    // The contract's CHANGE_CONTRIBUTION and CHANGE_RULES thresholds.
    return (
      <EditRules
        base={`/groups/${group.id}`}
        needs={{ contribution: percent(onChain[5]), rules: percent(onChain[6]) }}
        // UI only: matches the one sample rule change in #votes.
        voting={1}
      />
    );
  }

  if (channel.slug === "votes") {
    const saved = Object.fromEntries(
      group.governance.map((rule) => [rule.action, rule.thresholdPermille]),
    ) as Partial<Record<GovernedAction, number>>;
    const onChain = contractThresholds(saved);
    return (
      <Votes
        rotating={rotating}
        needs={{
          smallSpend: percent(onChain[0]),
          largeSpend: percent(onChain[1]),
          contribution: percent(onChain[5]),
          rules: percent(onChain[6]),
          admin: percent(saved.REMOVE_ADMIN ?? DEFAULT_GOVERNANCE.REMOVE_ADMIN),
        }}
      />
    );
  }

  if (channel.slug === "transactions") {
    const filter = typeof query.filter === "string" ? query.filter : "all";
    return (
      <Transactions
        base={`/groups/${group.id}`}
        filter={filter === "mine" || filter === "in" || filter === "out" ? filter : "all"}
        rotating={group.type === "ROTATING"}
      />
    );
  }

  if (channel.slug === "roles") {
    return (
      <div className="flex min-h-full flex-col justify-end">
        <ChannelIntro title={`Who's in ${group.name}`}>
          Everyone in the group, and who looks after it.
        </ChannelIntro>
        <DateDivider date={group.createdAt} />
        <RallMessage
          sentAt={group.createdAt}
          footnote={group.safeAddress ? <VaultFootnote address={group.safeAddress} /> : null}
        >
          <Detail label="Members">
            <ul className="space-y-2">
              {members.map((member) => (
                <li key={member.memberId} className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="grid size-6 shrink-0 place-items-center rounded-full bg-overlay text-xs font-semibold text-ink"
                  >
                    {member.displayName.trim().charAt(0).toUpperCase() || "?"}
                  </span>
                  <span className="min-w-0 truncate">{member.displayName}</span>
                  {member.role === "ADMIN" && (
                    <span className="shrink-0 rounded-[4px] bg-overlay px-1.5 py-px text-[0.6875rem] leading-4 font-semibold text-ink-muted">
                      ADMIN
                    </span>
                  )}
                  {/* Starting the group is a fact, not a power. */}
                  {member.role === "OWNER" && <span className="shrink-0 text-xs text-ink-faint">started the group</span>}
                </li>
              ))}
            </ul>
          </Detail>
        </RallMessage>
      </div>
    );
  }

  return null;
}

/** #general's sample overview, for this UI-only step. */
const GENERAL_SAMPLE = {
  pot: "USDC 4,200",
  change: "+USDC 800 since 1 Nov",
  paid: 6,
  members: 8,
  collected: "USDC 600",
  expected: "USDC 800",
  late: ["Femi", "Kemi"],
  nextDue: "1 December",
  vote: { what: "Airbnb deposit", amount: "USDC 400", closes: "Friday" },
  payout: { who: "Tunde", when: "1 December", amount: "USDC 800" },
  rotating: {
    round: "4 of 8",
    owing: "Femi, 1 round after their turn",
    activity: [
      { what: "Tunde paid in", amount: "+100", inflow: true },
      { what: "Kemi paid in", amount: "+100", inflow: true },
      { what: "Payout to Amaka", amount: "−800", inflow: false },
    ],
  },
  activity: [
    { what: "Tunde paid in", amount: "+100", inflow: true },
    { what: "Amaka paid in", amount: "+100", inflow: true },
    { what: "Generator repair", amount: "−400", inflow: false },
  ],
};

/**
 * The contract's votable actions in plain words, in the contract's own order
 * (JfkModule's Rule enum: SPEND_SMALL … MIGRATE_MODULE).
 */
const CONTRACT_RULES = [
  "A small spend",
  "A large spend",
  "Adding a member",
  "Removing a member",
  "Replacing a member's lost wallet",
  "Changing what everyone pays",
  "Changing the rules",
  "Closing the group",
  "Moving to a new version of Rallied",
] as const;

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


