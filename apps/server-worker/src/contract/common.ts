//
// Ported verbatim from bb (Samuka007/bb fork of get-bb/bb) commit 8473d8c33.
// Cross-package imports rewritten to workspace-relative paths; no semantic edits.
//
/**
 * Ported verbatim from bb `packages/hono-typed-routes/src/endpoint.ts`
 * (commit 8473d8c33) — the only symbols the ported contract layer needs from
 * that package. The descriptor helpers (defineRoute/jsonRequest/...) are
 * Node-server plumbing and are not ported; the Worker defines routes with
 * plain Hono.
 */
declare const __untyped: unique symbol;
/** Sentinel type for endpoints whose output is not yet explicitly typed. */
export type Untyped = { readonly [__untyped]: never };
export type Endpoint<
  Input,
  Output = Untyped,
  Status extends number = 200,
  Format extends "json" | "text" | "binary" = "json",
> = {
  input: Input;
  output: Output;
  outputFormat: Format;
  status: Status;
};
export type EmptyInput = Record<never, never>;

export type PathId = { param: { id: string } };
export type PathProjectId = { param: { id: string } };
export type PathThreadAndQueuedMessage = {
  param: { id: string; queuedMessageId: string };
};
/**
 * Thread routes that address a workspace-relative file as a path suffix
 * (`:filePath{.+}` matches across slashes). Clients must percent-encode each
 * path segment themselves — hono's `$url()` substitutes params verbatim.
 */
export type PathThreadAndFilePath = {
  param: { id: string; filePath: string };
};
export type PathPreviewAndFilePath = {
  param: { id: string; filePath: string };
};
export type PathThreadAndTerminal = {
  param: { id: string; terminalId: string };
};
export type PathEnvironmentAndTerminal = {
  param: { id: string; terminalId: string };
};
export type PathTerminal = {
  param: { terminalId: string };
};
