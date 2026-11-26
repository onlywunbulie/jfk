import "server-only";
import { and, eq, isNotNull, ne } from "drizzle-orm";
import { decodeEventLog, encodeEventTopics, encodeFunctionData, getAddress, pad, erc20Abi as standardErc20Abi, type Address, type Hex } from "viem";
import { CONTRACTS, HISTORY_API_URL, isRalliedModule } from "@/lib/chain/addresses";
import { Money } from "@/lib/money";
import { getGroupDetail, listMembers } from "./service";
import { db } from "@/lib/db";
import { groupMembers, groups, users } from "@/lib/db/schema";
import { HELPER_POWER, erc20Abi, jfkHelperAbi, jfkModuleAbi, jfkRotationAbi } from "@/lib/chain/abis";
import { publicClient } from "@/lib/chain/client";
import { moduleFor } from "@/lib/chain/module";
import { relayer } from "@/lib/chain/relayer";
import { isRalliedHelper } from "@/lib/chain/helper-key";
import { recordAudit } from "@/modules/audit/service";

/**
 * Paying out rotating groups' turns on Base, from Rallied's daily job.
 *
 * Rallied only triggers the payout: the contract decides whether it's due
 * (every member paid and the date reached, or the grace period over) and
 * sends the pot to the member whose turn it is, and nobody else. Rallied
 * asks the contract first (a simulation), so a turn that isn't due yet
 * costs nothing and is simply tried again tomorrow.
 */

export type TurnOutcome = "paid" | "not_due" | "waiting_for_late_payers" | "not_rotating" | "failed";

export interface TurnPayoutRun {
  tried: number;
  paid: number;
  results: { groupId: string; result: TurnOutcome }[];
}

export async function runTurnPayouts(now: Date = new Date()): Promise<TurnPayoutRun> {
  const results: TurnPayoutRun["results"] = [];
  let paid = 0;
  if (!relayer()) return { tried: 0, paid, results };

  const rows = await db
    .select({ id: groups.id, safeAddress: groups.safeAddress })
    .from(groups)
    .where(and(eq(groups.type, "ROTATING"), eq(groups.status, "ACTIVE"), isNotNull(groups.safeAddress)));

  for (const row of rows) {
    const result = await payTurnFor(getAddress(row.safeAddress as string), row.id, now);
    if (result === "paid") paid++;
    results.push({ groupId: row.id, result });
  }
  return { tried: rows.length, paid, results };
}

async function payTurnFor(safe: Address, groupId: string, now: Date): Promise<TurnOutcome> {
  const wallet = relayer();
  if (!wallet) return "failed";
  const client = publicClient();
  try {
    const contract = await moduleFor(safe);
    if (!contract || contract.version < 3) return "not_rotating";
    const [on, , , , nextPayoutAt] = await client.readContract({
      address: contract.address,
      abi: jfkRotationAbi,
      functionName: "getRotation",
      args: [safe],
    });
    if (!on) return "not_rotating";
    if (BigInt(Math.floor(now.getTime() / 1000)) < nextPayoutAt) return "not_due";

    // Due by date. Whether it pays now or waits for late payers is the contract's call.
    try {
      await client.simulateContract({
        account: wallet.account,
        address: contract.address,
        abi: jfkRotationAbi,
        functionName: "payTurn",
        args: [safe],
      });
    } catch {
      return "waiting_for_late_payers";
    }

    const txHash: Hex = await wallet.writeContract({
      address: contract.address,
      abi: jfkRotationAbi,
      functionName: "payTurn",
      args: [safe],
    });
    const receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
    if (receipt.status !== "success") return "failed";

    await recordAudit(db, {
      action: "rotation.turn_paid",
      groupId,
      subjectType: "group",
      subjectId: groupId,
      after: { safe, txHash },
    });
    return "paid";
  } catch (cause) {
    console.error("[rotation] paying a turn failed", cause);
    return "failed";
  }
}

// ---------------------------------------------------------------------------
// Reading a rotation, for #payout order
// ---------------------------------------------------------------------------

export interface RotationSeat {
  wallet: Address;
  userId: string | null;
  name: string;
  paidThisRound: boolean;
  collected: boolean;
  leaving: boolean;
  /** What they owe, in USDC base units. */
  debt: bigint;
  /** Rallied's key is their live helper with the collect power: their dues are paid automatically. */
  autoDues: boolean;
}

