import "server-only";
import { encodeFunctionData, getAddress, zeroAddress, type Address, type Hex } from "viem";
import { db } from "@/lib/db";
import { HELPER_POWER, jfkHelperAbi, jfkModuleAbi, safeAbi } from "@/lib/chain/abis";
import { publicClient } from "@/lib/chain/client";
import { moduleFor } from "@/lib/chain/module";
import { relayer } from "@/lib/chain/relayer";
import { recordAudit } from "@/modules/audit/service";
import { getGroupDetail, listMembers } from "./service";

/**
 * Voting through the user's AI. The contract lets a member name one helper
 * per group, with powers they choose; Rallied's key is that helper. With the
 * vote power, Rallied's key can cast the member's own vote (voteFor): one
 * vote, theirs, recorded on Base as cast by their helper.
 *
 * Claude may only pass on a vote the user stated in the conversation. A
 * member can always vote either here or through their AI: Rallied never lets
 * a group make it human-only (see contracts/NEXT-VERSION.md).
 *
 * Adding or removing the vote power keeps every other power: a member's
 * automatic dues keep working either way.
 */

const LIFETIME_S = 365 * 24 * 60 * 60;
const CHOICES = { yes: 1, no: 2, abstain: 3 } as const;
export type VoteChoice = keyof typeof CHOICES;

interface Context {
  safe: Address;
  module: Address;
  wallet: Address;
  helperKey: Address;
  groupName: string;
}

async function contextFor(userId: string, groupId: string): Promise<{ ok: true; context: Context } | { ok: false; reason: string }> {
  const [group, members] = await Promise.all([getGroupDetail(groupId, userId), listMembers(groupId, userId)]);
  if (!group || !members) return { ok: false, reason: "You're not in that group." };
  if (!group.safeAddress) return { ok: false, reason: "This group isn't on Base yet, so there's nothing to vote on there." };
  const wallet = members.find((m) => m.userId === userId)?.walletAddress;
  if (!wallet) return { ok: false, reason: "Your account has no wallet. Sign in with your wallet first." };
  const key = relayer();
  if (!key) return { ok: false, reason: "Rallied can't vote for anyone right now. Vote in the group's #votes instead." };
  const safe = getAddress(group.safeAddress);
  const contract = await moduleFor(safe).catch(() => null);
  if (!contract) return { ok: false, reason: "This group runs on an older Rallied contract without voting through your AI." };
  return { ok: true, context: { safe, module: contract.address, wallet: getAddress(wallet), helperKey: key.account.address, groupName: group.name } };
}

/** The member's helper as Base has it: Rallied's key or not, and what it may do. */
async function helperFor(context: Context): Promise<{ ours: boolean; powers: number; expiresAt: bigint; live: boolean }> {
  const helper = await publicClient().readContract({
    address: context.module,
    abi: jfkHelperAbi,
    functionName: "getHelper",
    args: [context.safe, context.wallet],
  });
  const ours = helper.key.toLowerCase() === context.helperKey.toLowerCase();
  const live = ours && helper.expiresAt > BigInt(Math.floor(Date.now() / 1000));
  return { ours, powers: live ? helper.powers : 0, expiresAt: helper.expiresAt, live };
}

/** The powers Rallied's key already has here, to keep when another one is added or taken away. */
export async function currentRalliedPowers(context: { safe: Address; module: Address; wallet: Address; helperKey: Address }): Promise<number> {
  return (await helperFor({ ...context, groupName: "" })).powers;
}

export interface AiVoteStatus {
  allowed: boolean;
  /** When the permission ends, if allowed. */
  until: Date | null;
}

export async function aiVoteStatus(userId: string, groupId: string): Promise<AiVoteStatus | null> {
  const found = await contextFor(userId, groupId);
  if (!found.ok) return null;
  const helper = await helperFor(found.context);
  const allowed = (helper.powers & HELPER_POWER.VOTE) !== 0;
  return { allowed, until: allowed ? new Date(Number(helper.expiresAt) * 1000) : null };
}

export type PreparedAiVotes =
  | { ok: true; calls: { to: Address; data: Hex }[]; wallet: Address; groupName: string; until: Date }
  | { ok: false; reason: string };

/**
 * The one wallet call that lets the user's AI vote for them in this group
 * (`mode: "allow"`), or stops it (`"remove"`), keeping every other power.
 */
