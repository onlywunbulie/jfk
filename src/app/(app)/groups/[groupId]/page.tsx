import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { requireUser } from "@/lib/auth/session";
import { getGroupDetail } from "@/modules/groups/service";
import {
  getMonthlyRaised,
  groupAvailable,
  listEntries,
} from "@/modules/ledger/service";
import { sumMoney } from "@/lib/money";
import { Card, CardHeader, IconTile } from "@/components/ui/card";
import { ButtonLink } from "@/components/ui/button";
import { Delta } from "@/components/ui/stat-tile";
import {
  ArrowDownIcon,
  CalendarIcon,
  ClockIcon,
  PeopleIcon,
  PlusIcon,
  ScalesIcon,
  ScrollIcon,
  SwapIcon,
  VaultIcon,
} from "@/components/ui/icons";
import { TransactionHeader, TransactionRow } from "@/components/transaction-row";
import { MonthlyRaisedChart } from "@/components/monthly-raised-chart";
import { previewContribution } from "@/modules/payments/contribute";
import { listPaymentMethods } from "@/modules/payments/service";
import { ContributePanel } from "./contribute-panel";
import { simulationAvailable } from "@/modules/payments/simulate";
import { SimulatePanel } from "./simulate-panel";
import { getArrears, getCurrentCycle } from "@/modules/contributions/service";
import { CycleCard, NoCycleYet } from "@/components/cycle-card";
import { listProposals } from "@/modules/governance/service";
import { getOnChainStatus } from "@/modules/groups/onchain";
import { EXPLORER_URL, shortAddress } from "@/lib/chain/addresses";
import { StartOnChain } from "./start-on-chain";

export async function generateMetadata({
  params,
}: PageProps<"/groups/[groupId]">): Promise<Metadata> {
  const { groupId } = await params;
  const user = await requireUser();
  const group = await getGroupDetail(groupId, user.id);
  return { title: group?.name ?? "Group" };
}

const CADENCE_LABEL = { WEEKLY: "Weekly", MONTHLY: "Monthly" } as const;

