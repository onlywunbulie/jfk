import { redirect } from "next/navigation";

/** Chat isn't part of Rallied for now; a group's #general shows its money instead. */
export default async function ChatPage({ params }: PageProps<"/groups/[groupId]/chat">): Promise<never> {
  const { groupId } = await params;
  redirect(`/groups/${groupId}/general`);
}
