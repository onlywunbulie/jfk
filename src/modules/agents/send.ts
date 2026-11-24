import "server-only";
import { and, eq } from "drizzle-orm";
import { decodeEventLog, encodeAbiParameters, encodeFunctionData, getAddress, isAddress, type Address, type Hex } from "viem";
import { db } from "@/lib/db";
import { agentDrafts, type AgentDraft } from "@/lib/db/schema";
import { publicClient } from "@/lib/chain/client";
import { RALLIED_MODULES, moduleFor } from "@/lib/chain/module";
import { jfkModuleAbi, jfkRotationAbi, safeAbi } from "@/lib/chain/abis";
import { getGroupDetail, listMembers } from "@/modules/groups/service";
import { DECISIONS, type GroupDetails, type RoleDetails, type RuleDetails, type SpendDetails } from "@/modules/agents/drafts";

/**
 * Sending a draft to a vote: turning it into a real proposal on the group's
 * vault on Base, which the member signs with their own wallet (Rallied pays
 * the fee through the paymaster).
 *
 * Two steps, both checked on the server:
 *  1. prepare: is this the member's own waiting draft, is the group on Base
 *     with contract v2, is their wallet one of its owners? Then the exact
 *     call to sign.
 *  2. confirm: given the transaction, read Base itself (never the browser's
 *     word) for a ProposalOpened by that member on that vault, then mark the
 *     draft sent.
 *
 * Some drafts are Rallied's own rules, not the contract's (the due day,
 * admins). Those can't go on Base and say so.
 */

/** JfkModule.Action, in the contract's order. */
const ACTION = {
  SPEND: 0,
  ADD_MEMBER: 1,
  REMOVE_MEMBER: 2,
  REPLACE_MEMBER: 3,
  CHANGE_CONTRIBUTION: 4,
  CHANGE_RULES: 5,
  CLOSE_GROUP: 6,
  CHANGE_ORDER: 8,
} as const;

export type Prepared =
  | { ok: true; call: { to: Address; data: Hex }; wallet: Address; safe: Address }
  | { ok: false; reason: string };

async function ownWaitingDraft(userId: string, draftId: string): Promise<AgentDraft | null> {
  const [draft] = await db
    .select()
    .from(agentDrafts)
    .where(and(eq(agentDrafts.id, draftId), eq(agentDrafts.userId, userId), eq(agentDrafts.status, "WAITING")))
    .limit(1);
  return draft ?? null;
}

export async function prepareProposal(userId: string, draftId: string): Promise<Prepared> {
  const draft = await ownWaitingDraft(userId, draftId);
  if (!draft) return { ok: false, reason: "This draft has already been sent or discarded." };

  const [group, members] = await Promise.all([getGroupDetail(draft.groupId, userId), listMembers(draft.groupId, userId)]);
  if (!group || !members) return { ok: false, reason: "You're no longer in this group." };
  if (!group.safeAddress) return { ok: false, reason: "This group isn't on Base yet. Start it on Base first, then send." };

  const me = members.find((member) => member.userId === userId);
  if (!me?.walletAddress) return { ok: false, reason: "Your account has no wallet. Sign in with your Base wallet to send." };

  const safe = getAddress(group.safeAddress);
  const wallet = getAddress(me.walletAddress);
  const client = publicClient();
  const [vault, isOwner] = await Promise.all([
    moduleFor(safe),
    client.readContract({ address: safe, abi: safeAbi, functionName: "isOwner", args: [wallet] }),
  ]);
  if (!vault) {
    return { ok: false, reason: "This group runs on Rallied's first contract, which can't take this. Start a new group on Base to try it." };
  }
  if (!isOwner) return { ok: false, reason: "The wallet you're signed in with isn't one of this group's owners on Base." };

  const built = await buildPayload(draft, members, safe, vault.address);
  if (!built.ok) return built;

  const data = encodeFunctionData({ abi: jfkModuleAbi, functionName: "propose", args: [safe, built.action, built.payload] });
  return { ok: true, call: { to: vault.address, data }, wallet, safe };
}

type Built = { ok: true; action: number; payload: Hex } | { ok: false; reason: string };

