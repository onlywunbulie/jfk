import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/session";
import {
  getGroupDetail,
  getMembership,
  listMembers,
} from "@/modules/groups/service";
import { assertCan } from "@/lib/auth/policy";
import { ProposalForm } from "./proposal-form";

export const metadata: Metadata = { title: "New proposal" };

export default async function NewProposalPage({
  params,
}: PageProps<"/groups/[groupId]/proposals/new">) {
  const { groupId } = await params;
  const user = await requireUser();

  const [group, membership, members] = await Promise.all([
    getGroupDetail(groupId, user.id),
    getMembership(groupId, user.id),
    listMembers(groupId, user.id),
  ]);

  if (!group || !membership || !members) notFound();

  // Throws for a member of a group where only admins may propose.
  assertCan("proposal.create", membership);

  return (
    // A sequence of decisions reads better narrow than stretched across a
    // dashboard-width page.
    <main className="animate-rise mx-auto max-w-2xl space-y-6">
      <div>
        <Link
          href={`/groups/${groupId}/proposals`}
          className="text-sm text-ink-muted transition-colors hover:text-ink"
        >
          ← Proposals
        </Link>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">
          Put something to the group
        </h1>
        <p className="mt-1.5 text-sm text-ink-muted">
          Nothing happens until enough of the group agrees. Not even you can
          override that.
        </p>
      </div>

      <ProposalForm
        groupId={groupId}
        available={group.balance.available.format({ compact: true })}
        members={members.map((m) => ({
          userId: m.userId,
          displayName: m.displayName,
          role: m.role,
        }))}
        currentThresholds={group.governance.map((rule) => ({
          action: rule.action,
          permille: rule.thresholdPermille,
        }))}
        contribution={{
          amount: group.contributionAmount.format({ compact: true }),
          cadence: group.cadence,
          dueDay: group.dueDay,
        }}
      />
    </main>
  );
}
