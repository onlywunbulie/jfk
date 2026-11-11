import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/session";
import { getGroupDetail } from "@/modules/groups/service";
import { loadFeed } from "@/modules/chat/feed";
import { ChatRoom } from "./chat-room";

export const metadata: Metadata = { title: "general" };

/**
 * The group's #general: where people talk, and where proposals, decisions and
 * the group's milestones appear as they happen.
 */
export default async function ChatPage({ params }: PageProps<"/groups/[groupId]/chat">) {
  const { groupId } = await params;
  const user = await requireUser();
  const [group, feed] = await Promise.all([getGroupDetail(groupId, user.id), loadFeed(groupId, user.id)]);
  if (!group || !feed) notFound();

  return <ChatRoom groupId={groupId} groupName={group.name} meId={user.id} initialFeed={feed} />;
}