export default async function GroupPage({
  params,
}: PageProps<"/groups/[groupId]">) {
  const { groupId } = await params;
  const user = await requireUser();
  const group = await getGroupDetail(groupId, user.id);

  // Null covers both "no such group" and "you aren't in it" — from the outside
  // those must be indistinguishable.
  if (!group) notFound();

  // A USDC group's money lives on-chain; the card-charging Contribute panel
  // and the naira ledger only apply to groups from the Paystack era.
  const onChainGroup = group.currency === "USDC";

  const [entries, preview, methods, cycle, arrears, proposalList, monthly, onChain] =
    await Promise.all([
      listEntries(groupAvailable(groupId), { limit: 20 }),
      onChainGroup ? null : previewContribution(groupId),
      listPaymentMethods(user.id),
      getCurrentCycle(groupId, user.id),
      getArrears(groupId),
      listProposals(groupId, user.id),
      getMonthlyRaised(groupId, { currency: group.currency }),
      getOnChainStatus(groupId, user.id),
    ]);

  const openProposals = (proposalList ?? []).filter((p) => p.status === "OPEN").length;

  const thisMonth = monthly[monthly.length - 1].raised;
  const lastMonth = monthly[monthly.length - 2].raised;
  const raisedInWindow = sumMoney(monthly.map((row) => row.raised));
  const activeMonths = monthly.filter((row) => !row.raised.isZero()).length;

  return (
    <main className="animate-rise space-y-6">
      {/* On mobile the sidebar is gone, so the way back has to live here. */}
      <div className="lg:hidden">
        <Link
          href="/groups"
          className="text-sm text-ink-muted transition-colors hover:text-ink"
        >
          ← Groups
        </Link>
      </div>

      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight lg:text-[1.75rem]">
            Welcome back, {user.displayName.split(" ")[0]} 👋
          </h1>
          <p className="mt-1.5 max-w-prose text-sm text-ink-muted">
            <span className="text-ink">{group.name}</span>
            {group.description ? ` — ${group.description}` : null}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <ButtonLink
            href={`/groups/${groupId}/proposals`}
            size="sm"
            variant="secondary"
          >
            {openProposals > 0 ? `Vote · ${openProposals}` : "Proposals"}
          </ButtonLink>
          <ButtonLink
            href={`/groups/${groupId}/members`}
            size="sm"
            variant="secondary"
          >
            Invite
          </ButtonLink>
        </div>
      </header>

      {onChain?.eligible && !onChain.started && (
        <StartOnChain
          groupId={groupId}
          isOwner={onChain.isOwner}
          members={onChain.members}
          inviteHref={`/groups/${groupId}/members`}
        />
      )}

      {onChain?.safeAddress && (
        <p className="text-sm text-ink-muted">
          Started on Base. The group&rsquo;s money is held by its own shared wallet,{" "}
          <a
            href={`${EXPLORER_URL}/address/${onChain.safeAddress}`}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-ink underline decoration-white/30 underline-offset-4 hover:decoration-white"
          >
            {shortAddress(onChain.safeAddress)}
          </a>
          , which anyone can check.
        </p>
      )}

      {/* Row one: the money on the left, how it has been arriving on the right. */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.75fr)] lg:items-stretch">
        <Card raised className="flex flex-col">
          <CardHeader title="Group balance" icon={<VaultIcon />} />

          <p className="text-[2.5rem] leading-none font-semibold tracking-tight">
            {group.balance.total.format({ compact: true })}
          </p>
          <p className="mt-3 text-xs text-ink-muted">
            {group.memberCount} member{group.memberCount === 1 ? "" : "s"} ·{" "}
            {group.contributionAmount.format({ compact: true })}{" "}
            {CADENCE_LABEL[group.cadence].toLowerCase()} each
          </p>

          {/* The two things you actually come here to do. */}
          <div className="mt-5 grid grid-cols-2 gap-2.5">
            {preview ? (
              <ButtonLink href="#contribute" size="sm">
                <ArrowDownIcon />
                Contribute
              </ButtonLink>
            ) : (
              <ButtonLink href={`/groups/${groupId}/proposals/new`} size="sm">
                <PlusIcon />
                Propose a spend
              </ButtonLink>
            )}
            {preview ? (
              <ButtonLink
                href={`/groups/${groupId}/proposals/new`}
                size="sm"
                variant="secondary"
              >
                {/* No room for it beside the label on a phone. */}
                <span className="hidden sm:contents">
                  <PlusIcon />
                </span>
                Propose a spend
              </ButtonLink>
            ) : (
              <ButtonLink
                href={`/groups/${groupId}/proposals`}
                size="sm"
                variant="secondary"
              >
                Proposals
              </ButtonLink>
            )}
          </div>

          <p className="mt-6 mb-2.5 text-sm text-ink-muted">Where it sits</p>
          <div className="grid grid-cols-2 gap-2.5">
            <Pocket
              label="Available"
              value={group.balance.available.format({ compact: true })}
              note="Free to propose"
              tone="text-inflow"
            />
            <Pocket
              label="Reserved"
              value={group.balance.reserved.format({ compact: true })}
              note="Voted, waiting to send"
              tone="text-held"
            />
          </div>
          <p className="mt-auto pt-4 text-xs leading-relaxed text-ink-faint">
            Reserved money has already been voted through and is waiting to be
            sent.
          </p>
        </Card>

        <div className="flex min-w-0 flex-col gap-6">
          <div className="grid gap-6 sm:grid-cols-2">
            <Metric
              title="Raised this month"
              icon={<ArrowDownIcon />}
              value={thisMonth.format({ compact: true })}
            >
              {lastMonth.isZero() ? (
                <span>Nothing was raised last month</span>
              ) : (
                <>
                  <Delta up={!thisMonth.lessThan(lastMonth)}>
                    {percentChange(thisMonth.minor, lastMonth.minor)}
                  </Delta>
                  <span>from last month</span>
                </>
              )}
            </Metric>
            <Metric
              title="Raised in 12 months"
              icon={<CalendarIcon />}
              value={raisedInWindow.format({ compact: true })}
            >
              <span>
                {activeMonths === 0
                  ? "No contributions have settled yet"
                  : `across ${activeMonths} month${activeMonths === 1 ? "" : "s"} with contributions`}
              </span>
            </Metric>
          </div>

          <MonthlyRaisedChart months={monthly} />
        </div>
      </div>

      {/* Row two: this cycle's collection beside the statement. */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.75fr)] lg:items-start">
        {cycle ? (
          <CycleCard cycle={cycle} />
        ) : (
          <NoCycleYet amount={group.contributionAmount} />
        )}

        <Card inset={false}>
          <div className="px-5 pt-5">
            <CardHeader title="Recent activity" icon={<SwapIcon />} />
          </div>
          {entries.length === 0 ? (
            <p className="px-5 pb-5 text-sm text-ink-muted">
              Nothing yet. Contributions will show up here.
            </p>
          ) : (
            <>
              <TransactionHeader />
              <ul className="divide-y divide-white/[0.05] pb-1.5">
                {entries.map((entry) => (
                  <TransactionRow key={entry.transactionId} entry={entry} />
                ))}
              </ul>
            </>
          )}
        </Card>
      </div>

      {/* Row three: the group's standing facts. */}
      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
        {preview && (
          <Card id="contribute" className="scroll-mt-6">
            <CardHeader title="Contribute" icon={<ArrowDownIcon />} />
            <ContributePanel
              groupId={groupId}
              target={preview.target.format({ compact: true })}
              charged={preview.charged.format()}
              fee={preview.fee.format()}
              grossUp={preview.grossUp}
              hasCard={methods.length > 0}
            />
          </Card>
        )}

        {arrears.length > 0 && (
          <Card>
            <CardHeader title="Behind" icon={<ClockIcon />} />
            <ul className="space-y-2.5 text-sm">
              {arrears.map((row) => (
                <li
                  key={row.userId}
                  className="flex items-baseline justify-between gap-4"
                >
                  <span className="truncate text-ink">{row.displayName}</span>
                  <span className="shrink-0 text-ink-muted">
                    {row.missedCount} missed ·{" "}
                    {row.totalOwed.format({ compact: true })}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-xs leading-relaxed text-ink-faint">
              Missed contributions stay on the record. How the group handles
              them is the group&rsquo;s call — JFK doesn&rsquo;t apply
              penalties.
            </p>
          </Card>
        )}

        <Card>
          <CardHeader
            title="Members"
            icon={<PeopleIcon />}
            action={
              <Link
                href={`/groups/${group.id}/members`}
                className="text-sm text-ink-muted transition-colors hover:text-ink"
              >
                Manage
              </Link>
            }
          />
          <p className="text-ink">
            {group.memberCount} member{group.memberCount === 1 ? "" : "s"}
          </p>
          {group.memberCount === 1 && (
            <div className="mt-4">
              <ButtonLink
                href={`/groups/${group.id}/members`}
                size="sm"
                variant="secondary"
              >
                Invite your people
              </ButtonLink>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="The rules" icon={<ScrollIcon />} />
          <dl className="space-y-3 text-sm">
            <Row label="Type" value={group.type === "ROTATING" ? "Rotating (Ajo)" : "Treasury"} />
            <Row
              label="Contribution"
              value={`${group.contributionAmount.format({ compact: true })} each`}
            />
            <Row label="Frequency" value={CADENCE_LABEL[group.cadence]} />
            <Row
              label="Due"
              value={
                group.cadence === "MONTHLY"
                  ? `Day ${group.dueDay} of the month`
                  : WEEKDAYS[group.dueDay - 1] ?? `Day ${group.dueDay}`
              }
            />
            <Row
              label="Who can propose"
              value={group.membersCanPropose ? "Any member" : "Admins only"}
            />
            <Row label="Quorum" value={`${group.quorumPct}% must vote`} />
          </dl>
        </Card>

        <Card>
          <CardHeader title="Approval thresholds" icon={<ScalesIcon />} />
          <p className="mb-4 text-sm text-ink-muted">
            What share of the group has to agree before each thing can happen.
            Nobody can bypass these — not admins, not you.
          </p>
          <dl className="space-y-2.5 text-sm">
            {group.governance.map((rule) => (
              <Row
                key={rule.action}
                label={GOVERNANCE_LABELS[rule.action] ?? rule.action}
                value={formatPermille(rule.thresholdPermille)}
              />
            ))}
          </dl>
        </Card>

        {simulationAvailable() && <SimulatePanel groupId={groupId} />}
      </div>
    </main>
  );
}

/** One of the two places a group's money can be. */
function Pocket({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note: string;
  tone: string;
}) {
  return (
    <div className="glass-subtle rounded-xl p-3.5">
      <p className="text-xs text-ink-muted">{label}</p>
      <p className="mt-1.5 truncate text-lg font-semibold tracking-tight text-ink tabular-nums">
        {value}
      </p>
      <p className={`mt-1 text-[0.6875rem] ${tone}`}>{note}</p>
    </div>
  );
}

/** A headline figure with its own title, icon and a line of context. */
function Metric({
  title,
  icon,
  value,
  children,
}: {
  title: string;
  icon: ReactNode;
  value: string;
  children: ReactNode;
}) {
  return (
    <Card>
      <div className="flex items-center gap-2.5">
        <IconTile>{icon}</IconTile>
        <h2 className="truncate text-[0.9375rem] font-medium text-ink">{title}</h2>
      </div>
      <p className="mt-4 truncate text-[1.75rem] leading-none font-semibold tracking-tight tabular-nums">
        {value}
      </p>
      <p className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
        {children}
      </p>
    </Card>
  );
}

/**
 * Month-on-month change as "12.5%". Integer kobo in, tenths of a percent out
 * — the ratio is taken in `bigint`, so no amount passes through a float.
 */
function percentChange(current: bigint, previous: bigint): string {
  const diff = current > previous ? current - previous : previous - current;
  const permille = (diff * 1000n) / previous;
  const tenth = permille % 10n;
  return `${permille / 10n}${tenth === 0n ? "" : `.${tenth}`}%`;
}

const WEEKDAYS = [
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
  "Sundays",
];

const GOVERNANCE_LABELS: Record<string, string> = {
  FUND_RELEASE_SMALL: "Release funds",
  FUND_RELEASE_LARGE: "Large withdrawal",
  CHANGE_CONTRIBUTION: "Change the contribution",
  CHANGE_GOVERNANCE: "Change these thresholds",
  REMOVE_MEMBER: "Remove a member",
  REMOVE_ADMIN: "Remove an admin",
  ROTATION_ORDER_CHANGE: "Change payout order",
  DISSOLVE_GROUP: "Dissolve the group",
};

/** 667 → "66.7%", 800 → "80%" */
function formatPermille(value: number): string {
  const percent = value / 10;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="text-right text-ink">{value}</dd>
    </div>
  );
}
