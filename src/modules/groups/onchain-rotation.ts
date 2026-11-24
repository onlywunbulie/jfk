import "server-only";
import { and, eq, isNotNull } from "drizzle-orm";
import { decodeEventLog, encodeEventTopics, getAddress, pad, type Address, type Hex } from "viem";
import { HISTORY_API_URL } from "@/lib/chain/addresses";
import { db } from "@/lib/db";
import { groups } from "@/lib/db/schema";
import { jfkModuleAbi, jfkRotationAbi } from "@/lib/chain/abis";
import { publicClient } from "@/lib/chain/client";
import { moduleFor } from "@/lib/chain/module";
import { relayer } from "@/lib/chain/relayer";
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
    if (!contract || contract.version !== 3) return "not_rotating";
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
    if (!contract || contract.version !== 3) return { ok: false, reason: "not_rotating" };
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
      ]),
    });
    const byWallet = new Map(members.filter((m) => m.walletAddress).map((m) => [(m.walletAddress as string).toLowerCase(), m]));
    const seat = (wallet: Address, i: number): RotationSeat => {
      const [, paidThisRound, collected, leaving] = reads[i * 2] as readonly [boolean, boolean, boolean, boolean];
      const member = byWallet.get(wallet.toLowerCase());
      return {
        wallet,
        userId: member?.userId ?? null,
        name: member?.displayName ?? wallet,
        paidThisRound,
        collected,
        leaving,
        debt: reads[i * 2 + 1] as bigint,
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
