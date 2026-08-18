"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { ForbiddenError, explain } from "@/lib/auth/policy";
import { Money } from "@/lib/money";
import { castVote, createProposal } from "@/modules/governance/service";
import {
  THRESHOLD_ACTION_LABELS,
  type ProposalPayload,
} from "@/modules/governance/kinds";
import type { GovernedAction } from "@/lib/db/schema";
import { executeRelease } from "@/modules/releases/service";
import type { CreateProposalState, VoteState } from "./state";

const createSchema = z.object({
  groupId: z.string().min(1),
  kind: z
    .enum([
      "SPEND",
      "CHANGE_CONTRIBUTION",
      "CHANGE_THRESHOLD",
      "REMOVE_MEMBER",
      "REMOVE_ADMIN",
    ])
    .default("SPEND"),
  title: z.string().trim().min(3, "Give the proposal a title").max(80),
  reason: z
    .string()
    .trim()
    .min(10, "Explain why — the group is being asked to agree to this")
    .max(1000),
  voteDays: z.coerce.number().int().min(1).max(30).default(3),

  // Spend
  amount: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,2})?$/, "Enter an amount like 120000")
    .optional(),
  destination: z.string().trim().max(120).optional(),

  // Change the contribution
  newAmount: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,2})?$/, "Enter an amount like 80000")
    .optional(),
  newCadence: z.enum(["WEEKLY", "MONTHLY"]).optional(),
  newDueDay: z.coerce.number().int().min(1).max(28).optional(),

  // Change a threshold
  thresholdAction: z.string().optional(),
  newThreshold: z.coerce.number().int().optional(),

  // Remove someone
  targetUserId: z.string().optional(),
});

export async function createProposalAction(
  _prev: CreateProposalState,
  formData: FormData,
): Promise<CreateProposalState> {
  const user = await requireUser();

  const parsed = createSchema.safeParse({
    groupId: formData.get("groupId"),
    kind: formData.get("kind") ?? "SPEND",
    title: formData.get("title"),
    reason: formData.get("reason"),
    voteDays: formData.get("voteDays") ?? 3,
    amount: formData.get("amount") ?? undefined,
    destination: formData.get("destination") ?? undefined,
    newAmount: formData.get("newAmount") ?? undefined,
    newCadence: formData.get("newCadence") ?? undefined,
    newDueDay: formData.get("newDueDay") ?? undefined,
    thresholdAction: formData.get("thresholdAction") ?? undefined,
    newThreshold: formData.get("newThreshold") ?? undefined,
    targetUserId: formData.get("targetUserId") ?? undefined,
  });

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { error: issue.message, field: String(issue.path[0] ?? "") };
  }

  const input = parsed.data;

  const built = buildPayload(input);
  if ("error" in built) return built.error;

  try {
    const result = await createProposal(user.id, {
      groupId: input.groupId,
      title: input.title,
      reason: input.reason,
      kind: input.kind,
      amount: built.amount,
      destination: input.destination,
      payload: built.payload,
      voteDays: input.voteDays,
    });

    if (!result.ok) {
      return {
        error: result.message,
        field: result.reason === "insufficient_funds" ? "amount" : undefined,
      };
    }

    revalidatePath(`/groups/${input.groupId}`);
    redirect(`/groups/${input.groupId}/proposals/${result.proposalId}`);
  } catch (error) {
    if (isRedirect(error)) throw error;
    if (error instanceof ForbiddenError) return { error: explain(error.decision) };
    throw error;
  }
}

const voteSchema = z.object({
  proposalId: z.string().min(1),
  groupId: z.string().min(1),
  choice: z.enum(["YES", "NO", "ABSTAIN"]),
  reason: z.string().trim().max(500).optional(),
});

