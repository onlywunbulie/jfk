import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { listGroupsForUser } from "@/modules/groups/service";

/**
 * The landing route is a router, not a screen.
 *
 * Opening Rallied puts the user inside a group with its money in front of
 * them. With no groups yet, `/groups` holds the empty state.
 *
 * `?profile=1` is passed along, so a link can land home with the profile
 * modal open.
 */
export default async function LandingPage({ searchParams }: PageProps<"/">) {
  const user = await requireUser();
  const groups = await listGroupsForUser(user.id);
  const { profile } = await searchParams;
  const keep = profile === "1" ? "?profile=1" : "";

  if (groups.length === 0) redirect(`/groups${keep}`);

  // A group opens on its ledger overview.
  redirect(`/groups/${groups[0].id}/general${keep}`);
}
