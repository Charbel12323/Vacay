import { ApiError } from "@/modules/api/errors";

/**
 * Ownership gate: a resource that doesn't exist and a resource owned by
 * someone else are indistinguishable to the caller — both are 404, never 403
 * (don't leak resource existence). Keep this rule consistent forever.
 */
export function assertOwned<T extends { userId: string }>(row: T | undefined, userId: string): T {
  if (!row || row.userId !== userId) {
    throw new ApiError("NOT_FOUND", "Not found.");
  }
  return row;
}
