import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { signInHref } from "@/lib/auth/return-to";
import { getCurrentUser } from "@/lib/auth/session";
import { listGroupsForUser } from "@/modules/groups/service";
import { countVotesAwaitingUser } from "@/modules/governance/service";
import { countWaitingDrafts } from "@/modules/agents/drafts";
import { getAiConnection } from "@/modules/agents/connection";
import { AI_NUDGE_COOKIE } from "@/components/shell/ai-nudge-cookie";
import { chainSummaries } from "@/modules/groups/onchain-summary";
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

  const [groups, waiting, drafts, connection, cookieStore] = await Promise.all([
    listGroupsForUser(user.id),
    countVotesAwaitingUser(user.id),
    countWaitingDrafts(user.id),
    getAiConnection(user.id),
    cookies(),
  ]);
  // No AI connected and not snoozed: remind them. Rallied is built around one.
  const aiNudge = connection === null && !cookieStore.has(AI_NUDGE_COOKIE);
  // Groups on Base: the vault and the votes waiting come from Base. The old
  // off-chain records only know about groups from before the move on-chain.
  const onBase = await chainSummaries(groups, user.walletAddress);

  const shellGroups: ShellGroup[] = groups.map((group) => {
    const groupDrafts = drafts.get(group.id) ?? {};
    return {
      id: group.id,
      name: group.name,
      avatarUrl: group.avatarUrl,
      bannerUrl: group.bannerUrl,
      memberCount: group.memberCount,
      kind: group.type,
      // "USDC 15000": the currency's code, then the amount, as the wireframe has it.
      balance:
        onBase.get(group.id)?.vault ??
        `${group.balance.total.currency} ${group.balance.total
          .format({ compact: true, showSymbol: false })
          .replaceAll(",", "")}`,
      waiting: onBase.get(group.id)?.votesWaiting ?? waiting.get(group.id) ?? 0,
      // What's waiting for this user, by channel: their AI's drafts, and votes they haven't cast.
      needsYou: {
        propose: (groupDrafts.SPEND ?? 0) + (groupDrafts.GROUP_CHANGE ?? 0),
        "edit-rules": groupDrafts.RULE_CHANGE ?? 0,
        "manage-roles": groupDrafts.ROLE_CHANGE ?? 0,
        votes: onBase.get(group.id)?.votesWaiting ?? waiting.get(group.id) ?? 0,
      },
    };
  });

  return (
    <AppShell
      groups={shellGroups}
      userInitial={user.displayName.trim().charAt(0).toUpperCase() || "?"}
      profile={<ProfilePanel user={user} />}
      aiNudge={aiNudge}
    >
      {children}
    </AppShell>
  );
}
