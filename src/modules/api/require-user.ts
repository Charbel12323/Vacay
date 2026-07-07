import { auth } from "@/lib/auth";
import { ApiError } from "@/modules/api/errors";

export type SessionUser = {
  id: string;
  email: string | null;
};

/**
 * Returns the session user or throws UNAUTHENTICATED (401 via
 * withErrorHandling). Every DB query in every route MUST filter by this
 * user's id; pair with assertOwned() for single-resource lookups.
 */
export async function requireUser(): Promise<SessionUser> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) {
    throw new ApiError("UNAUTHENTICATED", "You must be signed in.");
  }
  return { id, email: session.user.email ?? null };
}
