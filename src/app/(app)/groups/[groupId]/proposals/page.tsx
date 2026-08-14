import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/session";
import { listProposals } from "@/modules/governance/service";
import { getGroupDetail, getMembership } from "@/modules/groups/service";
import { can } from "@/lib/auth/policy";
import { Card } from "@/components/ui/card";
import { ButtonLink } from "@/components/ui/button";
import { ProposalCard } from "@/components/proposal-card";

export const metadata: Metadata = { title: "Proposals" };

export default async function ProposalsPage({
  params,
}: PageProps<"/groups/[groupId]/proposals">) {
  const { groupId } = await params;
  const user = await requireUser();

  const [group, proposals, membership] = await Promise.all([
    getGroupDetail(groupId, user.id),
    listProposals(groupId, user.id),
    getMembership(groupId, user.id),
  ]);

  if (!group || !proposals || !membership) notFound();

  const canPropose = can("proposal.create", membership).allowed;
  const open = proposals.filter((p) => p.status === "OPEN");
  const past = proposals.filter((p) => p.status !== "OPEN");

  return (
    <main className="animate-rise space-y-6">
      <div>
        <Link
          href={`/groups/${groupId}`}
          className="text-sm text-ink-muted transition-colors hover:text-ink"
        >
          ← {group.name}
        </Link>
        <div className="mt-3 flex items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Proposals</h1>
          {canPropose && proposals.length > 0 && (
            <ButtonLink
              href={`/groups/${groupId}/proposals/new`}
              size="sm"
              variant="secondary"
            >
              New
            </ButtonLink>
          )}
        </div>
      </div>

      {proposals.length === 0 ? (
        <Card className="border-dashed text-center">
          <div className="py-8">
            <h2 className="font-medium text-ink">Nothing to vote on</h2>
            <p className="mx-auto mt-1.5 max-w-[32ch] text-sm text-ink-muted">
              This is how money leaves the group. Someone proposes a spend,
              everyone votes, and it only happens if enough of you agree.
            </p>
            {canPropose && (
              <ButtonLink
                href={`/groups/${groupId}/proposals/new`}
                className="mt-5"
                size="sm"
              >
                Propose something
              </ButtonLink>
            )}
          </div>
        </Card>
      ) : (
        <>
          {open.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-medium tracking-wide text-ink-muted uppercase">
                Needs your vote
              </h2>
              {open.map((proposal) => (
                <ProposalCard
                  key={proposal.id}
                  proposal={proposal}
                  groupId={groupId}
                />
              ))}
            </section>
          )}

          {past.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-medium tracking-wide text-ink-muted uppercase">
                Decided
              </h2>
              {past.map((proposal) => (
                <ProposalCard
                  key={proposal.id}
                  proposal={proposal}
                  groupId={groupId}
                />
              ))}
            </section>
          )}
        </>
      )}
    </main>
  );
}
