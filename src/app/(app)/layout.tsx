import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { signInHref } from "@/lib/auth/return-to";
import { getCurrentUser } from "@/lib/auth/session";
import { listGroupsForUser } from "@/modules/groups/service";
import { countVotesAwaitingUser } from "@/modules/governance/service";
import { countWaitingDrafts } from "@/modules/agents/drafts";
import { AppShell, type ShellGroup } from "@/components/shell/app-shell";
import { ProfilePanel } from "@/components/shell/profile-panel";

/**
 * The authenticated frame: a rail of groups, the open group's sidebar card
 * and the main card. See `components/shell/app-shell.tsx`.
 *
 * The redirect here is a routing convenience, not the security boundary: per
 * BLUEPRINT.md §12, every action and query re-checks authorization at the data
 * layer via `requireUser()`.
 */
export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await getCurrentUser();
  // Back to the page they asked for once signed in (see proxy.ts).
  if (!user) redirect(signInHref((await headers()).get("x-rallied-path")));

  const [groups, waiting, drafts] = await Promise.all([
    listGroupsForUser(user.id),
    countVotesAwaitingUser(user.id),
    countWaitingDrafts(user.id),
  ]);

  const shellGroups: ShellGroup[] = groups.map((group) => {
    const groupDrafts = drafts.get(group.id) ?? {};
    return {
      id: group.id,
      name: group.name,
      memberCount: group.memberCount,
      kind: group.type,
      // "USDC 15000": the currency's code, then the amount, as the wireframe has it.
      balance: `${group.balance.total.currency} ${group.balance.total
        .format({ compact: true, showSymbol: false })
        .replaceAll(",", "")}`,
      waiting: waiting.get(group.id) ?? 0,
      // What's waiting for this user, by channel: their AI's drafts, and votes they haven't cast.
      needsYou: {
        propose: groupDrafts.SPEND ?? 0,
        "edit-rules": groupDrafts.RULE_CHANGE ?? 0,
        "manage-roles": groupDrafts.ROLE_CHANGE ?? 0,
        votes: waiting.get(group.id) ?? 0,
      },
    };
  });

  return (
    <AppShell
      groups={shellGroups}
      userInitial={user.displayName.trim().charAt(0).toUpperCase() || "?"}
      profile={<ProfilePanel user={user} />}
    >
      {children}
    </AppShell>
  );
}
