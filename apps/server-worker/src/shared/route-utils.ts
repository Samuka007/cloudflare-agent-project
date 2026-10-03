import type { Context } from "hono";
import { ZodError } from "zod";
import { ApiError, ZodErrorHolder, toApiError } from "./api-error.js";

export { ApiError };

/**
 * Parse helper used by every route: zod failures become bb 422
 * validation_failed; anything else rethrows for the app error handler.
 */
export function parseOr422<T>(schema: {
  safeParse(input: unknown): { success: true; data: T } | { success: false; error: ZodError };
}, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ZodErrorHolder(
      result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

export function requireJsonBody<T>(ctx: Context, schema: {
  safeParse(input: unknown): { success: true; data: T } | { success: false; error: ZodError };
}): Promise<T> {
  return ctx.req
    .json()
    .then((body) => parseOr422(schema, body))
    .catch((error: unknown) => {
      // Syntax error on JSON body → 400 invalid_request, zod errors rethrow.
      if (error instanceof ZodError || error instanceof ZodErrorHolder) {
        throw toApiError(error);
      }
      throw new ApiError({
        status: 400,
        code: "invalid_request",
        message: "Request body must be valid JSON",
      });
    });
}

/** bb route helpers: requireXxx throws 404 not_found with the subject code. */
export function requireFound<T>(
  value: T | null | undefined,
  args: { code: string; message: string },
): T {
  if (value === null || value === undefined) {
    throw new ApiError({ status: 404, code: args.code, message: args.message });
  }
  return value;
}

export function intParam(ctx: Context, name: string): number {
  const raw = ctx.req.param(name);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ApiError({
      status: 400,
      code: "invalid_request",
      message: `Invalid ${name}`,
    });
  }
  return parsed;
}
