import { and, count, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentDrafts, type AgentDraft } from "@/lib/db/schema";
import { Money, toCurrency } from "@/lib/money";
import { isAddress } from "viem";
import { DEFAULT_GOVERNANCE, type GovernedAction } from "@/lib/db/schema";
import { getGroupDetail, listMembers, type GroupDetail, type MemberView } from "@/modules/groups/service";
import { aiAllowedInGroup } from "./connection";
import { readRotation } from "@/modules/groups/onchain-rotation";

/**
 * Drafts a user's AI prepares for them: a spend, a rule change, a change to
 * who's in the group, or a whole-group decision (closing it). A draft is private and inert: only the user sees it, in the
 * matching channel's Waiting section, and nothing happens until they send it
 * (or they discard it).
 *
 * Everything is checked when the draft is made, so what lands in Waiting
 * always makes sense for that group. Failures come back as plain sentences
 * for the AI to relay, never as exceptions.
 */

const MAX_WAITING_PER_GROUP = 20;

export type SpendDetails = {
  what: string;
  amountMinor: string;
  currency: string;
  paidTo: { kind: "member"; memberId: string; name: string } | { kind: "address"; address: string; name: string | null };
  receiptUrl: string | null;
};

export type RuleKey = "what_everyone_pays" | "due_day" | "votes_count_share" | "share_needed" | "vote_days";

/**
 * Decisions whose share-to-pass can be changed, with their slot in the
 * contract's rule list (JfkModule's Rule enum) and their Rallied rule, if any.
 * Changing the rules also sets moving to a new contract (slot 8): it's as
 * hard as changing the rules.
 */
export const DECISIONS = {
  small_spend: { label: "A small spend", slots: [0], governed: "FUND_RELEASE_SMALL" },
  large_spend: { label: "A large spend", slots: [1], governed: "FUND_RELEASE_LARGE" },
  adding_a_member: { label: "Adding a member", slots: [2], governed: null },
  removing_a_member: { label: "Removing a member", slots: [3], governed: "REMOVE_MEMBER" },
  replacing_a_lost_wallet: { label: "Replacing a lost wallet", slots: [4], governed: null },
  what_everyone_pays: { label: "Changing what everyone pays", slots: [5], governed: "CHANGE_CONTRIBUTION" },
  changing_the_rules: { label: "Changing the rules", slots: [6, 8], governed: "CHANGE_GOVERNANCE" },
  closing_the_group: { label: "Closing the group", slots: [7], governed: "DISSOLVE_GROUP" },
} as const satisfies Record<string, { label: string; slots: readonly number[]; governed: GovernedAction | null }>;
export type DecisionKey = keyof typeof DECISIONS;

/** Shares that live only on Base, as Rallied sets them up (see contractThresholds). */
const ON_BASE_ONLY_PERMILLE: Record<number, number> = { 2: 500, 4: 750 };

export type RuleDetails = {
  rule: RuleKey;
  ruleLabel: string;
  before: string;
  after: string;
  /** Money changes start from the next round; anything else as soon as it passes. */
  starts: string;
  money: boolean;
  /**
   * The exact new value, for sending: minor units for what everyone pays, a
   * day for the due day, a whole percentage for the share that must vote,
   * tenths of a percent for a decision's share, days for how long votes stay
   * open. Missing on drafts made before it was recorded.
   */
  value?: string;
  /** share_needed only: which decision. */
  decision?: DecisionKey;
};

export type RoleChange = "make_admin" | "remove_admin" | "remove_member" | "add_member" | "replace_wallet";

export type RoleDetails = {
  change: RoleChange;
  label: string;
  /** Empty for add_member: they aren't a member yet. */
  memberId: string;
  memberName: string;
  /** add_member: their wallet. replace_wallet: the member's new wallet. */
  wallet?: string;
};

/** Whole-group decisions. Moving to a new contract comes with that contract. */
export type GroupChange = "close_group" | "change_order";

export type GroupDetails = {
  change: GroupChange;
  label: string;
  detail: string;
  /** change_order: everyone still to collect this cycle, in the new order. */
  order?: { memberId: string; name: string }[];
};

type Made = { ok: true; draft: AgentDraft } | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Shared checks
// ---------------------------------------------------------------------------

