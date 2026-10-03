//
// Ported verbatim from bb (Samuka007/bb fork of get-bb/bb) commit 8473d8c33.
// Cross-package imports rewritten to workspace-relative paths; no semantic edits.
//
import { z } from "zod";

export const threadTimelineGoalStatusSchema = z.enum([
  "active",
  "paused",
  "budgetLimited",
  "complete",
]);
export type ThreadTimelineGoalStatus = z.infer<
  typeof threadTimelineGoalStatusSchema
>;

export const threadTimelineGoalSchema = z.object({
  sourceSeq: z.number().int().nonnegative(),
  updatedAt: z.number(),
  objective: z.string(),
  status: threadTimelineGoalStatusSchema,
  tokenBudget: z.number().nullable(),
  tokensUsed: z.number(),
  timeUsedSeconds: z.number(),
});
export type ThreadTimelineGoal = z.infer<typeof threadTimelineGoalSchema>;
