import "server-only";
import { and, eq, gt, isNull } from "drizzle-orm";
import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { db } from "@/lib/db";
import { duesAutopay } from "@/lib/db/schema";
import { CONTRACTS } from "@/lib/chain/addresses";
import { erc20Abi, HELPER_POWER, jfkDuesAbi, jfkHelperAbi, jfkModuleAbi, safeAbi } from "@/lib/chain/abis";
import { publicClient } from "@/lib/chain/client";
import { relayer } from "@/lib/chain/relayer";
import { Money } from "@/lib/money";
import { everyText } from "@/lib/schedule-text";
import { recordAudit } from "@/modules/audit/service";
import { cyclePeriodFor } from "@/modules/contributions/schedule";
import { getGroupDetail, listMembers } from "./service";

/**
 * Automatic dues: Rallied collects a member's contribution on each due date,
 * or when their AI asks, without a wallet popup each time.
 *
 * Setting it up is the member's one wallet confirm per group: name Rallied's
 * key as their helper with only the collect power, until an end date at most
 * a year away, and approve that year's dues. The contract then lets that key
 * take exactly the group's amount, from that member, into that group's
 * vault, at most once per period. Nothing else: it can't spend, vote, or
 * send money anywhere but the vault.
 *
 * Stopping is Rallied's promise (a row in dues_autopay), so it works at once
 * from Claude. Removing the permission from Base itself is another confirm
 * (prepareRemoval), offered as a link.
 */

const DAY_S = 86_400;
/** A year, inside the contract's 366-day helper limit. */
const LIFETIME_S = 365 * DAY_S;
const LAGOS_DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Lagos" });
const usdc = (minor: bigint) => Money.fromMinor(minor, "USDC").format();

/** How many dues fall in a year, so the approval covers the whole permission. */
function periodsInAYear(cadence: "WEEKLY" | "MONTHLY", intervalWeeks: number): number {
  return cadence === "MONTHLY" ? 12 : Math.ceil(52 / Math.min(Math.max(intervalWeeks, 1), 3));
}

interface Context {
  safe: Address;
  wallet: Address;
  helperKey: Address;
  group: NonNullable<Awaited<ReturnType<typeof getGroupDetail>>>;
}

type ContextResult = { ok: true; context: Context } | { ok: false; reason: string };

/** The member, their wallet, the group's vault and Rallied's helper key, or why there isn't one. */
async function contextFor(userId: string, groupId: string): Promise<ContextResult> {
  const [group, members] = await Promise.all([getGroupDetail(groupId, userId), listMembers(groupId, userId)]);
  if (!group || !members) return { ok: false, reason: "You're not in that group." };
  if (!group.safeAddress) return { ok: false, reason: "This group isn't on Base yet. Start it on Base first." };
  const wallet = members.find((m) => m.userId === userId)?.walletAddress;
  if (!wallet) return { ok: false, reason: "Your account has no wallet. Sign in with your wallet first." };
  const key = relayer();
  if (!key) return { ok: false, reason: "Rallied can't collect dues right now. Pay in the group's #about instead." };
  return { ok: true, context: { safe: getAddress(group.safeAddress), wallet: getAddress(wallet), helperKey: key.account.address, group } };
}

