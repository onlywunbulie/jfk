"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { requireUser } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { db } from "@/lib/db";
import { paymentMethods, TOKENIZATION_AMOUNT_KOBO } from "@/lib/db/schema";
import { Money } from "@/lib/money";
import { paystack } from "@/modules/payments/paystack";
import { startPayment, getUserEmail } from "@/modules/payments/service";
import { recordAudit } from "@/modules/audit/service";
import { uuidv7 } from "@/lib/ids";
import type { AddCardState } from "./state";

/**
 * Begin adding a card.
 *
 * Paystack collects the card on their own page; we never see it. They charge a
 * small amount to prove the card works and produce a reusable authorization
 * code, then refund it automatically.
 */
// Signature is fixed by useActionState; neither argument is needed here
// because adding a card takes no input beyond who is asking.
export async function startAddCardAction(): Promise<AddCardState> {
  const user = await requireUser();

  if (!env().PAYSTACK_SECRET_KEY) {
    return {
      error:
        "Payments aren't configured yet. Add PAYSTACK_SECRET_KEY to .env.local to add a card.",
    };
  }

  const email = (await getUserEmail(user.id)) ?? user.email;
  // Paystack needs an email for a card. Wallet-only members pay in USDC
  // instead, so they never reach here in practice.
  if (!email) {
    return { error: "Add an email to your profile before adding a card." };
  }
  const reference = `jfk_tok_${uuidv7()}`;
  const amount = Money.fromMinor(TOKENIZATION_AMOUNT_KOBO);

  // Record the intent before calling out, so a timeout still leaves a trace.
  await startPayment({
    reference,
    purpose: "CARD_TOKENIZATION",
    amount,
    userId: user.id,
  });

  try {
    const session = await paystack.startTokenization({
      email,
      reference,
      amount,
      callbackUrl: `${env().APP_URL}/wallet?added=1`,
    });

    redirect(session.authorizationUrl);
  } catch (error) {
    // `redirect` throws to unwind; never swallow it as a payment failure.
    if (isRedirectError(error)) throw error;
    return {
      error:
        error instanceof Error
          ? `Couldn't start card setup: ${error.message}`
          : "Couldn't start card setup.",
    };
  }
}

export async function removeCardAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const methodId = String(formData.get("methodId") ?? "");

  // Scoped to the owner, so a guessed id cannot revoke someone else's card.
  await db.transaction(async (tx) => {
    const [method] = await tx
      .update(paymentMethods)
      .set({ status: "REVOKED", isDefault: false })
      .where(
        and(eq(paymentMethods.id, methodId), eq(paymentMethods.userId, user.id)),
      )
      .returning({ id: paymentMethods.id, last4: paymentMethods.last4 });

    if (method) {
      await recordAudit(tx, {
        action: "payment_method.removed",
        actorId: user.id,
        subjectType: "payment_method",
        subjectId: method.id,
        before: { last4: method.last4 },
      });
    }
  });

  revalidatePath("/wallet");
}

export async function setDefaultCardAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const methodId = String(formData.get("methodId") ?? "");

  await db.transaction(async (tx) => {
    await tx
      .update(paymentMethods)
      .set({ isDefault: false })
      .where(eq(paymentMethods.userId, user.id));

    await tx
      .update(paymentMethods)
      .set({ isDefault: true })
      .where(
        and(
          eq(paymentMethods.id, methodId),
          eq(paymentMethods.userId, user.id),
          eq(paymentMethods.status, "ACTIVE"),
        ),
      );
  });

  revalidatePath("/wallet");
}

/** Next signals redirects by throwing; that must not be caught as an error. */
function isRedirectError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    typeof (error as { digest: unknown }).digest === "string" &&
    (error as { digest: string }).digest.startsWith("NEXT_REDIRECT")
  );
}
