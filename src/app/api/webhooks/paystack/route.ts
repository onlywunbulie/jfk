import { paystack } from "@/modules/payments/paystack";
import { handleWebhook } from "@/modules/payments/service";

/**
 * Paystack webhook endpoint.
 *
 * Three things this handler must get right:
 *
 *   1. Read the **raw body** before anything else. The signature is an HMAC
 *      over the exact bytes sent; parsing and re-serialising would change the
 *      whitespace and invalidate it.
 *   2. Return 200 for anything we have successfully taken responsibility for,
 *      including duplicates. Paystack retries on non-2xx, and retrying a
 *      duplicate we already stored achieves nothing.
 *   3. Return non-2xx only when we genuinely failed to record the event, so
 *      the retry is useful.
 *
 * An invalid signature gets 401 and is not stored: it did not come from
 * Paystack, and writing unauthenticated payloads to our tables would hand an
 * attacker a way to fill the database.
 */
export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();

  const result = await handleWebhook(paystack, rawBody, request.headers);

  switch (result.outcome) {
    case "invalid_signature":
      return Response.json({ error: "invalid signature" }, { status: 401 });

    case "error":
      // Stored but not applied. A retry may succeed, so ask for one.
      console.error(
        `[paystack] failed to apply ${result.eventId}: ${result.message}`,
      );
      return Response.json({ error: "processing failed" }, { status: 500 });

    case "duplicate":
    case "ignored":
    case "processed":
      return Response.json({ received: true, outcome: result.outcome });
  }
}

/** Paystack only POSTs here; anything else is a misconfiguration. */
export async function GET(): Promise<Response> {
  return Response.json({ error: "method not allowed" }, { status: 405 });
}
