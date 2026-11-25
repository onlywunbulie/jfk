import "server-only";
import { getAddress, type Address } from "viem";
import { CONTRACTS } from "@/lib/chain/addresses";
import { erc20Abi, jfkModuleAbi, jfkRotationAbi } from "@/lib/chain/abis";
import { publicClient } from "@/lib/chain/client";
import { moduleFor } from "@/lib/chain/module";
import { Money } from "@/lib/money";

/**
 * What the app's frame shows for each group on Base: the vault's balance and
 * how many open votes are waiting for this user. Read from Base, never from
 * the old off-chain records (which know nothing about votes on Base).
 *
 * Cheap enough for every page load: one batched read per group (the vault,
 * the proposal count), then one for the most recent proposals, all groups in
 * parallel. A group Base can't answer for just shows nothing, never an error.
 */

/** Only recent proposals can still be open: votes last days, not months. */
const RECENT = 10;
const OPEN = 1;

export interface ChainSummary {
  /** "$12.00" */
  vault: string;
  votesWaiting: number;
  /**
   * A rotating group (contract v3): this round instead of a balance, since the
   * vault empties every turn and "$0.00" would look like something's wrong.
   */
  round?: RoundSummary;
}

export interface RoundSummary {
  /** "$3.00": paid in so far this round. */
  paidIn: string;
  /** "$5.00": the whole turn, when everyone has paid. */
  fullPot: string;
  /** Who collects next, as a wallet (the caller names them). */
  nextWallet: Address | null;
  nextPayoutAt: Date;
}

export async function chainSummaries(
  groups: { id: string; safeAddress: string | null; type?: "ROTATING" | "TREASURY" }[],
  wallet: string | null,
): Promise<Map<string, ChainSummary>> {
  const onBase = groups.filter((group) => group.safeAddress);
  const summaries = new Map<string, ChainSummary>();
  if (onBase.length === 0) return summaries;

  const results = await Promise.all(
    onBase.map(async (group) => {
      try {
        return [group.id, await summarise(getAddress(group.safeAddress as string), wallet ? getAddress(wallet) : null, group.type === "ROTATING")] as const;
      } catch (cause) {
        console.error("[summary] couldn't read Base for a group", cause);
        return null;
      }
    }),
  );
  for (const result of results) if (result) summaries.set(result[0], result[1]);
  return summaries;
}

async function summarise(safe: Address, me: Address | null, rotating: boolean): Promise<ChainSummary> {
  const client = publicClient();
  const contract = await moduleFor(safe);
  if (!contract) throw new Error("This vault doesn't run on a contract Rallied reads");
  const jfk = { address: contract.address, abi: jfkModuleAbi } as const;
  const [group, vault] = await client.multicall({
    allowFailure: false,
    contracts: [
      { ...jfk, functionName: "getGroup", args: [safe] },
      { address: CONTRACTS.usdc, abi: erc20Abi, functionName: "balanceOf", args: [safe] },
    ],
  });
  const count = Number(group[6]);
  const ids = Array.from({ length: Math.min(count, RECENT) }, (_, i) => BigInt(count - i));

  let votesWaiting = 0;
  if (me && ids.length > 0) {
    const reads = await client.multicall({
      allowFailure: false,
      contracts: ids.flatMap((id) => [
        { ...jfk, functionName: "getProposal", args: [safe, id] } as const,
        { ...jfk, functionName: "eligibleVoter", args: [safe, id, me] } as const,
        { ...jfk, functionName: "voteOf", args: [safe, id, me] } as const,
      ]),
    });
    const now = BigInt(Math.floor(Date.now() / 1000));
    for (let i = 0; i < ids.length; i++) {
      const proposal = reads[i * 3] as { status: number; deadline: bigint };
      const eligible = reads[i * 3 + 1] as boolean;
      const voted = reads[i * 3 + 2] as number;
      if (proposal.status === OPEN && proposal.deadline > now && eligible && voted === 0) votesWaiting++;
    }
  }

  // The round is extra: if Base can't say, the frame still shows the vault and the votes.
  const round =
    rotating && contract.version === 3
      ? await readRound(contract.address, safe, group[1]).catch((cause) => {
          console.error("[summary] couldn't read the round", cause);
          return undefined;
        })
      : undefined;
  return { vault: Money.fromMinor(vault, "USDC").format(), votesWaiting, ...(round ? { round } : {}) };
}

async function readRound(module: Address, safe: Address, contribution: bigint): Promise<RoundSummary | undefined> {
  const jfk = { address: module, abi: jfkRotationAbi } as const;
  const [rotation, orders] = await publicClient().multicall({
    allowFailure: false,
    contracts: [
      { ...jfk, functionName: "getRotation", args: [safe] },
      { ...jfk, functionName: "getOrder", args: [safe] },
    ],
  });
  const [on, , , turn, nextPayoutAt, , , roundPot] = rotation;
  if (!on) return undefined;
  const [order] = orders;
  return {
    paidIn: Money.fromMinor(roundPot, "USDC").format(),
    fullPot: Money.fromMinor(contribution * BigInt(order.length), "USDC").format(),
    nextWallet: order[Number(turn)] ?? null,
    nextPayoutAt: new Date(Number(nextPayoutAt) * 1000),
  };
}
