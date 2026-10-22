"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { ForbiddenError, assertCan, explain } from "@/lib/auth/policy";
import { Money } from "@/lib/money";
import * as groupsService from "@/modules/groups/service";
import { startGroupOnChain } from "@/modules/groups/onchain";
import { chargeContribution } from "@/modules/payments/contribute";
import type { GovernedAction } from "@/lib/db/schema";
import { ALL_GOVERNED_ACTIONS } from "./new/governance-options";
import {
  simulateContribution,
  SimulationNotAllowedError,
} from "@/modules/payments/simulate";
import type {
  ContributeState,
  CreateGroupState,
  InviteState,
  MemberActionState,
  StartOnChainState,
} from "./state";

async function clientIp(): Promise<string | null> {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip");
  return ip && /^[0-9a-fA-F.:]+$/.test(ip) ? ip : null;
}

const createGroupSchema = z.object({
  name: z.string().trim().min(2, "Give the group a name").max(60),
  description: z.string().trim().max(280).optional(),
  type: z.enum(["TREASURY", "ROTATING"]),
  // Naira, entered as a plain number. Money.fromMajor rejects sub-kobo values.
  amount: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,2})?$/, "Enter an amount like 50 or 12.50")
    .refine((v) => Number(v) > 0, "The amount must be more than zero"),
  cadence: z.enum(["WEEKLY", "MONTHLY"]),
  dueDay: z.coerce.number().int().min(1).max(28),
  membersCanPropose: z.union([z.literal("on"), z.null()]).optional(),
});

export async function createGroupAction(
  _prev: CreateGroupState,
  formData: FormData,
): Promise<CreateGroupState> {
  const user = await requireUser();

  const parsed = createGroupSchema.safeParse({
    name: formData.get("name"),
    description: formData.get("description") ?? undefined,
    type: formData.get("type"),
    amount: formData.get("amount"),
    cadence: formData.get("cadence"),
    dueDay: formData.get("dueDay"),
    membersCanPropose: formData.get("membersCanPropose"),
  });

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      error: issue.message,
      field: String(issue.path[0] ?? ""),
    };
  }

  const input = parsed.data;
  const { groupId } = await groupsService.createGroup(
    user.id,
    {
      name: input.name,
      description: input.description ?? null,
      type: input.type,
      // Every group made from here on lives on-chain and saves in USDC.
      contributionAmount: Money.fromMajor(input.amount, "USDC"),
      cadence: input.cadence,
      dueDay: input.dueDay,
      membersCanPropose: input.membersCanPropose === "on",
      governance: readThresholds(formData),
      quorumPct: Number(formData.get("quorumPct") ?? 60),
    },
    { ip: await clientIp() },
  );

  revalidatePath("/");
  revalidatePath("/groups");
  redirect(`/groups/${groupId}`);
}

export async function createInviteAction(
  _prev: InviteState,
  formData: FormData,
): Promise<InviteState> {
  const user = await requireUser();
  const groupId = String(formData.get("groupId") ?? "");
  const maxUses = Number(formData.get("maxUses") ?? 1);

  try {
    const result = await groupsService.createInvite(
      groupId,
      user.id,
      { maxUses: Number.isFinite(maxUses) ? Math.min(Math.max(maxUses, 1), 50) : 1 },
      { ip: await clientIp() },
    );

    if (!result.ok) return { error: "You can't invite people to this group." };

    revalidatePath(`/groups/${groupId}`);
    return { code: result.code, expiresAt: result.expiresAt.toISOString() };
  } catch (error) {
    return { error: forbiddenMessage(error) };
  }
}

export async function acceptInviteAction(code: string): Promise<never> {
  const user = await requireUser();
  const result = await groupsService.acceptInvite(code, user.id, {
    ip: await clientIp(),
  });

  if (!result.ok) redirect(`/join/${code}?error=${result.reason}`);

  revalidatePath("/");
  revalidatePath("/groups");
  redirect(`/groups/${result.groupId}`);
}

export async function grantAdminAction(
  _prev: MemberActionState,
  formData: FormData,
): Promise<MemberActionState> {
  const user = await requireUser();
  const groupId = String(formData.get("groupId") ?? "");
  const targetUserId = String(formData.get("userId") ?? "");

  try {
    const result = await groupsService.grantAdmin(groupId, user.id, targetUserId, {
      ip: await clientIp(),
    });
    if (!result.ok) return { error: "That member couldn't be updated." };

    revalidatePath(`/groups/${groupId}/members`);
    return { message: "Admin granted." };
  } catch (error) {
    return { error: forbiddenMessage(error) };
  }
}

export async function removeMemberAction(
  _prev: MemberActionState,
  formData: FormData,
): Promise<MemberActionState> {
  const user = await requireUser();
  const groupId = String(formData.get("groupId") ?? "");
  const targetUserId = String(formData.get("userId") ?? "");

  try {
    const result = await groupsService.removeMember(
      groupId,
      user.id,
      targetUserId,
      { ip: await clientIp() },
    );
    if (!result.ok) return { error: "That member couldn't be removed." };

    revalidatePath(`/groups/${groupId}/members`);
    return { message: "Member removed." };
  } catch (error) {
    return { error: forbiddenMessage(error) };
  }
}