/** Is Rallied's key this member's live helper with the collect power, on Base? */
async function helperOnBase(context: Context): Promise<{ live: boolean; expiresAt: bigint }> {
  const helper = await publicClient().readContract({
    address: CONTRACTS.jfkModule,
    abi: jfkHelperAbi,
    functionName: "getHelper",
    args: [context.safe, context.wallet],
  });
  const now = BigInt(Math.floor(Date.now() / 1000));
  const live =
    helper.key.toLowerCase() === context.helperKey.toLowerCase() && (helper.powers & HELPER_POWER.COLLECT) !== 0 && helper.expiresAt > now;
  return { live, expiresAt: helper.expiresAt };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type AutopayStatus =
  | { on: true; until: string; lastCollected: string | null; problem: string | null }
  | { on: false; why: "never_set_up" | "stopped" | "ended" | "removed_from_base" };

export async function autopayStatus(userId: string, groupId: string): Promise<AutopayStatus | null> {
  const found = await contextFor(userId, groupId);
  if (!found.ok) return null;
  const [row] = await db
    .select()
    .from(duesAutopay)
    .where(and(eq(duesAutopay.groupId, groupId), eq(duesAutopay.userId, userId)))
    .limit(1);
  if (!row) return { on: false, why: "never_set_up" };
  if (row.stoppedAt) return { on: false, why: "stopped" };
  if (row.endsAt.getTime() <= Date.now()) return { on: false, why: "ended" };
  const { live } = await helperOnBase(found.context);
  if (!live) return { on: false, why: "removed_from_base" };
  return {
    on: true,
    until: LAGOS_DAY.format(row.endsAt),
    lastCollected: row.lastCollectedAt ? LAGOS_DAY.format(row.lastCollectedAt) : null,
    problem: row.lastProblem,
  };
}

// ---------------------------------------------------------------------------
// Setting it up: the member's one wallet confirm
// ---------------------------------------------------------------------------

export type PreparedAutopay =
  | {
      ok: true;
      calls: { to: Address; data: Hex }[];
      wallet: Address;
      /** For the confirm page: "$1.00 every month, until 18 November 2027". */
      summary: { amount: string; every: string; until: string; groupName: string; approved: string };
    }
  | { ok: false; reason: string };

export async function prepareAutopay(userId: string, groupId: string): Promise<PreparedAutopay> {
  const found = await contextFor(userId, groupId);
  if (!found.ok) return found;
  const { safe, wallet, helperKey, group } = found.context;

  const client = publicClient();
  const [isOwner, chainGroup] = await Promise.all([
    client.readContract({ address: safe, abi: safeAbi, functionName: "isOwner", args: [wallet] }),
    client.readContract({ address: CONTRACTS.jfkModule, abi: jfkModuleAbi, functionName: "getGroup", args: [safe] }),
  ]);
  if (!isOwner) return { ok: false, reason: "The wallet you're signed in with isn't one of this group's owners on Base." };
  const [, contribution, , , closed] = chainGroup;
  if (closed) return { ok: false, reason: "This group has closed." };

  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + LIFETIME_S);
  const periods = periodsInAYear(group.cadence, group.intervalWeeks);
  const allowance = contribution * BigInt(periods);

  return {
    ok: true,
    wallet,
    calls: [
      {
        to: CONTRACTS.jfkModule,
        data: encodeFunctionData({ abi: jfkHelperAbi, functionName: "setHelper", args: [safe, helperKey, HELPER_POWER.COLLECT, expiresAt] }),
      },
      // A year of dues, at most. The contract still takes only the group's amount, once a period.
      { to: CONTRACTS.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [CONTRACTS.jfkModule, allowance] }) },
    ],
    summary: {
      amount: usdc(contribution),
      every: everyText(group.cadence, group.intervalWeeks),
      until: LAGOS_DAY.format(new Date(Number(expiresAt) * 1000)),
      groupName: group.name,
      approved: usdc(allowance),
    },
  };
}

