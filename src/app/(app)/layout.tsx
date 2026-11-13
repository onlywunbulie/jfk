import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { listGroupsForUser } from "@/modules/groups/service";
import { countVotesAwaitingUser } from "@/modules/governance/service";
import { AppShell, type ShellGroup } from "@/components/shell/app-shell";

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
  if (!user) redirect("/sign-in");

  const [groups, waiting] = await Promise.all([
    listGroupsForUser(user.id),
    countVotesAwaitingUser(user.id),
  ]);

  const shellGroups: ShellGroup[] = groups.map((group) => ({
    id: group.id,
    name: group.name,
    memberCount: group.memberCount,
    kind: group.type,
    // "USDC 15000": the currency's code, then the amount, as the wireframe has it.
    balance: `${group.balance.total.currency} ${group.balance.total
      .format({ compact: true, showSymbol: false })
      .replaceAll(",", "")}`,
    waiting: waiting.get(group.id) ?? 0,
  }));

  return (
    <AppShell groups={shellGroups}>
      {children}
    </AppShell>
  );
}
