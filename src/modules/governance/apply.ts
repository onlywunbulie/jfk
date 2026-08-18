import "server-only";
import { and, eq } from "drizzle-orm";
import type { Transaction } from "@/lib/db";
import {
  governanceRules,
  groupMembers,
  groupSettings,
} from "@/lib/db/schema";
import {
  MAX_THRESHOLD_PERMILLE,
  MIN_THRESHOLD_PERMILLE,
} from "@/modules/groups/service";
import { recordAudit } from "@/modules/audit/service";
import type { ProposalPayload } from "./kinds";

/**
 * Carrying out what the group voted for.
 *
 * Rule changes apply the moment a proposal passes, in the same transaction
 * that settles the vote. That differs from spending on purpose: sending money
 * is irreversible and needs a human at the bank, whereas writing a number to a
 * settings row does not. Making the group press a second button to enact its
 * own decision would be ceremony, not safety.
 *
 * Every branch re-clamps its input. The values were validated when the
 * proposal was created, but they have since sat in a jsonb column for days —
 * and this is the last point before they become the group's rules.
 */
export async function applyProposalPayload(
  tx: Transaction,
  groupId: string,
  proposalId: string,
  payload: ProposalPayload,
): Promise<void> {
  switch (payload.kind) {
    // Money is reserved on approval and sent by an admin afterwards; there is
    // nothing to apply here.
    case "SPEND":
      return;

    case "CHANGE_CONTRIBUTION": {
      const amount = BigInt(payload.amountMinor);
      if (amount <= 0n) return;

      await tx
        .update(groupSettings)
        .set({
          contributionAmount: amount,
          cadence: payload.cadence,
          dueDay: Math.min(28, Math.max(1, payload.dueDay)),
        })
        .where(eq(groupSettings.groupId, groupId));

      await recordAudit(tx, {
        action: "group.settings.updated",
        groupId,
        subjectType: "proposal",
        subjectId: proposalId,
        after: {
          contributionAmount: amount,
          cadence: payload.cadence,
          dueDay: payload.dueDay,
          via: "vote",
        },
      });
      return;
    }

    case "CHANGE_THRESHOLD": {
      const permille = Math.min(
        MAX_THRESHOLD_PERMILLE,
        Math.max(MIN_THRESHOLD_PERMILLE, Math.round(payload.thresholdPermille)),
      );

      await tx
        .update(governanceRules)
        .set({ thresholdPermille: permille })
        .where(
          and(
            eq(governanceRules.groupId, groupId),
            eq(governanceRules.action, payload.action),
          ),
        );

      await recordAudit(tx, {
        action: "group.settings.updated",
        groupId,
        subjectType: "proposal",
        subjectId: proposalId,
        after: { threshold: payload.action, permille, via: "vote" },
      });
      return;
    }

    case "REMOVE_MEMBER": {
      /**
       * The membership row is kept and marked REMOVED rather than deleted, so
       * their contribution history stays attached to the group's books.
       *
       * Their money is deliberately not returned here. Refunding is a spend,
       * and a spend is its own proposal — the group should decide the amount
       * explicitly rather than have it happen as a side effect of a removal.
       */
      await tx
        .update(groupMembers)
        .set({
          status: "REMOVED",
          exitedAt: new Date(),
          rotationPosition: null,
        })
        .where(
          and(
            eq(groupMembers.groupId, groupId),
            eq(groupMembers.userId, payload.userId),
            eq(groupMembers.status, "ACTIVE"),
          ),
        );

      await recordAudit(tx, {
        action: "member.removed",
        groupId,
        subjectType: "user",
        subjectId: payload.userId,
        after: { via: "vote", proposalId },
      });
      return;
    }

    case "REMOVE_ADMIN": {
      // Demoted, not removed. The vote was about their powers, not their
      // membership, and conflating the two would take more than was asked.
      await tx
        .update(groupMembers)
        .set({ role: "MEMBER" })
        .where(
          and(
            eq(groupMembers.groupId, groupId),
            eq(groupMembers.userId, payload.userId),
            eq(groupMembers.role, "ADMIN"),
          ),
        );

      await recordAudit(tx, {
        action: "member.role_changed",
        groupId,
        subjectType: "user",
        subjectId: payload.userId,
        before: { role: "ADMIN" },
        after: { role: "MEMBER", via: "vote", proposalId },
      });
      return;
    }
  }
}
