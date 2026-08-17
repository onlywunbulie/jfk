"use client";

import { usePathname } from "next/navigation";
import { Sidebar, type SidebarGroup } from "./sidebar";

/**
 * Works out which group is open from the URL, then renders the sidebar.
 *
 * A layout cannot read the params of the page nested inside it, and threading
 * a context provider through every page for one string is more machinery than
 * the problem deserves. Reading the pathname is exact and costs nothing.
 */
export function CurrentGroupProbe({
  groups,
  user,
}: {
  groups: SidebarGroup[];
  user: { displayName: string; email: string };
}) {
  const pathname = usePathname();
  const match = pathname.match(/^\/groups\/([^/]+)/);
  const currentId = match?.[1];

  return (
    <Sidebar
      groups={groups.map((group) => ({
        ...group,
        isCurrent: group.id === currentId,
      }))}
      user={user}
    />
  );
}
