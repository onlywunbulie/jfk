import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { listGroupsForUser } from "@/modules/groups/service";
import { formatPermille } from "@/modules/governance/threshold";
import { TabBar } from "@/components/tab-bar";
import { TopBar } from "@/components/top-bar";
import type { SidebarGroup } from "@/components/sidebar";
import { CurrentGroupProbe } from "@/components/current-group-probe";

/**
 * The authenticated shell.
 *
 * Desktop-first: a persistent sidebar carries the group context so no page has
 * to re-state which group you are in or what it holds. Below `lg` the sidebar
 * disappears and the bottom tab bar takes over, so the phone experience the
 * app was originally built for still works.
 *
 * The redirect here is a routing convenience, not the security boundary — per
 * BLUEPRINT.md §12, every action and query re-checks authorization at the data
 * layer via `requireUser()`.
 */
export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const groups = await listGroupsForUser(user.id);

  // The sidebar needs to know which group is open, but a layout cannot read
  // the route params of the page beneath it. A tiny client probe reads the
  // pathname instead — cheaper than threading a context through every page.
  const sidebarGroups: SidebarGroup[] = groups.map((group) => ({
    id: group.id,
    name: group.name,
    balance: group.balance.total.format({ compact: true }),
    memberCount: group.memberCount,
    // Groups all share the same default for a routine release; showing the
    // large-withdrawal bar would misrepresent the common case.
    threshold: formatPermille(667),
    isCurrent: false,
  }));

  return (
    <div className="min-h-dvh">
      <CurrentGroupProbe groups={sidebarGroups} />

      <div className="flex min-h-dvh flex-col lg:pl-[var(--sidebar-width)]">
        <TopBar user={user} />
        {/*
          Mobile stays a centred narrow column. Desktop fills the space beside
          the sidebar rather than sitting in a centred box — the dead margins
          made a wide screen feel like a stretched phone. The cap only bites on
          very large displays, where an uninterrupted 2000px row of text would
          be worse than a margin.
        */}
        <div className="mx-auto w-full max-w-lg flex-1 px-5 pt-8 pb-6 lg:mx-0 lg:max-w-none lg:px-8 lg:pt-6 lg:pb-16 2xl:max-w-[112rem] 2xl:px-12">
          {children}
        </div>
        <div className="lg:hidden">
          <TabBar />
        </div>
      </div>
    </div>
  );
}
