import "server-only";
import { readChainVotes } from "@/modules/groups/onchain-votes";
import { readDues } from "@/modules/groups/onchain-dues";
import { autopayStatus } from "@/modules/groups/onchain-autopay";
import { countWaitingDrafts } from "@/modules/agents/drafts";

/**
 * What the user will most likely want next, as short phrases in their own
 * words, so their AI can offer them as numbered choices and the user just
 * replies "1". Worked out from where the group really stands (on Base or
 * not, dues paid, drafts waiting, votes open), never guessed.
 *
 * At most three, most useful first. Each phrase is something the AI can act
 * on with Rallied's tools, or a link Rallied gives.
 */

const MAX = 3;

interface GroupLike {
  id: string;
  name: string;
  type: "ROTATING" | "TREASURY";
  role: string;
  safeAddress: string | null;
}

/** For one group, reading Base for dues, votes and automatic payment. */
export async function nextForGroup(userId: string, group: GroupLike, first: string[] = []): Promise<string[]> {
  const g = group.name;
  const steps = [...first];

  if (!group.safeAddress) {
    if (group.role === "OWNER") steps.push(`Invite friends to ${g}`, `Start ${g} on Base`);
    else steps.push(`What's happening in ${g}?`);
    return unique(steps);
  }

  const [drafts, votes, dues, autopay] = await Promise.all([
    countWaitingDrafts(userId),
    readChainVotes(group.id, userId),
    readDues(group.id, userId),
    autopayStatus(userId, group.id),
  ]);

  const waiting = Object.values(drafts.get(group.id) ?? {}).reduce((sum, n) => sum + (n ?? 0), 0);
  if (waiting > 0) steps.push(waiting === 1 ? `Open my waiting draft in ${g}` : `Open my ${waiting} waiting drafts in ${g}`);

  const myVote = votes.ok ? votes.votes.find((vote) => vote.canVote) : undefined;
  if (myVote) steps.push(`Open the vote on "${myVote.title}"`);

  const unpaid = dues.ok && !dues.you.paidThisPeriod;
  if (unpaid) steps.push(`Pay my ${g} dues now`);
  // Required in a rotating group, so it goes first there.
  if (!autopay?.on) {
    if (group.type === "ROTATING") steps.unshift(`Turn on automatic dues in ${g} (required)`);
    else steps.push(`Pay my ${g} dues automatically`);
  }

  // When nothing needs the user, the most useful things to do in the group.
  if (group.type === "TREASURY") steps.push(`Propose a spend from ${g}`);
  steps.push(`How much is in ${g}'s pot?`);
  return unique(steps);
}

/** Across all the user's groups, from what Rallied already knows (no reads from Base, so listing stays quick). */
export async function nextAcrossGroups(userId: string, groups: GroupLike[]): Promise<string[]> {
  const drafts = await countWaitingDrafts(userId);
  const steps: string[] = [];
  for (const group of groups) {
    const waiting = Object.values(drafts.get(group.id) ?? {}).reduce((sum, n) => sum + (n ?? 0), 0);
    if (waiting > 0) steps.push(`Open my waiting draft in ${group.name}`);
  }
  for (const group of groups) {
    if (!group.safeAddress && group.role === "OWNER") steps.push(`Start ${group.name} on Base`);
  }
  if (groups.length > 0) steps.push(`What's happening in ${groups[0].name}?`);
  steps.push("Create a new group");
  return unique(steps);
}

function unique(steps: string[]): string[] {
  return [...new Set(steps)].slice(0, MAX);
}
