import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Money } from "@/lib/money";
import { env } from "@/lib/env";
import type {
  ChargeResult,
  NormalizedPaymentEvent,
  PaymentProvider,
  PayoutResult,
  ResolvedBankAccount,
  TokenizationSession,
  WebhookVerification,
} from "./provider";

const API = "https://api.paystack.co";

/**
 * Paystack adapter.
 *
 * Paystack speaks kobo, which is exactly what `Money.minor` holds, so amounts
 * pass through without conversion or rounding.
 */
export class PaystackProvider implements PaymentProvider {
  readonly name = "PAYSTACK" as const;

  constructor(private readonly secretKey: string = env().PAYSTACK_SECRET_KEY) {}

  // -------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------

  /**
   * Verify `x-paystack-signature`: HMAC-SHA512 of the raw body, keyed with the
   * secret key.
   *
   * Must run on the exact bytes received. Parsing and re-serialising the JSON
   * first would change the whitespace and break the digest — which is why the
   * route handler reads `await request.text()` before anything else.
   */
  verifyWebhook(rawBody: string, headers: Headers): WebhookVerification {
    const provided = headers.get("x-paystack-signature");
    if (!provided) return { valid: false, reason: "missing signature header" };
    if (!this.secretKey) return { valid: false, reason: "no secret key configured" };

    const expected = createHmac("sha512", this.secretKey)
      .update(rawBody, "utf8")
      .digest("hex");

    const a = Buffer.from(provided, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { valid: false, reason: "signature mismatch" };
    }

    try {
      return { valid: true, payload: JSON.parse(rawBody) };
    } catch {
      return { valid: false, reason: "body is not valid JSON" };
    }
  }

  parseWebhook(payload: unknown): NormalizedPaymentEvent {
    const body = payload as PaystackWebhookBody;
    const data = body?.data ?? {};
    const event = body?.event ?? "unknown";

    return {
      eventId: eventIdFor(event, data),
      type: normaliseEventType(event),
      reference: data.reference ?? null,
      providerRef: data.id != null ? String(data.id) : null,
      amount: data.amount != null ? Money.fromMinor(BigInt(data.amount)) : null,
      fee: data.fees != null ? Money.fromMinor(BigInt(data.fees)) : null,
      failureReason: data.gateway_response ?? data.message ?? undefined,
      authorization: data.authorization?.authorization_code
        ? {
            authorizationCode: data.authorization.authorization_code,
            signature: data.authorization.signature ?? null,
            last4: data.authorization.last4 ?? null,
            brand: data.authorization.brand ?? null,
            bank: data.authorization.bank ?? null,
            expMonth: toInt(data.authorization.exp_month),
            expYear: toInt(data.authorization.exp_year),
            reusable: data.authorization.reusable !== false,
          }
        : undefined,
      raw: payload,
    };
  }

  // -------------------------------------------------------------------------
  // Charging
  // -------------------------------------------------------------------------

  async startTokenization(input: {
    email: string;
    reference: string;
    amount: Money;
    callbackUrl: string;
  }): Promise<TokenizationSession> {
    const response = await this.request<{
      authorization_url: string;
      reference: string;
    }>("POST", "/transaction/initialize", {
      email: input.email,
      amount: Number(input.amount.minor),
      reference: input.reference,
      callback_url: input.callbackUrl,
      channels: ["card"],
      metadata: { purpose: "card_tokenization" },
    });

    return {
      authorizationUrl: response.authorization_url,
      reference: response.reference,
      amount: input.amount,
    };
  }

  async chargeAuthorization(input: {
    authorizationCode: string;
    email: string;
    amount: Money;
    reference: string;
    metadata?: Record<string, unknown>;
  }): Promise<ChargeResult> {
    try {
      const data = await this.request<PaystackTransactionData>(
        "POST",
        "/transaction/charge_authorization",
        {
          authorization_code: input.authorizationCode,
          email: input.email,
          amount: Number(input.amount.minor),
          reference: input.reference,
          metadata: input.metadata,
        },
      );

      return {
        accepted: true,
        reference: input.reference,
        providerRef: data.id != null ? String(data.id) : null,
        provisionalStatus:
          data.status === "success"
            ? "success"
            : data.status === "failed"
              ? "failed"
              : "pending",
        failureReason: data.gateway_response,
        raw: data,
      };
    } catch (error) {
      // A rejected request is a failed attempt, not a crash — the retry ladder
      // decides what happens next.
      return {
        accepted: false,
        reference: input.reference,
        providerRef: null,
        provisionalStatus: "failed",
        failureReason: error instanceof Error ? error.message : "request failed",
        raw: null,
      };
    }
  }

