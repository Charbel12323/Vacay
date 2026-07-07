import { NextResponse } from "next/server";

/**
 * Standard error envelope: { error: { code, message } }.
 * Every API route returns errors through this module from Stage 2 onward.
 */
export const ERROR_CODES = {
  UNAUTHENTICATED: 401,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  EMAIL_IN_USE: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export class ApiError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ApiError";
  }
}

export function errorBody(code: ErrorCode, message: string) {
  return { error: { code, message } };
}

export function errorResponse(code: ErrorCode, message: string): NextResponse {
  return NextResponse.json(errorBody(code, message), { status: ERROR_CODES[code] });
}

/**
 * Wraps a route handler: ApiErrors map to their envelope, anything else
 * becomes a 500 without leaking internals.
 */
export function withErrorHandling<Args extends unknown[]>(
  handler: (...args: Args) => Promise<NextResponse>,
): (...args: Args) => Promise<NextResponse> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (err) {
      if (err instanceof ApiError) {
        return errorResponse(err.code, err.message);
      }
      console.error("[api] unhandled error:", err instanceof Error ? err.message : "unknown");
      return errorResponse("INTERNAL", "Something went wrong.");
    }
  };
}
