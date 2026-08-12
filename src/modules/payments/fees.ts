import { Money } from "@/lib/money";

/**
 * Paystack's Nigerian local-card pricing.
 *
 *   1.5% of the charge, always
 * + ₦100, waived when the charge is under ₦2,500
 * = capped at ₦2,000 in total
 *
 * Verified against Paystack's pricing documentation, August 2026. If they
 * change it, change it here — nothing else in the codebase hard-codes a fee.
 *
 * We compute the fee ourselves only to decide what to charge and to show the
 * member. The authoritative figure is whatever the webhook reports, and that
 * is what the ledger records.
 */
export const PAYSTACK_NG_LOCAL = {
  percentageBasisPoints: 150,
  flatFee: Money.fromMajor(100),
  flatFeeWaivedBelow: Money.fromMajor(2_500),
  cap: Money.fromMajor(2_000),
} as const;

/** What Paystack will take from a charge of this size. */
export function estimateFee(charged: Money): Money {
  if (!charged.isPositive()) return Money.zero();

  const percentage = charged.percentage(PAYSTACK_NG_LOCAL.percentageBasisPoints);
  const flat = charged.lessThan(PAYSTACK_NG_LOCAL.flatFeeWaivedBelow)
    ? Money.zero()
    : PAYSTACK_NG_LOCAL.flatFee;

  const total = percentage.plus(flat);
  return total.greaterThan(PAYSTACK_NG_LOCAL.cap) ? PAYSTACK_NG_LOCAL.cap : total;
}

/** What actually reaches us after Paystack's cut. */
export function netOf(charged: Money): Money {
  return charged.minus(estimateFee(charged));
}

export interface ChargePlan {
  /** What the member's card is debited. */
  charged: Money;
  /** Paystack's expected cut. */
  fee: Money;
  /** What lands in the treasury. */
  net: Money;
  /** Extra the member pays over the headline contribution. Zero when absorbing. */
  memberPremium: Money;
}

/**
 * Work out what to charge so the treasury receives `target`.
 *
 * Two modes, per BLUEPRINT.md §8 and the group's `grossUpFees` setting:
 *
 *   gross-up — charge more so the treasury gets a clean ₦50,000 and the member
 *              pays ₦50,863. Recommended: round numbers in the group's books
 *              are worth more than round numbers on a card statement, and in
 *              an Ajo the contribution figure is the thing everyone agreed on.
 *
 *   absorb   — charge exactly ₦50,000; the treasury receives ₦49,137.
 */
export function planCharge(target: Money, grossUp: boolean): ChargePlan {
  if (!target.isPositive()) {
    throw new RangeError(`Contribution target must be positive, got ${target.format()}`);
  }

  if (!grossUp) {
    const fee = estimateFee(target);
    return {
      charged: target,
      fee,
      net: target.minus(fee),
      memberPremium: Money.zero(),
    };
  }

  const charged = smallestChargeYielding(target);
  const fee = estimateFee(charged);

  return {
    charged,
    fee,
    net: charged.minus(fee),
    memberPremium: charged.minus(target),
  };
}

/**
 * The smallest charge whose net is at least `target`.
 *
 * Starts from the algebraic answer for each of the three fee regimes, then
 * corrects by whole kobo. The correction loop exists because the fee is
 * rounded to a kobo, so the closed form can land a kobo either side; it runs
 * a handful of iterations at most.
 *
 * Rounding is always in the treasury's favour — never charge so little that
 * the group ends up short of the amount everyone agreed.
 */
function smallestChargeYielding(target: Money): Money {
  const { cap, flatFee, flatFeeWaivedBelow } = PAYSTACK_NG_LOCAL;

  // Regime 1 — fee is capped, so it is a flat addition.
  const capped = target.plus(cap);
  if (estimateFee(capped).equals(cap)) return refine(capped, target);

  // Regime 2 — percentage plus the flat fee. Solve c - 0.015c - 100 = target.
  const withFlat = divideCeil(
    (target.plus(flatFee)).minor * 10_000n,
    10_000n - BigInt(PAYSTACK_NG_LOCAL.percentageBasisPoints),
  );
  const candidateWithFlat = Money.fromMinor(withFlat);
  if (candidateWithFlat.greaterThanOrEqual(flatFeeWaivedBelow)) {
    return refine(candidateWithFlat, target);
  }

  // Regime 3 — small charge, no flat fee. Solve c - 0.015c = target.
  const withoutFlat = divideCeil(
    target.minor * 10_000n,
    10_000n - BigInt(PAYSTACK_NG_LOCAL.percentageBasisPoints),
  );
  return refine(Money.fromMinor(withoutFlat), target);
}

/** Nudge to the exact minimum charge, in case rounding put us a kobo out. */
function refine(start: Money, target: Money): Money {
  let charged = start;
  let guard = 0;

  // Too little: climb until the net covers the target.
  while (charged.minus(estimateFee(charged)).lessThan(target)) {
    charged = charged.plus(Money.fromMinor(1n));
    if (++guard > 1000) {
      throw new Error(`Could not find a charge yielding ${target.format()}`);
    }
  }

  // Too much: descend while the net still covers the target.
  while (true) {
    const lower = charged.minus(Money.fromMinor(1n));
    if (!lower.isPositive()) break;
    if (lower.minus(estimateFee(lower)).lessThan(target)) break;
    charged = lower;
    if (++guard > 1000) break;
  }

  return charged;
}

/** Integer division rounding up, so we never undercharge. */
function divideCeil(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}