/** The group, if the user is in it, their AI may see it, and they haven't too many drafts waiting. */
async function draftableGroup(
  userId: string,
  groupId: string,
): Promise<{ ok: true; group: GroupDetail; members: MemberView[] } | { ok: false; reason: string }> {
  const [group, members, allowed] = await Promise.all([
    getGroupDetail(groupId, userId),
    listMembers(groupId, userId),
    aiAllowedInGroup(userId, groupId),
  ]);
  if (!group || !members || !allowed) {
    return { ok: false, reason: "No group with that group_id that you're a member of. Use list_groups to see your groups." };
  }
  const [{ waiting }] = await db
    .select({ waiting: count() })
    .from(agentDrafts)
    .where(and(eq(agentDrafts.userId, userId), eq(agentDrafts.groupId, groupId), eq(agentDrafts.status, "WAITING")));
  if (waiting >= MAX_WAITING_PER_GROUP) {
    return { ok: false, reason: `There are already ${waiting} drafts waiting in this group. Send or discard some first.` };
  }
  return { ok: true, group, members };
}

/** One member by name, ignoring case and spacing. Ambiguity is an error, never a guess. */
function findMember(members: MemberView[], name: string): { ok: true; member: MemberView } | { ok: false; reason: string } {
  const wanted = name.trim().toLowerCase().replace(/\s+/g, " ");
  const matches = members.filter((member) => member.displayName.trim().toLowerCase().replace(/\s+/g, " ") === wanted);
  if (matches.length === 1) return { ok: true, member: matches[0] };
  if (matches.length > 1) return { ok: false, reason: `More than one member is called "${name}". Ask the user which one.` };
  return {
    ok: false,
    reason: `No member called "${name}". Members: ${members.map((member) => member.displayName).join(", ")}.`,
  };
}

function money(amount: Money): string {
  return amount.format();
}

async function save(userId: string, groupId: string, madeBy: string, kind: AgentDraft["kind"], details: object): Promise<Made> {
  const [draft] = await db
    .insert(agentDrafts)
    .values({ userId, groupId, madeBy, kind, details: details as Record<string, unknown> })
    .returning();
  return { ok: true, draft };
}

// ---------------------------------------------------------------------------
// Spends (shared pots only)
// ---------------------------------------------------------------------------

export async function draftSpend(input: {
  userId: string;
  groupId: string;
  madeBy: string;
  what: string;
  amount: string;
  paidTo: string;
  receiptUrl?: string | null;
}): Promise<Made> {
  const checked = await draftableGroup(input.userId, input.groupId);
  if (!checked.ok) return checked;
  const { group, members } = checked;

  if (group.type === "ROTATING") {
    return { ok: false, reason: "This is a rotating savings group: each round's money goes to whoever's turn it is, so there are no spends to propose." };
  }

  const what = input.what.trim();
  if (!what || what.length > 80) return { ok: false, reason: "Say what the money is for, in under 80 characters." };

  const currency = toCurrency(group.currency);
  if (!/^\d+(\.\d{1,2})?$/.test(input.amount.trim())) {
    return { ok: false, reason: `Give the amount as a number in ${currency}, like 400 or 400.50.` };
  }
  const amount = Money.fromMajor(input.amount.trim(), currency);
  if (amount.minor <= 0n) return { ok: false, reason: "The amount must be more than zero." };

  let paidTo: SpendDetails["paidTo"];
  const recipient = input.paidTo.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
    paidTo = { kind: "address", address: recipient.toLowerCase(), name: null };
  } else {
    const found = findMember(members, recipient);
    if (!found.ok) {
      return { ok: false, reason: `${found.reason} To pay someone outside the group, give their wallet address on Base (0x…).` };
    }
    paidTo = { kind: "member", memberId: found.member.memberId, name: found.member.displayName };
  }

  let receiptUrl: string | null = null;
  if (input.receiptUrl?.trim()) {
    try {
      const url = new URL(input.receiptUrl.trim());
      if (url.protocol !== "https:") throw new Error("not https");
      receiptUrl = url.toString();
    } catch {
      return { ok: false, reason: "The receipt must be a full https:// link." };
    }
  }

  const details: SpendDetails = { what, amountMinor: amount.minor.toString(), currency, paidTo, receiptUrl };
  return save(input.userId, input.groupId, input.madeBy, "SPEND", details);
}

// ---------------------------------------------------------------------------
// Rule changes
// ---------------------------------------------------------------------------

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

function dueDayLabel(cadence: string, day: number): string {
  return cadence === "MONTHLY" ? `${ordinal(day)} of the month` : WEEKDAYS[day - 1] ?? `day ${day}`;
}