export type ChainRotation =
  | {
      ok: true;
      cycle: number;
      /** Which seat collects next (an index into `order`). */
      turn: number;
      /** The earliest the next payout can happen, if everyone has paid. */
      nextPayoutAt: Date;
      contribution: bigint;
      roundPot: bigint;
      order: RotationSeat[];
      joining: RotationSeat[];
      /** The most recent turn paid out, if any: stays visible after a cycle rolls over. */
      lastPayout: LastPayout | null;
    }
  | { ok: false; reason: "not_on_base" | "not_rotating" | "unreachable" };

export interface LastPayout {
  wallet: Address;
  name: string;
  userId: string | null;
  round: number;
  paid: bigint;
  at: Date;
}

/**
 * The latest TurnPaid for this vault, from the history API (Base's own node
 * only searches a few hundred blocks back). Null if none, or if it can't be read:
 * it's a nicety, never a reason for the screen to fail.
 */
async function lastPayoutFor(
  module: Address,
  safe: Address,
  nameOf: (wallet: Address) => { name: string; userId: string | null },
): Promise<LastPayout | null> {
  try {
    const [topic0] = encodeEventTopics({ abi: jfkRotationAbi, eventName: "TurnPaid" });
    const url = new URL(HISTORY_API_URL);
    url.search = new URLSearchParams({
      module: "logs",
      action: "getLogs",
      address: module,
      topic0: topic0 as string,
      topic1: pad(safe),
      topic0_1_opr: "and",
      fromBlock: "0",
      toBlock: "latest",
    }).toString();
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8_000) });
    const body = (await response.json()) as { result?: { data: Hex; topics: (Hex | null)[]; timeStamp: Hex }[] | string };
    const logs = Array.isArray(body.result) ? body.result : [];
    const latest = logs.at(-1);
    if (!latest) return null;
    const event = decodeEventLog({ abi: jfkRotationAbi, data: latest.data, topics: latest.topics.filter(Boolean) as [Hex, ...Hex[]] });
    if (event.eventName !== "TurnPaid") return null;
    return {
      wallet: event.args.holder,
      ...nameOf(event.args.holder),
      round: Number(event.args.round),
      paid: event.args.paid,
      at: new Date(Number(BigInt(latest.timeStamp)) * 1000),
    };
  } catch {
    return null;
  }
}

/** A rotating group's state as Base has it: the order, this round, and who owes what. */
export async function readRotation(
  safeAddress: string | null,
  members: { userId: string; displayName: string; walletAddress: string | null }[],
): Promise<ChainRotation> {
  if (!safeAddress) return { ok: false, reason: "not_on_base" };
  const safe = getAddress(safeAddress);
  const client = publicClient();
  try {
    const contract = await moduleFor(safe);
    if (!contract || contract.version < 3) return { ok: false, reason: "not_rotating" };
    const jfk = { address: contract.address, abi: jfkRotationAbi } as const;
    const [rotation, orders, group] = await Promise.all([
      client.readContract({ ...jfk, functionName: "getRotation", args: [safe] }),
      client.readContract({ ...jfk, functionName: "getOrder", args: [safe] }),
      client.readContract({ address: contract.address, abi: jfkModuleAbi, functionName: "getGroup", args: [safe] }),
    ]);
    const [on, cycle, , turn, nextPayoutAt, , , roundPot] = rotation;
    if (!on) return { ok: false, reason: "not_rotating" };
    const [order, joining] = orders;

    const everyone = [...order, ...joining];
    const reads = await client.multicall({
      allowFailure: false,
      contracts: everyone.flatMap((wallet) => [
        { ...jfk, functionName: "rotationStatus", args: [safe, wallet] } as const,
        { ...jfk, functionName: "debtOf", args: [safe, wallet] } as const,
        { address: contract.address, abi: jfkHelperAbi, functionName: "getHelper", args: [safe, wallet] } as const,
      ]),
    });
    const now = BigInt(Math.floor(Date.now() / 1000));
    const byWallet = new Map(members.filter((m) => m.walletAddress).map((m) => [(m.walletAddress as string).toLowerCase(), m]));
    const seat = (wallet: Address, i: number): RotationSeat => {
      const [, paidThisRound, collected, leaving] = reads[i * 3] as readonly [boolean, boolean, boolean, boolean];
      const helper = reads[i * 3 + 2] as { key: string; powers: number; expiresAt: bigint };
      const member = byWallet.get(wallet.toLowerCase());
      return {
        wallet,
        userId: member?.userId ?? null,
        name: member?.displayName ?? wallet,
        paidThisRound,
        collected,
        leaving,
        debt: reads[i * 3 + 1] as bigint,
        autoDues: isRalliedHelper(helper.key) && (helper.powers & HELPER_POWER.COLLECT) !== 0 && helper.expiresAt > now,
      };
    };
    const lastPayout = await lastPayoutFor(contract.address, safe, (wallet) => {
      const member = byWallet.get(wallet.toLowerCase());
      return { name: member?.displayName ?? wallet, userId: member?.userId ?? null };
    });
    return {
      ok: true,
      lastPayout,
      cycle: Number(cycle),
      turn: Number(turn),
      nextPayoutAt: new Date(Number(nextPayoutAt) * 1000),
      contribution: group[1],
      roundPot,
      order: order.map((wallet, i) => seat(wallet, i)),
      joining: joining.map((wallet, i) => seat(wallet, order.length + i)),
    };
  } catch (cause) {
    console.error("[rotation] couldn't read Base", cause);
    return { ok: false, reason: "unreachable" };
  }
}

