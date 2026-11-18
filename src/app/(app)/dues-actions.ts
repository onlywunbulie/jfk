"use server";

import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { chainActionLimit } from "@/lib/rate-limit";
import { prepareDues } from "@/modules/groups/onchain-dues";

/**
 * Paying dues on Base: Rallied checks the member can pay and hands their
 * wallet the exact calls (approve this period's amount, then contribute).
 * The screen re-reads Base afterwards, so nothing here records a payment.
 */

const groupId = z.string().min(1).max(64);

export async function prepareDuesAction(
  id: string,
): Promise<{ ok: true; calls: { to: `0x${string}`; data: `0x${string}` }[]; wallet: string; amount: string } | { ok: false; error: string }> {
  const user = await requireUser();
  const slow = await chainActionLimit(user.id);
  if (slow) return { ok: false, error: slow };
  const parsed = groupId.safeParse(id);
  if (!parsed.success) return { ok: false, error: "That didn't work. Try again." };
  const prepared = await prepareDues(user.id, parsed.data);
  if (!prepared.ok) return { ok: false, error: prepared.reason };
  return { ok: true, calls: prepared.calls, wallet: prepared.wallet, amount: prepared.amount };
}
