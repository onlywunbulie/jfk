import { describe, expect, it } from "vitest";
import { can, assertCan, explain, ForbiddenError, type Action, type PolicyContext } from "./policy";
import type { MemberRole } from "@/lib/db/schema";

const ALL_ACTIONS: Action[] = [
  "group.view",
  "group.contribute",
  "group.chat",
  "group.vote",
  "proposal.create",
  "member.invite",
  "member.remove",
  "group.settings.edit",
  "chat.moderate",
  "proposal.execute",
  "role.grant_admin",
  "role.revoke_admin",
  "group.transfer_ownership",
  "group.contribution.change",
  "group.governance.change",
  "funds.release",
  "group.dissolve",
  "rotation.order.change",
];

const ROLES: MemberRole[] = ["MEMBER", "ADMIN", "OWNER"];

function context(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    role: "MEMBER",
    isActive: true,
    groupStatus: "ACTIVE",
    activeMemberCount: 10,
    membersCanPropose: true,
    ...overrides,
  };
}

/** Compact outcome label so the matrix below reads as a table. */
function outcome(action: Action, ctx: PolicyContext): string {
  const decision = can(action, ctx);
  if (decision.allowed) return "allow";
  return decision.reason === "needs_proposal"
    ? `vote:${decision.governedBy}`
    : decision.reason;
}

describe("permission matrix — every role × action", () => {
  // The full expected matrix. A missing cell fails the suite, so a new action
  // cannot be added without a deliberate decision about who may perform it.
  const EXPECTED: Record<Action, Record<MemberRole, string>> = {
    "group.view": { MEMBER: "allow", ADMIN: "allow", OWNER: "allow" },
    "group.contribute": { MEMBER: "allow", ADMIN: "allow", OWNER: "allow" },
    "group.chat": { MEMBER: "allow", ADMIN: "allow", OWNER: "allow" },
    "group.vote": { MEMBER: "allow", ADMIN: "allow", OWNER: "allow" },
    "proposal.create": { MEMBER: "allow", ADMIN: "allow", OWNER: "allow" },

    "member.invite": {
      MEMBER: "insufficient_role",
      ADMIN: "allow",
      OWNER: "allow",
    },
    "group.settings.edit": {
      MEMBER: "insufficient_role",
      ADMIN: "allow",
      OWNER: "allow",
    },
    "chat.moderate": {
      MEMBER: "insufficient_role",
      ADMIN: "allow",
      OWNER: "allow",
    },
    "proposal.execute": {
      MEMBER: "insufficient_role",
      ADMIN: "allow",
      OWNER: "allow",
    },

    "role.grant_admin": {
      MEMBER: "insufficient_role",
      ADMIN: "insufficient_role",
      OWNER: "allow",
    },
    "group.transfer_ownership": {
      MEMBER: "insufficient_role",
      ADMIN: "insufficient_role",
      OWNER: "allow",
    },

    // In a 10-member group, removing a plain member is governed for everyone.
    "member.remove": {
      MEMBER: "vote:REMOVE_MEMBER",
      ADMIN: "vote:REMOVE_MEMBER",
      OWNER: "vote:REMOVE_MEMBER",
    },
    "role.revoke_admin": {
      MEMBER: "vote:REMOVE_ADMIN",
      ADMIN: "vote:REMOVE_ADMIN",
      OWNER: "vote:REMOVE_ADMIN",
    },

    // Nobody — not even the owner — moves money or rewrites rules alone.
    "group.contribution.change": {
      MEMBER: "vote:CHANGE_CONTRIBUTION",
      ADMIN: "vote:CHANGE_CONTRIBUTION",
      OWNER: "vote:CHANGE_CONTRIBUTION",
    },
    "group.governance.change": {
      MEMBER: "vote:CHANGE_GOVERNANCE",
      ADMIN: "vote:CHANGE_GOVERNANCE",
      OWNER: "vote:CHANGE_GOVERNANCE",
    },
    "funds.release": {
      MEMBER: "vote:FUND_RELEASE_SMALL",
      ADMIN: "vote:FUND_RELEASE_SMALL",
      OWNER: "vote:FUND_RELEASE_SMALL",
    },
    "group.dissolve": {
      MEMBER: "vote:DISSOLVE_GROUP",
      ADMIN: "vote:DISSOLVE_GROUP",
      OWNER: "vote:DISSOLVE_GROUP",
    },
    "rotation.order.change": {
      MEMBER: "vote:ROTATION_ORDER_CHANGE",
      ADMIN: "vote:ROTATION_ORDER_CHANGE",
      OWNER: "vote:ROTATION_ORDER_CHANGE",
    },
  };

  it("covers every action with no gaps", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...ALL_ACTIONS].sort());
  });

  for (const action of ALL_ACTIONS) {
    for (const role of ROLES) {
      it(`${role} · ${action} → ${EXPECTED[action][role]}`, () => {
        expect(outcome(action, context({ role, targetRole: "MEMBER" }))).toBe(
          EXPECTED[action][role],
        );
      });
    }
  }
});

