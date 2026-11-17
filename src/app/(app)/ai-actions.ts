"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { revokeAllForUser } from "@/modules/agents/oauth";
import { setAiInGroup } from "@/modules/agents/connection";
import { discardDraft } from "@/modules/agents/drafts";
import { confirmProposal, prepareProposal } from "@/modules/agents/send";

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

const draftId = z.string().min(1).max(64);

/** Throw away one of the user's own drafts. */
export async function discardDraftAction(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireUser();
  const parsed = draftId.safeParse(id);
  if (!parsed.success) return { ok: false, error: "That didn't work. Try again." };
  const result = await discardDraft(user.id, parsed.data);
  if (!result.ok) return { ok: false, error: "That draft is already gone." };
  revalidatePath("/", "layout");
  return { ok: true };
}

/**
 * Step 1 of sending a draft to a vote: the exact call for the member's wallet
 * to sign, after checking it's their waiting draft and they can send it.
 */
export async function prepareSendAction(
  id: string,
): Promise<{ ok: true; call: { to: `0x${string}`; data: `0x${string}` }; wallet: string } | { ok: false; error: string }> {
  const user = await requireUser();
  const parsed = draftId.safeParse(id);
  if (!parsed.success) return { ok: false, error: "That didn't work. Try again." };
  const prepared = await prepareProposal(user.id, parsed.data);
  if (!prepared.ok) return { ok: false, error: prepared.reason };
  return { ok: true, call: prepared.call, wallet: prepared.wallet };
}

const txHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

/** Step 2: the wallet sent it; check Base for the proposal and mark the draft sent. */
export async function confirmSentAction(id: string, hash: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireUser();
  const parsedId = draftId.safeParse(id);
  const parsedHash = txHash.safeParse(hash);
  if (!parsedId.success || !parsedHash.success) return { ok: false, error: "That didn't work. Try again." };
  const confirmed = await confirmProposal(user.id, parsedId.data, parsedHash.data as `0x${string}`);
  if (!confirmed.ok) return { ok: false, error: confirmed.reason };
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
