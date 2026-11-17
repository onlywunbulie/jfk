import { NextResponse, type NextRequest } from "next/server";

/**
 * Tells the app which page was asked for, so a signed-out visitor sent to
 * sign-in can come straight back to it afterwards (a link from Claude, an
 * invite). Layouts can't read the address themselves.
 *
 * Only that: no sign-in checks here. Authorization stays at the data layer
 * (requireUser and the services), per AGENTS.md.
 */
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set("x-rallied-path", request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/groups/:path*", "/join/:path*"],
};
