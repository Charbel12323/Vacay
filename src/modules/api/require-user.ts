import { auth } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { ApiError } from "@/modules/api/errors";

export type SessionUser = {
  id: string;
  email: string | null;
};

// General per-user API budget (Stage 9 task 6). Generous — the dashboard
// polling loop uses a handful per minute — but a runaway client or leaked
// session token cannot hammer the database.
const GENERAL_LIMIT_PER_MINUTE = 120;

/**
 * Returns the session user or throws UNAUTHENTICATED (401 via
 * withErrorHandling). Every DB query in every route MUST filter by this
 * user's id; pair with assertOwned() for single-resource lookups.
 * Also the single choke point for the general per-user rate limit.
 */
export async function requireUser(): Promise<SessionUser> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) {
    throw new ApiError("UNAUTHENTICATED", "You must be signed in.");
  }

  const { limited } = await rateLimit(`user:${id}`, GENERAL_LIMIT_PER_MINUTE, 60);
  if (limited) {
    throw new ApiError("RATE_LIMITED", "Too many requests. Give it a minute.");
  }

  return { id, email: session.user.email ?? null };
}
