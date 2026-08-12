import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/session";
import { listGroupsForUser } from "@/modules/groups/service";
import { GroupCard } from "@/components/group-card";
import { Card } from "@/components/ui/card";
import { ButtonLink } from "@/components/ui/button";

export const metadata: Metadata = { title: "Groups" };

export default async function GroupsPage() {
  const user = await requireUser();
  const groups = await listGroupsForUser(user.id);

  return (
    <main className="animate-rise space-y-6">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Groups</h1>
        {groups.length > 0 && (
          <ButtonLink href="/groups/new" size="sm" variant="secondary">
            New group
          </ButtonLink>
        )}
      </header>

      {groups.length === 0 ? (
        <Card className="border-dashed text-center">
          <div className="py-8">
            <h2 className="font-medium text-ink">No groups yet</h2>
            <p className="mx-auto mt-1.5 max-w-[30ch] text-sm text-ink-muted">
              A group is where you and your people pool money and decide
              together.
            </p>
            <ButtonLink href="/groups/new" className="mt-5" size="sm">
              Create your first group
            </ButtonLink>
          </div>
        </Card>
      ) : (
        <div className="space-y-3">
          {groups.map((group) => (
            <GroupCard key={group.id} group={group} />
          ))}
        </div>
      )}
    </main>
  );
}
