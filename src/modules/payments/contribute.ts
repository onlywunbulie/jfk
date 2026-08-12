import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { groupSettings, paymentMethods } from "@/lib/db/schema";
import { Money } from "@/lib/money";
import { uuidv7 } from "@/lib/ids";
import { paystack } from "./paystack";
import { planCharge } from "./fees";
import { getUserEmail, startPayment } from "./service";

/**
 * Charge a member's saved card for their contribution.
 *
 * The full loop lives in Phase 4's scheduler; this is the manual "Pay now"
 * path, and the automated one will call the same function.
 *
 * Nothing here posts to the ledger. It records intent, asks Paystack to
 * charge, and stops. The webhook settles it.
 */

export type ContributeResult =
  | { ok: true; reference: string; charged: Money; status: "pending" | "success" }
  | {
      ok: false;
      reason: "no_card" | "not_configured" | "declined" | "no_group";
      message: string;
    };

export async function chargeContribution(input: {
  groupId: string;
  userId: string;
  /** Omit to use the group's configured contribution amount. */
  amount?: Money;
}): Promise<ContributeResult> {
  const [settings] = await db
    .select()
    .from(groupSettings)
    .where(eq(groupSettings.groupId, input.groupId))
    .limit(1);

  if (!settings) {
    return { ok: false, reason: "no_group", message: "That group doesn't exist." };
  }

  const target = input.amount ?? Money.fromMinor(settings.contributionAmount);
  if (!target.isPositive()) {
    return {
      ok: false,
      reason: "no_group",
      message: "This group hasn't set a contribution amount yet.",
    };
  }

  const [card] = await db
    .select()
    .from(paymentMethods)
    .where(
      and(
        eq(paymentMethods.userId, input.userId),
        eq(paymentMethods.status, "ACTIVE"),
      ),
    )
    .orderBy(paymentMethods.isDefault)
    .limit(1);

  if (!card) {
    return {
      ok: false,
      reason: "no_card",
      message: "Add a card in your wallet first.",
    };
  }

  // Gross-up decides what the card is debited so the treasury receives the
  // round contribution amount. Our figure is only a plan — the webhook's
  // numbers are what reach the ledger.
  const plan = planCharge(target, settings.grossUpFees);

  const email = await getUserEmail(input.userId);
  if (!email) {
    return { ok: false, reason: "no_card", message: "No email on your account." };
  }

  // Deterministic per attempt. Phase 4 keys this to the contribution row so a
  // retry of the *same* obligation reuses the reference and cannot double-charge.
  const reference = `jfk_c_${uuidv7()}`;

  await startPayment({
    reference,
    purpose: "CONTRIBUTION",
    amount: plan.charged,
    userId: input.userId,
    groupId: input.groupId,
    paymentMethodId: card.id,
    metadata: {
      target: target.minor.toString(),
      grossUp: settings.grossUpFees,
      estimatedFee: plan.fee.minor.toString(),
    },
  });

  const result = await paystack.chargeAuthorization({
    authorizationCode: card.providerAuthCode,
    email,
    amount: plan.charged,
    reference,
    metadata: { groupId: input.groupId, userId: input.userId },
  });

  if (!result.accepted) {
    return {
      ok: false,
      reason: result.failureReason?.includes("not configured")
        ? "not_configured"
        : "declined",
      message: result.failureReason ?? "The charge was declined.",
    };
  }

  return {
    ok: true,
    reference,
    charged: plan.charged,
    // Even a "success" here waits for the webhook before the money is real.
    status: result.provisionalStatus === "success" ? "success" : "pending",
  };
}

/** What the member will be charged, for showing before they confirm. */
export async function previewContribution(groupId: string): Promise<{
  target: Money;
  charged: Money;
  fee: Money;
  grossUp: boolean;
} | null> {
  const [settings] = await db
    .select()
    .from(groupSettings)
    .where(eq(groupSettings.groupId, groupId))
    .limit(1);

  if (!settings) return null;

  const target = Money.fromMinor(settings.contributionAmount);
  if (!target.isPositive()) return null;

  const plan = planCharge(target, settings.grossUpFees);
  return {
    target,
    charged: plan.charged,
    fee: plan.fee,
    grossUp: settings.grossUpFees,
  };
}
