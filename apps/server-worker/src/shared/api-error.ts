import type { Context } from "hono";

/**
 * ApiError semantics ported from bb `apps/server/src/errors` usage: routes
 * throw with (status, code, message, details?, retryable?); the app-level
 * error handler serializes the bb envelope
 * `{code, message, details?, retryable?}` (contract/errors.ts apiErrorSchema).
 * Zod validation failures map to bb's 422 validation_failed.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly retryable?: boolean;

  constructor(args: {
    status: number;
    code: string;
    message: string;
    details?: unknown;
    retryable?: boolean;
  }) {
    super(args.message);
    this.name = "ApiError";
    this.status = args.status;
    this.code = args.code;
    this.details = args.details;
    this.retryable = args.retryable;
  }
}

export function apiErrorHandler(error: unknown, ctx: Context): Response {
  if (error instanceof ApiError) {
    return ctx.json(
      {
        code: error.code,
        message: error.message,
        ...(error.details !== undefined ? { details: error.details } : {}),
        ...(error.retryable !== undefined ? { retryable: error.retryable } : {}),
      },
      error.status as 400,
    );
  }
  if (error instanceof ZodErrorHolder) {
    return ctx.json(
      {
        code: "validation_failed",
        message: "Request validation failed",
        details: { issues: error.issues },
        retryable: false,
      },
      422,
    );
  }
  console.error("unhandled error", error);
  return ctx.json({ code: "internal", message: "Internal server error", retryable: true }, 500);
}

/** Carries zod issues through the throw path without importing zod here. */
export class ZodErrorHolder extends Error {
  readonly issues: unknown;

  constructor(issues: unknown) {
    super("validation failed");
    this.name = "ZodErrorHolder";
    this.issues = issues;
  }
}

interface ZodLikeError {
  issues: unknown;
}

export function toApiError(error: unknown): Error {
  if (error && typeof error === "object" && "issues" in error && Array.isArray(error.issues)) {
    return new ZodErrorHolder(error.issues);
  }
  if (error instanceof Error) {
    return error;
  }
  return new ApiError({
    status: 500,
    code: "internal",
    message: String(error),
    retryable: true,
  });
}
