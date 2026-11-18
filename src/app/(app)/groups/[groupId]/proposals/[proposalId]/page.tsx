import { redirect } from "next/navigation";

/** Old link to one proposal: every vote is in #votes, read from Base. */
export default async function ProposalPage({ params }: PageProps<"/groups/[groupId]/proposals/[proposalId]">): Promise<never> {
  const { groupId } = await params;
  redirect(`/groups/${groupId}/votes`);
}
