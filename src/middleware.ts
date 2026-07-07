import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "@/lib/auth.config";
import { errorBody } from "@/modules/api/errors";

// Edge-safe NextAuth instance: decodes the session JWT, no DB access.
const { auth } = NextAuth(authConfig);

const PUBLIC_PAGES = new Set(["/", "/login", "/signup"]);

// /api/health and /api/webhooks/* are machine-facing; /api/auth/* is the auth
// flow itself (it carries its own rate limiting instead).
const EXEMPT_API = /^\/api\/(health$|auth\/|webhooks\/)/;

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const isAuthenticated = Boolean(req.auth?.user?.id);

  if (pathname.startsWith("/api")) {
    if (EXEMPT_API.test(pathname)) return NextResponse.next();
    if (!isAuthenticated) {
      return NextResponse.json(errorBody("UNAUTHENTICATED", "You must be signed in."), {
        status: 401,
      });
    }
    return NextResponse.next();
  }

  if (!isAuthenticated && !PUBLIC_PAGES.has(pathname)) {
    const login = new URL("/login", req.nextUrl);
    login.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(login);
  }

  if (isAuthenticated && (pathname === "/login" || pathname === "/signup")) {
    return NextResponse.redirect(new URL("/dashboard", req.nextUrl));
  }

  return NextResponse.next();
});

export const config = {
  // Everything except Next.js internals and static assets.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
