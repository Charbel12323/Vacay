import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { env } from "@/lib/env";
import { authConfig } from "@/lib/auth.config";

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function googleEnabled(): boolean {
  return Boolean(env().GOOGLE_CLIENT_ID && env().GOOGLE_CLIENT_SECRET);
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: {},
        password: {},
      },
      async authorize(credentials) {
        const parsed = credentialsSchema.safeParse(credentials);
        if (!parsed.success) return null;

        const [user] = await db
          .select()
          .from(users)
          .where(eq(users.email, parsed.data.email.toLowerCase()))
          .limit(1);
        if (!user?.passwordHash) return null;
        if (user.status !== "active") return null;

        const valid = await bcrypt.compare(parsed.data.password, user.passwordHash);
        if (!valid) return null;

        return { id: user.id, email: user.email, name: user.name };
      },
    }),
    ...(googleEnabled()
      ? [
          Google({
            clientId: env().GOOGLE_CLIENT_ID,
            clientSecret: env().GOOGLE_CLIENT_SECRET,
          }),
        ]
      : []),
  ],
  callbacks: {
    ...authConfig.callbacks,
    // Google sign-ins: create the users row on first sign-in and link
    // auth_provider_id (Stage 2 task 2). Credentials users are created by the
    // signup endpoint.
    async signIn({ user, account }) {
      if (account?.provider !== "google") return true;
      const email = user.email?.toLowerCase();
      if (!email) return false;

      const providerId = `google:${account.providerAccountId}`;
      const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);

      if (!existing) {
        await db.insert(users).values({ email, name: user.name, authProviderId: providerId });
      } else {
        if (existing.status !== "active") return false;
        if (!existing.authProviderId) {
          await db
            .update(users)
            .set({ authProviderId: providerId })
            .where(eq(users.id, existing.id));
        }
      }
      return true;
    },
    async jwt({ token, user, account }) {
      // Credentials: user.id is already our DB id. Google: resolve our DB id
      // by email at sign-in time (only then is `account` present).
      if (user?.id && account?.provider !== "google") {
        token.userId = user.id;
      } else if (account?.provider === "google" && user.email) {
        const [row] = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, user.email.toLowerCase()))
          .limit(1);
        if (row) token.userId = row.id;
      }
      return token;
    },
  },
});

export { googleEnabled };
