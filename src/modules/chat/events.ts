import "server-only";
import { db, type Transaction } from "@/lib/db";
import { chatMessages, type ChatEvent } from "@/lib/db/schema";

/**
 * Drop an event into a group's chat: a proposal opening, a vote decided,
 * someone joining, the group starting on-chain.
 *
 * Kept apart from the rest of the chat module, and free of imports from
 * other modules, so any module can announce something without a circular
 * import. Pass the caller's transaction so the event lands if, and only if,
 * the thing it announces did.
 */
export async function announce(
  groupId: string,
  event: ChatEvent,
  executor: Transaction | typeof db = db,
): Promise<void> {
  await executor.insert(chatMessages).values({ groupId, kind: "EVENT", event });
}
