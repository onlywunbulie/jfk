import "server-only";
import { eq } from "drizzle-orm";
import { decodeAbiParameters, encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { db } from "@/lib/db";
import { groupSettings } from "@/lib/db/schema";
import { CONTRACTS, shortAddress } from "@/lib/chain/addresses";
import { jfkModuleAbi, safeAbi } from "@/lib/chain/abis";
import { publicClient } from "@/lib/chain/client";
import { relayer } from "@/lib/chain/relayer";
import { Money } from "@/lib/money";
import { recordAudit } from "@/modules/audit/service";
import { getGroupDetail, listMembers, type MemberView } from "./service";

/**
 * A group's votes, read from Base. For a group on Base the contract is the
 * only record of what's being voted on, who voted which way, and what passed;
 * Rallied keeps no copy that could disagree with it.
 *
 *  - readChainVotes: every proposal on the group's vault, in plain words.
 *  - prepareVote: checks the member can still vote, then the exact call for
 *    their wallet to sign (Rallied pays the fee where the wallet allows).
 *  - carryOut: once a vote has passed, Rallied's relayer runs it on Base.
 *    The contract lets anyone do that and does nothing unless it passed, so
 *    the relayer gains no power by it; it only saves members the fee.
 */

/** JfkModule.Action, in the contract's order. */
const ACTIONS = [
  "SPEND",
  "ADD_MEMBER",
  "REMOVE_MEMBER",
  "REPLACE_MEMBER",
  "CHANGE_CONTRIBUTION",
  "CHANGE_RULES",
  "CLOSE_GROUP",
  "MIGRATE_MODULE",
] as const;
type Action = (typeof ACTIONS)[number];

const CHOICE = { YES: 1, NO: 2, ABSTAIN: 3 } as const;
export type Choice = keyof typeof CHOICE;
const CHOICE_NAMES: (Choice | null)[] = [null, "YES", "NO", "ABSTAIN"];
const DECISIONS = ["UNDECIDED", "APPROVED", "REJECTED"] as const;

export interface ChainVote {
  id: string;
  kind: "SPEND" | "MEMBER" | "RULE" | "GROUP";
  title: string;
  detail: string | null;
  change: { before: string; after: string } | null;
  /** "67%": the share of yes votes needed, fixed when the vote opened. */
  need: string;
  quorumPct: number;
  eligible: number;
  yes: string[];
  no: string[];
  abstain: string[];
  proposedBy: string;
  deadline: string;
  /** "Fri 21 Nov", in Lagos time, for the card. */
  closes: string;
  /** OPEN: still being voted on. PASSED: passed, waiting to be carried out. DONE: carried out. FAILED: didn't pass. */
  state: "OPEN" | "PASSED" | "DONE" | "FAILED";
  mine: Choice | null;
  canVote: boolean;
}

export type ChainVotes =
  | { ok: true; votes: ChainVote[]; safe: Address }
  | { ok: false; reason: "not_found" | "not_on_base" | "old_contract" | "unreachable" };

/** Only the most recent proposals are shown; older ones are on BaseScan. */
const MAX_SHOWN = 30;

export async function readChainVotes(groupId: string, userId: string): Promise<ChainVotes> {
  const [group, members] = await Promise.all([getGroupDetail(groupId, userId), listMembers(groupId, userId)]);
  if (!group || !members) return { ok: false, reason: "not_found" };
  if (!group.safeAddress) return { ok: false, reason: "not_on_base" };
  const safe = getAddress(group.safeAddress);
  const client = publicClient();

  try {
    const [onV2, chainGroup] = await Promise.all([
      client.readContract({ address: safe, abi: safeAbi, functionName: "isModuleEnabled", args: [CONTRACTS.jfkModule] }),
      client.readContract({ address: CONTRACTS.jfkModule, abi: jfkModuleAbi, functionName: "getGroup", args: [safe] }),
    ]);
    if (!onV2) return { ok: false, reason: "old_contract" };
    const [, contribution, , quorumNow, , , proposalCount] = chainGroup;

    const count = Number(proposalCount);
    const ids = Array.from({ length: Math.min(count, MAX_SHOWN) }, (_, i) => BigInt(count - i));
    if (ids.length === 0) return { ok: true, votes: [], safe };

    const wallets = members.filter((m) => m.walletAddress).map((m) => getAddress(m.walletAddress as string));
    const me = members.find((m) => m.userId === userId)?.walletAddress;
    const names = nameBook(members, userId);

    const jfk = { address: CONTRACTS.jfkModule, abi: jfkModuleAbi } as const;
    const [proposals, decisions, ballots] = await Promise.all([
      client.multicall({ allowFailure: false, contracts: ids.map((id) => ({ ...jfk, functionName: "getProposal", args: [safe, id] }) as const) }),
      client.multicall({ allowFailure: false, contracts: ids.map((id) => ({ ...jfk, functionName: "decision", args: [safe, id] }) as const) }),
      client.multicall({
        allowFailure: false,
        contracts: ids.flatMap((id) => wallets.map((w) => ({ ...jfk, functionName: "voteOf", args: [safe, id, w] }) as const)),
      }),
    ]);

    const now = BigInt(Math.floor(Date.now() / 1000));
    const votes = ids.map((id, i): ChainVote => {
      const p = proposals[i];
      const decision = DECISIONS[decisions[i]] ?? "UNDECIDED";
      const cast = wallets.map((w, j) => ({ wallet: w, choice: CHOICE_NAMES[ballots[i * wallets.length + j]] ?? null }));
      const who = (choice: Choice) => cast.filter((c) => c.choice === choice).map((c) => names(c.wallet));
      const mineChoice = me ? (cast.find((c) => c.wallet.toLowerCase() === me)?.choice ?? null) : null;

      const executed = p.status === 2;
      const state: ChainVote["state"] = executed ? "DONE" : decision === "APPROVED" ? "PASSED" : decision === "REJECTED" ? "FAILED" : "OPEN";
      const described = describe(ACTIONS[p.action] ?? "SPEND", p.payload, { contribution, quorumNow, open: state === "OPEN", names });

      return {
        id: id.toString(),
        ...described,
        need: `${Math.round(p.thresholdPermille / 10)}%`,
        quorumPct: p.quorumPct,
        eligible: p.eligible,
        yes: who("YES"),
        no: who("NO"),
        abstain: who("ABSTAIN"),
        proposedBy: names(p.proposer),
        deadline: new Date(Number(p.deadline) * 1000).toISOString(),
        closes: CLOSES.format(new Date(Number(p.deadline) * 1000)),
        state,
        mine: mineChoice,
        canVote: state === "OPEN" && mineChoice === null && Boolean(me) && p.deadline > now,
      };
    });
    return { ok: true, votes, safe };
  } catch (cause) {
    console.error("[votes] couldn't read Base", cause);
    return { ok: false, reason: "unreachable" };
  }
}

/** Wallet → the member's name ("You" for the viewer); anyone else by short address. */
function nameBook(members: MemberView[], userId: string) {
  const byWallet = new Map(members.filter((m) => m.walletAddress).map((m) => [m.walletAddress as string, m.userId === userId ? "You" : m.displayName]));
  return (wallet: string) => byWallet.get(wallet.toLowerCase()) ?? shortAddress(wallet);
}

const CLOSES = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "Africa/Lagos" });

