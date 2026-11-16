import { and, count, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentDrafts, type AgentDraft } from "@/lib/db/schema";
import { Money, toCurrency } from "@/lib/money";
import { getGroupDetail, listMembers, type GroupDetail, type MemberView } from "@/modules/groups/service";
import { aiAllowedInGroup } from "./connection";

/**
 * Drafts a user's AI prepares for them: a spend, a rule change or a role
 * change. A draft is private and inert: only the user sees it, in the
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

export type RuleKey = "what_everyone_pays" | "due_day" | "votes_count_share";

export type RuleDetails = {
  rule: RuleKey;
  ruleLabel: string;
  before: string;
  after: string;
  /** Money changes start from the next round; anything else as soon as it passes. */
  starts: string;
  money: boolean;
};

export type RoleChange = "make_admin" | "remove_admin" | "remove_member";

export type RoleDetails = { change: RoleChange; label: string; memberId: string; memberName: string };

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
  return `${amount.currency} ${amount.format({ compact: true, showSymbol: false })}`;
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
}): Promise<Made> {
  const checked = await draftableGroup(input.userId, input.groupId);
  if (!checked.ok) return checked;
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