export async function draftRuleChange(input: {
  userId: string;
  groupId: string;
  madeBy: string;
  rule: RuleKey;
  value: string;
  /** share_needed only. */
  decision?: DecisionKey;
}): Promise<Made> {
  const checked = await draftableGroup(input.userId, input.groupId);
  if (!checked.ok) return checked;
  const { group } = checked;
  const value = input.value.trim();
  const every = group.cadence === "MONTHLY" ? "a month" : "a week";

  let details: RuleDetails;
  if (input.rule === "what_everyone_pays") {
    if (!/^\d+(\.\d{1,2})?$/.test(value)) return { ok: false, reason: `Give the new amount as a number in ${group.currency}, like 150.` };
    const next = Money.fromMajor(value, toCurrency(group.currency));
    if (next.minor <= 0n) return { ok: false, reason: "The new amount must be more than zero." };
    if (next.minor === group.contributionAmount.minor) return { ok: false, reason: "That's already what everyone pays." };
    details = {
      rule: input.rule,
      ruleLabel: "What everyone pays",
      before: `${money(group.contributionAmount)} ${every}`,
      after: `${money(next)} ${every}`,
      starts: "From the next round",
      money: true,
      value: next.minor.toString(),
    };
  } else if (input.rule === "due_day") {
    const day = Number(value);
    const max = group.cadence === "MONTHLY" ? 28 : 7;
    if (!Number.isInteger(day) || day < 1 || day > max) {
      return {
        ok: false,
        reason: group.cadence === "MONTHLY" ? "The due day must be a day of the month from 1 to 28." : "The due day must be 1 (Monday) to 7 (Sunday).",
      };
    }
    if (day === group.dueDay) return { ok: false, reason: "That's already the due day." };
    details = {
      rule: input.rule,
      ruleLabel: "Due day",
      before: dueDayLabel(group.cadence, group.dueDay),
      after: dueDayLabel(group.cadence, day),
      starts: "From the next round",
      money: true,
      value: String(day),
    };
  } else if (input.rule === "share_needed") {
    const decision = input.decision;
    if (!decision || !(decision in DECISIONS)) {
      return { ok: false, reason: `Say which decision: ${Object.keys(DECISIONS).join(", ")}.` };
    }
    const percent = Number(value.replace("%", ""));
    // The contract allows 50% to 100%: less than half could never be a group decision.
    if (!Number.isFinite(percent) || percent < 50 || percent > 100) return { ok: false, reason: "Give the share as a percentage from 50 to 100." };
    const permille = Math.round(percent * 10);
    const now = currentPermille(group, decision);
    if (permille === now) return { ok: false, reason: `${DECISIONS[decision].label} already needs ${now / 10}%.` };
    details = {
      rule: input.rule,
      ruleLabel: `${DECISIONS[decision].label}: share that must agree`,
      before: `${now / 10}%`,
      after: `${permille / 10}%`,
      starts: "As soon as it passes",
      money: false,
      value: String(permille),
      decision,
    };
  } else if (input.rule === "vote_days") {
    const days = Number(value);
    if (!Number.isInteger(days) || days < 1 || days > 30) return { ok: false, reason: "Votes can stay open from 1 to 30 days." };
    if (days === group.defaultVoteDays) return { ok: false, reason: `Votes already stay open ${days} days.` };
    details = {
      rule: input.rule,
      ruleLabel: "How long votes stay open",
      before: `${group.defaultVoteDays} days`,
      after: `${days} ${days === 1 ? "day" : "days"}`,
      starts: "For votes opened after it passes",
      money: false,
      value: String(days),
    };
  } else {
    const share = Number(value);
    if (!Number.isInteger(share) || share < 1 || share > 100) return { ok: false, reason: "Give the share as a whole percentage from 1 to 100." };
    if (share === group.quorumPct) return { ok: false, reason: "That's already the share that must vote." };
    details = {
      rule: input.rule,
      ruleLabel: "How many must vote for a vote to count",
      before: `${group.quorumPct}%`,
      after: `${share}%`,
      starts: "As soon as it passes",
      money: false,
      value: String(share),
    };
  }

  return save(input.userId, input.groupId, input.madeBy, "RULE_CHANGE", details);
}

// ---------------------------------------------------------------------------
// Role changes
// ---------------------------------------------------------------------------