// ---------------------------------------------------------------------------
// Covering someone's debt
// ---------------------------------------------------------------------------

export type PreparedCover =
  | {
      ok: true;
      calls: { to: Address; data: Hex }[];
      wallet: Address;
      /** "$100.00" */
      amount: string;
      debtorName: string;
      groupName: string;
      self: boolean;
    }
  | { ok: false; reason: string };

/**
 * Pay off a member's debt in a rotating group from the user's own wallet:
 * the whole amount they owe on Base, straight on to whoever they shorted.
 * The user confirms in their wallet; nothing moves without that.
 */
export async function prepareCoverDebt(userId: string, groupId: string, memberId: string): Promise<PreparedCover> {
  const [group, members] = await Promise.all([getGroupDetail(groupId, userId), listMembers(groupId, userId)]);
  if (!group || !members) return { ok: false, reason: "You're not in that group." };
  const me = members.find((m) => m.userId === userId);
  if (!me?.walletAddress) return { ok: false, reason: "Your account has no wallet. Sign in with your wallet first." };
  const debtor = members.find((m) => m.memberId === memberId);
  if (!debtor?.walletAddress) return { ok: false, reason: "That person isn't in this group, or has no wallet on Base." };

  const chain = await readRotation(group.safeAddress, members);
  if (!chain.ok) {
    return {
      ok: false,
      reason: chain.reason === "unreachable" ? "Couldn't reach Base just now. Try again in a moment." : "This group has no debts on Base to cover.",
    };
  }
  const seat = [...chain.order, ...chain.joining].find((s) => s.wallet.toLowerCase() === debtor.walletAddress!.toLowerCase());
  const debt = seat?.debt ?? 0n;
  if (debt === 0n) return { ok: false, reason: `${debtor.displayName} doesn't owe anything in ${group.name}.` };

  const safe = getAddress(group.safeAddress as string);
  const payer = getAddress(me.walletAddress);
  const contract = await moduleFor(safe);
  if (!contract) return { ok: false, reason: "This group has no debts on Base to cover." };
  const client = publicClient();
  const [balance, allowance] = await Promise.all([
    client.readContract({ address: CONTRACTS.usdc, abi: erc20Abi, functionName: "balanceOf", args: [payer] }),
    client.readContract({ address: CONTRACTS.usdc, abi: erc20Abi, functionName: "allowance", args: [payer, contract.address] }),
  ]);
  const amount = Money.fromMinor(debt, "USDC").format();
  if (balance < debt) {
    return { ok: false, reason: `Your wallet has ${Money.fromMinor(balance, "USDC").format()} and covering this takes ${amount}.` };
  }

  const calls: { to: Address; data: Hex }[] = [];
  if (allowance < debt) {
    calls.push({ to: CONTRACTS.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [contract.address, debt] }) });
  }
  calls.push({
    to: contract.address,
    data: encodeFunctionData({ abi: jfkRotationAbi, functionName: "coverDebt", args: [safe, getAddress(debtor.walletAddress), debt] }),
  });
  return { ok: true, calls, wallet: payer, amount, debtorName: debtor.displayName, groupName: group.name, self: debtor.userId === userId };
}

