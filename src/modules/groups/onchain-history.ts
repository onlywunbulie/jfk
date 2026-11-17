import "server-only";
import { decodeEventLog, getAddress, pad, type Hex } from "viem";
import { CONTRACTS, HISTORY_API_URL, shortAddress } from "@/lib/chain/addresses";
import { jfkModuleAbi, jfkMoneyEventsAbi } from "@/lib/chain/abis";
import { publicClient } from "@/lib/chain/client";
import { Money } from "@/lib/money";
import { getGroupDetail, listMembers } from "./service";

/**
 * Every dollar in and out of a group's vault, read from Base: dues paid in,
 * spends the group voted for, refunds to removed members, and the share-out
 * when a group closes. Money only leaves through the contract's Paid event,
 * so each payment out is counted exactly once. Each row links to its transaction, so anyone can
 * check it.
 */

export interface HistoryEntry {
  id: string;
  /** "17 November 2026", or "Today", in Lagos time. */
  day: string;
  time: string;
  what: string;
  amount: string;
  inflow: boolean;
  mine: boolean;
  /** Money out on a vote: "2 of 3 voted yes". */
  approved: string | null;
  txHash: string;
}

export type History = { ok: true; entries: HistoryEntry[] } | { ok: false; reason: "not_found" | "not_on_base" | "unreachable" };

interface RawLog {
  data: Hex;
  topics: (Hex | null)[];
  timeStamp: Hex;
  transactionHash: Hex;
  logIndex: Hex;
}

const LAGOS = "Africa/Lagos";
const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: LAGOS });
const TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: LAGOS });
const usdc = (minor: bigint) => Money.fromMinor(minor, "USDC").format();

export async function readHistory(groupId: string, userId: string): Promise<History> {
  const [group, members] = await Promise.all([getGroupDetail(groupId, userId), listMembers(groupId, userId)]);
  if (!group || !members) return { ok: false, reason: "not_found" };
  if (!group.safeAddress) return { ok: false, reason: "not_on_base" };
  const safe = getAddress(group.safeAddress);

  const names = new Map(members.filter((m) => m.walletAddress).map((m) => [m.walletAddress as string, m.userId === userId ? "You" : m.displayName]));
  const nameOf = (wallet: string) => names.get(wallet.toLowerCase()) ?? shortAddress(wallet);
  const me = members.find((m) => m.userId === userId)?.walletAddress ?? null;

  let logs: RawLog[];
  try {
    const url = new URL(HISTORY_API_URL);
    url.search = new URLSearchParams({
      module: "logs",
      action: "getLogs",
      address: CONTRACTS.jfkModule,
      topic1: pad(safe),
      fromBlock: "0",
      toBlock: "latest",
    }).toString();
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    const body = (await response.json()) as { result?: RawLog[] | string };
    // "No records found" comes back as a message, not an empty list.
    logs = Array.isArray(body.result) ? body.result : [];
  } catch (cause) {
    console.error("[history] couldn't read the vault's history", cause);
    return { ok: false, reason: "unreachable" };
  }

  // What each transaction did besides paying, so a payment out can say why:
  // a voted spend, a refund to a removed member, or a share when the group closed.
  const executedIn = new Map<string, bigint>();
  const removedIn = new Set<string>();
  const closedIn = new Set<string>();
  const decoded = logs.flatMap((log) => {
    try {
      const event = decodeEventLog({ abi: jfkMoneyEventsAbi, data: log.data, topics: log.topics.filter(Boolean) as [Hex, ...Hex[]] });
      if (event.eventName === "ProposalExecuted") executedIn.set(log.transactionHash, event.args.id);
      if (event.eventName === "MemberRemoved") removedIn.add(log.transactionHash);
      if (event.eventName === "GroupClosed") closedIn.add(log.transactionHash);
      return [{ log, event }];
    } catch {
      return []; // Votes, proposals and settings: not money.
    }
  });

  const approvals = new Map<string, string>();
  const ids = [...new Set(executedIn.values())];
  if (ids.length > 0) {
    try {
      const proposals = await publicClient().multicall({
        allowFailure: false,
        contracts: ids.map((id) => ({ address: CONTRACTS.jfkModule, abi: jfkModuleAbi, functionName: "getProposal", args: [safe, id] }) as const),
      });
      ids.forEach((id, i) => approvals.set(id.toString(), `${proposals[i].yes} of ${proposals[i].eligible} voted yes`));
    } catch {
      // The rows still stand without the vote count.
    }
  }

  const today = DAY.format(new Date());
  const entries: HistoryEntry[] = [];
  for (const { log, event } of decoded) {
    const at = new Date(Number(BigInt(log.timeStamp)) * 1000);
    const base = {
      id: `${log.transactionHash}-${Number(BigInt(log.logIndex))}`,
      day: DAY.format(at) === today ? "Today" : DAY.format(at),
      time: TIME.format(at),
      txHash: log.transactionHash,
    };
    const proposal = executedIn.get(log.transactionHash);
    const approved = proposal !== undefined ? (approvals.get(proposal.toString()) ?? `Vote #${proposal}`) : null;

    if (event.eventName === "Contributed") {
      entries.push({ ...base, what: `${nameOf(event.args.member)} paid in`, amount: usdc(event.args.amount), inflow: true, mine: isMe(event.args.member), approved: null });
    } else if (event.eventName === "Paid") {
      // Every payment out is one Paid event; the others in its transaction say why.
      const who = nameOf(event.args.recipient);
      const what = closedIn.has(log.transactionHash)
        ? `${who === "You" ? "Your" : `${who}'s`} share, group closed`
        : removedIn.has(log.transactionHash)
          ? `Refund to ${who}, removed by vote`
          : `Paid to ${who}`;
      entries.push({ ...base, what, amount: usdc(event.args.amount), inflow: false, mine: isMe(event.args.recipient), approved });
    }
  }
  // Blockscout returns oldest first; keep it that way (the feed reads like a chat, newest at the bottom).
  return { ok: true, entries };

  function isMe(wallet: string) {
    return me !== null && wallet.toLowerCase() === me;
  }
}
