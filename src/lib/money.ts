/**
 * Money — an exact integer amount of minor units (kobo for NGN).
 *
 * Rules this type exists to enforce:
 *   1. Money is never a float. 0.1 + 0.2 !== 0.3, and a ledger that drifts by
 *      a kobo per transaction is a ledger nobody trusts.
 *   2. Amounts of different currencies never combine silently.
 *   3. Division always states where the remainder went. Splitting ₦100 three
 *      ways loses a kobo unless someone is explicitly handed it.
 *
 * Stored in Postgres as BIGINT (see `amount` columns in the ledger schema).
 */

export type Currency = "NGN";

/** Minor units per major unit, by currency. NGN: 100 kobo = ₦1. */
const MINOR_UNITS: Record<Currency, number> = { NGN: 100 };

const SYMBOLS: Record<Currency, string> = { NGN: "₦" };

export class Money {
  readonly minor: bigint;
  readonly currency: Currency;

  private constructor(minor: bigint, currency: Currency) {
    this.minor = minor;
    this.currency = currency;
  }

  // --- construction ---------------------------------------------------------

  /** From minor units (kobo). The canonical constructor. */
  static fromMinor(minor: bigint | number, currency: Currency = "NGN"): Money {
    if (typeof minor === "number") {
      if (!Number.isInteger(minor)) {
        throw new TypeError(
          `Money.fromMinor requires an integer, received ${minor}. ` +
            `A fractional kobo means a rounding bug upstream.`,
        );
      }
      if (!Number.isSafeInteger(minor)) {
        throw new RangeError(`Money.fromMinor received an unsafe integer: ${minor}`);
      }
    }
    return new Money(BigInt(minor), currency);
  }

  /**
   * From major units (naira). Accepts a number for ergonomics at trusted
   * boundaries (config, tests, literals) but rejects anything that cannot be
   * represented exactly, so `Money.fromMajor(0.001)` fails loudly.
   */
  static fromMajor(major: number | string, currency: Currency = "NGN"): Money {
    const factor = MINOR_UNITS[currency];
    const asString = typeof major === "string" ? major.trim() : String(major);

    if (!/^-?\d+(\.\d+)?$/.test(asString)) {
      throw new TypeError(`Money.fromMajor received a non-numeric value: "${major}"`);
    }

    const negative = asString.startsWith("-");
    const [whole, fraction = ""] = asString.replace("-", "").split(".");
    const scale = String(factor).length - 1;

    if (fraction.length > scale) {
      throw new RangeError(
        `${asString} has more precision than ${currency} supports (${scale} decimal places)`,
      );
    }

    const padded = fraction.padEnd(scale, "0");
    const minor = BigInt(whole) * BigInt(factor) + BigInt(padded || "0");
    return new Money(negative ? -minor : minor, currency);
  }

  static zero(currency: Currency = "NGN"): Money {
    return new Money(0n, currency);
  }

