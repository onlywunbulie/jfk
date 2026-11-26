"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { chainActionLimit } from "@/lib/rate-limit";
import { carryOutExit, prepareExitApproval } from "@/modules/groups/onchain-exit";

/**
 * The emergency exit. Each member approves on Base from their own wallet
 * (prepareExitApprovalAction hands it the exact call); once everyone has,
 * Rallied carries it out (carryOutExitAction). The Safe checks every
 * approval itself, so neither action can pay out anything unapproved.
 */

const groupId = z.string().min(1).max(64);

export async function prepareExitApprovalAction(
  group: string,
): Promise<{ ok: true; call: { to: `0x${string}`; data: `0x${string}` }; wallet: string } | { ok: false; error: string }> {
  const user = await requireUser();
  const slow = await chainActionLimit(user.id);
  if (slow) return { ok: false, error: slow };
  const parsed = groupId.safeParse(group);
  if (!parsed.success) return { ok: false, error: "That didn't work. Try again." };
  const prepared = await prepareExitApproval(user.id, parsed.data);
  if (!prepared.ok) return { ok: false, error: prepared.reason };
  return { ok: true, call: prepared.call, wallet: prepared.wallet };
}

/** After a wallet approved: the page reads Base again. */
export async function exitApprovedAction(group: string): Promise<void> {
  await requireUser();
  const parsed = groupId.safeParse(group);
  if (parsed.success) revalidatePath(`/groups/${parsed.data}/exit`);
}

export async function carryOutExitAction(group: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireUser();
  const slow = await chainActionLimit(user.id);
  if (slow) return { ok: false, error: slow };
  const parsed = groupId.safeParse(group);
  if (!parsed.success) return { ok: false, error: "That didn't work. Try again." };
  const result = await carryOutExit(user.id, parsed.data);
  if (!result.ok) return { ok: false, error: result.reason };
  revalidatePath("/", "layout");
  return { ok: true };
}