export async function castVoteAction(
  _prev: VoteState,
  formData: FormData,
): Promise<VoteState> {
  const user = await requireUser();

  const parsed = voteSchema.safeParse({
    proposalId: formData.get("proposalId"),
    groupId: formData.get("groupId"),
    choice: formData.get("choice"),
    reason: formData.get("reason") ?? undefined,
  });

  if (!parsed.success) return { error: "That vote wasn't valid." };

  try {
    const result = await castVote(
      parsed.data.proposalId,
      user.id,
      parsed.data.choice,
      parsed.data.reason,
    );

    if (!result.ok) return { error: result.message };

    revalidatePath(`/groups/${parsed.data.groupId}`);

    // Say what the vote did, not just that it was recorded.
    if (result.outcome.decision === "approved") {
      return { message: "That passed it — the funds are now reserved." };
    }
    if (result.outcome.decision === "rejected") {
      return { message: "That settled it. The proposal did not pass." };
    }
    return { message: "Vote recorded." };
  } catch (error) {
    if (error instanceof ForbiddenError) return { error: explain(error.decision) };
    throw error;
  }
}

/**
 * Pay out an approved proposal.
 *
 * The `mode` decides which route out: a provider transfer (simulated in this
 * build), a payout the admin already made themselves, or a deliberate failure
 * so the reversal path can be demonstrated.
 */
export async function executeReleaseAction(
  _prev: VoteState,
  formData: FormData,
): Promise<VoteState> {
  const user = await requireUser();
  const proposalId = String(formData.get("proposalId") ?? "");
  const groupId = String(formData.get("groupId") ?? "");
  const mode = String(formData.get("mode") ?? "transfer");

  try {
    const result = await executeRelease(proposalId, user.id, {
      manual: mode === "manual",
      simulateFailure: mode === "fail",
    });

    revalidatePath(`/groups/${groupId}`);
    revalidatePath(`/groups/${groupId}/proposals/${proposalId}`);

    if (!result.ok) return { error: result.message };

    return {
      message:
        mode === "manual"
          ? `Recorded. ${result.amount.format()} has left the group's books.`
          : `Sent. ${result.amount.format()} has left the group.`,
    };
  } catch (error) {
    if (error instanceof ForbiddenError) return { error: explain(error.decision) };
    throw error;
  }
}

/**
 * Turn the flat form into the amount and typed payload the service wants.
 *
 * Each kind needs different fields, and a form cannot enforce "required, but
 * only when this radio is selected". So the check happens here, and the
 * message points at the field that is actually missing.
 */
function buildPayload(
  input: z.infer<typeof createSchema>,
):
  | { amount?: Money; payload: ProposalPayload }
  | { error: CreateProposalState } {
  switch (input.kind) {
    case "SPEND": {
      if (!input.amount) {
        return {
          error: { error: "A spending proposal needs an amount.", field: "amount" },
        };
      }
      return { amount: Money.fromMajor(input.amount), payload: { kind: "SPEND" } };
    }

    case "CHANGE_CONTRIBUTION": {
      if (!input.newAmount) {
        return {
          error: { error: "Enter the new contribution amount.", field: "newAmount" },
        };
      }
      return {
        payload: {
          kind: "CHANGE_CONTRIBUTION",
          amountMinor: Money.fromMajor(input.newAmount).minor.toString(),
          cadence: input.newCadence ?? "MONTHLY",
          dueDay: input.newDueDay ?? 1,
        },
      };
    }

    case "CHANGE_THRESHOLD": {
      const action = input.thresholdAction;
      if (!action || !(action in THRESHOLD_ACTION_LABELS)) {
        return { error: { error: "Pick which rule to change." } };
      }
      if (!input.newThreshold) {
        return { error: { error: "Pick a new threshold." } };
      }
      return {
        payload: {
          kind: "CHANGE_THRESHOLD",
          action: action as GovernedAction,
          thresholdPermille: input.newThreshold,
        },
      };
    }

    case "REMOVE_MEMBER":
    case "REMOVE_ADMIN": {
      if (!input.targetUserId) {
        return { error: { error: "Pick who this is about." } };
      }
      return {
        payload: {
          kind: input.kind,
          userId: input.targetUserId,
          // Filled in by the service from the membership; a name supplied by
          // the browser is not worth trusting on a governance record.
          displayName: "",
        },
      };
    }
  }
}

function isRedirect(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    typeof (error as { digest: unknown }).digest === "string" &&
    (error as { digest: string }).digest.startsWith("NEXT_REDIRECT")
  );
}
