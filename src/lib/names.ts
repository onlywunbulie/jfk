/**
 * Someone who signed in with a wallet and hasn't named themselves yet goes by
 * their short wallet address ("0x4fCb…1f75"). That's a fine way to tell
 * people apart, but a poor initial ("0") and not a name, so screens ask.
 */

/** True for the stand-in name a wallet user starts with. */
export function isWalletName(name: string): boolean {
  return /^0x[0-9a-f]{4}…[0-9a-f]{4}$/i.test(name.trim());
}

/** The letter for an avatar, or null when there's no real name to take it from. */
export function initialOf(name: string): string | null {
  if (isWalletName(name)) return null;
  return Array.from(name.trim())[0]?.toUpperCase() ?? null;
}
