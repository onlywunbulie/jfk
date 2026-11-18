import { redirect } from "next/navigation";

/** Old links to a group's proposals: votes live in #votes, read from Base. */
export default async function ProposalsPage({ params }: PageProps<"/groups/[groupId]/proposals">): Promise<never> {
  const { groupId } = await params;
  redirect(`/groups/${groupId}/votes`);
}