describe("the admin ≠ owner-of-the-money rule", () => {
  it("denies every money-moving action to every role", () => {
    const moneyActions: Action[] = [
      "funds.release",
      "group.contribution.change",
      "group.dissolve",
    ];

    for (const action of moneyActions) {
      for (const role of ROLES) {
        const decision = can(action, context({ role }));
        expect(decision.allowed).toBe(false);
        if (!decision.allowed) expect(decision.reason).toBe("needs_proposal");
      }
    }
  });
});

describe("membership gates", () => {
  it("refuses non-members outright", () => {
    expect(can("group.view", context({ role: null }))).toEqual({
      allowed: false,
      reason: "not_a_member",
    });
  });

  it("refuses invited-but-not-joined and removed members", () => {
    for (const action of ALL_ACTIONS) {
      const decision = can(action, context({ role: "OWNER", isActive: false }));
      expect(decision).toEqual({ allowed: false, reason: "inactive_member" });
    }
  });
});

describe("dissolved groups", () => {
  it("stay readable", () => {
    expect(can("group.view", context({ groupStatus: "DISSOLVED" })).allowed).toBe(
      true,
    );
  });

  it("accept nothing else, even from the owner", () => {
    for (const action of ALL_ACTIONS.filter((a) => a !== "group.view")) {
      expect(
        can(action, context({ role: "OWNER", groupStatus: "DISSOLVED" })),
      ).toEqual({ allowed: false, reason: "group_inactive" });
    }
  });

  it("still allows normal actions while merely dissolving", () => {
    expect(
      can("group.chat", context({ groupStatus: "DISSOLVING" })).allowed,
    ).toBe(true);
  });
});

describe("proposal.create respects the group setting", () => {
  it("lets members propose when enabled", () => {
    expect(can("proposal.create", context({ membersCanPropose: true })).allowed).toBe(
      true,
    );
  });

  it("falls back to admins when disabled", () => {
    const ctx = { membersCanPropose: false };
    expect(can("proposal.create", context({ ...ctx, role: "MEMBER" }))).toEqual({
      allowed: false,
      reason: "insufficient_role",
      requires: "ADMIN",
    });
    expect(can("proposal.create", context({ ...ctx, role: "ADMIN" })).allowed).toBe(
      true,
    );
  });
});

describe("member.remove edge cases", () => {
  it("is an admin call in a group too small for a vote to mean anything", () => {
    const ctx = context({ role: "ADMIN", activeMemberCount: 2, targetRole: "MEMBER" });
    expect(can("member.remove", ctx).allowed).toBe(true);
  });

  it("still refuses a plain member in a small group", () => {
    const ctx = context({ role: "MEMBER", activeMemberCount: 2, targetRole: "MEMBER" });
    expect(can("member.remove", ctx)).toEqual({
      allowed: false,
      reason: "insufficient_role",
      requires: "ADMIN",
    });
  });

  it("becomes governed once the group reaches three members", () => {
    const ctx = context({ role: "ADMIN", activeMemberCount: 3, targetRole: "MEMBER" });
    expect(can("member.remove", ctx)).toEqual({
      allowed: false,
      reason: "needs_proposal",
      governedBy: "REMOVE_MEMBER",
    });
  });

  it("always governs removing an admin, however small the group", () => {
    const ctx = context({ role: "OWNER", activeMemberCount: 2, targetRole: "ADMIN" });
    expect(can("member.remove", ctx)).toEqual({
      allowed: false,
      reason: "needs_proposal",
      governedBy: "REMOVE_ADMIN",
    });
  });

  it("never lets anyone remove the owner without dissolving the group", () => {
    const ctx = context({ role: "ADMIN", activeMemberCount: 10, targetRole: "OWNER" });
    expect(can("member.remove", ctx)).toEqual({
      allowed: false,
      reason: "needs_proposal",
      governedBy: "DISSOLVE_GROUP",
    });
  });

  it("refuses self-removal — leaving is a different action", () => {
    const ctx = context({ role: "ADMIN", targetIsSelf: true, activeMemberCount: 2 });
    expect(can("member.remove", ctx)).toEqual({
      allowed: false,
      reason: "self_target",
    });
  });
});

describe("assertCan", () => {
  it("passes silently when allowed", () => {
    expect(() => assertCan("group.view", context())).not.toThrow();
  });

  it("throws a ForbiddenError carrying the decision", () => {
    try {
      assertCan("funds.release", context({ role: "OWNER" }));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenError);
      const forbidden = error as ForbiddenError;
      expect(forbidden.action).toBe("funds.release");
      expect(forbidden.decision.reason).toBe("needs_proposal");
    }
  });
});

describe("explain", () => {
  it("produces a member-safe sentence for every reason", () => {
    const decisions = [
      can("group.view", context({ role: null })),
      can("group.view", context({ isActive: false })),
      can("member.invite", context({ role: "MEMBER" })),
      can("funds.release", context()),
      can("group.chat", context({ groupStatus: "DISSOLVED" })),
      can("member.remove", context({ role: "ADMIN", targetIsSelf: true })),
    ];

    for (const decision of decisions) {
      const message = explain(decision);
      expect(message.length).toBeGreaterThan(0);
      // Never leak internals like enum names to a member.
      expect(message).not.toMatch(/[A-Z]{2,}_/);
    }
  });
});