export async function draftRoleChange(input: {
  userId: string;
  groupId: string;
  madeBy: string;
  change: RoleChange;
  memberName: string;
  /** add_member: their wallet. replace_wallet: the member's new wallet. */
  wallet?: string;
}): Promise<Made> {
  const checked = await draftableGroup(input.userId, input.groupId);
  if (!checked.ok) return checked;

  if (input.change === "add_member" || input.change === "replace_wallet") {
    if (!checked.group.safeAddress) {
      return {
        ok: false,
        reason:
          input.change === "add_member"
            ? "This group isn't on Base yet, so nobody needs voting in: share an invite link instead."
            : "This group isn't on Base yet, so there's no wallet to replace.",
      };
    }
    const wallet = input.wallet?.trim() ?? "";
    if (!isAddress(wallet)) return { ok: false, reason: "Give their wallet address on Base (0x followed by 40 letters and digits)." };
    const lower = wallet.toLowerCase();
    if (checked.members.some((member) => member.walletAddress === lower)) {
      return { ok: false, reason: "That wallet already belongs to a member of this group." };
    }
    if (input.change === "add_member") {
      const name = input.memberName.trim();
      const details: RoleDetails = { change: "add_member", label: `Add ${name} to the group`, memberId: "", memberName: name, wallet: lower };
      return save(input.userId, input.groupId, input.madeBy, "ROLE_CHANGE", details);
    }
    const found = findMember(checked.members, input.memberName);
    if (!found.ok) return found;
    const { member } = found;
    const details: RoleDetails = {
      change: "replace_wallet",
      label: `Move ${member.displayName} to a new wallet`,
      memberId: member.memberId,
      memberName: member.displayName,
      wallet: lower,
    };
    return save(input.userId, input.groupId, input.madeBy, "ROLE_CHANGE", details);
  }

  const found = findMember(checked.members, input.memberName);
  if (!found.ok) return found;
  const { member } = found;

  if (member.userId === input.userId && input.change !== "remove_admin") {
    return { ok: false, reason: input.change === "make_admin" ? "Members can't propose making themselves admin." : "To leave a group, leave it yourself rather than proposing your own removal." };
  }
  if (input.change === "make_admin" && member.role !== "MEMBER") {
    return { ok: false, reason: `${member.displayName} already looks after the group.` };
  }
  if (input.change === "remove_admin" && member.role !== "ADMIN") {
    return { ok: false, reason: `${member.displayName} isn't an admin.` };
  }

  const label =
    input.change === "make_admin"
      ? `Make ${member.displayName} an admin`
      : input.change === "remove_admin"
        ? `Remove ${member.displayName} as admin`
        : `Remove ${member.displayName} from the group`;
  const details: RoleDetails = { change: input.change, label, memberId: member.memberId, memberName: member.displayName };
  return save(input.userId, input.groupId, input.madeBy, "ROLE_CHANGE", details);
}

// ---------------------------------------------------------------------------
// Whole-group decisions
// ---------------------------------------------------------------------------

export async function draftGroupChange(input: {
  userId: string;
  groupId: string;
  madeBy: string;
  change: GroupChange;
  /** change_order: the names of everyone still to collect, in the new order. */
  order?: string[];
}): Promise<Made> {
  const checked = await draftableGroup(input.userId, input.groupId);
  if (!checked.ok) return checked;
  const { group } = checked;
  if (input.change === "change_order") return draftOrderChange(input, group, checked.members);
  if (!group.safeAddress) {
    return {
      ok: false,
      reason: "This group isn't on Base, so there's no vault to close. Its starter can delete it instead, with no vote.",
    };
  }
  const details: GroupDetails = {
    change: "close_group",
    label: `Close ${group.name}`,
    detail: "The vault is shared out by how much each member paid in, and the group ends.",
  };
  return save(input.userId, input.groupId, input.madeBy, "GROUP_CHANGE", details);
}

/**
 * A new payout order for a rotating group on Base: the same people still to
 * collect this cycle, rearranged. Checked against Base, since the order
 * there moves on its own (each payout, and anyone who misses goes to the back).
 */
