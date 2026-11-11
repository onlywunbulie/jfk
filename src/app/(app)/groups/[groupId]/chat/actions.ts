"use server";

import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { MAX_MESSAGE_LENGTH, postMessage } from "@/modules/chat/service";
import type { FeedItem } from "@/modules/chat/feed";

const schema = z.object({
  groupId: z.string().min(1),
  body: z.string().max(MAX_MESSAGE_LENGTH * 2),
});

export async function sendMessageAction(input: {
  groupId: string;
  body: string;
}): Promise<{ ok: true; item: Extract<FeedItem, { kind: "text" }> } | { ok: false; error: string }> {
  const user = await requireUser();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That message couldn't be sent." };

  const result = await postMessage(parsed.data.groupId, user.id, parsed.data.body);
  if (!result.ok) {
    return {
      ok: false,
      error: {
        not_member: "You're not in this group any more.",
        empty: "Write something first.",
        too_long: `Keep it under ${MAX_MESSAGE_LENGTH} characters.`,
      }[result.reason],
    };
  }
  const m = result.message;
  return {
    ok: true,
    item: {
      id: m.id,
      kind: "text",
      at: m.createdAt.toISOString(),
      authorId: m.authorId,
      authorName: m.authorName ?? user.displayName,
      body: m.body ?? "",
    },
  };
}
