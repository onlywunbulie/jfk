import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import type { Route } from "next";
import { requireUser } from "@/lib/auth/session";
import { getGroupDetail, listMembers } from "@/modules/groups/service";
import { channelBelongs, findChannel } from "@/components/shell/channels";
import { PayoutOrder } from "./payout-order";
import { getOnChainStatus } from "@/modules/groups/onchain";
import { StartOnChain } from "../start-on-chain";
import { EXPLORER_URL, shortAddress } from "@/lib/chain/addresses";
import { VerifyAi } from "./verify-ai";
import { listWaitingDrafts } from "@/modules/agents/drafts";
import { roleDraftView, ruleDraftView, spendDraftView } from "./draft-views";
import { aiAllowedInGroup, getAiConnection } from "@/modules/agents/connection";
import { DEFAULT_GOVERNANCE, type GovernedAction, type GroupType } from "@/lib/db/schema/groups";
import { contractThresholds } from "@/modules/groups/onchain-setup";
import { ChannelIntro, DateDivider, Detail, RallMessage, VaultFootnote, longDate } from "./parts";
import { Transactions } from "./transactions";
import { ProposeChannel } from "./propose";
import { ManageRoles, type Assistant, type Person } from "./manage-roles";
import { EditRules } from "./edit-rules";
import { Votes } from "./votes";
import { readChainVotes } from "@/modules/groups/onchain-votes";
import { readDues } from "@/modules/groups/onchain-dues";
import { readHistory } from "@/modules/groups/onchain-history";
import { Dues } from "./dues";
import { everyText } from "@/lib/schedule-text";
import { cyclePeriodFor } from "@/modules/contributions/schedule";

