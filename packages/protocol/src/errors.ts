import { z } from "zod";

/**
 * HTTP error envelope, bb-shaped (`{code, message, details?, retryable?}`).
 * bb freezes lifecycle errors as snake_case discriminated unions on `code`;
 * we keep the envelope and a small closed code set for M0 (additive growth
 * allowed; codes never repurposed).
 */
export const apiErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  details: z.unknown().optional(),
  retryable: z.boolean().optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const apiErrorCodeSchema = z.enum([
  "bad_request",
  "validation_failed",
  "not_found",
  "conflict",
  "machine_unavailable",
  "internal",
]);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

const HTTP_STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  bad_request: 400,
  validation_failed: 422,
  not_found: 404,
  conflict: 409,
  machine_unavailable: 503,
  internal: 500,
};

const RETRYABLE_BY_CODE: Record<ApiErrorCode, boolean> = {
  bad_request: false,
  validation_failed: false,
  not_found: false,
  conflict: false,
  machine_unavailable: true,
  internal: true,
};

export function apiError(
  code: ApiErrorCode,
  message: string,
  details?: unknown,
): ApiError {
  return {
    code,
    message,
    details,
    retryable: RETRYABLE_BY_CODE[code],
  };
}

export function httpStatusForCode(code: ApiErrorCode): number {
  return HTTP_STATUS_BY_CODE[code];
}

/** Details payload for `conflict` raised while a turn is already running. */
export const turnActiveErrorDetailsSchema = z.object({
  reason: z.literal("turn-active"),
  threadId: z.string().min(1),
});
