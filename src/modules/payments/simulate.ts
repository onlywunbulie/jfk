import "server-only";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { groupSettings, paymentMethods } from "@/lib/db/schema";
import { Money } from "@/lib/money";
import { uuidv7 } from "@/lib/ids";
import { planCharge } from "./fees";
import { startPayment, handleWebhook } from "./service";
import { PaystackProvider } from "./paystack";

/**
 * Development-only stand-in for Paystack.
 *
 * Fabricates the exact webhook Paystack would send for a successful charge and
 * feeds it through the *real* intake path — same signature check, same dedupe
 * index, same ledger posting. Nothing here shortcuts the pipeline; it only
 * removes the need for a live account and a public callback URL.
 *
 * Useful beyond convenience: Phase 4's scheduler has to be testable without
 * putting real charges through a real card.
 *
 * SAFETY: refuses to run in production, and refuses if a live secret key is
 * configured. A simulator that can mint money on a real deployment would be a
 * far worse hole than anything it helps test.
 */

export class SimulationNotAllowedError extends Error {
  constructor(reason: string) {
    super(`Simulated payments are not allowed: ${reason}`);
    this.name = "SimulationNotAllowedError";
  }
}

function assertSimulationAllowed(): void {
  if (env().NODE_ENV === "production") {
    throw new SimulationNotAllowedError("this is a production environment");
  }
  if (env().PAYSTACK_SECRET_KEY.startsWith("sk_live")) {
    throw new SimulationNotAllowedError("a live Paystack key is configured");
  }
}

/** True when the UI should offer the simulate control at all. */
export function simulationAvailable(): boolean {
  try {
    assertSimulationAllowed();
    return true;
  } catch {
    return false;
  }
}

export interface SimulatedContribution {
  reference: string;
  charged: Money;
  fee: Money;
  net: Money;
  outcome: string;
}

/**
 * Put one contribution through the whole pipeline as if Paystack had charged
 * a card: payment row → signed webhook → verification → dedupe → ledger.
 */
export async function simulateContribution(input: {
  groupId: string;
  userId: string;
  amount?: Money;
  /** Simulate a decline instead of a success. */
  fail?: boolean;
}): Promise<SimulatedContribution> {
  assertSimulationAllowed();

  const [settings] = await db
    .select()
    .from(groupSettings)
    .where(eq(groupSettings.groupId, input.groupId))
    .limit(1);

  if (!settings) throw new Error(`No such group: ${input.groupId}`);

  const target = input.amount ?? Money.fromMinor(settings.contributionAmount);
  const plan = planCharge(target, settings.grossUpFees);

  // A card is not required to simulate, but reuse one if the member has it so
  // the resulting history looks like the real thing.
  const [card] = await db
    .select({ signature: paymentMethods.signature })
    .from(paymentMethods)
    .where(eq(paymentMethods.userId, input.userId))
    .limit(1);

  const reference = `jfk_sim_${uuidv7()}`;

  await startPayment({
    reference,
    purpose: "CONTRIBUTION",
    amount: plan.charged,
    userId: input.userId,
    groupId: input.groupId,
    metadata: { simulated: true },
  });

  const body = JSON.stringify({
    event: input.fail ? "charge.failed" : "charge.success",
    data: {
      id: Math.floor(Math.random() * 1_000_000_000),
      reference,
      amount: Number(plan.charged.minor),
      fees: Number(plan.fee.minor),
      status: input.fail ? "failed" : "success",
      gateway_response: input.fail ? "Insufficient funds" : "Successful",
      authorization: {
        authorization_code: `AUTH_sim_${input.userId.slice(0, 8)}`,
        signature: card?.signature ?? `SIG_sim_${input.userId.slice(0, 8)}`,
        last4: "4321",
        brand: "visa",
        bank: "Simulated Bank",
        exp_month: "12",
        exp_year: String(new Date().getFullYear() + 3),
        reusable: true,
      },
    },
  });

  // Sign it exactly as Paystack would, so the real verifier accepts it. The
  // signature check is genuinely exercised, not bypassed.
  const secret = env().PAYSTACK_SECRET_KEY || "sk_test_simulated_local_key";
  const headers = new Headers({
    "x-paystack-signature": createHmac("sha512", secret)
      .update(body, "utf8")
      .digest("hex"),
  });

  const result = await handleWebhook(new PaystackProvider(secret), body, headers);

  return {
    reference,
    charged: plan.charged,
    fee: plan.fee,
    net: plan.net,
    outcome: result.outcome,
  };
}
