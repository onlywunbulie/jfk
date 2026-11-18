"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { chainActionLimit } from "@/lib/rate-limit";
import { carryOut, prepareVote } from "@/modules/groups/onchain-votes";

/**
 * Voting on Base. The member's own wallet casts the vote (prepareVoteAction
 * hands it the exact call); once a vote has passed, Rallied carries it out
 * (carryOutAction). Both re-check everything on the chain, never trusting
 * what the screen showed.
 */

const ids = z.object({
  groupId: z.string().min(1).max(64),
  proposalId: z.string().regex(/^\d{1,10}$/),
});
const choice = z.enum(["YES", "NO", "ABSTAIN"]);

export async function prepareVoteAction(
  groupId: string,
  proposalId: string,
  vote: string,
): Promise<{ ok: true; call: { to: `0x${string}`; data: `0x${string}` }; wallet: string } | { ok: false; error: string }> {
  const user = await requireUser();
  const slow = await chainActionLimit(user.id);
  if (slow) return { ok: false, error: slow };
  const parsed = ids.safeParse({ groupId, proposalId });
  const parsedChoice = choice.safeParse(vote);
  if (!parsed.success || !parsedChoice.success) return { ok: false, error: "That didn't work. Try again." };
  const prepared = await prepareVote(user.id, parsed.data.groupId, parsed.data.proposalId, parsedChoice.data);
  if (!prepared.ok) return { ok: false, error: prepared.reason };
  return { ok: true, call: prepared.call, wallet: prepared.wallet };
}

const CARRY_OUT_ERRORS = {
  not_found: "That vote isn't on this group.",
  not_passed: "This vote hasn't passed, so it can't be carried out.",
  already_done: "This one has already been carried out.",
  no_relayer: "Rallied can't carry out votes right now. Try again later.",
  failed: "Base didn't accept it. Nothing changed; try again.",
} as const;

export async function carryOutAction(groupId: string, proposalId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireUser();
  const slow = await chainActionLimit(user.id);
  if (slow) return { ok: false, error: slow };
  const parsed = ids.safeParse({ groupId, proposalId });
  if (!parsed.success) return { ok: false, error: "That didn't work. Try again." };
  const result = await carryOut(user.id, parsed.data.groupId, parsed.data.proposalId);
  if (!result.ok) {
    // Someone else (or an earlier tap) already did it: that's the outcome they wanted.
    if (result.reason === "already_done") return { ok: true };
    return { ok: false, error: CARRY_OUT_ERRORS[result.reason] };
  }
  revalidatePath("/", "layout");
  return { ok: true };
}
