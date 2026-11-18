/**
 * Who an AI app really is, as far as Rallied can tell. Any app may register
 * itself under any name (that's how Claude connects), so the name alone
 * proves nothing. What does: where approval sends the code back to.
 *
 *  - A known AI company's own site, matching the name it claims: verified.
 *  - This computer (localhost): an app installed here, e.g. Claude Code.
 *  - Anywhere else: shown as that site, and an app naming itself after a
 *    known AI from somewhere else is flagged, since that's what a phishing
 *    link would look like.
 */

const KNOWN: { pattern: RegExp; hosts: string[] }[] = [
  { pattern: /claude|anthropic/i, hosts: ["claude.ai", "claude.com", "anthropic.com"] },
  { pattern: /chatgpt|openai/i, hosts: ["chatgpt.com", "openai.com"] },
  { pattern: /grok|xai\b/i, hosts: ["grok.com", "x.ai"] },
];

export interface ClientIdentity {
  /** "claude.ai", or "this computer". */
  destination: string;
  /** True when the name claims a known AI but the code goes somewhere else. */
  impersonating: boolean;
}

export function identifyClient(name: string, redirectUri: string): ClientIdentity {
  let host: string;
  try {
    host = new URL(redirectUri).hostname.toLowerCase();
  } catch {
    return { destination: "an unknown address", impersonating: true };
  }
  const local = host === "localhost" || host === "127.0.0.1";
  const claimed = KNOWN.find((known) => known.pattern.test(name));
  const ownSite = claimed?.hosts.some((h) => host === h || host.endsWith(`.${h}`)) ?? false;
  return {
    destination: local ? "an app on this computer" : host,
    // An app on this computer is the user's own install; anything else must match its name.
    impersonating: Boolean(claimed) && !ownSite && !local,
  };
}
