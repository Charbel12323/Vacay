import { ApiError } from "@/modules/api/errors";

/**
 * Opaque cursor pagination: cursor = base64url("sortValue|id"). Stable under
 * concurrent inserts (keyset, not offset).
 */
export function encodeCursor(sortValue: string, id: string): string {
  return Buffer.from(`${sortValue}|${id}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): { sortValue: string; id: string } {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const sep = raw.lastIndexOf("|");
    if (sep < 1) throw new Error("bad cursor");
    return { sortValue: raw.slice(0, sep), id: raw.slice(sep + 1) };
  } catch {
    throw new ApiError("VALIDATION_FAILED", "Invalid cursor.");
  }
}