/** After the member's wallet sent it: check Base for the permission, then remember it. */
export async function confirmAutopay(userId: string, groupId: string, txHash: Hex): Promise<{ ok: true } | { ok: false; reason: string }> {
  const found = await contextFor(userId, groupId);
  if (!found.ok) return found;
  const receipt = await publicClient().waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
  if (receipt.status !== "success") return { ok: false, reason: "It didn't go through on Base. Nothing was set up." };

  const { live, expiresAt } = await helperOnBase(found.context);
  if (!live) return { ok: false, reason: "Base doesn't show Rallied as your helper in this group, so nothing was set up." };

  const endsAt = new Date(Number(expiresAt) * 1000);
  await db.transaction(async (tx) => {
    await tx
      .insert(duesAutopay)
      .values({ groupId, userId, setUpTx: txHash, endsAt })
      .onConflictDoUpdate({
        target: [duesAutopay.groupId, duesAutopay.userId],
        set: { setUpTx: txHash, endsAt, stoppedAt: null, lastProblem: null, updatedAt: new Date() },
      });
    await recordAudit(tx, {
      action: "group.settings.updated",
      actorId: userId,
      groupId,
      subjectType: "group",
      subjectId: groupId,
      after: { autopay: "on", helper: found.context.helperKey, until: endsAt.toISOString(), txHash },
    });
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Stopping
// ---------------------------------------------------------------------------

/** Rallied stops collecting at once. The permission on Base stays until removed or it ends. */
export async function stopAutopay(userId: string, groupId: string): Promise<{ ok: true; wasOn: boolean } | { ok: false; reason: string }> {
  const found = await contextFor(userId, groupId);
  if (!found.ok) return found;
  const stopped = await db
    .update(duesAutopay)
    .set({ stoppedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(duesAutopay.groupId, groupId), eq(duesAutopay.userId, userId), isNull(duesAutopay.stoppedAt)))
    .returning({ id: duesAutopay.id });
  if (stopped.length > 0) {
    await recordAudit(db, {
      action: "group.settings.updated",
      actorId: userId,
      groupId,
      subjectType: "group",
      subjectId: groupId,
      after: { autopay: "stopped" },
    });
  }
  return { ok: true, wasOn: stopped.length > 0 };
}

/** Removing the permission from Base too: take the helper away and set the approval to zero. */
export async function prepareRemoval(
  userId: string,
  groupId: string,
): Promise<{ ok: true; calls: { to: Address; data: Hex }[]; wallet: Address; groupName: string } | { ok: false; reason: string }> {
  const found = await contextFor(userId, groupId);
  if (!found.ok) return found;
  const { safe, wallet, group } = found.context;
  const helper = await publicClient().readContract({ address: CONTRACTS.jfkModule, abi: jfkHelperAbi, functionName: "getHelper", args: [safe, wallet] });

  const calls: { to: Address; data: Hex }[] = [];
  if (helper.key !== "0x0000000000000000000000000000000000000000") {
    calls.push({ to: CONTRACTS.jfkModule, data: encodeFunctionData({ abi: jfkHelperAbi, functionName: "revokeHelper", args: [safe] }) });
  }
  calls.push({ to: CONTRACTS.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [CONTRACTS.jfkModule, 0n] }) });
  return { ok: true, calls, wallet, groupName: group.name };
}

// ---------------------------------------------------------------------------
// Collecting
// ---------------------------------------------------------------------------

export type CollectResult =
  | { ok: true; amount: string; txHash: Hex }
  | {
      ok: false;
      reason: "not_found" | "not_set_up" | "stopped" | "ended" | "removed_from_base" | "already_paid" | "not_due_yet" | "short" | "allowance_used_up" | "failed";
      /** Plain words for the member or their AI. */
      text: string;
    };

/**
 * Collect one member's dues now. `when`:
 *  - "asked": the member (or their AI) asked; collect if the contract allows
 *    it (their last payment is at least the group's gap ago).
 *  - "schedule": the daily run; collect only once this period's due date has
 *    come and they haven't paid since it started.
 */
export async function collectDues(userId: string, groupId: string, when: "asked" | "schedule"): Promise<CollectResult> {
  const found = await contextFor(userId, groupId);
  if (!found.ok) return { ok: false, reason: "not_found", text: found.reason };
  const { safe, wallet, group } = found.context;

  const [row] = await db
    .select()
    .from(duesAutopay)
    .where(and(eq(duesAutopay.groupId, groupId), eq(duesAutopay.userId, userId)))
    .limit(1);
  if (!row) return { ok: false, reason: "not_set_up", text: "Automatic dues aren't set up for you in this group." };
  if (row.stoppedAt) return { ok: false, reason: "stopped", text: "You stopped automatic dues in this group." };
  if (row.endsAt.getTime() <= Date.now()) return { ok: false, reason: "ended", text: "Your automatic dues permission in this group has ended. Set it up again to continue." };

  const client = publicClient();
  const jfk = { address: CONTRACTS.jfkModule } as const;
  const [{ live }, chainGroup, settings, last, balance, allowance] = await Promise.all([
    helperOnBase(found.context),
    client.readContract({ ...jfk, abi: jfkModuleAbi, functionName: "getGroup", args: [safe] }),
    client.readContract({ ...jfk, abi: jfkModuleAbi, functionName: "getGroupSettings", args: [safe] }),
    client.readContract({ ...jfk, abi: jfkDuesAbi, functionName: "lastPaidAt", args: [safe, wallet] }),
    client.readContract({ address: CONTRACTS.usdc, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }),
    client.readContract({ address: CONTRACTS.usdc, abi: erc20Abi, functionName: "allowance", args: [wallet, CONTRACTS.jfkModule] }),
  ]);
  if (!live) return { ok: false, reason: "removed_from_base", text: "Rallied is no longer your helper on Base in this group, so it can't collect." };

  const contribution = chainGroup[1];
  const payGap = BigInt(settings[1]);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const lastPaid = last === 0n ? null : new Date(Number(last) * 1000);

  if (last !== 0n && now < last + payGap) {
    return { ok: false, reason: "already_paid", text: `Already paid for this period, on ${LAGOS_DAY.format(lastPaid as Date)}.` };
  }
  if (when === "schedule") {
    const period = cyclePeriodFor(new Date(), { cadence: group.cadence, dueDay: group.dueDay, graceDays: 0, intervalWeeks: group.intervalWeeks });
    if (lastPaid && lastPaid >= period.periodStart) {
      return { ok: false, reason: "already_paid", text: `Already paid for this period, on ${LAGOS_DAY.format(lastPaid)}.` };
    }
    if (period.dueAt.getTime() > Date.now()) return { ok: false, reason: "not_due_yet", text: "Not due yet." };
  }
  if (balance < contribution) {
    return await problem(row.id, "short", `Your wallet has ${usdc(balance)} and the dues are ${usdc(contribution)}. Add USDC to your wallet and it'll be collected next time.`);
  }
  if (allowance < contribution) {
    return await problem(row.id, "allowance_used_up", "The amount you approved has been used up (or the group's dues went up). Set up automatic dues again to approve more.");
  }

  const key = relayer();
  if (!key) return { ok: false, reason: "failed", text: "Rallied can't collect right now. Try again later, or pay in #about." };
  try {
    const txHash = await key.writeContract({ ...jfk, abi: jfkHelperAbi, functionName: "collect", args: [safe, wallet] });
    const receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
    if (receipt.status !== "success") return await problem(row.id, "failed", "Base refused the collection. Nothing was taken.");
    await db.transaction(async (tx) => {
      await tx.update(duesAutopay).set({ lastCollectedAt: new Date(), lastProblem: null, updatedAt: new Date() }).where(eq(duesAutopay.id, row.id));
      await recordAudit(tx, {
        action: "contribution.paid",
        actorId: userId,
        groupId,
        subjectType: "group",
        subjectId: groupId,
        after: { collectedBy: "rallied", when, amount: contribution.toString(), txHash },
      });
    });
    return { ok: true, amount: usdc(contribution), txHash };
  } catch (cause) {
    console.error("[autopay] collect failed", cause);
    return await problem(row.id, "failed", "Couldn't collect just now. Nothing was taken; it'll be tried again.");
  }
}

async function problem(id: string, reason: "short" | "allowance_used_up" | "failed", text: string): Promise<CollectResult> {
  await db.update(duesAutopay).set({ lastProblem: text, updatedAt: new Date() }).where(eq(duesAutopay.id, id));
  return { ok: false, reason, text };
}

/** The daily run: everyone with automatic dues on, one at a time. */
export async function runScheduledCollections(): Promise<{ tried: number; collected: number; results: { groupId: string; result: CollectResult["ok"] | string }[] }> {
  const rows = await db
    .select({ groupId: duesAutopay.groupId, userId: duesAutopay.userId })
    .from(duesAutopay)
    .where(and(isNull(duesAutopay.stoppedAt), gt(duesAutopay.endsAt, new Date())));
  const results: { groupId: string; result: true | string }[] = [];
  for (const row of rows) {
    const result = await collectDues(row.userId, row.groupId, "schedule");
    results.push({ groupId: row.groupId, result: result.ok ? true : result.reason });
  }
  return { tried: rows.length, collected: results.filter((r) => r.result === true).length, results };
}
