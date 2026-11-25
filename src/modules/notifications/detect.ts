import "server-only";
import { Money } from "@/lib/money";
import { getGroupDetail, listMembers } from "@/modules/groups/service";
import { readChainVotes, type ChainVote } from "@/modules/groups/onchain-votes";
import { readDues } from "@/modules/groups/onchain-dues";
import { autopayStatus } from "@/modules/groups/onchain-autopay";
import { readRotation } from "@/modules/groups/onchain-rotation";

/**
 * What needs one member in one group, worked out from Base each time, never
 * remembered: a vote they can vote on, one closing soon, a result, their turn
 * paid, a round they owe, dues not paid.
 *
 * Each notice has a key naming exactly the thing it's about, so the service
 * stores it once and nobody hears about the same thing twice, however often
 * Rallied looks. A key changes when the thing does (a new vote, a new round
 * owed, a new period unpaid).
 */

export interface Notice {
  key: string;
  title: string;
  body: string;
  url: string;
}

const HOUR = 60 * 60 * 1000;
/** A vote's result is news for two days after it closes; older ones aren't. */
const RESULT_FRESH = 48 * HOUR;
/** How soon before a vote closes to remind someone who hasn't voted. */
const CLOSING_SOON = 24 * HOUR;
/** A payout is news for two days. */
const PAYOUT_FRESH = 48 * HOUR;

export async function noticesFor(userId: string, groupId: string, now: Date = new Date()): Promise<Notice[]> {
  const [group, members] = await Promise.all([getGroupDetail(groupId, userId), listMembers(groupId, userId)]);
  if (!group || !members || !group.safeAddress) return [];
  const g = group.name;
  const at = (channel: string) => `/groups/${groupId}/${channel}`;
  const notices: Notice[] = [];

  const rotating = group.type === "ROTATING";
  const [votes, dues, autopay, rotation] = await Promise.all([
    readChainVotes(groupId, userId),
    readDues(groupId, userId),
    autopayStatus(userId, groupId),
    rotating ? readRotation(group.safeAddress, members) : null,
  ]);

  if (votes.ok) {
    for (const vote of votes.votes) notices.push(...voteNotices(vote, groupId, g, at("votes"), now));
  }

  if (rotation?.ok) {
    const last = rotation.lastPayout;
    if (last && last.userId === userId && now.getTime() - last.at.getTime() < PAYOUT_FRESH) {
      notices.push({
        key: `payout:${groupId}:${rotation.cycle}:${last.round}`,
        title: `You collected ${usdc(last.paid)}`,
        body: `It was your turn in ${g}. The money is in your wallet.`,
        url: at("payout-order"),
      });
    }
    const me = [...rotation.order, ...rotation.joining].find((seat) => seat.userId === userId);
    if (me && me.debt > 0n) {
      notices.push({
        // A new round missed raises the debt, so it's news again.
        key: `debt:${groupId}:${rotation.cycle}:${me.debt}`,
        title: `You owe ${usdc(me.debt)} in ${g}`,
        body: "A round went unpaid. Your next payment goes to whoever was short.",
        url: at("transactions"),
      });
    }
  }

  // Automatic dues that didn't go through (no USDC left, say): each new problem is news once.
  if (autopay?.on && autopay.problem) {
    notices.push({
      key: `autopay-problem:${groupId}:${autopay.lastCollected ?? "never"}:${autopay.problem}`,
      title: `Automatic dues didn't go through in ${g}`,
      body: autopay.problem,
      url: at("transactions"),
    });
  }

  // Dues by hand only: with automatic dues on, Rallied collects them anyway.
  if (dues.ok && !dues.you.paidThisPeriod && dues.you.canPay && !autopay?.on) {
    notices.push({
      // What they've paid in changes once they pay, so each unpaid period is one notice.
      key: `dues:${groupId}:${dues.members.find((m) => m.isYou)?.paidIn ?? ""}`,
      title: `Your ${g} dues are due`,
      body: rotating
        ? `${dues.contribution} for this round. Turn on automatic dues so you never miss one.`
        : `${dues.contribution} for this period.`,
      url: at("transactions"),
    });
  }

  return notices;
}

function voteNotices(vote: ChainVote, groupId: string, g: string, url: string, now: Date): Notice[] {
  const deadline = new Date(vote.deadline).getTime();
  const mineToDecide = vote.proposedBy !== "You";
  const out: Notice[] = [];

  if (vote.canVote) {
    if (mineToDecide) {
      out.push({
        key: `vote-opened:${groupId}:${vote.id}`,
        title: `New vote in ${g}`,
        body: `${vote.title}. ${vote.proposedBy} proposed it; voting closes ${vote.closes}.`,
        url,
      });
    }
    if (deadline - now.getTime() < CLOSING_SOON) {
      out.push({
        key: `vote-closing:${groupId}:${vote.id}`,
        title: `Last day to vote in ${g}`,
        body: `${vote.title}. You haven't voted yet.`,
        url,
      });
    }
  }

  if ((vote.state === "PASSED" || vote.state === "DONE" || vote.state === "FAILED") && now.getTime() - deadline < RESULT_FRESH) {
    const passed = vote.state !== "FAILED";
    out.push({
      key: `vote-result:${groupId}:${vote.id}`,
      title: passed ? `Passed in ${g}` : `Didn't pass in ${g}`,
      body: `${vote.title}: ${vote.yes.length} yes, ${vote.no.length} no.`,
      url,
    });
  }
  return out;
}

const usdc = (minor: bigint) => Money.fromMinor(minor, "USDC").format();
