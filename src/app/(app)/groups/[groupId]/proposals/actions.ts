"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { ForbiddenError, explain } from "@/lib/auth/policy";
import { Money } from "@/lib/money";
import { castVote, createProposal } from "@/modules/governance/service";
import { executeRelease } from "@/modules/releases/service";
import type { CreateProposalState, VoteState } from "./state";

const createSchema = z.object({
  groupId: z.string().min(1),
  title: z.string().trim().min(3, "Give the proposal a title").max(80),
  reason: z
    .string()
    .trim()
    .min(10, "Explain why — the group is being asked to agree to this")
    .max(1000),
  amount: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,2})?$/, "Enter an amount like 120000"),
  destination: z.string().trim().max(120).optional(),
  voteDays: z.coerce.number().int().min(1).max(30).default(3),
});

export async function createProposalAction(
  _prev: CreateProposalState,
  formData: FormData,
): Promise<CreateProposalState> {
  const user = await requireUser();

  const parsed = createSchema.safeParse({
    groupId: formData.get("groupId"),
    title: formData.get("title"),
    reason: formData.get("reason"),
    amount: formData.get("amount"),
    destination: formData.get("destination") ?? undefined,
    voteDays: formData.get("voteDays") ?? 3,
  });

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { error: issue.message, field: String(issue.path[0] ?? "") };
  }

  const input = parsed.data;

  try {
    const result = await createProposal(user.id, {
      groupId: input.groupId,
      title: input.title,
      reason: input.reason,
      amount: Money.fromMajor(input.amount),
      destination: input.destination,
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

function isRedirect(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    typeof (error as { digest: unknown }).digest === "string" &&
    (error as { digest: string }).digest.startsWith("NEXT_REDIRECT")
  );
}
