//
// Ported verbatim from bb (Samuka007/bb fork of get-bb/bb) commit 8473d8c33.
// Cross-package imports rewritten to workspace-relative paths; no semantic edits.
//
import { z } from "zod";

export interface ActiveThinking {
  id: string;
  text: string;
  startedAt: number;
  updatedAt: number;
}

export const activeThinkingSchema = z.object({
  id: z.string(),
  text: z.string(),
  startedAt: z.number(),
  updatedAt: z.number(),
});
