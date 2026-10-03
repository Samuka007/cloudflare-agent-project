//
// Ported verbatim from bb (Samuka007/bb fork of get-bb/bb) commit 8473d8c33.
// Cross-package imports rewritten to workspace-relative paths; no semantic edits.
//
import { z } from "zod";

export const threadVisibilityValues = ["visible", "hidden"] as const;
export const threadVisibilitySchema = z.enum(threadVisibilityValues);
export type ThreadVisibility = z.infer<typeof threadVisibilitySchema>;
