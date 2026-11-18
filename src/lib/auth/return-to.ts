/**
 * Where sign-in may send someone back to afterwards. A link from Claude (a
 * group's channel, or the automatic-dues confirm), an invite link, or the
 * screen where they approve an AI app. Anything else is ignored, so a crafted link can't bounce someone off
 * to another site or an unexpected page.
 *
 * Safe on client and server: it only reads strings.
 */

const ALLOWED = /^\/(?:groups\/[A-Za-z0-9-]+(?:\/[a-z-]+)?(?:\?[A-Za-z0-9=&_-]*)?|join\/[A-Za-z0-9_-]+|auto-pay\/[A-Za-z0-9-]+(?:\?remove=1)?|oauth\/authorize\?[^\s]*)$/;

export function safeReturnTo(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2_000) return null;
  // "//evil.example" and "/\evil.example" are other sites to a browser.
  if (value.startsWith("//") || value.startsWith("/\\")) return null;
  return ALLOWED.test(value) ? value : null;
}

/** The sign-in address that brings them back to `path` afterwards, when that's allowed. */
export function signInHref(path: string | null): string {
  const back = safeReturnTo(path);
  return back ? `/sign-in?next=${encodeURIComponent(back)}` : "/sign-in";
}
