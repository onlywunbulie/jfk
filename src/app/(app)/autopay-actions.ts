"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { chainActionLimit } from "@/lib/rate-limit";
import { confirmAutopay, prepareAutopay, prepareRemoval, stopAutopay } from "@/modules/groups/onchain-autopay";

/**
 * Automatic dues from the member's side: the exact calls for their one wallet
 * confirm, checking Base afterwards, and stopping. Every step re-checks on the
 * server who's asking and what Base says.
 */

const groupId = z.string().min(1).max(64);
const txHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
type Calls = { to: `0x${string}`; data: `0x${string}` }[];

export async function prepareAutopayAction(id: string): Promise<{ ok: true; calls: Calls; wallet: string } | { ok: false; error: string }> {
  const user = await requireUser();
  const slow = await chainActionLimit(user.id);
  if (slow) return { ok: false, error: slow };
  const parsed = groupId.safeParse(id);
  if (!parsed.success) return { ok: false, error: "That didn't work. Try again." };
  const prepared = await prepareAutopay(user.id, parsed.data);
  if (!prepared.ok) return { ok: false, error: prepared.reason };
  return { ok: true, calls: prepared.calls, wallet: prepared.wallet };
}

export async function confirmAutopayAction(id: string, hash: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireUser();
  const slow = await chainActionLimit(user.id);
  if (slow) return { ok: false, error: slow };
  const parsedId = groupId.safeParse(id);
  const parsedHash = txHash.safeParse(hash);
  if (!parsedId.success || !parsedHash.success) return { ok: false, error: "That didn't work. Try again." };
  const confirmed = await confirmAutopay(user.id, parsedId.data, parsedHash.data as `0x${string}`);
  if (!confirmed.ok) return { ok: false, error: confirmed.reason };
  revalidatePath(`/groups/${parsedId.data}`, "layout");
  return { ok: true };
}

export async function prepareRemovalAction(id: string): Promise<{ ok: true; calls: Calls; wallet: string } | { ok: false; error: string }> {
  const user = await requireUser();
  const slow = await chainActionLimit(user.id);
  if (slow) return { ok: false, error: slow };
  const parsed = groupId.safeParse(id);
  if (!parsed.success) return { ok: false, error: "That didn't work. Try again." };
  // Rallied stops first, so nothing is collected even while the wallet confirm is open.
  await stopAutopay(user.id, parsed.data);
  const prepared = await prepareRemoval(user.id, parsed.data);
  if (!prepared.ok) return { ok: false, error: prepared.reason };
  return { ok: true, calls: prepared.calls, wallet: prepared.wallet };
}

export async function stopAutopayAction(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireUser();
  const parsed = groupId.safeParse(id);
  if (!parsed.success) return { ok: false, error: "That didn't work. Try again." };
  const stopped = await stopAutopay(user.id, parsed.data);
  if (!stopped.ok) return { ok: false, error: stopped.reason };
  revalidatePath(`/groups/${parsed.data}`, "layout");
  return { ok: true };
}
