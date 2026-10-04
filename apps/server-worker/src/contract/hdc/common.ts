//
// Ported verbatim from bb (Samuka007/bb fork of get-bb/bb) commit 8473d8c33.
// Cross-package imports rewritten to workspace-relative paths; no semantic edits.
//
// Inlined from bb packages/hono-typed-routes/src/endpoint.ts (only symbols
// the ported contract needs; descriptor helpers are not ported).
declare const __untyped: unique symbol;
export type Untyped = {
  readonly [__untyped]: never;
};
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
export type EmptyInput = Record<string, never>;