async function draftOrderChange(
  input: { userId: string; groupId: string; madeBy: string; order?: string[] },
  group: GroupDetail,
  members: MemberView[],
): Promise<Made> {
  if (group.type !== "ROTATING") return { ok: false, reason: "Only a rotating group has a payout order." };
  const chain = await readRotation(group.safeAddress, members);
  if (!chain.ok) {
    return {
      ok: false,
      reason:
        chain.reason === "not_on_base"
          ? "This group isn't on Base yet. Before then the order is the order people joined; start it on Base (start_on_base) to change it by vote."
          : chain.reason === "not_rotating"
            ? "This group runs on Rallied's earlier contract, which has no payout order on Base."
            : "Couldn't reach Base just now. Try again in a moment.",
    };
  }

  // Who can still be moved: everyone who hasn't collected yet this cycle.
  const still = chain.order.slice(chain.turn).map((seat) => members.find((m) => m.userId === seat.userId) ?? null);
  if (still.some((member) => member === null)) {
    return { ok: false, reason: "Someone in this cycle isn't in Rallied's member list, so the order can't be changed here." };
  }
  const remaining = still as MemberView[];
  const names = remaining.map((m) => m.displayName).join(", ");
  if (remaining.length < 2) return { ok: false, reason: `Only ${names} still has to collect this cycle, so there's nothing to rearrange.` };

  // Matched in any case; a refusal repeats the name as it was given.
  const given = (input.order ?? []).map((name) => name.trim());
  const picked = given.map((name) => remaining.filter((m) => m.displayName.trim().toLowerCase() === name.toLowerCase()));
  const unknown = given.filter((_, i) => picked[i].length === 0);
  if (unknown.length > 0) {
    return { ok: false, reason: `${unknown.join(", ")} isn't still to collect this cycle. Still to collect: ${names}.` };
  }
  if (picked.some((match) => match.length > 1)) {
    return { ok: false, reason: "Two people still to collect have the same name, so a name alone can't place them." };
  }
  const order = picked.map(([m]) => m);
  if (new Set(order.map((m) => m.memberId)).size !== order.length || order.length !== remaining.length) {
    return { ok: false, reason: `Name everyone still to collect, once each, in the new order: ${names}.` };
  }
  if (order.every((m, i) => m.memberId === remaining[i].memberId)) {
    return { ok: false, reason: "That's already the order." };
  }

  const details: GroupDetails = {
    change: "change_order",
    label: "Change the payout order",
    detail: `Still to collect this cycle, in order: ${order.map((m) => m.displayName).join(", ")}.`,
    order: order.map((m) => ({ memberId: m.memberId, name: m.displayName })),
  };
  return save(input.userId, input.groupId, input.madeBy, "GROUP_CHANGE", details);
}

// ---------------------------------------------------------------------------
// Reading and discarding
// ---------------------------------------------------------------------------

/** The user's drafts waiting in one group, newest first, optionally of one kind. */
export async function listWaitingDrafts(userId: string, groupId: string, kind?: AgentDraft["kind"]): Promise<AgentDraft[]> {
  return db
    .select()
    .from(agentDrafts)
    .where(
      and(
        eq(agentDrafts.userId, userId),
        eq(agentDrafts.groupId, groupId),
        eq(agentDrafts.status, "WAITING"),
        ...(kind ? [eq(agentDrafts.kind, kind)] : []),
      ),
    )
    .orderBy(desc(agentDrafts.createdAt));
}

/**
 * How many drafts the user has waiting, per group and kind, for the sidebar's
 * counts. One query for all their groups.
 */
export async function countWaitingDrafts(userId: string): Promise<Map<string, Partial<Record<AgentDraft["kind"], number>>>> {
  const rows = await db
    .select({ groupId: agentDrafts.groupId, kind: agentDrafts.kind, waiting: count() })
    .from(agentDrafts)
    .where(and(eq(agentDrafts.userId, userId), eq(agentDrafts.status, "WAITING")))
    .groupBy(agentDrafts.groupId, agentDrafts.kind);

  const byGroup = new Map<string, Partial<Record<AgentDraft["kind"], number>>>();
  for (const row of rows) byGroup.set(row.groupId, { ...byGroup.get(row.groupId), [row.kind]: row.waiting });
  return byGroup;
}

/** Throw away one of the user's own waiting drafts. Anyone else's looks like it doesn't exist. */
export async function discardDraft(userId: string, draftId: string, now: Date = new Date()): Promise<{ ok: true } | { ok: false; reason: "not_found" }> {
  const [row] = await db
    .update(agentDrafts)
    .set({ status: "DISCARDED", decidedAt: now })
    .where(and(eq(agentDrafts.id, draftId), eq(agentDrafts.userId, userId), eq(agentDrafts.status, "WAITING")))
    .returning({ id: agentDrafts.id });
  return row ? { ok: true } : { ok: false, reason: "not_found" };
}

/** The share a decision needs now, in tenths of a percent: the group's rule, or how Rallied set it up on Base. */
function currentPermille(group: GroupDetail, decision: DecisionKey): number {
  const { slots, governed } = DECISIONS[decision];
  if (!governed) return ON_BASE_ONLY_PERMILLE[slots[0]];
  return group.governance.find((rule) => rule.action === governed)?.thresholdPermille ?? DEFAULT_GOVERNANCE[governed];
}
