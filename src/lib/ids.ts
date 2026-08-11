import { randomBytes } from "node:crypto";

/**
 * UUIDv7 — time-ordered UUIDs.
 *
 * Chosen over v4 because the ledger is append-only and read in time order;
 * sortable primary keys keep b-tree inserts at the right edge of the index
 * and let us page through history by id without a secondary sort.
 *
 * Layout (RFC 9562): 48-bit big-endian unix millis | version 7 | 12 bits rand
 * | variant 0b10 | 62 bits rand.
 */
export function uuidv7(): string {
  const bytes = randomBytes(16);
  const now = Date.now();

  // 48-bit timestamp, big-endian, into bytes 0..5
  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now / 2 ** 24) & 0xff;
  bytes[3] = (now / 2 ** 16) & 0xff;
  bytes[4] = (now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;

  // version 7 in the high nibble of byte 6
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  // RFC 4122 variant (0b10) in the top two bits of byte 8
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/**
 * URL-safe random token for invite codes and session tokens.
 * Uses an unbiased alphabet (64 chars) so modulo bias is impossible.
 */
const TOKEN_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function randomToken(length = 32): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += TOKEN_ALPHABET[bytes[i] & 63];
  return out;
}

/**
 * Numeric OTP code. Rejection-samples so every code is equally likely —
 * `% 10` on a raw byte would make 0–5 more common than 6–9.
 */
export function numericCode(digits = 6): string {
  let out = "";
  while (out.length < digits) {
    for (const byte of randomBytes(digits)) {
      if (byte < 250) {
        out += (byte % 10).toString();
        if (out.length === digits) break;
      }
    }
  }
  return out;
}