async function buildPayload(
  draft: AgentDraft,
  members: Awaited<ReturnType<typeof listMembers>> & object,
  safe: Address,
  moduleAddress: Address,
): Promise<Built> {
  if (draft.kind === "SPEND") {
    const details = draft.details as unknown as SpendDetails;
    if (details.currency !== "USDC") return { ok: false, reason: "Only dollar (USDC) groups can spend on Base." };
    let recipient: string | null;
    if (details.paidTo.kind === "address") {
      recipient = details.paidTo.address;
    } else {
      const memberId = details.paidTo.memberId;
      recipient = members.find((member) => member.memberId === memberId)?.walletAddress ?? null;
      if (!recipient) return { ok: false, reason: `${details.paidTo.name} has no wallet on Base to be paid to.` };
    }
    if (!isAddress(recipient)) return { ok: false, reason: "The recipient's wallet address isn't valid." };
    const payload = encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [getAddress(recipient), BigInt(details.amountMinor)],
    );
    return { ok: true, action: ACTION.SPEND, payload };
  }

  if (draft.kind === "GROUP_CHANGE") {
    const details = draft.details as unknown as GroupDetails;
    if (details.change === "close_group") return { ok: true, action: ACTION.CLOSE_GROUP, payload: "0x" };
    if (details.change === "change_order" && details.order) {
      const wallets: Address[] = [];
      for (const placed of details.order) {
        const wallet = members.find((member) => member.memberId === placed.memberId)?.walletAddress;
        if (!wallet) return { ok: false, reason: `${placed.name} has no wallet on Base.` };
        wallets.push(getAddress(wallet));
      }
      // The order on Base moves on its own (each payout, and anyone who misses goes to the back).
      const client = publicClient();
      const [[order], rotation] = await Promise.all([
        client.readContract({ address: moduleAddress, abi: jfkRotationAbi, functionName: "getOrder", args: [safe] }),
        client.readContract({ address: moduleAddress, abi: jfkRotationAbi, functionName: "getRotation", args: [safe] }),
      ]);
      const still = order.slice(Number(rotation[3])).map((wallet) => wallet.toLowerCase());
      const same = still.length === wallets.length && wallets.every((wallet) => still.includes(wallet.toLowerCase()));
      if (!same) {
        return { ok: false, reason: "Who's still to collect has changed on Base since this was drafted. Ask your AI for a new order." };
      }
      return { ok: true, action: ACTION.CHANGE_ORDER, payload: encodeAbiParameters([{ type: "address[]" }], [wallets]) };
    }
    return { ok: false, reason: "Rallied can't send that kind of group decision yet." };
  }

  if (draft.kind === "ROLE_CHANGE" && (draft.details as unknown as RoleDetails).change === "add_member") {
    const details = draft.details as unknown as RoleDetails;
    if (!details.wallet || !isAddress(details.wallet)) return { ok: false, reason: "This draft has no valid wallet to add. Ask your AI to draft it again." };
    return { ok: true, action: ACTION.ADD_MEMBER, payload: encodeAbiParameters([{ type: "address" }], [getAddress(details.wallet)]) };
  }

  if (draft.kind === "ROLE_CHANGE" && (draft.details as unknown as RoleDetails).change === "replace_wallet") {
    const details = draft.details as unknown as RoleDetails;
    const member = members.find((m) => m.memberId === details.memberId);
    if (!member?.walletAddress) return { ok: false, reason: `${details.memberName} has no wallet on Base to replace.` };
    if (!details.wallet || !isAddress(details.wallet)) return { ok: false, reason: "This draft has no valid new wallet. Ask your AI to draft it again." };
    return {
      ok: true,
      action: ACTION.REPLACE_MEMBER,
      payload: encodeAbiParameters([{ type: "address" }, { type: "address" }], [getAddress(member.walletAddress), getAddress(details.wallet)]),
    };
  }

  if (draft.kind === "ROLE_CHANGE") {
    const details = draft.details as unknown as RoleDetails;
    if (details.change !== "remove_member") {
      return { ok: false, reason: "Admins are Rallied's own role, not part of the vault on Base. Votes on admins run in Rallied, coming soon." };
    }
    const target = members.find((member) => member.memberId === details.memberId);
    if (!target?.walletAddress) return { ok: false, reason: `${details.memberName} has no wallet on Base.` };
    return { ok: true, action: ACTION.REMOVE_MEMBER, payload: encodeAbiParameters([{ type: "address" }], [getAddress(target.walletAddress)]) };
  }

  const details = draft.details as unknown as RuleDetails;
  if (!details.value) return { ok: false, reason: "This draft is from before sending was possible. Ask your AI to draft it again." };

  if (details.rule === "what_everyone_pays") {
    return { ok: true, action: ACTION.CHANGE_CONTRIBUTION, payload: encodeAbiParameters([{ type: "uint256" }], [BigInt(details.value)]) };
  }
  if (details.rule === "votes_count_share" || details.rule === "share_needed" || details.rule === "vote_days") {
    // CHANGE_RULES replaces the whole rule set, so everything else is kept as it is on Base now.
    const client = publicClient();
    const group = await client.readContract({ address: moduleAddress, abi: jfkModuleAbi, functionName: "getGroup", args: [safe] });
    const [, , votingPeriodNow, quorumNow, , thresholdsNow] = group;
    // "Every vote needs a human" is always sent off: in Rallied, a member can always vote
    // either here or through their AI, never only here. (The next contract drops the setting.)
    const humanVotesOnly = false;
    const thresholds = [...thresholdsNow] as number[];
    let quorum = quorumNow;
    let votingPeriod = votingPeriodNow;
    if (details.rule === "votes_count_share") quorum = Number(details.value);
    if (details.rule === "vote_days") votingPeriod = Number(details.value) * 86_400;
    if (details.rule === "share_needed") {
      if (!details.decision || !(details.decision in DECISIONS)) return { ok: false, reason: "This draft doesn't say which decision. Ask your AI to draft it again." };
      for (const slot of DECISIONS[details.decision].slots) thresholds[slot] = Number(details.value);
    }
    const payload = encodeAbiParameters(
      [{ type: "uint16[9]" }, { type: "uint8" }, { type: "uint32" }, { type: "bool" }],
      [thresholds as unknown as readonly [number, number, number, number, number, number, number, number, number], quorum, votingPeriod, humanVotesOnly],
    );
    return { ok: true, action: ACTION.CHANGE_RULES, payload };
  }
  return { ok: false, reason: "The due day is Rallied's own rule, not part of the vault on Base. Votes on it run in Rallied, coming soon." };
}