export async function prepareAiVotes(userId: string, groupId: string, mode: "allow" | "remove"): Promise<PreparedAiVotes> {
  const found = await contextFor(userId, groupId);
  if (!found.ok) return found;
  const { safe, module, wallet, helperKey, groupName } = found.context;
  const isOwner = await publicClient().readContract({ address: safe, abi: safeAbi, functionName: "isOwner", args: [wallet] });
  if (!isOwner) return { ok: false, reason: "The wallet you're signed in with isn't one of this group's owners on Base." };

  const helper = await helperFor(found.context);
  if (mode === "allow") {
    const powers = helper.powers | HELPER_POWER.VOTE;
    // A year from now, and never shorter than what's already there (a rotating group's dues lock asks for that).
    const until = BigInt(Math.floor(Date.now() / 1000) + LIFETIME_S);
    const expiresAt = helper.live && helper.expiresAt > until ? helper.expiresAt : until;
    return {
      ok: true,
      wallet,
      groupName,
      until: new Date(Number(expiresAt) * 1000),
      calls: [{ to: module, data: encodeFunctionData({ abi: jfkHelperAbi, functionName: "setHelper", args: [safe, helperKey, powers, expiresAt] }) }],
    };
  }

  if ((helper.powers & HELPER_POWER.VOTE) === 0) return { ok: false, reason: "Your AI can't vote for you in this group anyway." };
  const rest = helper.powers & ~HELPER_POWER.VOTE;
  const call =
    rest === 0
      ? encodeFunctionData({ abi: jfkHelperAbi, functionName: "revokeHelper", args: [safe] })
      : encodeFunctionData({ abi: jfkHelperAbi, functionName: "setHelper", args: [safe, helperKey, rest, helper.expiresAt] });
  return { ok: true, wallet, groupName, until: new Date(Number(helper.expiresAt) * 1000), calls: [{ to: module, data: call }] };
}

export type CastResult =
  | { ok: true; txHash: Hex }
  | { ok: false; reason: string; allowAt?: "allow" };

/**
 * Cast the user's own vote through Rallied's key, after they said how in the
 * conversation. Checks Base first: the permission, the vote being open, the
 * user being one of its voters, and not having voted.
 */
export async function castVoteForUser(userId: string, groupId: string, proposalId: string, choice: VoteChoice): Promise<CastResult> {
  const found = await contextFor(userId, groupId);
  if (!found.ok) return found;
  const { safe, module, wallet } = found.context;
  const helper = await helperFor(found.context);
  if ((helper.powers & HELPER_POWER.VOTE) === 0) {
    return { ok: false, reason: "You haven't let your AI vote for you in this group yet.", allowAt: "allow" };
  }

  let id: bigint;
  try {
    id = BigInt(proposalId);
  } catch {
    return { ok: false, reason: "That isn't a vote in this group." };
  }
  const client = publicClient();
  const jfk = { address: module, abi: jfkModuleAbi } as const;
  const [proposal, eligible, already, settings] = await Promise.all([
    client.readContract({ ...jfk, functionName: "getProposal", args: [safe, id] }),
    client.readContract({ ...jfk, functionName: "eligibleVoter", args: [safe, id, wallet] }),
    client.readContract({ ...jfk, functionName: "voteOf", args: [safe, id, wallet] }),
    client.readContract({ ...jfk, functionName: "getGroupSettings", args: [safe] }),
  ]);
  if (proposal.status === 0) return { ok: false, reason: "That isn't a vote in this group." };
  if (proposal.status !== 1) return { ok: false, reason: "That vote has already been carried out." };
  if (proposal.deadline <= BigInt(Math.floor(Date.now() / 1000))) return { ok: false, reason: "Voting on that one has closed." };
  if (!eligible) return { ok: false, reason: "You joined after that vote opened, so it isn't yours to vote on." };
  if (already !== 0) return { ok: false, reason: "You've already voted on that one. Votes can't be changed." };
  // Rallied never turns this on, but a group from before could have it.
  if (settings[0]) return { ok: false, reason: "This group's contract only takes votes cast in Rallied. Vote in #votes." };

  const wallet_ = relayer();
  if (!wallet_ || wallet_.account.address === zeroAddress) return { ok: false, reason: "Rallied can't vote for anyone right now." };
  try {
    const txHash = await wallet_.writeContract({
      ...jfk,
      abi: jfkHelperAbi,
      functionName: "voteFor",
      args: [safe, wallet, id, CHOICES[choice]],
    });
    const receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
    if (receipt.status !== "success") return { ok: false, reason: "The vote didn't go through on Base. Nothing was counted." };
    await recordAudit(db, {
      action: "vote.cast",
      actorId: userId,
      groupId,
      subjectType: "proposal",
      subjectId: `${safe}:${id}`,
      after: { choice, via: "ai", txHash },
    });
    return { ok: true, txHash };
  } catch (cause) {
    console.error("[ai-votes] casting a vote failed", cause);
    return { ok: false, reason: "Couldn't cast the vote on Base just now. Try again, or vote in #votes." };
  }
}
