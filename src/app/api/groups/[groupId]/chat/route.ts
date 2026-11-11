import { getCurrentUser } from "@/lib/auth/session";
import { loadFeed } from "@/modules/chat/feed";

/**
 * The group's chat, as the screen polls it. Members only: anyone else gets a
 * 404, the same as a group that doesn't exist.
 */
export async function GET(
  _request: Request,
  { params }: RouteContext<"/api/groups/[groupId]/chat">,
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });

  const { groupId } = await params;
  const feed = await loadFeed(groupId, user.id);
  if (!feed) return Response.json({ error: "Not found" }, { status: 404 });

  return Response.json({ feed }, { headers: { "Cache-Control": "no-store" } });
}