/**
 * After the member's wallet sent it: find the proposal on Base and mark the
 * draft sent. Trusts only what the chain says.
 */
export async function confirmProposal(
  userId: string,
  draftId: string,
  txHash: Hex,
): Promise<{ ok: true; proposalId: string } | { ok: false; reason: string }> {
  const draft = await ownWaitingDraft(userId, draftId);
  if (!draft) return { ok: false, reason: "This draft has already been sent or discarded." };
  const [group, members] = await Promise.all([getGroupDetail(draft.groupId, userId), listMembers(draft.groupId, userId)]);
  const wallet = members?.find((member) => member.userId === userId)?.walletAddress;
  if (!group?.safeAddress || !wallet) return { ok: false, reason: "This group or wallet isn't on Base." };

  const receipt = await publicClient().waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
  if (receipt.status !== "success") return { ok: false, reason: "The transaction didn't go through on Base. Nothing was sent." };

  for (const log of receipt.logs) {
    if (!RALLIED_MODULES.some((address) => address.toLowerCase() === log.address.toLowerCase())) continue;
    try {
      const event = decodeEventLog({ abi: jfkModuleAbi, data: log.data, topics: log.topics });
      if (
        event.eventName === "ProposalOpened" &&
        event.args.safe.toLowerCase() === group.safeAddress.toLowerCase() &&
        event.args.proposer.toLowerCase() === wallet.toLowerCase()
      ) {
        const proposalId = event.args.id.toString();
        await db
          .update(agentDrafts)
          .set({
            status: "SENT",
            decidedAt: new Date(),
            details: { ...draft.details, sent: { txHash, proposalId } },
          })
          .where(and(eq(agentDrafts.id, draftId), eq(agentDrafts.userId, userId), eq(agentDrafts.status, "WAITING")));
        return { ok: true, proposalId };
      }
    } catch {
      // Not one of our events; keep looking.
    }
  }
  return { ok: false, reason: "That transaction didn't open a proposal for this group." };
}
