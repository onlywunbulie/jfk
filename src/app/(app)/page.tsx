import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { listGroupsForUser } from "@/modules/groups/service";

/**
 * The landing route is a router, not a screen.
 *
 * Opening JFK should put you inside a group with its money in front of you,
 * not on an index asking which one you meant. The overview of every group
 * still exists at `/groups` for when you genuinely want to compare them.
 *
 * With no groups yet, `/groups` is the right place — it holds the empty state
 * and the invitation to create one.
 */
export default async function LandingPage() {
  const user = await requireUser();
  const groups = await listGroupsForUser(user.id);

  if (groups.length === 0) redirect("/groups");

  redirect(`/groups/${groups[0].id}`);
}