  // --- arithmetic -----------------------------------------------------------

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new TypeError(
        `Cannot combine ${this.currency} with ${other.currency}. ` +
          `Convert explicitly at a boundary that records the rate.`,
      );
    }
  }

  plus(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  minus(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  negated(): Money {
    return new Money(-this.minor, this.currency);
  }

  abs(): Money {
    return new Money(this.minor < 0n ? -this.minor : this.minor, this.currency);
  }

  /** Multiply by a whole number (e.g. amount × member count). */
  times(factor: bigint | number): Money {
    if (typeof factor === "number" && !Number.isInteger(factor)) {
      throw new TypeError(
        `Money.times requires an integer factor. For percentages use percentage().`,
      );
    }
    return new Money(this.minor * BigInt(factor), this.currency);
  }

  /**
   * A percentage of this amount, rounded half-up to the nearest minor unit.
   * Used for gateway fees and governance thresholds on amounts.
   *
   * `basisPoints` avoids float percentages: 1.5% is 150 bps.
   */
  percentage(basisPoints: number): Money {
    if (!Number.isInteger(basisPoints)) {
      throw new TypeError(`basisPoints must be an integer, received ${basisPoints}`);
    }
    const numerator = this.minor * BigInt(basisPoints);
    return new Money(divideRoundHalfUp(numerator, 10_000n), this.currency);
  }

  /**
   * Split into `parts` as evenly as possible, distributing the remainder one
   * minor unit at a time to the earliest parts. The sum of the result always
   * equals the original — that is the whole point.
   *
   * Money.fromMajor(100).split(3) -> [₦33.34, ₦33.33, ₦33.33]
   */
  split(parts: number): Money[] {
    if (!Number.isInteger(parts) || parts <= 0) {
      throw new RangeError(`Cannot split into ${parts} parts`);
    }
    const n = BigInt(parts);
    const base = this.minor / n;
    let remainder = this.minor - base * n;
    const step = remainder < 0n ? -1n : 1n;

    return Array.from({ length: parts }, () => {
      let share = base;
      if (remainder !== 0n) {
        share += step;
        remainder -= step;
      }
      return new Money(share, this.currency);
    });
  }

  // --- comparison -----------------------------------------------------------

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    if (this.minor < other.minor) return -1;
    if (this.minor > other.minor) return 1;
    return 0;
  }

  isZero(): boolean {
    return this.minor === 0n;
  }
  isNegative(): boolean {
    return this.minor < 0n;
  }
  isPositive(): boolean {
    return this.minor > 0n;
  }
  greaterThan(other: Money): boolean {
    return this.compare(other) === 1;
  }
  lessThan(other: Money): boolean {
    return this.compare(other) === -1;
  }
  greaterThanOrEqual(other: Money): boolean {
    return this.compare(other) >= 0;
  }

  // --- output ---------------------------------------------------------------

  /** Exact major-unit decimal string, e.g. "50000.00". No symbol, no commas. */
  toDecimalString(): string {
    const scale = String(MINOR_UNITS[this.currency]).length - 1;
    const negative = this.minor < 0n;
    const digits = (negative ? -this.minor : this.minor).toString().padStart(scale + 1, "0");
    const whole = digits.slice(0, digits.length - scale);
    const fraction = digits.slice(digits.length - scale);
    return `${negative ? "-" : ""}${whole}.${fraction}`;
  }

  /**
   * Display form: "₦50,000.00". Pass `compact` to drop a ".00" tail, which
   * reads better in balance headlines where round numbers are the norm.
   */
  format(options: { compact?: boolean; showSymbol?: boolean } = {}): string {
    const { compact = false, showSymbol = true } = options;
    const decimal = this.toDecimalString();
    const negative = decimal.startsWith("-");
    const [whole, fraction] = decimal.replace("-", "").split(".");
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    const showFraction = !(compact && /^0+$/.test(fraction));
    const symbol = showSymbol ? SYMBOLS[this.currency] : "";
    return `${negative ? "-" : ""}${symbol}${grouped}${showFraction ? `.${fraction}` : ""}`;
  }

  /** For persistence — BIGINT columns take the string form losslessly. */
  toJSON(): { minor: string; currency: Currency } {
    return { minor: this.minor.toString(), currency: this.currency };
  }

  toString(): string {
    return this.format();
  }
}

/** Banker-free half-up division that behaves symmetrically around zero. */
function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const a = numerator < 0n ? -numerator : numerator;
  const b = denominator < 0n ? -denominator : denominator;
  const quotient = a / b;
  const remainder = a - quotient * b;
  const rounded = remainder * 2n >= b ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/** Sum a list, asserting a single currency. Empty list needs an explicit one. */
export function sumMoney(amounts: Money[], currency: Currency = "NGN"): Money {
  return amounts.reduce((acc, m) => acc.plus(m), Money.zero(currency));
}
