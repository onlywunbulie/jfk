import "server-only";
import { and, eq, isNotNull } from "drizzle-orm";
import { getAddress, type Address, type Hex } from "viem";
import { db } from "@/lib/db";
import { groups } from "@/lib/db/schema";
import { jfkRotationAbi } from "@/lib/chain/abis";
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
