import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/session";
import { getGroupDetail, getMembership } from "@/modules/groups/service";
import { assertCan } from "@/lib/auth/policy";
import { formatPermille } from "@/modules/governance/threshold";
import { LARGE_RELEASE_SHARE_PERMILLE } from "@/lib/db/schema";
import { ProposalForm } from "./proposal-form";

export const metadata: Metadata = { title: "New proposal" };

export default async function NewProposalPage({
  params,
}: PageProps<"/groups/[groupId]/proposals/new">) {
  const { groupId } = await params;
  const user = await requireUser();

  const [group, membership] = await Promise.all([
    getGroupDetail(groupId, user.id),
    getMembership(groupId, user.id),
  ]);

  if (!group || !membership) notFound();

  // Throws for a member of a group where only admins may propose.
  assertCan("proposal.create", membership);

  const thresholdFor = (action: string) =>
    formatPermille(
      group.governance.find((rule) => rule.action === action)
        ?.thresholdPermille ?? 667,
    );

  // The "large withdrawal" line, expressed in naira for this group.
  const largeAbove = group.balance.total
    .percentage(LARGE_RELEASE_SHARE_PERMILLE * 10)
    .format({ compact: true });

  return (
    <main className="animate-rise space-y-6">
      <div>
        <Link
          href={`/groups/${groupId}/proposals`}
          className="text-sm text-ink-muted transition-colors hover:text-ink"
        >
          ← Proposals
        </Link>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">
          Propose a spend
        </h1>
        <p className="mt-1.5 text-sm text-ink-muted">
          Nothing moves until enough of the group agrees. Not even you can
          override that.
        </p>
      </div>

      <ProposalForm
        groupId={groupId}
        available={group.balance.available.format({ compact: true })}
        smallThreshold={thresholdFor("FUND_RELEASE_SMALL")}
        largeThreshold={thresholdFor("FUND_RELEASE_LARGE")}
        largeAbove={largeAbove}
      />
    </main>
  );
}
