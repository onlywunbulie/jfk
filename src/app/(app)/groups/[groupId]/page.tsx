import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/session";
import { getGroupDetail } from "@/modules/groups/service";
import { groupAvailable, listEntries } from "@/modules/ledger/service";
import { Card, CardHeader } from "@/components/ui/card";
import { ButtonLink } from "@/components/ui/button";
import { TransactionRow } from "@/components/transaction-row";
import { previewContribution } from "@/modules/payments/contribute";
import { listPaymentMethods } from "@/modules/payments/service";
import { ContributePanel } from "./contribute-panel";
import { simulationAvailable } from "@/modules/payments/simulate";
import { SimulatePanel } from "./simulate-panel";
import { getArrears, getCurrentCycle } from "@/modules/contributions/service";
import { CycleCard, NoCycleYet } from "@/components/cycle-card";
import { StatRow, StatTile } from "@/components/ui/stat-tile";
import { listProposals } from "@/modules/governance/service";

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

  const [entries, preview, methods, cycle, arrears, proposalList] = await Promise.all([
    listEntries(groupAvailable(groupId), { limit: 20 }),
    previewContribution(groupId),
    listPaymentMethods(user.id),
    getCurrentCycle(groupId, user.id),
    getArrears(groupId),
    listProposals(groupId, user.id),
  ]);

  const openProposals = (proposalList ?? []).filter((p) => p.status === "OPEN").length;

  return (
    <main className="animate-rise space-y-6">
      {/* On mobile the sidebar is gone, so the group has to name itself here. */}
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
          <h1 className="text-2xl font-semibold tracking-tight">{group.name}</h1>
          {group.description && (
            <p className="mt-1.5 max-w-prose text-sm text-ink-muted">
              {group.description}
            </p>
          )}
        </div>

        {/* The three things you actually come here to do. */}
        <div className="flex flex-wrap gap-2">
          <ButtonLink href={`/groups/${groupId}/proposals/new`} size="sm">
            Propose a spend
          </ButtonLink>
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

      <Card raised>
        <p className="text-sm text-ink-muted">Total balance</p>
        <p className="mt-1 text-[2.75rem] leading-none font-semibold tracking-tight">
          {group.balance.total.format({ compact: true })}
        </p>
        <p className="mt-3 text-xs leading-relaxed text-ink-faint">
          Reserved money has already been voted through and is waiting to be sent.
        </p>
      </Card>

      <StatRow>
        <StatTile
          value={group.balance.available.format({ compact: true })}
          label="Available to spend"
          tone="inflow"
        />
        <StatTile
          value={group.balance.reserved.format({ compact: true })}
          label="Reserved"
          tone="held"
        />
        <StatTile value={group.memberCount} label="Members" />
        <StatTile
          value={openProposals}
          label={openProposals === 1 ? "Open proposal" : "Open proposals"}
          tone={openProposals > 0 ? "pending" : "default"}
        />
      </StatRow>

      {/* Two columns on desktop: what's happening now on the left, the
          group's standing facts on the right. One column below lg. */}
      <div className="grid gap-6 lg:grid-cols-[1.55fr_1fr] lg:items-start">
        <div className="space-y-6">
          {cycle ? (
            <CycleCard cycle={cycle} />
          ) : (
            <NoCycleYet amount={group.contributionAmount} />
          )}

          <Card inset={false}>
            <div className="px-5 pt-5">
              <CardHeader title="Activity" />
            </div>
            {entries.length === 0 ? (
              <p className="px-5 pb-5 text-sm text-ink-muted">
                Nothing yet. Contributions will show up here.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {entries.map((entry) => (
                  <TransactionRow key={entry.transactionId} entry={entry} />
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-6">

      {arrears.length > 0 && (
        <Card>
          <CardHeader title="Behind" />
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
            Missed contributions stay on the record. How the group handles them
            is the group&rsquo;s call — JFK doesn&rsquo;t apply penalties.
          </p>
        </Card>
      )}

      {preview && (
        <Card>
          <CardHeader title="Contribute" />
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

      <Card>
        <CardHeader
          title="Members"
          action={
            <Link
              href={`/groups/${group.id}/members`}
              className="text-sm text-accent transition-opacity hover:opacity-80"
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
        <CardHeader title="The rules" />
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
        <CardHeader title="Approval thresholds" />
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
      </div>
    </main>
  );
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
