//
// Ported verbatim from bb (Samuka007/bb fork of get-bb/bb) commit 8473d8c33.
// Cross-package imports rewritten to workspace-relative paths; no semantic edits.
//
export const threadDynamicContextFileStatusValues = [
  "present",
  "missing",
  "too_large",
  "non_utf8",
] as const;

export type ThreadDynamicContextFileStatus =
  (typeof threadDynamicContextFileStatusValues)[number];