const usdc = (minor: bigint) => Money.fromMinor(minor, "USDC").format();

function describe(
  action: Action,
  payload: Hex,
  ctx: { contribution: bigint; quorumNow: number; open: boolean; names: (wallet: string) => string },
): Pick<ChainVote, "kind" | "title" | "detail" | "change"> {
  const one = <T extends readonly { type: string }[]>(types: T) => decodeAbiParameters(types, payload);
  switch (action) {
    case "SPEND": {
      const [to, amount] = one([{ type: "address" }, { type: "uint256" }] as const);
      return { kind: "SPEND", title: `Spend ${usdc(amount)}`, detail: `To ${ctx.names(to)}`, change: null };
    }
    case "ADD_MEMBER": {
      const [who] = one([{ type: "address" }] as const);
      return { kind: "MEMBER", title: `Add ${ctx.names(who)}`, detail: null, change: null };
    }
    case "REMOVE_MEMBER": {
      const [who] = one([{ type: "address" }] as const);
      return { kind: "MEMBER", title: `Remove ${ctx.names(who)}`, detail: "They get back what they paid in.", change: null };
    }
    case "REPLACE_MEMBER": {
      const [from, to] = one([{ type: "address" }, { type: "address" }] as const);
      return { kind: "MEMBER", title: `New wallet for ${ctx.names(from)}`, detail: `${shortAddress(from)} → ${shortAddress(to)}`, change: null };
    }
    case "CHANGE_CONTRIBUTION": {
      const [amount] = one([{ type: "uint256" }] as const);
      // Before it passes, "before" is today's amount; afterwards it would be the new one, so it's left out.
      return {
        kind: "RULE",
        title: "What everyone pays",
        detail: ctx.open ? null : `Now ${usdc(amount)}`,
        change: ctx.open ? { before: usdc(ctx.contribution), after: usdc(amount) } : null,
      };
    }
    case "CHANGE_RULES": {
      const [, quorum] = one([{ type: "uint16[9]" }, { type: "uint8" }, { type: "uint32" }, { type: "bool" }] as const);
      if (ctx.open && quorum !== ctx.quorumNow) {
        return {
          kind: "RULE",
          title: "Votes count",
          detail: null,
          change: { before: `When ${ctx.quorumNow}% vote`, after: `When ${quorum}% vote` },
        };
      }
      return { kind: "RULE", title: "The group's voting rules", detail: `Votes count when ${quorum}% vote`, change: null };
    }
    case "CLOSE_GROUP":
      return { kind: "GROUP", title: "Close the group", detail: "Everyone gets their share of the vault back.", change: null };
    case "MIGRATE_MODULE": {
      const [to] = one([{ type: "address" }] as const);
      return { kind: "GROUP", title: "Move to a new Rallied contract", detail: shortAddress(to), change: null };
    }
  }
}

