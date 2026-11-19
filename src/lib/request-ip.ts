/**
 * The visitor's address, as the host saw it. On Vercel the first
 * x-forwarded-for entry is the real client (Vercel sets it; a value the
 * browser sends is overwritten). Locally it may be missing.
 */
export function requestIp(headers: Headers): string {
  const ip = headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip") || "";
  return /^[0-9a-fA-F.:]{3,45}$/.test(ip) ? ip : "unknown";
}

/** The same address for an audit row, whose column only takes a real IP: null when there isn't one. */
export function auditIp(headers: Headers): string | null {
  const ip = requestIp(headers);
  return ip === "unknown" ? null : ip;
}
