import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/session";
import {
  getGroupDetail,
  getMembership,
  listMembers,
} from "@/modules/groups/service";
import { can } from "@/lib/auth/policy";
import { env } from "@/lib/env";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { InvitePanel } from "./invite-panel";
import { MemberActions } from "./member-actions";
import { leaveGroupAction } from "../../actions";

export const metadata: Metadata = { title: "Members" };

export default async function MembersPage({
  params,
}: PageProps<"/groups/[groupId]/members">) {
  const { groupId } = await params;
  const user = await requireUser();

  const [group, members, membership] = await Promise.all([
    getGroupDetail(groupId, user.id),
    listMembers(groupId, user.id),
    getMembership(groupId, user.id),
  ]);

  if (!group || !members || !membership) notFound();

  const canInvite = can("member.invite", membership).allowed;

  return (
    <main className="animate-rise space-y-6">
      <div>
        <Link
          href={`/groups/${groupId}`}
          className="text-sm text-ink-muted transition-colors hover:text-ink"
        >
          ← {group.name}
        </Link>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">Members</h1>
      </div>

      {canInvite && (
        <Card>
          <CardHeader title="Invite" />
          <InvitePanel groupId={groupId} appUrl={env().APP_URL} />
        </Card>
      )}

      <Card inset={false}>
        <ul className="divide-y divide-border">
          {members.map((member) => {
            const isSelf = member.userId === user.id;

            // Ask the policy module per member — the answer depends on the
            // target's role and the group's size, not just the viewer's role.
            const grantDecision = can("role.grant_admin", membership);
            const removeDecision = can("member.remove", {
              ...membership,
              targetIsSelf: isSelf,
              targetRole: member.role,
            });

            return (
              <li key={member.userId} className="p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <Avatar name={member.displayName} />
                    <div className="min-w-0">
                      <p className="truncate font-medium text-ink">
                        {member.displayName}
                        {isSelf && (
                          <span className="text-ink-faint"> (you)</span>
                        )}
                      </p>
                      <p className="text-xs text-ink-muted">
                        {ROLE_LABEL[member.role]}
                        {member.rotationPosition !== null && (
                          <> · payout #{member.rotationPosition}</>
                        )}
                      </p>
                    </div>
                  </div>
                </div>

                {!isSelf && (
                  <MemberActions
                    groupId={groupId}
                    userId={member.userId}
                    canGrantAdmin={
                      grantDecision.allowed && member.role === "MEMBER"
                    }
                    canRemove={removeDecision.allowed}
                  />
                )}
              </li>
            );
          })}
        </ul>
      </Card>

      {membership.role !== "OWNER" && (
        <form action={leaveGroupAction}>
          <input type="hidden" name="groupId" value={groupId} />
          <Button type="submit" variant="ghost" size="sm">
            Leave this group
          </Button>
        </form>
      )}

      <p className="text-xs leading-relaxed text-ink-faint">
        Removing someone from a group of three or more needs a vote, not an
        admin. Admins can never move money on their own.
      </p>
    </main>
  );
}

const ROLE_LABEL = {
  OWNER: "Owner",
  ADMIN: "Admin",
  MEMBER: "Member",
} as const;

function Avatar({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <span
      aria-hidden="true"
      className="grid size-10 shrink-0 place-items-center rounded-full bg-accent-soft text-sm font-medium text-accent"
    >
      {initials || "?"}
    </span>
  );
}
