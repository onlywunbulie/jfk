import { redirect } from "next/navigation";

/**
 * A group's address opens its #general: the money at a glance. (This was the
 * naira-era overview; everything it showed now lives in the group's channels,
 * read from Base.)
 */
export default async function GroupPage({ params }: PageProps<"/groups/[groupId]">): Promise<never> {
  const { groupId } = await params;
  redirect(`/groups/${groupId}/general`);
}