const LONG_DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", timeZone: "Africa/Lagos" });

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
    // Real: whether the user's AI is connected and allowed in this group.
    // Still a sample: limits, which come with the contract work.
    const [connection, allowedHere] = await Promise.all([getAiConnection(user.id), aiAllowedInGroup(user.id, group.id)]);
    const aiName = connection ? (/chatgpt|openai/i.test(connection.appName) ? "ChatGPT" : /grok/i.test(connection.appName) ? "Grok" : "Claude") : null;
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
            <VerifyAi
              ai={aiName}
              groupId={group.id}
              groupName={group.name}
              connected={connection !== null}
              allowedHere={allowedHere}
            />
          </Detail>
          {connection && <Detail label="It can">Read this group: money, members, rules and votes</Detail>}
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
    // Until the group is on Base, #about is where it gets started (by whoever started the group).
    const onChain = await getOnChainStatus(group.id, user.id);

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
            {amount} every {everyText(group.cadence, group.intervalWeeks)}
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
        {onChain?.eligible && !onChain.started && (
          <div className="mt-6 max-w-xl">
            <StartOnChain
              groupId={group.id}
              isOwner={onChain.isOwner}
              members={onChain.members}
              inviteHref={`/groups/${group.id}/members`}
            />
          </div>
        )}
        {group.safeAddress && (
          <div className="mt-6 max-w-xl">
            <Dues dues={await readDues(group.id, user.id)} groupId={group.id} />
          </div>
        )}
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
        : `every ${everyText(group.cadence, group.intervalWeeks)}, due on ${WEEKDAYS[group.dueDay - 1] ?? "Monday"}`;
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
    // Everything here is read from Base (or, for the next due date, from the
    // group's schedule); nothing is a sample.
    const now = new Date();
    const transactionsLink = (
      <p className="border-t border-border pt-3 text-xs text-ink-faint">
        <Link
          href={`/groups/${group.id}/transactions` as Route}
          className="underline decoration-ink-faint/50 underline-offset-4 transition-colors hover:text-ink hover:decoration-ink"
        >
          Everything in #transactions
        </Link>
      </p>
    );
    const period = cyclePeriodFor(now, {
      cadence: group.cadence,
      dueDay: group.dueDay,
      graceDays: 0,
      intervalWeeks: group.intervalWeeks,
    });
    const nextDue = LONG_DAY.format(period.periodEnd);

    if (!group.safeAddress) {
      return (
        <div className="flex min-h-full flex-col justify-end">
          <ChannelIntro title="The group's money">Where the money stands, read from the group&rsquo;s vault on Base.</ChannelIntro>
          <DateDivider date={now} label="Today" />
          <RallMessage sentAt={now} footnote={null}>
            <Detail label="In the pot">Nothing yet: this group isn&rsquo;t on Base.</Detail>
            <Detail label="Next step">
              Start it on Base in{" "}
              <Link
                href={`/groups/${group.id}/about` as Route}
                className="text-ink underline decoration-ink-faint underline-offset-4 hover:decoration-ink"
              >
                #about
              </Link>
              , then everyone can pay in.
            </Detail>
          </RallMessage>
        </div>
      );
    }

    const [dues, votes, history] = await Promise.all([
      readDues(group.id, user.id),
      readChainVotes(group.id, user.id),
      readHistory(group.id, user.id),
    ]);
    const paid = dues.ok ? dues.members.filter((member) => member.paidThisPeriod) : [];
    const notPaid = dues.ok ? dues.members.filter((member) => !member.paidThisPeriod).map((member) => member.name) : [];
    const open = votes.ok ? votes.votes.filter((vote) => vote.state === "OPEN") : [];
    const latest = history.ok ? history.entries.slice(-3).reverse() : [];

    return (
      <div className="flex min-h-full flex-col justify-end">
        <ChannelIntro title="The group's money">Where the money stands, read from the group&rsquo;s vault on Base.</ChannelIntro>
        <DateDivider date={now} label="Today" />
        <RallMessage sentAt={now} footnote={transactionsLink}>
          <Detail label="In the pot">
            {dues.ok ? <span className="font-semibold tabular-nums">{dues.vault}</span> : <span className="text-ink-muted">Couldn&rsquo;t reach Base just now</span>}
          </Detail>
          {dues.ok && (
            <Detail label="This period">
              {paid.length} of {dues.members.length} paid · {dues.contribution} each
              {notPaid.length > 0 && <span className="text-ink-muted"> · Not yet: {notPaid.join(", ")}</span>}
            </Detail>
          )}
          <Detail label="Next due">{nextDue}</Detail>
          <Detail label="Up for a vote">
            {open.length === 0 ? (
              <span className="text-ink-muted">Nothing right now</span>
            ) : (
              <>
                {open[0].title}
                {open[0].change && (
                  <span className="tabular-nums">
                    {" "}
                    ({open[0].change.before} → {open[0].change.after})
                  </span>
                )}
                <span className="text-ink-muted">
                  {" "}
                  · closes {open[0].closes}
                  {open.length > 1 && ` · and ${open.length - 1} more in #votes`}
                </span>
              </>
            )}
          </Detail>
          <Detail label="Latest">
            {latest.length === 0 ? (
              <span className="text-ink-muted">No payments yet</span>
            ) : (
              <ul className="space-y-1">
                {latest.map((item) => (
                  <li key={item.id}>
                    {item.what}{" "}
                    <span className={item.inflow ? "text-inflow tabular-nums" : "text-ink-muted tabular-nums"}>
                      {item.inflow ? "+" : "−"}
                      {item.amount}
                    </span>
                  </li>
                ))}
              </ul>
            )}
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
          drafts={(await listWaitingDrafts(user.id, group.id, "SPEND")).map(spendDraftView)}
          base={`/groups/${group.id}`}
          rules={{
            // What the vault holds on Base; 0 before the group is on Base.
            pot: group.safeAddress ? await vaultDollars(group.id, user.id) : 0,
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
    // Which AI each member has connected, if any: real connections, never guessed.
    const assistants = await Promise.all(members.map(async (member) => aiNameOf(await getAiConnection(member.userId))));
    const live = await readChainVotes(group.id, user.id);
    const people: Person[] = members.map((member, i) => ({
      id: member.memberId,
      name: member.displayName,
      admin: member.role === "ADMIN",
      startedGroup: member.role === "OWNER",
      isYou: member.userId === user.id,
      assistant: assistants[i],
    }));
    return (
      <ManageRoles
          drafts={(await listWaitingDrafts(user.id, group.id, "ROLE_CHANGE")).map(roleDraftView)}
          history={decided(live, "MEMBER").map((vote) => ({ what: vote.title, detail: resultOf(vote), passed: vote.state === "DONE" }))}
          base={`/groups/${group.id}`}
          people={people}
          startedBy={owner?.displayName ?? "Unknown"}
          startedOn={longDate(group.createdAt)}
          voting={await openVoteCount(group.id, user.id, "MEMBER")}
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
        drafts={(await listWaitingDrafts(user.id, group.id, "RULE_CHANGE")).map(ruleDraftView)}
        history={decided(await readChainVotes(group.id, user.id), "RULE").map((vote) => ({
          id: vote.id,
          rule: vote.title,
          outcome: vote.state === "DONE" ? vote.detail : null,
          passed: vote.state === "DONE",
          result: resultOf(vote),
        }))}
        base={`/groups/${group.id}`}
        needs={{ contribution: percent(onChain[5]), rules: percent(onChain[6]) }}
        voting={await openVoteCount(group.id, user.id, "RULE")}
      />
    );
  }

  if (channel.slug === "votes") {
    return <Votes live={await readChainVotes(group.id, user.id)} base={`/groups/${group.id}`} />;
  }

  if (channel.slug === "transactions") {
    const filter = typeof query.filter === "string" ? query.filter : "all";
    const [history, dues] = await Promise.all([readHistory(group.id, user.id), readDues(group.id, user.id)]);
    const mine = dues.ok ? dues.members.find((member) => member.isYou) : undefined;
    return (
      <Transactions
        base={`/groups/${group.id}`}
        filter={filter === "mine" || filter === "in" || filter === "out" ? filter : "all"}
        history={history}
        you={dues.ok && mine ? { paidIn: mine.paidIn, thisPeriod: dues.you.paidThisPeriod } : null}
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



/** How many votes of one kind are open on Base right now; 0 when the group isn't on Base. */
async function openVoteCount(groupId: string, userId: string, kind: "RULE" | "MEMBER"): Promise<number> {
  const live = await readChainVotes(groupId, userId);
  return live.ok ? live.votes.filter((vote) => vote.kind === kind && vote.state === "OPEN").length : 0;
}

/** Decided votes of one kind on Base (carried out or failed), newest first. */
function decided(live: Awaited<ReturnType<typeof readChainVotes>>, kind: "RULE" | "MEMBER") {
  return live.ok ? live.votes.filter((vote) => vote.kind === kind && (vote.state === "DONE" || vote.state === "FAILED")) : [];
}

/** "Passed · 1 of 1 yes" */
function resultOf(vote: { state: string; yes: string[]; eligible: number }): string {
  return `${vote.state === "DONE" ? "Passed" : "Didn't pass"} · ${vote.yes.length} of ${vote.eligible} yes`;
}

/** Which AI app a connection is, by the name it registered with. */
function aiNameOf(connection: { appName: string } | null): Assistant {
  if (!connection) return null;
  return /chatgpt|openai/i.test(connection.appName) ? "ChatGPT" : /grok/i.test(connection.appName) ? "Grok" : "Claude";
}

/** What the vault holds on Base, in dollars; 0 if Base can't be reached. */
async function vaultDollars(groupId: string, userId: string): Promise<number> {
  const dues = await readDues(groupId, userId);
  return dues.ok ? dues.vaultDollars : 0;
}
