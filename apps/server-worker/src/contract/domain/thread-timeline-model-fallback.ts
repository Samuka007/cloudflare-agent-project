//
// Ported verbatim from bb (Samuka007/bb fork of get-bb/bb) commit 8473d8c33.
// Cross-package imports rewritten to workspace-relative paths; no semantic edits.
//
import { z } from "zod";

export const threadTimelineModelFallbackSchema = z.object({
  sourceSeq: z.number().int().nonnegative(),
  detectedAt: z.number(),
  originalModel: z.string().min(1),
  fallbackModel: z.string().min(1),
  reason: z.enum(["refusal", "provider"]),
  message: z.string(),
});
export type ThreadTimelineModelFallback = z.infer<typeof threadTimelineModelFallbackSchema>;
