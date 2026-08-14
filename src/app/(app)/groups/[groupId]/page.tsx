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
      <div>
        <Link
          href="/groups"
          className="text-sm text-ink-muted transition-colors hover:text-ink"
        >
          ← Groups
        </Link>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">
          {group.name}
        </h1>
        {group.description && (
          <p className="mt-1.5 text-sm text-ink-muted">{group.description}</p>
        )}
      </div>

      <Card raised>
        <p className="text-sm text-ink-muted">Group balance</p>
        <p className="mt-1 text-[2.5rem] leading-tight font-semibold tracking-tight">
          {group.balance.total.format({ compact: true })}
        </p>
        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          <span className="rounded-full bg-inflow-soft px-2.5 py-1 text-inflow">
            {group.balance.available.format({ compact: true })} available
          </span>
          <span className="rounded-full bg-locked-soft px-2.5 py-1 text-locked">
            {group.balance.locked.format({ compact: true })} locked
          </span>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-ink-faint">
          Locked money can&rsquo;t be spent until the group votes to release it.
        </p>
      </Card>

      <Card inset={false}>
        <div className="flex items-center justify-between gap-3 p-5">
          <div className="min-w-0">
            <h2 className="text-sm font-medium tracking-wide text-ink-muted uppercase">
              Proposals
            </h2>
            <p className="mt-1 text-ink">
              {openProposals === 0
                ? "Nothing to vote on"
                : `${openProposals} waiting on the group`}
            </p>
          </div>
          <ButtonLink
            href={`/groups/${groupId}/proposals`}
            size="sm"
            variant={openProposals > 0 ? "primary" : "secondary"}
          >
            {openProposals > 0 ? "Vote" : "View"}
          </ButtonLink>
        </div>
      </Card>

      {cycle ? (
        <CycleCard cycle={cycle} />
      ) : (
        <NoCycleYet amount={group.contributionAmount} />
      )}

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

      {simulationAvailable() && <SimulatePanel groupId={groupId} />}

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

      <Card className="border-dashed text-center">
        <div className="py-6">
          <p className="mx-auto max-w-[30ch] text-sm text-ink-muted">
            Contributions, the group wallet, proposals and chat land in the next
            phases.
          </p>
          <p className="mt-3 text-xs text-ink-faint">Phases 2–7</p>
        </div>
      </Card>
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
  CHANGE_LOCK_RULE: "Change the lock",
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
