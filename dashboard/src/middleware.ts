import { NextRequest, NextResponse } from "next/server";

/**
 * HTTP Basic Auth middleware — protects ALL routes.
 *
 * Env vars (set in .env.local or Vercel):
 *   DASHBOARD_PASSWORD  — required, blocks access if unset
 *   DASHBOARD_USER      — optional, defaults to "admin"
 *
 * How it works:
 *   - Every request (pages, API, assets) hits this middleware
 *   - If no valid Authorization header → 401 with WWW-Authenticate
 *   - Browser shows native login prompt; credentials cached per session
 *   - No cookies, no JS, works with curl / fetch / browsers
 */

export function middleware(request: NextRequest) {
  const password = process.env.DASHBOARD_PASSWORD;

  // If no password configured, block everything with a clear error
  if (!password) {
    return new NextResponse(
      "Dashboard password not configured. Set DASHBOARD_PASSWORD env var.",
      { status: 503 },
    );
  }

  const user = process.env.DASHBOARD_USER ?? "admin";
  const authHeader = request.headers.get("authorization");

  if (authHeader) {
    // Parse "Basic base64(user:pass)"
    const [scheme, encoded] = authHeader.split(" ", 2);
    if (scheme === "Basic" && encoded) {
      try {
        const decoded = atob(encoded);
        const [u, ...pParts] = decoded.split(":");
        const p = pParts.join(":"); // password may contain colons
        if (u === user && p === password) {
          return NextResponse.next();
        }
      } catch {
        // invalid base64 — fall through to 401
      }
    }
  }

  // Reject with 401 + prompt
  return new NextResponse("Unauthorized", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Sales Tax Agent", charset="UTF-8"',
    },
  });
}

// Apply to ALL routes — no exceptions
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
