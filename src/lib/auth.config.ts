import type { NextAuthConfig } from "next-auth";

/**
 * Edge-safe Auth.js config: no DB imports, JWT sessions only. The middleware
 * builds its own NextAuth instance from this; the full instance in auth.ts
 * adds the providers (which need the DB).
 *
 * Session cookies are Auth.js defaults: httpOnly, sameSite=lax, secure in
 * production. Tokens never go to localStorage.
 */
export const authConfig = {
  pages: {
    signIn: "/login",
  },
  session: {
    strategy: "jwt",
  },
  callbacks: {
    jwt({ token, user }) {
      if (user?.id) {
        token.userId = user.id;
      }
      return token;
    },
    session({ session, token }) {
      if (typeof token.userId === "string") {
        session.user.id = token.userId;
      }
      return session;
    },
  },
  providers: [],
} satisfies NextAuthConfig;