export async function leaveGroupAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const groupId = String(formData.get("groupId") ?? "");

  const result = await groupsService.leaveGroup(groupId, user.id, {
    ip: await clientIp(),
  });

  if (!result.ok) redirect(`/groups/${groupId}/members?error=${result.reason}`);

  revalidatePath("/");
  redirect("/groups");
}

/**
 * Pull the per-action thresholds out of the create-group form.
 *
 * Only recognised action names are accepted — a crafted `threshold.WHATEVER`
 * field is dropped rather than trusted, and anything unparseable falls back to
 * the default. The service clamps the range on top of this, so a hand-rolled
 * POST cannot set a 1% bar for releasing funds.
 */
function readThresholds(
  formData: FormData,
): Partial<Record<GovernedAction, number>> {
  const chosen: Partial<Record<GovernedAction, number>> = {};

  for (const action of ALL_GOVERNED_ACTIONS) {
    const raw = formData.get(`threshold.${action}`);
    if (typeof raw !== "string") continue;

    const permille = Number(raw);
    if (Number.isFinite(permille)) chosen[action] = permille;
  }

  return chosen;
}

/**
 * Charge the member's saved card for their contribution.
 *
 * Returns a *pending* state, never a success: the money is not real until the
 * webhook confirms it, and the UI says so rather than showing a balance that
 * might evaporate.
 */
export async function contributeAction(
  _prev: ContributeState,
  formData: FormData,
): Promise<ContributeState> {
  const user = await requireUser();
  const groupId = String(formData.get("groupId") ?? "");

  // Membership is the authorization boundary; a non-member cannot pay in.
  const membership = await groupsService.getMembership(groupId, user.id);
  if (!membership || membership.role === null) {
    return { status: "idle", error: "You're not a member of this group." };
  }

  try {
    assertCan("group.contribute", membership);
  } catch (error) {
    return { status: "idle", error: forbiddenMessage(error) };
  }

  const result = await chargeContribution({ groupId, userId: user.id });

  if (!result.ok) {
    return { status: "idle", error: result.message };
  }

  revalidatePath(`/groups/${groupId}`);
  return { status: "pending", charged: result.charged.format() };
}

/**
 * Development-only: put a contribution through the full pipeline without a
 * live Paystack account. The service refuses to run in production or with a
 * live key configured.
 */
export async function simulateContributionAction(
  _prev: ContributeState,
  formData: FormData,
): Promise<ContributeState> {
  const user = await requireUser();
  const groupId = String(formData.get("groupId") ?? "");
  const fail = formData.get("fail") === "1";

  const membership = await groupsService.getMembership(groupId, user.id);
  if (!membership || membership.role === null) {
    return { status: "idle", error: "You're not a member of this group." };
  }

  try {
    assertCan("group.contribute", membership);

    const result = await simulateContribution({
      groupId,
      userId: user.id,
      fail,
    });

    revalidatePath(`/groups/${groupId}`);
    revalidatePath("/");

    if (fail) {
      return {
        status: "idle",
        error: `Simulated decline — the books are untouched (${result.outcome}).`,
      };
    }

    return {
      status: "idle",
      error: undefined,
      message: `Simulated ${result.charged.format()} — the group received ${result.net.format()}.`,
    };
  } catch (error) {
    if (error instanceof SimulationNotAllowedError) {
      return { status: "idle", error: error.message };
    }
    return { status: "idle", error: forbiddenMessage(error) };
  }
}

/**
 * Turn a policy refusal into something a member can read. Anything else is a
 * genuine bug and is rethrown rather than swallowed into a friendly message.
 */
function forbiddenMessage(error: unknown): string {
  if (error instanceof ForbiddenError) return explain(error.decision);
  throw error;
}

/**
 * The owner starts the group on-chain: its Safe is created with every member
 * in it. The app pays the network fee.
 */
export async function startOnChainAction(
  _prev: StartOnChainState,
  formData: FormData,
): Promise<StartOnChainState> {
  const user = await requireUser();
  const groupId = String(formData.get("groupId") ?? "");

  const result = await startGroupOnChain(groupId, user.id, { ip: await clientIp() });
  if (!result.ok) {
    const error = {
      not_found: "That group doesn't exist.",
      not_owner: "Only the person who created the group can start it.",
      not_usdc: "This group was made before JFK moved on-chain, so it can't start there.",
      already_started: "This group has already started.",
      members_without_wallets: "Everyone needs to sign in with Base before the group can start.",
      no_relayer: "The app isn't set up to pay network fees yet. Add RELAYER_PRIVATE_KEY to .env.local.",
      relayer_out_of_funds: "The app's fee wallet is out of test ETH. Top it up and try again.",
      reverted: "The network refused to create the group's wallet. Try again.",
      not_confirmed: "The group's wallet was created but didn't check out. Nothing was recorded; tell the developer.",
    }[result.reason];
    return { error };
  }

  revalidatePath(`/groups/${groupId}`);
  return { safeAddress: result.safeAddress };
}
