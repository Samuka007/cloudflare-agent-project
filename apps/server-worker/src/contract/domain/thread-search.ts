//
// Ported verbatim from bb (Samuka007/bb fork of get-bb/bb) commit 8473d8c33.
// Cross-package imports rewritten to workspace-relative paths; no semantic edits.
//
import { z } from "zod";

export const threadSearchSourceKindValues = [
  "title",
  "title_fallback",
  "user_message",
  "assistant_message",
  "system_message",
] as const;

export const threadSearchSourceKindSchema = z.enum(
  threadSearchSourceKindValues,
);
export type ThreadSearchSourceKind = z.infer<
  typeof threadSearchSourceKindSchema
>;
