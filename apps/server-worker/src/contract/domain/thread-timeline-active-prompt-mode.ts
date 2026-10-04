//
// Ported verbatim from bb (Samuka007/bb fork of get-bb/bb) commit 8473d8c33.
// Cross-package imports rewritten to workspace-relative paths; no semantic edits.
//
import { z } from "zod";

export const threadTimelineActivePromptModeSchema = z
  .object({
    mode: z.literal("plan"),
    providerId: z.enum(["claude-code", "codex"]),
    prompt: z.string(),
  })
  .strict();

export type ThreadTimelineActivePromptMode = z.infer<typeof threadTimelineActivePromptModeSchema>;
