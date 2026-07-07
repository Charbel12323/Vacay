import { describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import {
  ApiError,
  ERROR_CODES,
  errorBody,
  errorResponse,
  withErrorHandling,
} from "@/modules/api/errors";

describe("error envelope", () => {
  it("produces the standard { error: { code, message } } shape", () => {
    expect(errorBody("UNAUTHENTICATED", "nope")).toEqual({
      error: { code: "UNAUTHENTICATED", message: "nope" },
    });
  });

  it("maps codes to their HTTP status", async () => {
    expect(errorResponse("UNAUTHENTICATED", "x").status).toBe(401);
    expect(errorResponse("NOT_FOUND", "x").status).toBe(404);
    expect(errorResponse("VALIDATION_FAILED", "x").status).toBe(422);
    expect(errorResponse("RATE_LIMITED", "x").status).toBe(429);
    expect(ERROR_CODES.EMAIL_IN_USE).toBe(409);
  });

  it("withErrorHandling converts ApiError to its envelope", async () => {
    const handler = withErrorHandling(async () => {
      throw new ApiError("NOT_FOUND", "Not found.");
    });
    const res = await handler();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "NOT_FOUND", message: "Not found." } });
  });

  it("withErrorHandling hides unexpected errors behind a 500", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = withErrorHandling(async () => {
      throw new Error("secret internal detail");
    });
    const res = await handler();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("secret internal detail");
    spy.mockRestore();
  });

  it("passes successful responses through", async () => {
    const handler = withErrorHandling(async () => NextResponse.json({ ok: true }));
    const res = await handler();
    expect(res.status).toBe(200);
  });
});
