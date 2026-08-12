import type { Money } from "@/lib/money";

/**
 * The seam that matters (BLUEPRINT.md §10).
 *
 * Everything above the ledger speaks this interface and `NormalizedPaymentEvent`.
 * Paystack is one implementation; Monnify's virtual accounts and a future
 * stablecoin rail are others. Swapping providers should be a new file here,
 * not a rewrite of the contribution engine.
 */

export interface TokenizationSession {
  /** Where to send the member to enter their card. */
  authorizationUrl: string;
  reference: string;
  /** What we will charge and immediately refund to obtain the token. */
  amount: Money;
}

export interface ChargeResult {
  /** Whether the provider accepted the request — not whether money moved. */
  accepted: boolean;
  reference: string;
  providerRef: string | null;
  /**
   * The provider's immediate view. Never trusted for finality: the webhook
   * decides, and only the webhook posts to the ledger.
   */
  provisionalStatus: "pending" | "success" | "failed";
  failureReason?: string;
  raw: unknown;
}

export interface ResolvedBankAccount {
  accountNumber: string;
  bankCode: string;
  accountName: string;
}

export interface PayoutResult {
  accepted: boolean;
  reference: string;
  providerRef: string | null;
  failureReason?: string;
  raw: unknown;
}

export type WebhookVerification =
  | { valid: true; payload: unknown }
  | { valid: false; reason: string };

/**
 * A provider event translated into JFK's own vocabulary.
 *
 * `eventId` must be stable across redeliveries of the same event — it is the
 * duplicate guard. `authorization` is present when the event carries a
 * reusable card token.
 */
export interface NormalizedPaymentEvent {
  eventId: string;
  type:
    | "charge.success"
    | "charge.failed"
    | "transfer.success"
    | "transfer.failed"
    | "transfer.reversed"
    | "unknown";
  reference: string | null;
  providerRef: string | null;
  amount: Money | null;
  /** The provider's authoritative fee. Overrides any estimate of ours. */
  fee: Money | null;
  failureReason?: string;
  authorization?: {
    authorizationCode: string;
    signature: string | null;
    last4: string | null;
    brand: string | null;
    bank: string | null;
    expMonth: number | null;
    expYear: number | null;
    reusable: boolean;
  };
  raw: unknown;
}

export interface PaymentProvider {
  readonly name: "PAYSTACK";

  /** Begin collecting a card. Returns a URL to send the member to. */
  startTokenization(input: {
    email: string;
    reference: string;
    amount: Money;
    callbackUrl: string;
  }): Promise<TokenizationSession>;

  /** Charge a stored authorization. `reference` must be deterministic. */
  chargeAuthorization(input: {
    authorizationCode: string;
    email: string;
    amount: Money;
    reference: string;
    metadata?: Record<string, unknown>;
  }): Promise<ChargeResult>;

  /** Ask the provider what really happened. The webhook safety net. */
  verifyTransaction(reference: string): Promise<NormalizedPaymentEvent | null>;

  /** Confirm an account number belongs to who we think it does. */
  resolveBankAccount(input: {
    accountNumber: string;
    bankCode: string;
  }): Promise<ResolvedBankAccount | null>;

  /** Send money out. Used from Phase 6. */
  payout(input: {
    recipientCode: string;
    amount: Money;
    reference: string;
    reason: string;
  }): Promise<PayoutResult>;

  /** Check the signature over the *raw* body, before any parsing. */
  verifyWebhook(rawBody: string, headers: Headers): WebhookVerification;

  parseWebhook(payload: unknown): NormalizedPaymentEvent;
}
