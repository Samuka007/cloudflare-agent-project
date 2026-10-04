import { z } from "zod";

/**
 * Pending-interaction surface (M1.5 T4 #94): the DO↔SPA ask channel, shaped
 * on bb's own interactive-request semantics (packages/domain/src/
 * pending-interactions.ts + host-daemon-contract session.ts:725-754) so the
 * SPA contract and an upstream bb surface are the same shape.
 *
 * The MODEL-facing `ask` tool schema stays omp verbatim (agent-do
 * tools/registry.ts); this module is the SPA-side projection registered in
 * the journal (`interaction.*` events) and pushed over /ws.
 *
 * Deliberate divergence from bb, omp-verbatim by #74: omp ask enforces no
 * question/option count caps (docs/tools/ask.md §Limits "no minimum/maximum
 * is enforced"), so bb's MAX_QUESTIONS/MAX_OPTIONS caps are exported as
 * contract constants but NOT enforced here — the DO accepts a superset of
 * bb's payload and an upstream surface re-imposes presentation caps SPA-side.
 */

export const pendingInteractionStatusSchema = z.enum([
  "pending",
  "resolving",
  "resolved",
  "interrupted",
]);
export type PendingInteractionStatus = z.infer<typeof pendingInteractionStatusSchema>;

/** bb contract constants (packages/domain pending-interactions.ts:192-195). */
export const USER_QUESTION_MAX_QUESTIONS = 4;
export const USER_QUESTION_MAX_OPTIONS = 4;
export const USER_QUESTION_MAX_SELECTED = 4;
export const USER_QUESTION_MAX_FREE_TEXT_LENGTH = 4096;

const userQuestionIdSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: "User question ids cannot be blank",
  });

const userQuestionPromptSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: "User question prompts cannot be blank",
  });

const userQuestionShortLabelSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: "User question short labels cannot be blank",
  });

const userQuestionFreeTextSchema = z
  .string()
  .min(1)
  .max(
    USER_QUESTION_MAX_FREE_TEXT_LENGTH,
    `User question free text cannot exceed ${USER_QUESTION_MAX_FREE_TEXT_LENGTH} characters`,
  )
  .refine((value) => value.trim().length > 0, {
    message: "User question free text cannot be blank",
  });

export const pendingInteractionUserQuestionOptionSchema = z.object({
  /** Stable choice id (omp label value-scheme: `omp-ui:<executionId>:option-N`). */
  value: z
    .string()
    .min(1)
    .refine((value) => value.trim().length > 0, {
      message: "User question option values cannot be blank",
    }),
  label: z
    .string()
    .min(1)
    .refine((value) => value.trim().length > 0, {
      message: "User question option labels cannot be blank",
    }),
  description: z
    .string()
    .min(1)
    .refine((value) => value.trim().length > 0, {
      message: "User question option descriptions cannot be blank",
    })
    .optional(),
});
export type PendingInteractionUserQuestionOption = z.infer<
  typeof pendingInteractionUserQuestionOptionSchema
>;

/**
 * One registered question. bb `pendingInteractionUserQuestionQuestionSchema`
 * shape with two DO-additive passthroughs: `recommended` (omp 0-based default,
 * consumed by the timeout auto-select arm; bb's payload has no field for it)
 * and uncapped arrays (see module docstring).
 */
export const pendingInteractionUserQuestionQuestionSchema = z
  .object({
    id: userQuestionIdSchema,
    prompt: userQuestionPromptSchema,
    shortLabel: userQuestionShortLabelSchema.optional(),
    multiSelect: z.boolean(),
    options: z.array(pendingInteractionUserQuestionOptionSchema).optional(),
    allowFreeText: z.boolean(),
    recommended: z.number().int().nonnegative().optional(),
  })
  .refine(
    (question) =>
      question.allowFreeText || (question.options !== undefined && question.options.length > 0),
    { message: "User question needs options when free text is not allowed" },
  );
export type PendingInteractionUserQuestionQuestion = z.infer<
  typeof pendingInteractionUserQuestionQuestionSchema
>;

export const userQuestionPendingInteractionPayloadSchema = z.object({
  kind: z.literal("user_question"),
  questions: z
    .array(pendingInteractionUserQuestionQuestionSchema)
    .min(1, "User questions must include at least one question"),
});
export type UserQuestionPendingInteractionPayload = z.infer<
  typeof userQuestionPendingInteractionPayloadSchema
>;

export const pendingInteractionPayloadSchema = z.discriminatedUnion("kind", [
  userQuestionPendingInteractionPayloadSchema,
]);
export type PendingInteractionPayload = z.infer<typeof pendingInteractionPayloadSchema>;

/** bb `pendingInteractionUserAnswerSchema` (cap dropped — omp verbatim). */
export const pendingInteractionUserAnswerSchema = z.object({
  selected: z.array(z.string().min(1)),
  freeText: userQuestionFreeTextSchema.optional(),
});
export type PendingInteractionUserAnswer = z.infer<typeof pendingInteractionUserAnswerSchema>;

/** bb `userQuestionPendingInteractionResolutionSchema` — the ruling backflow. */
export const userQuestionPendingInteractionResolutionSchema = z.object({
  kind: z.literal("user_answer"),
  answers: z.record(z.string().min(1), pendingInteractionUserAnswerSchema),
});
export type UserQuestionPendingInteractionResolution = z.infer<
  typeof userQuestionPendingInteractionResolutionSchema
>;

export const pendingInteractionResolutionSchema = z.union(
  [userQuestionPendingInteractionResolutionSchema],
  "Invalid resolution. Expected 'user_answer'",
);
export type PendingInteractionResolution = z.infer<typeof pendingInteractionResolutionSchema>;

export function isUserQuestionPendingInteractionResolution(
  resolution: PendingInteractionResolution,
): resolution is UserQuestionPendingInteractionResolution {
  // Single-member union today: the `in` check is the whole guard; the
  // discriminant comparison returns when further kinds (bb approval) land.
  return "kind" in resolution;
}

/** Provider-origin provenance (bb pendingInteractionProviderOriginSchema). */
export const pendingInteractionProviderOriginSchema = z.object({
  kind: z.literal("provider"),
  providerId: z.string().min(1),
  providerThreadId: z.string().min(1),
  providerRequestId: z.string().min(1),
});
export type PendingInteractionProviderOrigin = z.infer<
  typeof pendingInteractionProviderOriginSchema
>;

/**
 * Full row as the SPA renders it from the journal (`interaction.registered`
 * plus the lifecycle transitions folded by tools/ask.ts projectInteraction).
 */
export interface PendingInteractionRow {
  id: string;
  threadId: string;
  status: PendingInteractionStatus;
  statusReason: string | null;
  createdAt: number;
  /** Absolute deadline for provider-originated interactions, when bounded. */
  expiresAt: number | null;
  resolvedAt: number | null;
  /** Owning ask execution (bb turnId role — the DO execution IS the request). */
  executionId: string;
  turnId: string;
  origin: PendingInteractionProviderOrigin;
  payload: PendingInteractionPayload;
  /** The ruling once resolved; null while pending/interrupted (bb row shape). */
  resolution: PendingInteractionResolution | null;
}
