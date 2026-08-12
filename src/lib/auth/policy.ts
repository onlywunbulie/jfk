import type { GovernedAction, MemberRole } from "@/lib/db/schema";
import { GOVERNED_REMOVAL_MIN_MEMBERS } from "@/lib/db/schema";

/**
 * The permission matrix from BLUEPRINT.md §6, in one place.
 *
 * The rule that matters: **an admin is not an owner of the money.** Admins can
 * run the group's day-to-day, but every action that moves funds or rewrites the
 * rules resolves to `needs_proposal` — no role can bypass it, including OWNER.
 *
 * Every server action calls `can()`. Roles are never checked inline in UI code,
 * because a check that lives in a component is a check that gets forgotten on
 * the next screen.
 */

export type Action =
  // Read
  | "group.view"
  // Participation — any active member
  | "group.contribute"
  | "group.chat"
  | "group.vote"
  | "proposal.create"
  // Administration
  | "member.invite"
  | "member.remove"
  | "group.settings.edit"
  | "chat.moderate"
  | "proposal.execute"
  // Ownership
  | "role.grant_admin"
  | "role.revoke_admin"
  | "group.transfer_ownership"
  // Always governed — listed so the matrix is exhaustive and testable
  | "group.contribution.change"
  | "group.governance.change"
  | "group.lock.change"
  | "funds.release"
  | "group.dissolve"
  | "rotation.order.change";

export type Decision =
  | { allowed: true }
  | { allowed: false; reason: "not_a_member" }
  | { allowed: false; reason: "inactive_member" }
  | { allowed: false; reason: "insufficient_role"; requires: MemberRole }
  | { allowed: false; reason: "needs_proposal"; governedBy: GovernedAction }
  | { allowed: false; reason: "group_inactive" }
  | { allowed: false; reason: "self_target" };

export interface PolicyContext {
  /** Null when the user has no membership row at all. */
  role: MemberRole | null;
  /** False for INVITED, LEFT or REMOVED members. */
  isActive: boolean;
  groupStatus: "ACTIVE" | "DISSOLVING" | "DISSOLVED";
  /** Count of ACTIVE members, used for the small-group removal exemption. */
  activeMemberCount: number;
  /** Group setting: may ordinary members open proposals. */
  membersCanPropose: boolean;
  /** True when the action targets the actor themselves. */
  targetIsSelf?: boolean;
  /** Role of the member being acted on, for removal and role changes. */
  targetRole?: MemberRole | null;
}

const ROLE_RANK: Record<MemberRole, number> = { MEMBER: 0, ADMIN: 1, OWNER: 2 };

function atLeast(role: MemberRole, required: MemberRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

/** Actions that no role may perform directly — they require a passed vote. */
const ALWAYS_GOVERNED: Partial<Record<Action, GovernedAction>> = {
  "group.contribution.change": "CHANGE_CONTRIBUTION",
  "group.governance.change": "CHANGE_GOVERNANCE",
  "group.lock.change": "CHANGE_LOCK_RULE",
  "funds.release": "FUND_RELEASE_SMALL",
  "group.dissolve": "DISSOLVE_GROUP",
  "rotation.order.change": "ROTATION_ORDER_CHANGE",
};

/** Minimum role for actions that are a straightforward role check. */
const REQUIRED_ROLE: Partial<Record<Action, MemberRole>> = {
  "group.view": "MEMBER",
  "group.contribute": "MEMBER",
  "group.chat": "MEMBER",
  "group.vote": "MEMBER",
  "member.invite": "ADMIN",
  "group.settings.edit": "ADMIN",
  "chat.moderate": "ADMIN",
  "proposal.execute": "ADMIN",
  "role.grant_admin": "OWNER",
  "group.transfer_ownership": "OWNER",
};

export function can(action: Action, context: PolicyContext): Decision {
  const { role, isActive, groupStatus } = context;

  if (role === null) return { allowed: false, reason: "not_a_member" };
  if (!isActive) return { allowed: false, reason: "inactive_member" };

  // A dissolved group is readable history and nothing more.
  if (groupStatus === "DISSOLVED" && action !== "group.view") {
    return { allowed: false, reason: "group_inactive" };
  }

  const governed = ALWAYS_GOVERNED[action];
  if (governed) return { allowed: false, reason: "needs_proposal", governedBy: governed };

  switch (action) {
    /**
     * Proposal creation is a group setting. When members may not propose, it
     * falls back to an admin action rather than being forbidden outright.
     */
    case "proposal.create": {
      if (context.membersCanPropose) return { allowed: true };
      return atLeast(role, "ADMIN")
        ? { allowed: true }
        : { allowed: false, reason: "insufficient_role", requires: "ADMIN" };
    }

    /**
     * Removal is an admin action in a small group, where a vote among two or
     * three people is theatre, and a governed action once the group is big
     * enough for the vote to mean something. Removing an admin is always
     * governed regardless of size.
     */
    case "member.remove": {
      if (context.targetIsSelf) return { allowed: false, reason: "self_target" };
      if (context.targetRole === "OWNER") {
        return { allowed: false, reason: "needs_proposal", governedBy: "DISSOLVE_GROUP" };
      }
      if (context.targetRole === "ADMIN") {
        return { allowed: false, reason: "needs_proposal", governedBy: "REMOVE_ADMIN" };
      }
      if (context.activeMemberCount >= GOVERNED_REMOVAL_MIN_MEMBERS) {
        return { allowed: false, reason: "needs_proposal", governedBy: "REMOVE_MEMBER" };
      }
      return atLeast(role, "ADMIN")
        ? { allowed: true }
        : { allowed: false, reason: "insufficient_role", requires: "ADMIN" };
    }

    /**
     * An owner may hand out admin freely, but taking it back is governed —
     * otherwise an owner could strip every dissenting admin before a vote.
     */
    case "role.revoke_admin": {
      return { allowed: false, reason: "needs_proposal", governedBy: "REMOVE_ADMIN" };
    }

    default: {
      const required = REQUIRED_ROLE[action];
      /* c8 ignore next 3 -- unreachable while REQUIRED_ROLE covers the union */
      if (!required) {
        throw new Error(`No policy defined for action "${action}"`);
      }
      return atLeast(role, required)
        ? { allowed: true }
        : { allowed: false, reason: "insufficient_role", requires: required };
    }
  }
}

/** Throwing wrapper for server actions, which should refuse rather than branch. */
export function assertCan(action: Action, context: PolicyContext): void {
  const decision = can(action, context);
  if (!decision.allowed) throw new ForbiddenError(action, decision);
}

export class ForbiddenError extends Error {
  constructor(
    readonly action: Action,
    readonly decision: Extract<Decision, { allowed: false }>,
  ) {
    super(`Not allowed to ${action}: ${decision.reason}`);
    this.name = "ForbiddenError";
  }
}

/** Human-readable explanation, safe to show a member. */
export function explain(decision: Decision): string {
  if (decision.allowed) return "Allowed";
  switch (decision.reason) {
    case "not_a_member":
      return "You're not a member of this group.";
    case "inactive_member":
      return "Your membership isn't active.";
    case "insufficient_role":
      return `Only ${decision.requires.toLowerCase()}s can do that.`;
    case "needs_proposal":
      return "This needs a proposal the group votes on.";
    case "group_inactive":
      return "This group has been dissolved.";
    case "self_target":
      return "You can't do that to yourself.";
  }
}