// ---------------------------------------------------------------------------
// Voting
// ---------------------------------------------------------------------------

export type PreparedVote =
  | { ok: true; call: { to: Address; data: Hex }; wallet: Address }
  | { ok: false; reason: string };

export async function prepareVote(userId: string, groupId: string, proposalId: string, choice: Choice): Promise<PreparedVote> {
  const [group, members] = await Promise.all([getGroupDetail(groupId, userId), listMembers(groupId, userId)]);
  if (!group || !members) return { ok: false, reason: "You're no longer in this group." };
  if (!group.safeAddress) return { ok: false, reason: "This group isn't on Base yet." };
  const wallet = members.find((m) => m.userId === userId)?.walletAddress;
  if (!wallet) return { ok: false, reason: "Your account has no wallet. Sign in with your wallet to vote." };

  const safe = getAddress(group.safeAddress);
  const voter = getAddress(wallet);
  const id = BigInt(proposalId);
  const client = publicClient();
  const jfk = { address: CONTRACTS.jfkModule, abi: jfkModuleAbi } as const;
  const [proposal, eligible, already] = await Promise.all([
    client.readContract({ ...jfk, functionName: "getProposal", args: [safe, id] }),
    client.readContract({ ...jfk, functionName: "eligibleVoter", args: [safe, id, voter] }),
    client.readContract({ ...jfk, functionName: "voteOf", args: [safe, id, voter] }),
  ]);
  if (proposal.status === 0) return { ok: false, reason: "That vote doesn't exist on this group." };
  if (proposal.status !== 1) return { ok: false, reason: "That vote has already been carried out." };
  if (proposal.deadline <= BigInt(Math.floor(Date.now() / 1000))) return { ok: false, reason: "Voting on this one has closed." };
  if (!eligible) return { ok: false, reason: "You joined after this vote opened, so it isn't yours to vote on." };
  if (already !== 0) return { ok: false, reason: "You've already voted on this one. Votes can't be changed." };

  const data = encodeFunctionData({ ...jfk, functionName: "vote", args: [safe, id, CHOICE[choice]] });
  return { ok: true, call: { to: CONTRACTS.jfkModule, data }, wallet: voter };
}

// ---------------------------------------------------------------------------
// Carrying out a vote that passed
// ---------------------------------------------------------------------------

export type CarryOutResult =
  | { ok: true; txHash: Hex }
  | { ok: false; reason: "not_found" | "not_passed" | "already_done" | "no_relayer" | "failed" };

export async function carryOut(userId: string, groupId: string, proposalId: string): Promise<CarryOutResult> {
  const group = await getGroupDetail(groupId, userId);
  if (!group?.safeAddress) return { ok: false, reason: "not_found" };
  const safe = getAddress(group.safeAddress);
  const id = BigInt(proposalId);
  const client = publicClient();
  const jfk = { address: CONTRACTS.jfkModule, abi: jfkModuleAbi } as const;

  const [proposal, decision] = await Promise.all([
    client.readContract({ ...jfk, functionName: "getProposal", args: [safe, id] }),
    client.readContract({ ...jfk, functionName: "decision", args: [safe, id] }).catch(() => 0),
  ]);
  if (proposal.status === 0) return { ok: false, reason: "not_found" };
  if (proposal.status === 2) return { ok: false, reason: "already_done" };
  if (decision !== 1) return { ok: false, reason: "not_passed" };

  const wallet = relayer();
  if (!wallet) return { ok: false, reason: "no_relayer" };

  try {
    const txHash = await wallet.writeContract({ ...jfk, functionName: "execute", args: [safe, id] });
    const receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
    if (receipt.status !== "success") return { ok: false, reason: "failed" };

    const action = ACTIONS[proposal.action];
    await db.transaction(async (tx) => {
      // Rallied's copy of the group's settings follows what Base now says.
      if (action === "CHANGE_CONTRIBUTION") {
        const [amount] = decodeAbiParameters([{ type: "uint256" }], proposal.payload);
        await tx.update(groupSettings).set({ contributionAmount: amount }).where(eq(groupSettings.groupId, groupId));
      } else if (action === "CHANGE_RULES") {
        const [, quorum] = decodeAbiParameters([{ type: "uint16[9]" }, { type: "uint8" }, { type: "uint32" }, { type: "bool" }], proposal.payload);
        await tx.update(groupSettings).set({ quorumPct: quorum }).where(eq(groupSettings.groupId, groupId));
      }
      await recordAudit(tx, {
        action: "proposal.executed",
        actorId: userId,
        groupId,
        subjectType: "group",
        subjectId: groupId,
        after: { safe, proposalId, action, txHash },
      });
    });
    return { ok: true, txHash };
  } catch (cause) {
    console.error("[votes] carrying out failed", cause);
    return { ok: false, reason: "failed" };
  }
}