  /**
   * Ask Paystack directly what happened to a reference.
   *
   * The safety net for a webhook that never arrived: a scheduled job polls
   * anything stuck pending and settles it from this.
   */
  async verifyTransaction(reference: string): Promise<NormalizedPaymentEvent | null> {
    try {
      const data = await this.request<PaystackTransactionData>(
        "GET",
        `/transaction/verify/${encodeURIComponent(reference)}`,
      );
      return this.parseWebhook({
        event: data.status === "success" ? "charge.success" : "charge.failed",
        data,
      });
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Payouts (Phase 6)
  // -------------------------------------------------------------------------

  async resolveBankAccount(input: {
    accountNumber: string;
    bankCode: string;
  }): Promise<ResolvedBankAccount | null> {
    try {
      const data = await this.request<{
        account_number: string;
        account_name: string;
      }>(
        "GET",
        `/bank/resolve?account_number=${encodeURIComponent(input.accountNumber)}&bank_code=${encodeURIComponent(input.bankCode)}`,
      );

      return {
        accountNumber: data.account_number,
        bankCode: input.bankCode,
        accountName: data.account_name,
      };
    } catch {
      return null;
    }
  }

  async payout(input: {
    recipientCode: string;
    amount: Money;
    reference: string;
    reason: string;
  }): Promise<PayoutResult> {
    try {
      const data = await this.request<{ id: number | string; status: string }>(
        "POST",
        "/transfer",
        {
          source: "balance",
          recipient: input.recipientCode,
          amount: Number(input.amount.minor),
          reference: input.reference,
          reason: input.reason,
        },
      );

      return {
        accepted: true,
        reference: input.reference,
        providerRef: String(data.id),
        raw: data,
      };
    } catch (error) {
      return {
        accepted: false,
        reference: input.reference,
        providerRef: null,
        failureReason: error instanceof Error ? error.message : "request failed",
        raw: null,
      };
    }
  }

  // -------------------------------------------------------------------------

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    if (!this.secretKey) {
      throw new Error("PAYSTACK_SECRET_KEY is not configured");
    }

    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      // Paystack is usually fast; a hung request must not wedge a job.
      signal: AbortSignal.timeout(20_000),
    });

    const json = (await response.json().catch(() => null)) as PaystackEnvelope<T> | null;

    if (!response.ok || !json?.status) {
      throw new Error(
        `Paystack ${method} ${path} failed (${response.status}): ${json?.message ?? "no message"}`,
      );
    }

    return json.data;
  }
}

// ---------------------------------------------------------------------------

/**
 * Paystack does not send an event id, so derive a stable one.
 *
 * The pair (event type, reference) is unique per logical event: a redelivery
 * of the same `charge.success` produces the same key and is rejected by the
 * unique index, while a genuine later refund on the same reference is a
 * different event type and gets through.
 */
function eventIdFor(event: string, data: PaystackTransactionData): string {
  const reference = data.reference ?? (data.id != null ? String(data.id) : "unknown");
  return `${event}:${reference}`;
}

function normaliseEventType(event: string): NormalizedPaymentEvent["type"] {
  switch (event) {
    case "charge.success":
      return "charge.success";
    case "charge.failed":
      return "charge.failed";
    case "transfer.success":
      return "transfer.success";
    case "transfer.failed":
      return "transfer.failed";
    case "transfer.reversed":
      return "transfer.reversed";
    default:
      return "unknown";
  }
}

function toInt(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

interface PaystackEnvelope<T> {
  status: boolean;
  message: string;
  data: T;
}

interface PaystackTransactionData {
  id?: number | string;
  reference?: string;
  amount?: number;
  fees?: number;
  status?: string;
  gateway_response?: string;
  message?: string;
  authorization?: {
    authorization_code?: string;
    signature?: string;
    last4?: string;
    brand?: string;
    bank?: string;
    exp_month?: string | number;
    exp_year?: string | number;
    reusable?: boolean;
  };
}

interface PaystackWebhookBody {
  event?: string;
  data?: PaystackTransactionData;
}

/** Shared instance. */
export const paystack = new PaystackProvider();
