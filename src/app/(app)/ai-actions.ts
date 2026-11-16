"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { revokeAllForUser } from "@/modules/agents/oauth";
import { setAiInGroup } from "@/modules/agents/connection";

/**
 * Switching the user's AI off. Disconnect cuts every token at once (Claude's
 * next request is refused); the per-group switch keeps the connection but
 * hides one group from the AI. Both act only on the signed-in user's own
 * connection.
 */

export async function disconnectAiAction(): Promise<{ ok: true }> {
  const user = await requireUser();
  await revokeAllForUser(user.id);
  revalidatePath("/", "layout");
  return { ok: true };
}

const groupSwitch = z.object({ groupId: z.string().min(1).max(64), allowed: z.boolean() });

export async function setAiInGroupAction(input: {
  groupId: string;
  allowed: boolean;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireUser();
  const parsed = groupSwitch.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That didn't work. Try again." };

  const result = await setAiInGroup(user.id, parsed.data.groupId, parsed.data.allowed);
  if (!result.ok) return { ok: false, error: "You're not a member of this group." };
  revalidatePath(`/groups/${parsed.data.groupId}`, "layout");
  return { ok: true };
}
