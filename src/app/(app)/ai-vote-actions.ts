"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { chainActionLimit } from "@/lib/rate-limit";
import { aiVoteStatus, prepareAiVotes } from "@/modules/groups/onchain-ai-votes";

/**
 * Letting the user's AI vote for them in one group, or stopping it: the one
 * wallet call, then a check of Base. Every step re-checks who's asking.
 */

const id = z.string().min(1).max(64);
const mode = z.enum(["allow", "remove"]);
type Calls = { to: `0x${string}`; data: `0x${string}` }[];

export async function prepareAiVotesAction(
  groupId: string,
  which: string,
): Promise<{ ok: true; calls: Calls; wallet: string } | { ok: false; error: string }> {
  const user = await requireUser();
  const slow = await chainActionLimit(user.id);
  if (slow) return { ok: false, error: slow };
  const group = id.safeParse(groupId);
  const parsed = mode.safeParse(which);
  if (!group.success || !parsed.success) return { ok: false, error: "That didn't work. Try again." };
  const prepared = await prepareAiVotes(user.id, group.data, parsed.data);
  if (!prepared.ok) return { ok: false, error: prepared.reason };
  return { ok: true, calls: prepared.calls, wallet: prepared.wallet };
}

/** After the wallet confirm: Base must now show what the user asked for. */
export async function confirmAiVotesAction(groupId: string, which: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireUser();
  const group = id.safeParse(groupId);
  const parsed = mode.safeParse(which);
  if (!group.success || !parsed.success) return { ok: false, error: "That didn't work. Try again." };
  const status = await aiVoteStatus(user.id, group.data);
  if (!status) return { ok: false, error: "Couldn't read Base just now." };
  if (status.allowed !== (parsed.data === "allow")) {
    return { ok: false, error: "Base doesn't show the change yet. Give it a moment and refresh." };
  }
  revalidatePath(`/groups/${group.data}`, "layout");
  return { ok: true };
}
