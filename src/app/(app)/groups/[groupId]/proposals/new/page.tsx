import { redirect } from "next/navigation";

/** Old link to propose something: whole-group decisions start in #propose. */
export default async function NewProposalPage({ params }: PageProps<"/groups/[groupId]/proposals/new">): Promise<never> {
  const { groupId } = await params;
  redirect(`/groups/${groupId}/propose`);
}