export interface CoverSeen {
  debtorUserId: string;
  /** "$10.00": everything this transaction paid off for them. */
  amount: string;
  coveredBy: string;
  groupName: string;
}

/**
 * After someone covered a debt: what Base says that transaction did. Only a
 * successful transaction, sent from the user's own wallet, that paid off
 * another member's debt in this group counts, so nobody can make Rallied
 * announce a cover that didn't happen. Null otherwise.
 */
export async function readCover(userId: string, groupId: string, txHash: Hex): Promise<CoverSeen | null> {
  const [group, members] = await Promise.all([getGroupDetail(groupId, userId), listMembers(groupId, userId)]);
  const me = members?.find((m) => m.userId === userId);
  if (!group?.safeAddress || !members || !me?.walletAddress) return null;
  const client = publicClient();
  try {
    const [receipt, tx] = await Promise.all([
      client.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 }),
      client.getTransaction({ hash: txHash }),
    ]);
    if (receipt.status !== "success") return null;
    // A browser wallet sends the transaction itself; a Coinbase smart wallet goes through a bundler,
    // so for it the proof is the USDC leaving the user's own wallet in the same transaction.
    const sentByMe =
      tx.from.toLowerCase() === me.walletAddress.toLowerCase() ||
      receipt.logs.some((log) => {
        if (log.address.toLowerCase() !== CONTRACTS.usdc.toLowerCase()) return false;
        try {
          const event = decodeEventLog({ abi: standardErc20Abi, data: log.data, topics: log.topics });
          return event.eventName === "Transfer" && event.args.from.toLowerCase() === me.walletAddress!.toLowerCase();
        } catch {
          return false;
        }
      });
    if (!sentByMe) return null;

    const byWallet = new Map(members.filter((m) => m.walletAddress).map((m) => [(m.walletAddress as string).toLowerCase(), m]));
    let debtor: (typeof members)[number] | undefined;
    let total = 0n;
    for (const log of receipt.logs) {
      if (!isRalliedModule(log.address)) continue;
      try {
        const event = decodeEventLog({ abi: jfkRotationAbi, data: log.data, topics: log.topics });
        if (event.eventName !== "DebtRepaid") continue;
        const args = event.args as { safe: string; debtor: string; amount: bigint };
        if (args.safe.toLowerCase() !== group.safeAddress.toLowerCase()) continue;
        const who = byWallet.get(args.debtor.toLowerCase());
        if (!who || who.userId === userId) continue;
        debtor = who;
        total += args.amount;
      } catch {
        // Not a rotation event; keep looking.
      }
    }
    if (!debtor || total === 0n) return null;
    return { debtorUserId: debtor.userId, amount: Money.fromMinor(total, "USDC").format(), coveredBy: me.displayName, groupName: group.name };
  } catch (cause) {
    console.error("[rotation] couldn't read the cover", cause);
    return null;
  }
}

/**
 * What a wallet owes across Rallied's other rotating groups on Base, for the
 * warning on a vote to add them (with their Rallied name, since they aren't in
 * this group yet): one total, never which group, so one group's
 * business stays its own. Groups they were voted out of count too, since a
 * debt stays on record. Zero when they've never been in one, or Base can't say.
 */
export async function owedElsewhere(wallet: string, exceptGroupId: string): Promise<{ owed: bigint; name: string | null }> {
  const rows = await db
    .select({ id: groups.id, safeAddress: groups.safeAddress, name: users.displayName })
    .from(groups)
    .innerJoin(groupMembers, eq(groupMembers.groupId, groups.id))
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(and(eq(users.walletAddress, wallet.toLowerCase()), eq(groups.type, "ROTATING"), isNotNull(groups.safeAddress), ne(groups.id, exceptGroupId)));

  const debts = await Promise.all(
    [...new Map(rows.map((row) => [row.id, row.safeAddress as string])).values()].map(async (safeAddress) => {
      try {
        const safe = getAddress(safeAddress);
        const contract = await moduleFor(safe);
        if (!contract || contract.version < 3) return 0n;
        return await publicClient().readContract({ address: contract.address, abi: jfkRotationAbi, functionName: "debtOf", args: [safe, getAddress(wallet)] });
      } catch {
        return 0n;
      }
    }),
  );
  return { owed: debts.reduce((sum, debt) => sum + debt, 0n), name: rows[0]?.name ?? null };
}
