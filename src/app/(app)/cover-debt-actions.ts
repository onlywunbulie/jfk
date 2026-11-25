"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { tellAboutCover } from "@/modules/notifications/service";
import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { chainActionLimit } from "@/lib/rate-limit";
import { prepareCoverDebt } from "@/modules/groups/onchain-rotation";

/**
 * Covering a member's debt in a rotating group: the exact calls for the
 * user's one wallet confirm. Re-checks on the server who's asking and what
 * Base says the member owes.
 */

const id = z.string().min(1).max(64);
type Calls = { to: `0x${string}`; data: `0x${string}` }[];

export async function prepareCoverDebtAction(
  groupId: string,
  memberId: string,
): Promise<{ ok: true; calls: Calls; wallet: string } | { ok: false; error: string }> {
  const user = await requireUser();
  const slow = await chainActionLimit(user.id);
  if (slow) return { ok: false, error: slow };
  const group = id.safeParse(groupId);
  const member = id.safeParse(memberId);
  if (!group.success || !member.success) return { ok: false, error: "That didn't work. Try again." };
  const prepared = await prepareCoverDebt(user.id, group.data, member.data);
  if (!prepared.ok) return { ok: false, error: prepared.reason };
  return { ok: true, calls: prepared.calls, wallet: prepared.wallet };
}

const txHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

/**
 * After the wallet confirm: the group's screens read Base again, and the
 * member whose debt it was hears who covered it (checked against the
 * transaction itself, after the reply).
 */
export async function coveredAction(groupId: string, hash: string): Promise<void> {
  const user = await requireUser();
  const group = id.safeParse(groupId);
  if (!group.success) return;
  revalidatePath(`/groups/${group.data}`, "layout");
  const tx = txHash.safeParse(hash);
  if (tx.success) after(() => tellAboutCover(user.id, group.data, tx.data as `0x${string}`));
}
